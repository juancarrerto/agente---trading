// Sonda de compatibilidad con Alpaca (cuenta DEMO). Comprueba con órdenes mínimas (1 o 2 acciones de Ford, muy lejos del precio) las cosas que la
// documentación no deja claras y de las que depende el agente. Hay que correrla con el mercado abierto (de 9:30 a 16:00, hora de Nueva York).
//   1) ¿Acepta una orden de compra con stop por encima del precio?           (entrada por ruptura)
//   2) ¿Acepta DOS grupos de salida OCO sobre la misma posición?             (lote A: mitad con objetivo en 1R; lote B: el resto)
//   3) ¿Se puede subir el stop de una orden OCO ya colocada?                  (stop a equilibrio)
//   4) ¿Cómo devuelve Alpaca las órdenes OCO al listarlas?                    (para que el agente las reconozca)
//   5) ¿Se puede cerrar la posición y queda todo limpio?
// Al terminar deja todo cancelado y cerrado. Escribe datos/sonda.json. No usa nada de la estrategia.
const fs = require('fs');
const path = require('path');
const { crearCliente } = require('./alpaca.js');
const { leerReal } = require('./espejo.js');

async function cuerpoSonda({ cliente, simbolo, esperar, ahora }) {
  const R = { inicio: new Date(ahora()).toISOString(), simbolo, pasos: [] };
  const paso = async (nombre, fn) => {
    try { const detalle = await fn(); R.pasos.push({ nombre, ok: true, detalle }); return detalle; }
    catch (e) { R.pasos.push({ nombre, ok: false, error: e.message }); return null; }
  };
  const cid = `ag-sonda-${ahora()}`;
  const r2 = x => (Math.round(x * 100) / 100).toFixed(2);
  try {
    const reloj = await cliente.reloj();
    if (!reloj?.is_open) { R.pasos.push({ nombre: 'mercado abierto', ok: false, error: 'El mercado está cerrado: corre la sonda de nuevo entre las 9:30 y las 16:00 (Nueva York).' }); return R; }
    const cuenta = await cliente.cuenta();
    R.cuenta = { estado: cuenta.status, equity: cuenta.equity, buying_power: cuenta.buying_power, pattern_day_trader: cuenta.pattern_day_trader, daytrade_count: cuenta.daytrade_count, shorting_enabled: cuenta.shorting_enabled, multiplier: cuenta.multiplier };
    const antes = await leerReal(cliente);
    if (antes.posiciones.has(simbolo) || antes.ordenes.some(o => o.symbol === simbolo)) { R.pasos.push({ nombre: 'cuenta limpia', ok: false, error: `Ya hay posición u órdenes en ${simbolo}: la sonda no sigue para no tocarlas.` }); return R; }

    const ini = new Date(ahora() - 30 * 60000).toISOString();
    const v = (await cliente.velas([simbolo], ini, new Date(ahora() + 60000).toISOString()))[simbolo] ?? [];
    const px = v.at(-1)?.c;
    R.precio = px;
    if (!(px > 1)) { R.pasos.push({ nombre: 'precio', ok: false, error: 'No llegaron velas recientes de IEX' }); return R; }
    R.ultimaVela = v.at(-1)?.t;

    // 1) entrada con stop por encima del precio
    const e1 = await paso('1. compra con stop por encima del precio (se cancela enseguida)', async () => {
      const o = await cliente.enviarOrden({ symbol: simbolo, qty: '1', side: 'buy', type: 'stop', stop_price: r2(px * 1.06), time_in_force: 'day', client_order_id: `${cid}-1` });
      await cliente.cancelarOrden(o.id); return { estado: o.status };
    });
    // 2) compra a mercado de 2 acciones
    const compra = await paso('2. compra a mercado de 2 acciones', async () => {
      const o = await cliente.enviarOrden({ symbol: simbolo, qty: '2', side: 'buy', type: 'market', time_in_force: 'day', client_order_id: `${cid}-2` });
      for (let i = 0; i < 20; i++) { await esperar(1000); const r = await leerReal(cliente); if ((r.posiciones.get(simbolo)?.qty ?? 0) >= 2) return { estado: o.status, qty: r.posiciones.get(simbolo).qty, precioPromedio: r.posiciones.get(simbolo).entrada }; }
      throw new Error('la compra no apareció como posición en 20 s');
    });
    if (compra) {
      // 3) dos grupos OCO sobre la misma posición
      const tp = r2(px * 1.12), sl = r2(px * 0.88);
      const g = [];
      for (const n of [1, 2]) {
        const o = await paso(`3.${n} grupo OCO de 1 acción (objetivo ${tp}, stop ${sl})`, async () => {
          const x = await cliente.enviarOrden({ symbol: simbolo, qty: '1', side: 'sell', type: 'limit', time_in_force: 'day', order_class: 'oco', take_profit: { limit_price: tp }, stop_loss: { stop_price: sl }, client_order_id: `${cid}-oco${n}` });
          return { id: x.id, estado: x.status, patas: (x.legs ?? []).map(l => ({ id: l.id, tipo: l.order_type ?? l.type, estado: l.status })) };
        });
        if (o) g.push(o);
      }
      // 4) forma del listado
      await paso('4. listado de órdenes abiertas con patas anidadas', async () => {
        const r = await leerReal(cliente);
        const mias = r.ordenes.filter(o => o.symbol === simbolo);
        return { ordenesVistas: mias.length, ejemplo: mias.slice(0, 3).map(o => ({ id: o.id, side: o.side, tipo: o.order_type ?? o.type, clase: o.order_class, estado: o.status, stop: o.stop_price, limite: o.limit_price, padre: o.parent_order_id ?? null, cid: o.client_order_id })) };
      });
      // 5) subir el stop de una pata
      if (g[0]) await paso('5. subir el stop de un grupo OCO (reemplazo de la pata stop)', async () => {
        const r = await leerReal(cliente);
        const pata = r.ordenes.find(o => (o.order_type ?? o.type) === 'stop' && o.symbol === simbolo && o.side === 'sell');
        if (!pata) throw new Error('no encontré la pata stop en el listado');
        const nuevo = r2(px * 0.9);
        const x = await cliente.reemplazarOrden(pata.id, { stop_price: nuevo });
        return { pedido: nuevo, respuesta: x?.stop_price, estado: x?.status };
      });
      // 6) ¿una compra con stop mientras hay salidas abiertas?
      await paso('6. compra con stop con salidas abiertas (informativo: el agente no lo hace)', async () => {
        const o = await cliente.enviarOrden({ symbol: simbolo, qty: '1', side: 'buy', type: 'stop', stop_price: r2(px * 1.06), time_in_force: 'day', client_order_id: `${cid}-6` });
        await cliente.cancelarOrden(o.id); return { estado: o.status };
      });
    }
  } finally {
    // Limpieza: cancelar todo lo de la sonda y cerrar
    await paso('limpieza: cancelar órdenes', async () => {
      const r = await leerReal(cliente);
      let n = 0;
      for (const o of r.ordenes.filter(x => x.symbol === simbolo && !x.parent_order_id)) { try { await cliente.cancelarOrden(o.id); n++; } catch { /* ya cancelada */ } }
      return { canceladas: n };
    });
    await paso('limpieza: cerrar posición', async () => {
      for (let i = 0; i < 8; i++) {
        await esperar(1500);
        const r = await leerReal(cliente);
        if (!r.posiciones.has(simbolo)) return { quedoLimpia: true };
        try { await cliente.cerrarPosicion(simbolo); } catch { /* se reintenta */ }
      }
      const r = await leerReal(cliente);
      if (r.posiciones.has(simbolo)) throw new Error(`QUEDÓ UNA POSICIÓN ABIERTA en ${simbolo}: ciérrala a mano en Alpaca`);
      return { quedoLimpia: true };
    });
  }
  return R;
}

async function sonda({ cliente, simbolo = 'F', salida, esperar = ms => new Promise(r => setTimeout(r, ms)), ahora = () => Date.now() }) {
  const R = await cuerpoSonda({ cliente, simbolo, esperar, ahora });
  R.fin = new Date(ahora()).toISOString();
  R.todoBien = R.pasos.every(p => p.ok);
  if (salida) { fs.mkdirSync(path.dirname(salida), { recursive: true }); fs.writeFileSync(salida, JSON.stringify(R, null, 1)); }
  return R;
}

if (require.main === module) {
  const cliente = crearCliente();
  sonda({ cliente, salida: path.join(__dirname, '..', 'datos', 'sonda.json') }).then(r => {
    for (const p of r.pasos) console.log(`${p.ok ? 'OK   ' : 'FALLA'} ${p.nombre}${p.error ? ' → ' + p.error : p.detalle ? ' · ' + JSON.stringify(p.detalle).slice(0, 240) : ''}`);
    console.log(r.todoBien ? '\nSONDA COMPLETA: todo bien' : '\nSONDA CON PROBLEMAS: revisa las líneas con FALLA');
    process.exit(0);
  }).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
module.exports = { sonda };
