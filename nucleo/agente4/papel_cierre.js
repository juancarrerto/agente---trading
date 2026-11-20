// ================================================================
// Agente 4 · Motor de paper trading (simula las operaciones, no usa dinero ni broker)
// Recibe las órdenes aprobadas por el Agente 3 y las velas nuevas, y gestiona las posiciones:
// entrada, stop, venta de la mitad, stop a equilibrio, objetivo y salida por tiempo.
// No guarda nada por sí mismo: el estado ENTRA y SALE en cada llamada (campo "estado").
// Quien lo llame (el orquestador) es quien lo guarda entre una llamada y la siguiente.
// (libro) = regla del libro "Day trading" (Vélez y Capra), con página.
// (mío)   = supuesto de simulación que debes calibrar.
//
// ENTRADA (un solo item):
//   estado       el estado devuelto por la llamada anterior (si falta, cuenta nueva)
//   ordenes      lista de "orden" aprobadas por el Agente 3 (o "orden" suelta)
//   velas        { "EUR/USD": [ {time, open, high, low, close}, ... ] }  (velas de 5 min)
//                o bien la salida del Agente 1 (ticker + candles5m)
//   ahora        fecha ISO (por defecto, ahora mismo)
//   cuenta       { capital } solo si no hay estado
//   revisionHecha  true si ya revisaste el diario (reinicia el contador de pérdidas)
//   parametros   cualquier parámetro de abajo
// ================================================================

const entrada = $input.first().json ?? {};

// ---------- PARÁMETROS: puedes editarlos aquí ----------
const PARAMETROS = {
  capitalPorDefecto: 10000,                // (mío) cuenta de prueba en dólares
  barraDatosMin: 5,                        // (mío) minutos de cada vela con que se gestionan las posiciones
  minutosPorPlazo: { '5min': 5, '15min': 15, '1h': 60, '1day': 1440 },
  neutralR: 0.05,                          // (mío) una operación entre -0,05 R y +0,05 R no cuenta como racha
  cierreSesion: null,                      // (mío) 'HH:MM' en zonaCierre: a esa hora se cancelan las órdenes pendientes y se cierra todo a mercado. null = apagado (no se cierra nada por hora)
  zonaCierre: 'America/New_York',          // (mío) zona de cierreSesion
  zonaDia: 'UTC',                          // (mío) zona que define cuándo empieza el día para los contadores diarios
  friccionPct: { forex: 0.006, cripto: 0.2, otros: 0.02 },   // (mío) costo de ida y vuelta, % del valor de la posición
  maxFilasDiario: 200
};

// Reglas de la simulación (todas pesimistas, para no ser optimista por accidente):
//  - Solo se usan velas CERRADAS. La vela en curso se procesa cuando cierre.
//  - Si en una misma vela el precio toca el stop y también un nivel a favor, se asume que tocó el stop primero.
//  - Si una vela abre más allá del stop, la salida es al precio de apertura (hueco), no al stop.
//  - Tras vender la mitad y subir el stop a equilibrio, si esa misma vela vuelve al precio de entrada, se asume que salió ahí.
//  - Una orden a mercado entra al precio de referencia; una orden pendiente entra al precio de la orden (o a la apertura si hay hueco).
//  - La posición se gestiona desde la primera vela que abre después de la entrada.

// ---------- Utilidades ----------
const CRIPTO = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'LTC', 'BNB', 'ADA', 'DOGE']);
const redondear = (x, d = 8) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const esNumero = x => typeof x === 'number' && Number.isFinite(x);
const num = (x, def) => (x !== null && x !== '' && x !== undefined && Number.isFinite(Number(x)) ? Number(x) : def);
const arreglo = x => (Array.isArray(x) ? x : []);
const iso = ms => new Date(ms).toISOString();
const mayus = s => String(s ?? '').toUpperCase();

function partesDelPar(simbolo) {
  const m = /^([A-Z]{3,5})\/([A-Z]{3,5})$/.exec(mayus(simbolo));
  return m ? { base: m[1], cotizada: m[2] } : null;
}
const claseActivo = s => { const p = partesDelPar(s); return p ? (CRIPTO.has(p.base) ? 'cripto' : 'forex') : 'otros'; };
const pasoUnidades = s => (claseActivo(s) === 'cripto' ? 1e-4 : 1);

// ---------- Preparación ----------
const P = { ...PARAMETROS, ...(entrada.parametros ?? {}), friccionPct: { ...PARAMETROS.friccionPct, ...(entrada.parametros?.friccionPct ?? {}) } };
const ahora = entrada.ahora ? new Date(entrada.ahora) : new Date();
if (Number.isNaN(ahora.getTime())) throw new Error('El campo "ahora" no es una fecha válida.');
const ahoraMs = ahora.getTime();
const barraMs = P.barraDatosMin * 60000;

// Cierre de sesión (opcional): hora local de una vela y minuto del día en que se cierra todo
let cierreMin = null, horaLocal = null;
if (P.cierreSesion) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(P.cierreSesion));
  if (!m) throw new Error(`cierreSesion no válido: ${P.cierreSesion} (use HH:MM)`);
  cierreMin = +m[1] * 60 + +m[2];
  let f;
  try { f = new Intl.DateTimeFormat('en-GB', { timeZone: P.zonaCierre, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); f.format(ahora); }
  catch (e) { throw new Error(`Zona horaria no válida: ${P.zonaCierre}`); }
  horaLocal = ms => { const q = {}; for (const x of f.formatToParts(new Date(ms))) q[x.type] = x.value; return { dia: `${q.year}-${q.month}-${q.day}`, min: +q.hour * 60 + +q.minute }; };
}

const E0 = JSON.parse(JSON.stringify(entrada.estado ?? {}));
const E = {
  capital: num(E0.capital, num(entrada.cuenta?.capital, P.capitalPorDefecto)),
  posiciones: arreglo(E0.posiciones),
  ordenesPendientes: arreglo(E0.ordenesPendientes),
  ultimaVela: E0.ultimaVela && typeof E0.ultimaVela === 'object' ? E0.ultimaVela : {},
  dia: E0.dia ?? null,
  operacionesHoy: num(E0.operacionesHoy, 0), pnlHoyR: num(E0.pnlHoyR, 0), maxPnlHoyR: num(E0.maxPnlHoyR, 0),
  gananciasSeguidas: num(E0.gananciasSeguidas, 0), perdidasSeguidas: num(E0.perdidasSeguidas, 0),
  rachaGanadoraPrevia: num(E0.rachaGanadoraPrevia, 0), perdidasDesdeRevision: num(E0.perdidasDesdeRevision, 0),
  siguienteId: num(E0.siguienteId, 1),
  diario: arreglo(E0.diario)
};
if (!(E.capital > 0)) throw new Error('El capital debe ser mayor que cero.');

let formatoDia;
try {
  formatoDia = new Intl.DateTimeFormat('en-CA', { timeZone: P.zonaDia, year: 'numeric', month: '2-digit', day: '2-digit' });
  formatoDia.format(ahora);
} catch (e) { throw new Error(`Zona horaria no válida: ${P.zonaDia}`); }
const diaDe = ms => formatoDia.format(new Date(ms));
// Día nuevo: se reinician los contadores diarios (las rachas siguen).
// El día de cada hecho es el de su vela, no el de la llamada: así partir las velas en varias llamadas da lo mismo.
function avanzarDia(ms) {
  const k = diaDe(ms);
  if (k > E.dia) { E.dia = k; E.operacionesHoy = 0; E.pnlHoyR = 0; E.maxPnlHoyR = 0; }
}
if (E.dia === null) E.dia = diaDe(ahoraMs);
if (entrada.revisionHecha === true) E.perdidasDesdeRevision = 0;

const eventos = [], diarioNuevo = [], avisos = [];

// Velas por símbolo: solo cerradas, ordenadas, sin datos inválidos
function limpiar(v) {
  return arreglo(v).map(c => ({ ...c, t: Date.parse(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
    .filter(c => Number.isFinite(c.t) && [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.high >= c.low)
    .sort((a, b) => a.t - b.t);
}
const velasPorSimbolo = {};
if (entrada.velas && typeof entrada.velas === 'object') for (const [s, v] of Object.entries(entrada.velas)) velasPorSimbolo[mayus(s)] = limpiar(v);
if (entrada.ticker && Array.isArray(entrada.candles5m) && !velasPorSimbolo[mayus(entrada.ticker)]) velasPorSimbolo[mayus(entrada.ticker)] = limpiar(entrada.candles5m);

// ---------- Contabilidad ----------
function pnlBruto(pos, precio, unidades) {
  const par = partesDelPar(pos.simbolo);
  const dif = precio - pos.entrada;                                  // solo posiciones largas
  return par && par.base === 'USD' ? (dif * unidades) / precio : dif * unidades;
}
function friccion(pos, unidades) {
  const par = partesDelPar(pos.simbolo);
  const valor = par && par.base === 'USD' ? unidades : unidades * pos.entrada;
  return valor * (P.friccionPct[claseActivo(pos.simbolo)] ?? P.friccionPct.otros) / 100;
}

function cerrarParte(pos, precio, unidades, tipo, tms) {
  const costo = friccion(pos, unidades);
  const pnl = pnlBruto(pos, precio, unidades) - costo;
  pos.realizadoUSD = pos.realizadoUSD + pnl;
  pos.unidadesRestantes = redondear(pos.unidadesRestantes - unidades, 6);
  E.capital = redondear(E.capital + pnl, 6);
  eventos.push({ tipo, id: pos.id, simbolo: pos.simbolo, tiempo: iso(tms), precio: redondear(precio), unidades: redondear(unidades, 6),
    pnlUSD: redondear(pnl, 6), costoUSD: redondear(costo, 6) });
}

function cerrarTodo(pos, precio, tipo, tms) {
  cerrarParte(pos, precio, pos.unidadesRestantes, tipo, tms);
  avanzarDia(tms);
  const R = pos.riesgoDinero > 0 ? pos.realizadoUSD / pos.riesgoDinero : 0;
  E.pnlHoyR += R; E.maxPnlHoyR = Math.max(E.maxPnlHoyR, E.pnlHoyR);
  if (R > P.neutralR) {
    E.gananciasSeguidas += 1; E.perdidasSeguidas = 0; E.rachaGanadoraPrevia = 0;
  } else if (R < -P.neutralR) {
    if (E.perdidasSeguidas === 0) E.rachaGanadoraPrevia = E.gananciasSeguidas;
    E.gananciasSeguidas = 0; E.perdidasSeguidas += 1; E.perdidasDesdeRevision += 1;
  }
  const fila = {
    id: pos.id, simbolo: pos.simbolo, plazo: pos.plazo, lado: 'COMPRA', regla: pos.regla,
    apertura: pos.abiertaEn, cierre: iso(tms), duracionMin: Math.round((tms - Date.parse(pos.abiertaEn)) / 60000),
    entrada: pos.entrada, stopInicial: pos.stopInicial, objetivo: pos.objetivo, salidaFinal: redondear(precio),
    unidades: pos.unidades, motivoSalida: tipo, pnlUSD: redondear(pos.realizadoUSD, 4), R: redondear(R, 3),
    cumpleReglas: true                       // el motor solo ejecuta lo que el Agente 3 aprobó (libro, p. 173)
  };
  diarioNuevo.push(fila);
  E.diario.push(fila);
  if (E.diario.length > P.maxFilasDiario) E.diario.splice(0, E.diario.length - P.maxFilasDiario);
  E.posiciones = E.posiciones.filter(p => p.id !== pos.id);
}

// ---------- Gestión de una vela cerrada ----------
function unidadesParciales(pos) {
  const paso = pasoUnidades(pos.simbolo), f = pos.ventaParcial?.fraccion ?? 0;
  const u = Math.floor((pos.unidades * f) / paso + 1e-9) * paso;
  return u >= paso && u < pos.unidadesRestantes ? redondear(u, 4) : 0;
}

function gestionarBarra(pos, b) {
  pos.ultimaBarraGestionada = b.t;
  // 1. Stop (el stop solo sube, nunca se aleja: libro, pp. 157, 179)
  if (b.low <= pos.stop) {
    return cerrarTodo(pos, Math.min(pos.stop, b.open), pos.stopEnEquilibrio ? 'STOP_EQUILIBRIO' : 'STOP', b.t);
  }
  // 2. Venta de la mitad y stop a equilibrio (libro, pp. 431-433, 438-441)
  const nivel = pos.ventaParcial?.en ?? pos.nivelEquilibrio;
  if (!pos.parcialHecha && esNumero(nivel) && b.high >= nivel) {
    pos.parcialHecha = true;
    const vender = unidadesParciales(pos);
    if (vender > 0) cerrarParte(pos, Math.max(nivel, b.open), vender, 'PARCIAL', b.t);
    if (pos.entrada > pos.stop) {
      pos.stop = pos.entrada; pos.stopEnEquilibrio = true;
      eventos.push({ tipo: 'STOP_A_EQUILIBRIO', id: pos.id, simbolo: pos.simbolo, tiempo: iso(b.t), precio: redondear(pos.stop) });
    }
    if (b.low <= pos.stop) return cerrarTodo(pos, pos.stop, 'STOP_EQUILIBRIO', b.t);
  }
  // 3. Objetivo
  if (b.high >= pos.objetivo) return cerrarTodo(pos, Math.max(pos.objetivo, b.open), 'OBJETIVO', b.t);
  // 4. Salida por tiempo (libro, p. 436)
  const plazoMs = (P.minutosPorPlazo[pos.plazo] ?? P.barraDatosMin) * 60000;
  if (pos.timeStopBarras && (b.t + barraMs) - Date.parse(pos.abiertaEn) >= pos.timeStopBarras * plazoMs) {
    return cerrarTodo(pos, b.close, 'TIEMPO', b.t + barraMs);
  }
  // 5. Cierre de sesión (opcional): la vela que termina a la hora de cierre o después se cierra a su precio de cierre
  if (cierreMin !== null) {
    const h = horaLocal(b.t + barraMs);
    if (h.min >= cierreMin) return cerrarTodo(pos, b.close, 'CIERRE_SESION', b.t + barraMs);
  }
}

function abrirPosicion(o, precio, tms, detalle) {
  const pos = {
    id: `T${E.siguienteId++}`, simbolo: mayus(o.simbolo), plazo: o.plazo ?? null, lado: 'COMPRA',
    unidades: o.unidades, unidadesRestantes: o.unidades,
    entrada: redondear(precio), entradaPlan: o.entrada, stop: o.stop, stopInicial: o.stop, objetivo: o.objetivo,
    ventaParcial: o.gestion?.ventaParcial ?? null, nivelEquilibrio: o.gestion?.stopAEquilibrio?.cuando ?? null,
    parcialHecha: false, stopEnEquilibrio: false, timeStopBarras: o.gestion?.timeStopBarras ?? null,
    abiertaEn: iso(tms), regla: o.regla ?? null, metodoStop: o.metodoStop ?? null,
    riesgoDinero: o.riesgoDinero, realizadoUSD: 0, ultimaBarraGestionada: null
  };
  E.posiciones.push(pos);
  avanzarDia(tms);
  E.operacionesHoy += 1;
  eventos.push({ tipo: 'ENTRADA', id: pos.id, simbolo: pos.simbolo, tiempo: iso(tms), precio: pos.entrada, unidades: pos.unidades, detalle });
  return pos;
}

// ---------- 1) Velas cerradas desde la última llamada (en orden cronológico entre todos los símbolos) ----------
const trabajo = [];
for (const [sim, velas] of Object.entries(velasPorSimbolo)) {
  const ult = E.ultimaVela[sim] ? Date.parse(E.ultimaVela[sim]) : -Infinity;
  const nuevas = velas.filter(b => b.t > ult && b.t + barraMs <= ahoraMs);
  for (const b of nuevas) trabajo.push({ sim, b });
  if (nuevas.length) E.ultimaVela[sim] = iso(nuevas.at(-1).t);
}
trabajo.sort((x, y) => x.b.t - y.b.t || (x.sim < y.sim ? -1 : 1));
for (const { sim, b } of trabajo) {
  if (cierreMin !== null) {
    const h = horaLocal(b.t + barraMs);
    // Orden pendiente de otro día, o en una vela que ya llega a la hora de cierre: se cancela sin activarse
    for (const ord of E.ordenesPendientes.filter(o => o.simbolo === sim)) {
      if (h.dia > horaLocal(Date.parse(ord.creadaEn)).dia || h.min >= cierreMin) {
        E.ordenesPendientes = E.ordenesPendientes.filter(o => o.id !== ord.id);
        eventos.push({ tipo: 'ORDEN_VENCIDA', id: ord.id, simbolo: sim, tiempo: iso(b.t), detalle: 'cancelada por cierre de sesión' });
      }
    }
    // Posición que quedó abierta de un día para otro (p. ej. medio día de bolsa sin velas hasta la hora de cierre): sale a la apertura
    for (const pos of [...E.posiciones.filter(p => p.simbolo === sim)]) {
      if (h.dia > horaLocal(Date.parse(pos.abiertaEn)).dia && !(pos.ultimaBarraGestionada >= b.t)) { pos.ultimaBarraGestionada = b.t; cerrarTodo(pos, b.open, 'CIERRE_SESION', b.t); }
    }
  }
  for (const ord of E.ordenesPendientes.filter(o => o.simbolo === sim)) {
    if (b.t >= Date.parse(ord.venceEn)) {
      E.ordenesPendientes = E.ordenesPendientes.filter(o => o.id !== ord.id);
      eventos.push({ tipo: 'ORDEN_VENCIDA', id: ord.id, simbolo: sim, tiempo: iso(b.t), detalle: 'no se activó a tiempo' });
    } else if (b.t >= Date.parse(ord.creadaEn) && b.high >= ord.entrada) {
      E.ordenesPendientes = E.ordenesPendientes.filter(o => o.id !== ord.id);
      const pos = abrirPosicion(ord, Math.max(ord.entrada, b.open), b.t, 'orden stop activada');
      gestionarBarra(pos, b);
    }
  }
  for (const pos of [...E.posiciones.filter(p => p.simbolo === sim)]) {
    if (b.t >= Date.parse(pos.abiertaEn) && !(pos.ultimaBarraGestionada >= b.t)) gestionarBarra(pos, b);
  }
}
for (const s of new Set([...E.posiciones, ...E.ordenesPendientes].map(x => x.simbolo))) {
  if (!velasPorSimbolo[s]) avisos.push(`No llegaron velas de ${s}: su posición u orden no se gestionó en esta llamada.`);
}

// ---------- 2) Órdenes nuevas del Agente 3 ----------
const nuevasOrdenes = [...arreglo(entrada.ordenes), ...(entrada.orden ? [entrada.orden] : [])];
for (const o of nuevasOrdenes) {
  const sim = mayus(o?.simbolo);
  const rechazar = detalle => eventos.push({ tipo: 'ORDEN_RECHAZADA', simbolo: sim || null, tiempo: iso(ahoraMs), detalle });
  const faltan = ['entrada', 'stop', 'objetivo', 'unidades', 'riesgoDinero'].filter(k => !esNumero(o?.[k]));
  if (!sim || faltan.length) { rechazar(`orden incompleta (falta: ${faltan.join(', ') || 'símbolo'})`); continue; }
  if (!(o.stop > 0 && o.stop < o.entrada && o.entrada < o.objetivo && o.unidades > 0)) { rechazar('orden con precios o unidades sin sentido'); continue; }
  if ([...E.posiciones, ...E.ordenesPendientes].some(x => x.simbolo === sim)) { rechazar('ya hay una posición u orden en este símbolo (no se promedia)'); continue; }
  if (o.tipo === 'MERCADO') {
    const precio = esNumero(o.precioReferencia) ? o.precioReferencia : o.entrada;
    if (precio <= o.stop) { rechazar('el precio actual ya está por debajo del stop'); continue; }
    abrirPosicion(o, precio, ahoraMs, 'a mercado');
  } else if (o.tipo === 'STOP_PENDIENTE') {
    const plazoMs = (P.minutosPorPlazo[o.plazo] ?? P.barraDatosMin) * 60000;
    const id = `T${E.siguienteId++}`;
    E.ordenesPendientes.push({ ...o, id, simbolo: sim, creadaEn: iso(ahoraMs), venceEn: iso(ahoraMs + (o.venceEnBarras ?? 3) * plazoMs) });
    eventos.push({ tipo: 'ORDEN_PENDIENTE', id, simbolo: sim, tiempo: iso(ahoraMs), precio: o.entrada, unidades: o.unidades, detalle: 'espera a que el precio supere la entrada' });
  } else {
    rechazar(`tipo de orden desconocido (${o.tipo})`);
  }
}

// ---------- Salida ----------
avanzarDia(ahoraMs);
E.capital = redondear(E.capital, 6);
const ultimoPrecio = s => velasPorSimbolo[s]?.at(-1)?.close ?? null;
const abiertas = E.posiciones.map(p => {
  const px = ultimoPrecio(p.simbolo);
  return { id: p.id, simbolo: p.simbolo, entrada: p.entrada, stop: p.stop, objetivo: p.objetivo, unidadesRestantes: p.unidadesRestantes,
    parcialHecha: p.parcialHecha, stopEnEquilibrio: p.stopEnEquilibrio, abiertaEn: p.abiertaEn,
    pnlNoRealizadoUSD: px === null ? null : redondear(pnlBruto(p, px, p.unidadesRestantes), 4) };
});
const pendientes = E.ordenesPendientes.map(o => ({ id: o.id, simbolo: o.simbolo, entrada: o.entrada, venceEn: o.venceEn }));

const lineas = eventos.map(e => `${e.tipo} ${e.simbolo ?? ''}${e.precio !== undefined ? ' @' + e.precio : ''}${e.pnlUSD !== undefined ? ` (${e.pnlUSD >= 0 ? '+' : ''}${e.pnlUSD} USD)` : ''}${e.tipo === 'ORDEN_RECHAZADA' ? ': ' + e.detalle : ''}`);
const resumen = `${eventos.length ? lineas.join(' · ') : 'Sin eventos.'} | capital ${E.capital} USD | abiertas ${abiertas.length} | pendientes ${pendientes.length} | día: ${E.operacionesHoy} entradas, ${redondear(E.pnlHoyR, 2)} R`;

return [{ json: { ok: true, generadoEn: iso(ahoraMs), resumen, eventos, diarioNuevo, abiertas, pendientes, avisos, estado: E } }];
