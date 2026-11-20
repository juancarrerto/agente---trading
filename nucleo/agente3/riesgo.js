// ================================================================
// Agente 3 · Riesgo y conducta
// Recibe la señal del Agente 2 y decide si se convierte en orden y de qué tamaño.
// No ejecuta nada. No guarda estado: el estado del día lo lleva el Agente 4 y se lo pasa.
// (libro) = regla o cifra del libro "Day trading" (Vélez y Capra), con página.
// (mío)   = valor de partida para calibrar con historial; el libro no lo fija.
//
// ENTRADA (un solo item): la salida del Agente 2 más estos campos opcionales:
//   edadUltimaVelaMin  minutos de antigüedad de la última vela (viene del Agente 1)
//   cuenta             { capital }  (por defecto, la cuenta de prueba)
//   estado             lo que lleva el Agente 4 (ver ESTADO_VACIO)
//   parametros         cualquier parámetro de abajo para sobrescribirlo
//   ahora              fecha ISO (solo para pruebas)
// ================================================================

const entrada = $input.first().json ?? {};

// ---------- PARÁMETROS: puedes editarlos aquí ----------
const PARAMETROS = {
  capitalPorDefecto: 10000,               // (mío) cuenta de prueba en dólares
  riesgoPorOperacionPct: 0.5,             // (mío) % del capital que se arriesga en cada operación
  nocionalMaxSobreCapital: 10,            // (mío) valor de la posición / capital, tope contra stops muy cortos

  // Límites del día
  maxOperacionesDia: 4,                   // (libro, ejemplo de 4 operaciones al día, p. 170)
  maxOperacionesDiaTrasRacha: 2,          // (libro, ejemplo de bajar de 4 a 2, p. 170)
  perdidaDiariaMaxR: 3,                   // (mío) se para el día al perder 3 veces el riesgo inicial
  protegerGananciaDesdeR: 2,              // (mío) desde esta ganancia del día se vigila que no se devuelva
  fraccionDevueltaMax: 0.5,               // (mío) se para si se devuelve esta fracción del máximo del día (libro, p. 202)

  // Posiciones
  maxPosicionesAbiertas: 3,               // (mío) incluye órdenes pendientes
  maxPosicionesPorSimbolo: 1,             // (libro) no promediar a la baja ni añadir (pp. 91, 104, 246)
  maxPosicionesPorDivisa: 2,              // (mío) evita acumular la misma apuesta (p. ej. cinco pares contra el dólar)

  // Rachas (libro, pp. 170 y 203)
  gananciasParaReducir: 4,                // (libro) "tras 4 o 5 ganadoras seguidas"
  factorTrasRacha: 0.5,                   // (libro) reducir el lote a la mitad
  perdidasParaReducirFrecuencia: 2,       // (libro) 2 pérdidas seguidas tras una racha larga
  rachaLargaMin: 4,                       // (libro)

  // Diario (libro, pp. 124 y 193-195)
  perdidasParaRevisar: 5,                 // (libro) con 5 pérdidas hay que revisar el diario

  // Calidad de la señal y de los datos
  edadMaximaDatosMin: 15,                 // (mío) la última vela de 5 min no puede ser más vieja
  minConfluencias: 0,                     // (mío) 0 = no filtrar; el libro pide actuar sin esperar más confirmaciones (pp. 215-217)

  // Órdenes pendientes
  vencimientoOrdenBarras: 3,              // (mío) una orden armada que no se activa en N barras se cancela

  // Horario. El libro trabaja con la sesión de Nueva York y solo para acciones (pp. 223-224, 514-515).
  // modo: 'desactivado' | 'ny_libro' | 'personalizado'
  horario: {
    modo: 'desactivado',                  // (mío) hasta decidir con historial qué horas usar en divisas y cripto
    zona: 'America/New_York',
    ventanas: [['09:35', '11:15'], ['14:15', '16:00']],   // (libro, p. 515) menor riesgo
    dias: [1, 2, 3, 4, 5]                 // 1 = lunes ... 7 = domingo
  }
};

const ESTADO_VACIO = {
  operacionesHoy: 0,          // entradas ejecutadas hoy
  pnlHoyR: 0,                 // resultado del día en múltiplos del riesgo inicial (R)
  maxPnlHoyR: 0,              // el mayor resultado del día alcanzado hasta ahora
  gananciasSeguidas: 0,
  perdidasSeguidas: 0,
  rachaGanadoraPrevia: 0,     // ganadoras seguidas que había antes de la racha perdedora actual
  perdidasDesdeRevision: 0,   // pérdidas desde la última revisión del diario
  posiciones: [],             // [{ simbolo, lado }]
  ordenesPendientes: []       // [{ simbolo, lado }]
};

// ---------- Utilidades ----------
const CRIPTO = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'LTC', 'BNB', 'ADA', 'DOGE']);
const redondear = (x, d = 8) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const esNumero = x => typeof x === 'number' && Number.isFinite(x);
const aNumero = (x, porDefecto) => (esNumero(Number(x)) && x !== null && x !== '' ? Number(x) : porDefecto);

function partesDelPar(simbolo) {
  const m = /^([A-Z]{3,5})\/([A-Z]{3,5})$/.exec(String(simbolo ?? '').toUpperCase());
  return m ? { base: m[1], cotizada: m[2] } : null;
}
// Dólares que gana o pierde una unidad cuando el precio se mueve 1.0
function dolaresPorUnidadYPrecio(par, precio) {
  if (!par || par.cotizada === 'USD') return 1;      // acción o par cotizado en dólares
  if (par.base === 'USD') return 1 / precio;         // USD/JPY, USD/CAD...
  return null;                                       // par cruzado sin dólar
}
function valorPorUnidad(par, precio) {               // valor de una unidad en dólares
  if (par && par.base === 'USD') return 1;
  return precio;
}
function exposicion(simbolo, lado) {                 // compra EUR/USD = largo EUR, corto USD
  const par = partesDelPar(simbolo);
  if (!par) return {};
  const s = lado === 'VENTA' ? -1 : 1;
  return { [par.base]: s, [par.cotizada]: -s };
}

const DIAS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function enHorario(h, fecha) {
  if (h.modo === 'desactivado') return { ok: true, detalle: 'filtro horario desactivado' };
  const ventanas = h.modo === 'ny_libro' ? [['09:35', '11:15'], ['14:15', '16:00']] : h.ventanas;
  const zona = h.modo === 'ny_libro' ? 'America/New_York' : h.zona;
  const dias = h.modo === 'ny_libro' ? [1, 2, 3, 4, 5] : h.dias;
  if (!['ny_libro', 'personalizado'].includes(h.modo) || !Array.isArray(ventanas) || !Array.isArray(dias)) {
    return { ok: false, detalle: 'configuración de horario no válida: por seguridad no se opera' };
  }
  let partes;
  try {
    partes = new Intl.DateTimeFormat('en-US', { timeZone: zona, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(fecha);
  } catch (e) {
    return { ok: false, detalle: `zona horaria no válida (${zona}): por seguridad no se opera` };
  }
  const pick = t => partes.find(p => p.type === t)?.value;
  const dia = DIAS[pick('weekday')];
  const minutos = Number(pick('hour')) * 60 + Number(pick('minute'));
  const aMin = s => { const [hh, mm] = String(s).split(':').map(Number); return hh * 60 + mm; };
  const hora = `${pick('hour')}:${pick('minute')} (${zona})`;
  if (!dias.includes(dia)) return { ok: false, detalle: `fuera de los días permitidos (${hora})` };
  const dentro = ventanas.some(([a, b]) => minutos >= aMin(a) && minutos < aMin(b));
  return dentro
    ? { ok: true, detalle: `dentro de la ventana horaria (${hora})` }
    : { ok: false, detalle: `fuera de las ventanas de menor riesgo (${hora}; libro, pp. 223-224, 514-515)` };
}

// ---------- Preparación ----------
if (entrada.ok === false) {
  return [{ json: { ok: false, veredicto: 'SIN_DATOS', motivo: 'El Agente 2 no entregó una señal válida: no se opera.', errors: entrada.errors ?? [] } }];
}

const P = { ...PARAMETROS, ...(entrada.parametros ?? {}), horario: { ...PARAMETROS.horario, ...(entrada.parametros?.horario ?? {}) } };
const E = { ...ESTADO_VACIO, ...(entrada.estado ?? {}) };
for (const k of ['operacionesHoy', 'pnlHoyR', 'maxPnlHoyR', 'gananciasSeguidas', 'perdidasSeguidas', 'rachaGanadoraPrevia', 'perdidasDesdeRevision']) E[k] = aNumero(E[k], 0);
E.posiciones = Array.isArray(E.posiciones) ? E.posiciones : [];
E.ordenesPendientes = Array.isArray(E.ordenesPendientes) ? E.ordenesPendientes : [];
const ahora = entrada.ahora ? new Date(entrada.ahora) : new Date();
if (Number.isNaN(ahora.getTime())) throw new Error('El campo "ahora" no es una fecha válida.');
const capital = aNumero(entrada.cuenta?.capital, P.capitalPorDefecto);
if (!(capital > 0)) throw new Error('El capital de la cuenta debe ser mayor que cero.');

const ticker = entrada.ticker ?? null;
const d = entrada.decision ?? null;
const base = { ok: true, ticker, generadoEn: ahora.toISOString() };

if (!d) {
  return [{ json: { ...base, veredicto: 'SIN_SENAL', resumen: 'Sin señal: cero órdenes (libro, pp. 96 y 201).', motivos: [], chequeos: [], avisos: [], orden: null, diario: null } }];
}

const chequeos = [];
const avisos = [];
const revisar = (regla, ok, detalle) => chequeos.push({ regla, ok, detalle });

// 1. Ninguna orden sin entrada, stop y objetivo fijados de antemano (libro, pp. 49, 157, 160, 161, 188)
const faltan = ['entrada', 'stop', 'objetivo'].filter(k => !esNumero(d[k]));
const ordenLogico = faltan.length === 0 && d.stop > 0 && d.stop < d.entrada && d.entrada < d.objetivo;
revisar('Entrada, stop y objetivo fijados de antemano (pp. 49, 157, 160, 161, 188)', ordenLogico,
  faltan.length ? `falta: ${faltan.join(', ')}` : (ordenLogico ? 'completos y en orden (stop < entrada < objetivo)' : 'el orden stop < entrada < objetivo no se cumple'));

// 2. Datos frescos
if (esNumero(entrada.edadUltimaVelaMin)) {
  const fresco = entrada.edadUltimaVelaMin <= P.edadMaximaDatosMin;
  revisar('Datos frescos', fresco, fresco
    ? `última vela de hace ${Math.round(entrada.edadUltimaVelaMin)} min`
    : `la última vela tiene ${Math.round(entrada.edadUltimaVelaMin)} min (máximo ${P.edadMaximaDatosMin}): ¿mercado cerrado o datos atrasados?`);
} else {
  avisos.push('No se comprobó la antigüedad de los datos (falta edadUltimaVelaMin).');
}

// 3. Horario
const h = enHorario(P.horario, ahora);
revisar('Horario', h.ok, h.detalle);

// 4. Confluencias mínimas
if (P.minConfluencias > 0) {
  const ok = (d.nConfluencias ?? 0) >= P.minConfluencias;
  revisar('Confluencias mínimas', ok, `${d.nConfluencias ?? 0} de ${P.minConfluencias} requeridas`);
}

// 5. No promediar ni añadir a una posición abierta (libro, pp. 91, 104, 246)
const abiertas = [...(E.posiciones ?? []), ...(E.ordenesPendientes ?? [])];
const mismas = abiertas.filter(p => String(p.simbolo).toUpperCase() === String(ticker).toUpperCase()).length;
revisar('Una posición por símbolo (pp. 91, 104, 246)', mismas < P.maxPosicionesPorSimbolo,
  mismas < P.maxPosicionesPorSimbolo ? 'no hay otra posición en este símbolo' : `ya hay ${mismas} posición(es) u orden(es) en ${ticker}: no se añade ni se promedia`);

// 6. Máximo de posiciones abiertas
revisar('Máximo de posiciones abiertas', abiertas.length < P.maxPosicionesAbiertas,
  `${abiertas.length} abiertas o pendientes de ${P.maxPosicionesAbiertas} permitidas`);

// 7. Exposición por divisa
const cuenta = {};
for (const p of abiertas) for (const [div, s] of Object.entries(exposicion(String(p.simbolo).toUpperCase(), p.lado))) {
  cuenta[`${div}:${s}`] = (cuenta[`${div}:${s}`] ?? 0) + 1;
}
const choques = Object.entries(exposicion(String(ticker).toUpperCase(), 'COMPRA'))
  .filter(([div, s]) => (cuenta[`${div}:${s}`] ?? 0) + 1 > P.maxPosicionesPorDivisa)
  .map(([div, s]) => `${cuenta[`${div}:${s}`]} posiciones ya ${s > 0 ? 'largas' : 'cortas'} en ${div}`);
revisar('Exposición por divisa', choques.length === 0,
  choques.length ? `acumularía la misma apuesta: ${choques.join('; ')} (máximo ${P.maxPosicionesPorDivisa})` : 'la exposición por divisa queda dentro del máximo');

// 8. Operaciones del día (con reducción de frecuencia tras una racha larga, libro, p. 170)
const reducirFrecuencia = E.perdidasSeguidas >= P.perdidasParaReducirFrecuencia && E.rachaGanadoraPrevia >= P.rachaLargaMin;
const maxOps = reducirFrecuencia ? P.maxOperacionesDiaTrasRacha : P.maxOperacionesDia;
if (reducirFrecuencia) avisos.push(`${E.perdidasSeguidas} pérdidas seguidas tras una racha de ${E.rachaGanadoraPrevia} ganadoras: se baja a ${maxOps} operaciones al día (libro, p. 170).`);
revisar('Operaciones del día', E.operacionesHoy < maxOps, `${E.operacionesHoy} de ${maxOps} permitidas hoy`);

// 9. Pérdida diaria máxima
revisar('Pérdida diaria máxima', E.pnlHoyR > -P.perdidaDiariaMaxR,
  `resultado del día ${redondear(E.pnlHoyR, 2)} R (límite −${P.perdidaDiariaMaxR} R)`);

// 10. No devolver las ganancias del día (libro, p. 202)
const devuelto = E.maxPnlHoyR >= P.protegerGananciaDesdeR && E.pnlHoyR <= E.maxPnlHoyR * (1 - P.fraccionDevueltaMax);
revisar('No devolver las ganancias del día (p. 202)', !devuelto, devuelto
  ? `el día llegó a +${redondear(E.maxPnlHoyR, 2)} R y va en ${redondear(E.pnlHoyR, 2)} R: se devolvió más de ${P.fraccionDevueltaMax * 100} %`
  : `día en ${redondear(E.pnlHoyR, 2)} R (máximo ${redondear(E.maxPnlHoyR, 2)} R)`);

// 11. Revisión del diario (libro, pp. 124 y 193-195)
revisar('Revisión del diario (pp. 124, 193-195)', E.perdidasDesdeRevision < P.perdidasParaRevisar, E.perdidasDesdeRevision < P.perdidasParaRevisar
  ? `${E.perdidasDesdeRevision} pérdidas desde la última revisión`
  : `${E.perdidasDesdeRevision} pérdidas sin revisar: revisa el diario y reinicia el contador`);

// 12. Tamaño de la posición
const par = partesDelPar(ticker);
const precioActual = esNumero(entrada.precioActual) ? entrada.precioActual : d.entrada;
const precioEntrada = ordenLogico ? (d.estado === 'DISPARADA' ? Math.max(d.entrada, precioActual) : d.entrada) : null;
let tamano = null;
if (ordenLogico) {
  const distancia = precioEntrada - d.stop;
  const dolaresPorPrecio = dolaresPorUnidadYPrecio(par, precioEntrada);
  if (dolaresPorPrecio === null) {
    revisar('Tamaño de la posición', false, `par sin dólar (${ticker}): no se puede calcular el tamaño en dólares`);
  } else {
    const factor = E.gananciasSeguidas >= P.gananciasParaReducir ? P.factorTrasRacha : 1;
    if (factor < 1) avisos.push(`${E.gananciasSeguidas} ganadoras seguidas: lote a la mitad (libro, pp. 170 y 203).`);
    const riesgoObjetivo = capital * (P.riesgoPorOperacionPct / 100) * factor;
    const esCripto = par && CRIPTO.has(par.base);
    const paso = esCripto ? 1e-4 : 1;
    const piso = x => Math.floor(x / paso + 1e-9) * paso;
    let unidades = piso(riesgoObjetivo / (distancia * dolaresPorPrecio));
    let limitadoPor = factor < 1 ? 'racha' : 'riesgo';
    const maxPorNocional = piso((capital * P.nocionalMaxSobreCapital) / valorPorUnidad(par, precioEntrada));
    if (unidades > maxPorNocional) { unidades = maxPorNocional; limitadoPor = 'apalancamiento'; }
    unidades = redondear(unidades, 4);
    const riesgoDinero = unidades * distancia * dolaresPorPrecio;
    const ok = unidades >= paso;
    revisar('Tamaño de la posición', ok, ok
      ? `${unidades} unidades; riesgo ${redondear(riesgoDinero, 2)} USD (${redondear((riesgoDinero / capital) * 100, 3)} % del capital)`
      : 'el riesgo permitido no alcanza para una unidad con este stop');
    tamano = { unidades, riesgoDinero: redondear(riesgoDinero, 2), riesgoPctCapital: redondear((riesgoDinero / capital) * 100, 3),
      nocionalUSD: redondear(unidades * valorPorUnidad(par, precioEntrada), 2), limitadoPor, distancia: redondear(distancia) };
    if (limitadoPor === 'apalancamiento') avisos.push(`Tamaño recortado por el tope de ${P.nocionalMaxSobreCapital} veces el capital: el stop es muy corto.`);
  }
}

// ---------- Veredicto ----------
const motivos = chequeos.filter(c => !c.ok).map(c => c.detalle);
const aprobada = motivos.length === 0 && tamano !== null;
const veredicto = aprobada ? 'APROBADA' : 'RECHAZADA';

let orden = null;
if (aprobada) {
  const tipo = d.estado === 'DISPARADA' ? 'MERCADO' : 'STOP_PENDIENTE';
  orden = {
    simbolo: ticker, lado: 'COMPRA', tipo,
    entrada: d.entrada, precioReferencia: redondear(precioEntrada), stop: d.stop, objetivo: d.objetivo,
    unidades: tamano.unidades, riesgoDinero: tamano.riesgoDinero, riesgoPctCapital: tamano.riesgoPctCapital,
    nocionalUSD: tamano.nocionalUSD, limitadoPor: tamano.limitadoPor,
    regla: d.regla, plazo: d.plazo, metodoStop: d.metodoStop,
    gestion: {
      stopAEquilibrio: { cuando: d.breakeven, moverStopA: 'precio de entrada' },
      ventaParcial: d.ventaParcial ?? null,
      objetivo: d.objetivo,
      timeStopBarras: d.timeStopBarras ?? null
    },
    venceEnBarras: tipo === 'STOP_PENDIENTE' ? P.vencimientoOrdenBarras : null
  };
}

const resumen = aprobada
  ? `APROBADA · compra ${ticker} (${orden.tipo === 'MERCADO' ? 'a mercado' : 'orden stop pendiente'}) · entrada ${orden.entrada} · stop ${orden.stop} · objetivo ${orden.objetivo} · ${orden.unidades} unidades · riesgo ${orden.riesgoDinero} USD (${orden.riesgoPctCapital} %)`
  : `RECHAZADA · ${motivos.join('; ')}`;

const diario = {
  fecha: ahora.toISOString(), simbolo: ticker, plazo: d.plazo, lado: 'COMPRA', estadoSenal: d.estado,
  regla: d.regla, entrada: d.entrada, stop: d.stop, objetivo: d.objetivo,
  unidades: orden?.unidades ?? null, riesgoDinero: orden?.riesgoDinero ?? null,
  confluencias: d.confluencias ?? [], veredicto, motivos,
  cumpleReglas: aprobada                      // una ganancia lograda rompiendo reglas se anota como pérdida (libro, p. 173)
};

return [{ json: { ...base, veredicto, resumen, motivos, chequeos, avisos, orden, diario,
  contexto: { precioActual: redondear(precioActual), tendenciaDiaria: entrada.contextoDiario?.pendienteSMA20 ?? null } } }];
