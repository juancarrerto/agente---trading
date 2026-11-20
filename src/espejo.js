// Espejo: copia a la cuenta demo de Alpaca lo que la sombra decide. La sombra manda; Alpaca ejecuta con sus propios precios.
//
// Reglas (por acción):
//   · La sombra tiene una orden pendiente  -> en Alpaca hay una orden de compra con stop (se dispara al romper el nivel de entrada).
//   · Hay posición real                    -> se colocan salidas con stop-loss y objetivo: la mitad (lote A) con objetivo en 1R y el resto (lote B)
//                                             con el objetivo final. Cuando la sombra sube el stop a equilibrio, se sube también el de Alpaca.
//   · La sombra cerró la operación         -> si en Alpaca sigue abierta (p. ej. salida por tiempo), se cierra a mercado.
//   · Orden de la sombra vencida/cancelada -> se cancela la de Alpaca.
//   · Posición corta o sin dueño           -> se cierra (seguridad).
// Alpaca no permite poner stop-loss a una orden de entrada tipo stop: por eso las salidas se colocan en cuanto se ve la posición.
const redondear = p => Math.round(p * 100) / 100;
const num = x => (x === undefined || x === null || x === '' ? null : Number(x));

// ----- Lectura del estado real: posiciones y órdenes abiertas (con las patas de las órdenes OCO como órdenes sueltas)
async function leerReal(cliente) {
  const [pos, ord] = await Promise.all([cliente.posiciones(), cliente.ordenesAbiertas()]);
  const posiciones = new Map();
  for (const p of pos ?? []) posiciones.set(p.symbol, { qty: num(p.qty) * (p.side === 'short' ? -1 : 1), entrada: num(p.avg_entry_price) });
  const ordenes = [];
  const vistos = new Set();
  const poner = o => { if (o.id && !vistos.has(o.id)) { vistos.add(o.id); ordenes.push(o); } };
  for (const o of ord ?? []) {
    poner(o);
    for (const l of o.legs ?? []) poner({ ...l, parent_order_id: l.parent_order_id ?? o.id, _padre: o });
  }
  return { posiciones, ordenes };
}

const idClienteDe = o => o._padre?.client_order_id || o.client_order_id || '';      // las patas de una orden OCO se identifican por la orden madre
const esNuestra = o => idClienteDe(o).startsWith('ag-');
const rolDe = o => (/-\d*([EMAB])$/.exec(idClienteDe(o)) ?? [])[1] ?? null;
const tipoDe = o => o.order_type ?? o.type;
const claveId = (fecha, id) => `${fecha}:${id}`;

function lotes(qty, plan) {
  const vp = plan.ventaParcial ?? plan.gestion?.ventaParcial ?? null;
  const parcialYaHecha = plan.parcialHecha === true;
  let a = vp ? Math.floor(qty * (vp.fraccion ?? 0.5) + 1e-9) : 0;
  if (a < 1 || a >= qty || parcialYaHecha) a = 0;
  const stop = redondear(plan.stop), out = [];
  if (a > 0 && vp?.en > stop + 0.01) out.push({ rol: 'A', qty: a, tp: redondear(vp.en), stop });
  const b = qty - (out[0]?.qty ?? 0);
  if (plan.objetivo > stop + 0.01) out.push({ rol: 'B', qty: b, tp: redondear(plan.objetivo), stop });
  return out;
}

// ----- Planificador (función pura: no toca la red)
// sombra: { pendientes, posiciones }   real: salida de leerReal   registro: { enviados, salidas }   fecha: 'AAAAMMDD' (Nueva York)
// eventosPasada: eventos de la última pasada de la sombra (para saber qué entradas fueron "a mercado")
function planificar({ sombra, real, registro, fecha, eventosPasada = [], ahoraMs = 0 }) {
  const acciones = [];
  const simbolos = new Set([...sombra.pendientes.map(o => o.simbolo), ...sombra.posiciones.map(p => p.simbolo), ...real.posiciones.keys(),
    ...real.ordenes.filter(esNuestra).map(o => o.symbol)]);
  const aMercado = new Set(eventosPasada.filter(e => e.tipo === 'ENTRADA' && /mercado/i.test(e.detalle ?? '')).map(e => e.id));
  for (const sim of [...simbolos].sort()) {
    const pendS = sombra.pendientes.find(o => o.simbolo === sim) ?? null;
    const posS = sombra.posiciones.find(p => p.simbolo === sim) ?? null;
    const plan = posS ?? pendS;
    const rp = real.posiciones.get(sim)?.qty ?? 0;
    const ords = real.ordenes.filter(o => o.symbol === sim && esNuestra(o) && ['new', 'accepted', 'pending_new', 'partially_filled', 'held', 'pending_replace', 'accepted_for_bidding', 'replaced'].includes(o.status));
    const entradas = ords.filter(o => o.side === 'buy' && !o.parent_order_id);
    const salidas = ords.filter(o => o.side === 'sell');
    const salidasPadre = salidas.filter(o => !o.parent_order_id || !salidas.some(x => x.id === o.parent_order_id));

    if (rp < 0) { acciones.push({ tipo: 'CERRAR', simbolo: sim, motivo: 'posición corta en Alpaca (no debería existir)' }); continue; }

    if (!plan) {
      if (rp > 0) acciones.push({ tipo: 'CERRAR', simbolo: sim, motivo: 'la sombra no tiene esta operación (ya cerró) y en Alpaca sigue abierta' });
      else for (const o of [...entradas, ...salidasPadre]) acciones.push({ tipo: 'CANCELAR', simbolo: sim, ordenId: o.id, motivo: 'la sombra ya no tiene esta orden' });
      continue;
    }

    if (rp === 0) {
      for (const o of salidasPadre) acciones.push({ tipo: 'CANCELAR', simbolo: sim, ordenId: o.id, motivo: 'salida sin posición' });
      if (pendS && ahoraMs >= Date.parse(pendS.venceEn)) { for (const o of entradas) acciones.push({ tipo: 'CANCELAR', simbolo: sim, ordenId: o.id, motivo: 'la orden de la sombra venció (3 velas sin activarse)' }); continue; }
      const k = claveId(fecha, plan.id);
      if (!entradas.length && !registro.enviados[k]) {
        if (pendS) acciones.push({ tipo: 'ENTRADA', simbolo: sim, idSombra: pendS.id, qty: pendS.unidades, disparador: pendS.entrada, clase: 'stop', clientId: `ag-${fecha}-${sim}-${pendS.id}-E` });
        else if (posS && aMercado.has(posS.id)) acciones.push({ tipo: 'ENTRADA', simbolo: sim, idSombra: posS.id, qty: posS.unidades, disparador: posS.entrada, clase: 'market', clientId: `ag-${fecha}-${sim}-${posS.id}-M` });
        else if (posS && !Object.entries(registro.enviados).some(([k, v]) => k.startsWith(fecha + ':') && v.simbolo === sim)) acciones.push({ tipo: 'AVISO', simbolo: sim, detalle: `la sombra abrió ${posS.id} pero en Alpaca nunca hubo orden de entrada: no se persigue el precio` });
      }
      continue;
    }

    // Hay posición real larga
    for (const o of entradas) acciones.push({ tipo: 'CANCELAR', simbolo: sim, ordenId: o.id, motivo: 'entrada ya ejecutada (o a medias): se cancela lo que falta' });
    const reg = registro.salidas[claveId(fecha, plan.id)] ?? { intentos: 0 };
    if (!salidasPadre.length) {
      if (reg.intentos >= 3) { acciones.push({ tipo: 'CERRAR', simbolo: sim, motivo: 'no se pudieron colocar las salidas (3 intentos): se cierra por seguridad' }); continue; }
      const ls = lotes(rp, plan);
      if (!ls.length) { acciones.push({ tipo: 'CERRAR', simbolo: sim, motivo: 'niveles de salida no válidos para colocar las órdenes: se cierra por seguridad' }); continue; }
      acciones.push({ tipo: 'SALIDAS', simbolo: sim, idSombra: plan.id, lotes: ls, fecha });
      continue;
    }
    // Ya hay salidas: el stop de Alpaca sigue al de la sombra (solo hacia arriba)
    const stopObjetivo = redondear(plan.stop);
    for (const o of salidas.filter(x => tipoDe(x) === 'stop' || tipoDe(x) === 'stop_limit')) {
      const actual = num(o.stop_price);
      if (actual !== null && stopObjetivo > actual + 0.004) acciones.push({ tipo: 'AJUSTAR_STOP', simbolo: sim, ordenId: o.id, nuevoStop: stopObjetivo, anterior: actual });
    }
  }
  return acciones;
}

// ----- Aplicación (habla con Alpaca; en modo "mirar" solo describe lo que haría)
async function aplicar({ cliente, acciones, registro, fecha, modo, esperar, bitacora, ahoraMs }) {
  const resultados = [];
  const log = (tipo, datos) => { const r = { tipo, ...datos }; bitacora(r); resultados.push(r); };
  for (const a of acciones) {
    if (a.tipo === 'AVISO') {
      registro.vistos ||= {};
      const k = `${fecha}:${JSON.stringify(a)}`;
      if (!registro.vistos[k]) { registro.vistos[k] = 1; log('AVISO_ESPEJO', { simbolo: a.simbolo, detalle: a.detalle }); }
      continue;
    }
    if (modo !== 'operar') {                                    // modo "mirar": se anota lo que haría, una sola vez por acción
      registro.vistos ||= {};
      const k = `${fecha}:${JSON.stringify({ ...a, ts: undefined })}`;
      if (!registro.vistos[k]) { registro.vistos[k] = 1; log('HARIA', { accion: a }); }
      continue;
    }
    try {
      if (a.tipo === 'ENTRADA') {
        registro.enviados[claveId(fecha, a.idSombra)] = { clientId: a.clientId, ts: ahoraMs, simbolo: a.simbolo };
        const cuerpo = { symbol: a.simbolo, qty: String(a.qty), side: 'buy', time_in_force: 'day', client_order_id: a.clientId };
        if (a.clase === 'stop') Object.assign(cuerpo, { type: 'stop', stop_price: String(redondear(a.disparador)) }); else cuerpo.type = 'market';
        try {
          const o = await cliente.enviarOrden(cuerpo);
          log('ORDEN_ENVIADA', { simbolo: a.simbolo, rol: a.clase === 'stop' ? 'entrada con stop' : 'entrada a mercado', qty: a.qty, precio: a.disparador, id: o?.id, estado: o?.status });
        } catch (e) {
          if (a.clase === 'stop' && e.estado === 422 && /stop/i.test(e.message)) {     // el precio ya superó el nivel: en la sombra se ejecutaría enseguida
            const cm = { symbol: a.simbolo, qty: String(a.qty), side: 'buy', type: 'market', time_in_force: 'day', client_order_id: a.clientId.replace(/-E$/, '-M') };
            const o = await cliente.enviarOrden(cm);
            log('ORDEN_ENVIADA', { simbolo: a.simbolo, rol: 'entrada a mercado (el precio ya había superado el stop)', qty: a.qty, id: o?.id, estado: o?.status, motivoCambio: e.message });
          } else throw e;
        }
      } else if (a.tipo === 'SALIDAS') {
        const k = claveId(a.fecha, a.idSombra);
        const reg = (registro.salidas[k] ||= { intentos: 0 });
        reg.intentos++; reg.ts = ahoraMs;
        let fallo = null;
        for (const l of a.lotes) {
          try {
            const o = await cliente.enviarOrden({ symbol: a.simbolo, qty: String(l.qty), side: 'sell', type: 'limit', time_in_force: 'day', order_class: 'oco',
              take_profit: { limit_price: String(l.tp) }, stop_loss: { stop_price: String(l.stop) }, client_order_id: `ag-${a.fecha}-${a.simbolo}-${a.idSombra}-${reg.intentos}${l.rol}` });
            log('ORDEN_ENVIADA', { simbolo: a.simbolo, rol: `salidas lote ${l.rol}`, qty: l.qty, objetivo: l.tp, stop: l.stop, id: o?.id, estado: o?.status });
          } catch (e) { fallo = e; log('ERROR_ORDEN', { simbolo: a.simbolo, rol: `salidas lote ${l.rol}`, error: e.message }); break; }
        }
        if (fallo) {                                           // posición sin protección completa: se cancela lo puesto y se cierra a mercado
          await cerrarSeguro({ cliente, simbolo: a.simbolo, esperar, log, motivo: 'falló la colocación de las salidas' });
        }
      } else if (a.tipo === 'AJUSTAR_STOP') {
        const clave = `ajuste:${a.ordenId}`;
        registro.ajustes ||= {};
        registro.ajustes[clave] = (registro.ajustes[clave] ?? 0) + 1;
        if (registro.ajustes[clave] > 4) { log('AJUSTE_ABANDONADO', { simbolo: a.simbolo, ordenId: a.ordenId }); continue; }
        try {
          await cliente.reemplazarOrden(a.ordenId, { stop_price: String(a.nuevoStop) });
          log('STOP_AJUSTADO', { simbolo: a.simbolo, de: a.anterior, a: a.nuevoStop });
        } catch (e) { log('ERROR_ORDEN', { simbolo: a.simbolo, rol: 'ajuste de stop', error: e.message }); }
      } else if (a.tipo === 'CANCELAR') {
        try { await cliente.cancelarOrden(a.ordenId); log('ORDEN_CANCELADA', { simbolo: a.simbolo, ordenId: a.ordenId, motivo: a.motivo }); }
        catch (e) { log('ERROR_ORDEN', { simbolo: a.simbolo, rol: 'cancelación', error: e.message }); }
      } else if (a.tipo === 'CERRAR') {
        await cerrarSeguro({ cliente, simbolo: a.simbolo, esperar, log, motivo: a.motivo });
      }
    } catch (e) { log('ERROR_ORDEN', { simbolo: a.simbolo, rol: a.tipo, error: e.message }); }
  }
  return resultados;
}

// Cancela las órdenes de la acción, espera a que se liberen las acciones reservadas y cierra la posición a mercado
async function cerrarSeguro({ cliente, simbolo, esperar, log, motivo }) {
  const { ordenes } = await leerReal(cliente);
  for (const o of ordenes.filter(x => x.symbol === simbolo && esNuestra(x) && !x.parent_order_id)) {
    try { await cliente.cancelarOrden(o.id); } catch { /* puede estar ya cancelada */ }
  }
  let ultimoError = null;
  for (let i = 0; i < 6; i++) {
    await esperar(1000);
    try { await cliente.cerrarPosicion(simbolo); log('POSICION_CERRADA', { simbolo, motivo }); return true; }
    catch (e) { ultimoError = e; if (e.estado === 404) { log('POSICION_CERRADA', { simbolo, motivo: motivo + ' (ya no había posición)' }); return true; } }
  }
  log('ERROR_ORDEN', { simbolo, rol: 'cierre a mercado', error: ultimoError?.message });
  return false;
}

module.exports = { leerReal, planificar, aplicar, lotes, cerrarSeguro, redondear, esNuestra };
