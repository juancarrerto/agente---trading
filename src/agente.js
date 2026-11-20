// Agente de trading intradía (estrategia "compra clave" de Vélez y Capra), solo largos, en cuenta DEMO de Alpaca.
//   node src/agente.js [--ejecucion diario|pasada] [--config config/agente.json]
//
// Cada pasada (cada 15 minutos, de 9:45 a 16:00 hora de Nueva York) la "sombra" (Agentes 1 a 4) decide con las velas reales.
// Entre pasadas, el espejo vigila Alpaca cada pocos segundos para colocar los stops apenas se ejecuta una compra.
//   ejecucion diario : un solo proceso vigila todo el día (necesita minutos de GitHub Actions de sobra; es lo más fiel).
//   ejecucion pasada : una pasada por ejecución; solo sigue vigilando mientras haya algo abierto (para gastar menos minutos).
// modo (en config): "mirar" = hace todo menos enviar órdenes (solo escribe lo que haría) | "operar" = envía órdenes a la cuenta demo.
const fs = require('fs');
const path = require('path');
const { crearCliente } = require('./alpaca.js');
const { Datos, nyPartes } = require('./datos.js');
const { crearSombra } = require('./sombra.js');
const { leerReal, planificar, aplicar, esNuestra } = require('./espejo.js');
const { nyAUtc, MIN } = require('../nucleo/backtest/mercado_historico.js');

const CFG_BASE = {
  modo: 'mirar', ejecucion: 'diario', filtro: 'juego', gapMin: 0.01, rvolMin: 1.5,
  ventanas: [['09:35', '11:15']], primeraPasada: [9, 45], ultimaPasada: [16, 0], cierreSesion: '15:55',
  riesgo: {}, intervaloVigilanciaSeg: 20, retrasoPasadaSeg: 20, simbolos: []
};

function hhmm(ms) { const p = nyPartes(ms); return p.minutoDelDia; }
const minDe = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

async function ejecutar({ cliente, cfg: cfgUsuario, reloj, rutas, salida = console.log }) {
  const cfg = { ...CFG_BASE, ...cfgUsuario };
  if (!cliente?.esPaper) throw new Error('El cliente no es de la cuenta demo: no se continúa.');
  const bitacora = d => { const linea = JSON.stringify({ ts: new Date(reloj.ahora()).toISOString(), ...d }); fs.mkdirSync(path.dirname(rutas.bitacora), { recursive: true }); fs.appendFileSync(rutas.bitacora, linea + '\n'); };
  const decir = (t, d = {}) => { bitacora({ tipo: t, ...d }); salida(`[${new Date(reloj.ahora()).toISOString().slice(11, 19)}] ${t} ${Object.keys(d).length ? JSON.stringify(d) : ''}`); };

  if (process.env.AGENTE_APAGADO === '1' || cfg.apagado === true) { decir('APAGADO', { motivo: 'interruptor de apagado activo (AGENTE_APAGADO o "apagado": true en la configuración)' }); return { terminado: 'apagado' }; }
  if (!cfg.simbolos.length) throw new Error('La configuración no trae lista de acciones.');

  // ----- ¿Hoy hay mercado?
  let ahora = reloj.ahora();
  const hoyNY = nyPartes(ahora).fecha;
  const cal = await cliente.calendario(hoyNY, hoyNY);
  if (!cal?.some(d => d.date === hoyNY)) { decir('SIN_MERCADO', { fecha: hoyNY }); return { terminado: 'sin_mercado' }; }
  const [yy, mm, dd] = hoyNY.split('-').map(Number);
  const aperturaMs = nyAUtc(yy, mm, dd, 9, 30);
  const cierreDuroMs = nyAUtc(yy, mm, dd, ...cfg.cierreSesion.split(':').map(Number));
  const fechaCorta = hoyNY.replace(/-/g, '');
  const cuenta = await cliente.cuenta();
  if (cuenta?.trading_blocked || cuenta?.account_blocked || (cuenta?.status && cuenta.status !== 'ACTIVE')) { decir('CUENTA_BLOQUEADA', { estado: cuenta.status }); return { terminado: 'cuenta_bloqueada' }; }
  decir('INICIO', { fecha: hoyNY, modo: cfg.modo, ejecucion: cfg.ejecucion, capitalDemo: cuenta?.equity, simbolos: cfg.simbolos.length });

  // ----- Estado guardado
  let estado = { version: 1, almacen: {}, fechaCandidatos: null, candidatos: [], ultimaPasadaMs: 0, espejo: { enviados: {}, salidas: {}, ajustes: {} } };
  try { estado = { ...estado, ...JSON.parse(fs.readFileSync(rutas.estado, 'utf8')) }; } catch { /* primera vez */ }
  estado.espejo ||= { enviados: {}, salidas: {}, ajustes: {} };
  for (const reg of [estado.espejo.enviados, estado.espejo.salidas, estado.espejo.vistos ?? {}]) for (const k of Object.keys(reg)) if (k.split(':')[0] < nyPartes(ahora - 6 * 86400000).fecha.replace(/-/g, '')) delete reg[k];
  const guardar = () => { fs.mkdirSync(path.dirname(rutas.estado), { recursive: true }); fs.writeFileSync(rutas.estado + '.tmp', JSON.stringify(estado)); fs.renameSync(rutas.estado + '.tmp', rutas.estado); };

  const sombra = crearSombra({ simbolos: cfg.simbolos, ventanas: cfg.ventanas, cierreSesion: cfg.cierreSesion, riesgo: cfg.riesgo });
  sombra.fijarAlmacen(estado.almacen);
  const datos = new Datos({ cliente, dirTrabajo: rutas.trabajo });
  await datos.cargarCalendario(ahora);
  const cargadas = new Set();                                          // acciones cuyo historial ya se bajó en esta ejecución

  const abiertasSombra = () => { const e = sombra.estado().estado ?? {}; return [...new Set([...(e.posiciones ?? []), ...(e.ordenesPendientes ?? [])].map(x => x.simbolo))]; };
  const enVentana = t => { const m = hhmm(t); return cfg.ventanas.some(([i, f]) => m >= minDe(i) && m < minDe(f)); };
  const ranuras = [];
  for (let m = cfg.primeraPasada[0] * 60 + cfg.primeraPasada[1]; m <= cfg.ultimaPasada[0] * 60 + cfg.ultimaPasada[1]; m += 15) ranuras.push(nyAUtc(yy, mm, dd, 0, 0) + m * MIN);

  async function asegurarDatos(simbolos, t) {
    const faltan = simbolos.filter(s => !cargadas.has(s));
    if (faltan.length) { await datos.cargar(faltan, t); faltan.forEach(s => cargadas.add(s)); }
    const ya = simbolos.filter(s => !faltan.includes(s));
    if (ya.length) await datos.actualizar(ya, t);
  }

  async function calcularCandidatos(t) {
    await asegurarDatos(cfg.simbolos, t);
    const m = datos.mercado(cfg.simbolos, t);
    const lista = [];
    for (const s of m.simbolos) {
      if (!m.sesionesDe(s).includes(hoyNY)) continue;
      if (cfg.filtro === 'todos') { lista.push(s); continue; }
      const j = m.enJuego(s, hoyNY);
      if (j && j.rvol !== null && j.gap >= cfg.gapMin && j.rvol >= cfg.rvolMin) lista.push(s);
    }
    estado.fechaCandidatos = hoyNY; estado.candidatos = lista;
    decir('CANDIDATAS', { fecha: hoyNY, acciones: lista, conDatos: m.simbolos.length });
  }

  let ultimosEventos = [];
  async function pasada(t) {
    let mercado;
    for (let intento = 1; ; intento++) {                       // bajar datos puede fallar por la red: se reintenta antes de dar la pasada por perdida
      try {
        if (estado.fechaCandidatos !== hoyNY) await calcularCandidatos(t);
        const activos = [...new Set([...estado.candidatos, ...abiertasSombra()])];
        await asegurarDatos(activos, t);
        mercado = datos.mercado(activos, t);
        break;
      } catch (e) { if (intento >= 3) throw e; decir('REINTENTO_DATOS', { intento, error: e.message }); await reloj.dormir(5000); }
    }
    const r = sombra.pasada(t, { mercado, candidatos: estado.candidatos, enVentana: enVentana(t) });
    estado.almacen = sombra.estado();
    estado.ultimaPasadaMs = t;
    ultimosEventos = r.eventos;
    const est = estado.almacen.estado ?? {};
    decir('PASADA', { slot: new Date(t).toISOString(), hora_NY: nyPartes(t).texto.slice(11, 16), pares: r.pares, omitida: r.omitida, veredictos: r.veredictos, ordenes: r.ordenes.map(o => ({ s: o.simbolo, tipo: o.tipo, entrada: o.entrada, stop: o.stop, objetivo: o.objetivo, unidades: o.unidades })),
      eventosSombra: r.eventos.map(e => `${e.tipo} ${e.simbolo ?? ''}${e.precio !== undefined ? ' @' + e.precio : ''}${e.pnlUSD !== undefined ? ' (' + e.pnlUSD + ' USD)' : ''}`), errores: r.errores, capitalSombra: est.capital });
    for (const f of r.trades) decir('OPERACION_SOMBRA', { id: f.id, simbolo: f.simbolo, plazo: f.plazo, apertura: f.apertura, cierre: f.cierre, entrada: f.entrada, stopInicial: f.stopInicial, salida: f.salidaFinal, motivo: f.motivoSalida, R: f.R, pnlUSD: f.pnlUSD, unidades: f.unidades });
    guardar();
  }

  async function sincronizar() {
    let real;
    try { real = await leerReal(cliente); } catch (e) { decir('ERROR_LECTURA', { error: e.message }); return null; }
    const est = sombra.estado().estado ?? {};
    const acciones = planificar({ sombra: { pendientes: est.ordenesPendientes ?? [], posiciones: est.posiciones ?? [] }, real, registro: estado.espejo, fecha: fechaCorta, eventosPasada: ultimosEventos, ahoraMs: reloj.ahora() });
    if (acciones.length) await aplicar({ cliente, acciones, registro: estado.espejo, fecha: fechaCorta, modo: cfg.modo, esperar: ms => reloj.dormir(ms), bitacora: ({ tipo, ...resto }) => decir(tipo, resto), ahoraMs: reloj.ahora() });
    if (acciones.length && cfg.modo === 'operar') guardar();
    ultimosEventos = [];
    return { real, acciones };
  }

  async function cierreDuro() {
    decir('CIERRE_DE_SESION', { motivo: 'hora de cierre del agente: se cancelan órdenes y se cierran posiciones' });
    if (cfg.modo !== 'operar') return;
    const { ordenes, posiciones } = await leerReal(cliente);
    for (const o of ordenes.filter(x => esNuestra(x) && !x.parent_order_id)) { try { await cliente.cancelarOrden(o.id); } catch { /* ya cancelada */ } }
    await reloj.dormir(1500);
    for (const s of posiciones.keys()) { try { await cliente.cerrarPosicion(s); decir('POSICION_CERRADA', { simbolo: s, motivo: 'cierre de sesión' }); } catch (e) { decir('ERROR_ORDEN', { simbolo: s, rol: 'cierre de sesión', error: e.message }); } }
  }

  const hayAlgo = real => {
    const est = sombra.estado().estado ?? {};
    if ((est.ordenesPendientes ?? []).length || (est.posiciones ?? []).length) return true;
    if (!real) return true;                                      // sin lectura de Alpaca no se puede asegurar que esté todo quieto
    return real.posiciones.size > 0 || real.ordenes.some(esNuestra);
  };
  const finVentanas = Math.max(...cfg.ventanas.map(([, f]) => minDe(f)));

  // ----- Bucle principal
  const retraso = cfg.retrasoPasadaSeg * 1000;
  let terminado = null, primeraVuelta = true, inicioMs = reloj.ahora();
  while (!terminado) {
    ahora = reloj.ahora();
    const debidas = ranuras.filter(t => t + retraso <= ahora && t > estado.ultimaPasadaMs && t > aperturaMs);
    if (primeraVuelta && cfg.ejecucion === 'pasada' && debidas.length > 1) debidas.splice(0, debidas.length - 1);   // en modo "pasada" solo la más reciente
    for (const t of debidas.slice(-12)) {
      if (t < ahora - 90 * MIN && !debidas.every(x => x <= t)) { /* pasadas viejas se repiten igual: la sombra es determinista */ }
      try { await pasada(t); } catch (e) { decir('ERROR_PASADA', { slot: new Date(t).toISOString(), error: e.message, pila: String(e.stack).split('\n').slice(0, 3).join(' | ') }); estado.ultimaPasadaMs = t; }
    }
    primeraVuelta = false;
    const sync = await sincronizar();
    ahora = reloj.ahora();
    if (ahora >= cierreDuroMs) { await cierreDuro(); terminado = 'cierre'; break; }
    const ultima = ranuras[ranuras.length - 1];
    const siguiente = ranuras.find(t => t + retraso > ahora);
    const activo = hayAlgo(sync?.real);
    if (cfg.ejecucion === 'diario') {
      if (!activo && (!siguiente || hhmm(ahora) >= finVentanas)) { terminado = 'sin_nada_que_vigilar'; break; }      // pasada la ventana de entradas y sin nada abierto, no queda nada por hacer hoy
    } else {                                                    // "pasada": se sale cuando no hay nada que vigilar o llega la siguiente pasada
      if (!activo) { terminado = 'quieto'; break; }
      if (siguiente && ahora >= siguiente - 30000) { terminado = 'siguiente_pasada'; break; }
      if (!siguiente && ahora >= ultima + 20 * MIN) { terminado = 'fin_del_dia'; break; }
    }
    await reloj.dormir(cfg.intervaloVigilanciaSeg * 1000);
  }

  // ----- Cierre de la ejecución: resumen con lo que pasó de verdad en Alpaca
  try {
    const desde = new Date(aperturaMs - 60 * MIN).toISOString();
    const ord = await cliente.ordenesDesde(desde);
    const flat = [];
    for (const o of ord ?? []) { flat.push(o); for (const l of o.legs ?? []) flat.push({ ...l, _padre: o }); }
    const resumen = flat.filter(o => (o._padre?.client_order_id ?? o.client_order_id ?? '').startsWith('ag-') && Number(o.filled_qty) > 0)
      .map(o => ({ simbolo: o.symbol, lado: o.side, tipo: o.order_type ?? o.type, qty: Number(o.filled_qty), precioPromedio: Number(o.filled_avg_price), hora: o.filled_at, cid: o._padre?.client_order_id ?? o.client_order_id }));
    decir('ORDENES_EJECUTADAS_HOY', { n: resumen.length, ordenes: resumen });
    const c2 = await cliente.cuenta();
    decir('FIN', { motivo: terminado, capitalDemo: c2?.equity, minutos: Math.round((reloj.ahora() - inicioMs) / 60000) });
  } catch (e) { decir('FIN', { motivo: terminado, avisoResumen: e.message }); }
  guardar();
  return { terminado };
}

// ----- Ejecución desde la línea de comandos
if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const raiz = path.join(__dirname, '..');
  const cfg = JSON.parse(fs.readFileSync(path.resolve(raiz, arg('--config', 'config/agente.json')), 'utf8'));
  if (arg('--ejecucion')) cfg.ejecucion = arg('--ejecucion');
  const reloj = { ahora: () => Date.now(), dormir: ms => new Promise(r => setTimeout(r, ms)) };
  const rutas = { estado: path.join(raiz, 'datos', 'estado.json'), bitacora: path.join(raiz, 'datos', 'bitacora.jsonl'), trabajo: path.join(require('os').tmpdir(), 'agente-velas') };
  let cliente;
  try { cliente = crearCliente(); } catch (e) { console.error(e.message); process.exit(2); }
  ejecutar({ cliente, cfg, reloj, rutas }).then(r => { console.log('Terminado:', r.terminado); process.exit(0); }).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
module.exports = { ejecutar, CFG_BASE };
