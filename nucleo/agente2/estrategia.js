// ================================================================
// Agente 2 · Estrategia
// Libro: "Day trading", Oliver Vélez y Greg Capra (Deusto, 2005).
// Usa solo precios (sin noticias ni volumen). Propone solo entradas LARGAS
// con la compra clave (libro, pp. 410-412).
// (libro) = cifra o regla del libro, con página.
// (mío)   = valor de partida para calibrar con historial; el libro no lo fija.
// ================================================================

const entrada = $input.first().json;

// ---------- PARÁMETROS: puedes editarlos aquí ----------
const PARAMETROS = {
  plazosEntrada: ['5min', '15min'],
  mediasPorPlazo: {                       // (libro, p. 514)
    '5min': [20, 200],
    '15min': [20, 200],
    '1day': [10, 20, 50, 100, 200]
  },
  periodosATR: 14,                        // (mío)

  // Compra clave (libro, pp. 410-412)
  ventanaNuevoMaximo: 20,                 // (mío) "nuevo máximo" = el mayor de las últimas 20 barras
  maxBarrasDesdeMaximo: 8,                // (libro)
  minBarrasMaximosBajos: 3,               // (libro)

  // Distancias en múltiplos del ATR (el libro usa 1/16 y 1/8 de dólar)
  holguraEntradaATR: 0.05,                // (mío) por encima del máximo de la barra anterior
  holguraStopATR: 0.10,                   // (mío) por debajo del mínimo que sirve de stop
  perseguirMaxATR: 0.25,                  // (mío) si el precio ya se alejó más de esto del disparo, no se persigue
  riesgoMaxATR: 1.5,                      // (mío) "demasiado riesgo": el libro no da cifra
  objetivoR: 2.5,                         // (mío) los ejemplos del libro dan de 2,3 a 2,7 veces el riesgo
  breakevenR: 1.0,                        // (mío) el libro: de 1 a 1,33 veces el riesgo
  timeStopBarras: { '5min': 24, '15min': 8 }, // (libro, p. 436) de 1 a 2 horas en intradía

  // Herramientas gráficas
  nrbFactor: 0.5, nrbVentana: 10,         // (mío) rango menor que la mitad del rango medio de 10 barras
  cierreCercaFraccion: 0.25,              // (mío) "cerca del máximo/mínimo" = 25 % del rango
  colaFraccionMin: 0.5,                   // (mío) mecha de al menos la mitad del rango
  rbCaidaInicial: 0.4,                    // (mío) movimiento inicial en contra de al menos 40 % del rango
  caidaMin: 3, caidaMax: 5,               // (libro, pp. 344-350)
  pivoteBarras: 3, zonaATR: 0.5,          // (mío) pivotes y zona de soportes/resistencias
  retrocesoMaxBarras: 60,                 // (mío)
  nivelesRetroceso: [0.4, 0.5, 0.6, 1.0], // (libro, pp. 319-324)
  toleranciaRetroceso: 0.05,              // (mío)
  pendienteBarras: 5, pendientePlanaATR: 0.15 // (mío) pendiente de la media de 20
};
const P = { ...PARAMETROS, ...(entrada.parametros ?? {}) };

// Si el Agente 1 no entregó datos buenos, no se opera.
if (entrada.ok === false) {
  return [{ json: { ok: false, motivo: 'El Agente 1 no entregó datos válidos: no se opera.', errors: entrada.errors ?? [] } }];
}

// ---------- Utilidades ----------
const redondear = x => (x === null || x === undefined || !Number.isFinite(x)) ? null : Number(x.toPrecision(8));
const rango = c => c.high - c.low;
const media = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

function smaEn(cierres, n, fin) {                  // media simple de n cierres que terminan en 'fin'
  if (fin + 1 < n || fin < 0) return null;
  let s = 0;
  for (let i = fin - n + 1; i <= fin; i++) s += cierres[i];
  return s / n;
}
function atrEn(velas, n, fin) {                    // media de los rangos verdaderos de las n barras hasta 'fin'
  if (fin < n) return null;
  let s = 0;
  for (let i = fin - n + 1; i <= fin; i++) {
    const previo = velas[i - 1].close;
    s += Math.max(velas[i].high - velas[i].low, Math.abs(velas[i].high - previo), Math.abs(velas[i].low - previo));
  }
  return s / n;
}
function pendienteMedia(cierres, n, fin, atr) {    // 'sube' | 'baja' | 'plana'
  const ahora = smaEn(cierres, n, fin);
  const antes = smaEn(cierres, n, fin - P.pendienteBarras);
  if (ahora === null || antes === null || !(atr > 0)) return null;
  const p = (ahora - antes) / atr;
  return p > P.pendientePlanaATR ? 'sube' : p < -P.pendientePlanaATR ? 'baja' : 'plana';
}

// ---------- Herramientas gráficas (todas sobre la barra i ya cerrada) ----------
// 1. Barra de rango estrecho, NRB (libro, pp. 291-295): rango menor que lo normal,
//    tras varias barras de rango normal o ancho.
function esNRB(v, i) {
  if (i < P.nrbVentana + 3) return false;
  const prom = media(v.slice(i - P.nrbVentana, i).map(rango));
  const estrecha = rango(v[i]) < P.nrbFactor * prom;
  const previasNormales = [1, 2, 3].every(k => rango(v[i - k]) >= P.nrbFactor * prom);
  return estrecha && previasNormales;
}
// 2. Barra reversa, RB (libro, pp. 295-300): movimiento inicial en contra y cierre cerca del extremo opuesto.
function tipoRB(v, i) {
  const c = v[i], r = rango(c);
  if (!(r > 0)) return null;
  if (c.close > c.open && (c.high - c.close) <= P.cierreCercaFraccion * r && (c.open - c.low) >= P.rbCaidaInicial * r) return 'alcista';
  if (c.close < c.open && (c.close - c.low) <= P.cierreCercaFraccion * r && (c.high - c.open) >= P.rbCaidaInicial * r) return 'bajista';
  return null;
}
// 3. Colas (libro, pp. 300-304). Mido la mecha real: en el ejemplo del libro (apertura 30, mínimo 27,
//    cierre 29) la cola de 2 coincide con la mecha inferior. Con velas alcistas, medir del mínimo al cierre
//    contaría también el cuerpo y marcaría casi la mitad de las barras (decisión mía).
function colas(c) {
  const r = rango(c);
  if (!(r > 0)) return { fondo: false, tope: false };
  const mechaInf = Math.min(c.open, c.close) - c.low;
  const mechaSup = c.high - Math.max(c.open, c.close);
  return { fondo: mechaInf >= P.colaFraccionMin * r, tope: mechaSup >= P.colaFraccionMin * r };
}
// 10. Caída de 3 a 5 barras (libro, pp. 344-350): barras bajistas consecutivas hasta la barra i.
function barrasBajistas(v, i) {
  let n = 0;
  for (let k = i; k >= 1; k--) {
    if (v[k].close < v[k - 1].close && v[k].close < v[k].open) n++; else break;
  }
  return n;
}
// 5. Soportes y resistencias (libro, pp. 311-318): pivotes de 'pivoteBarras' barras a cada lado.
function pivotes(v) {
  const k = P.pivoteBarras, altos = [], bajos = [];
  for (let i = k; i <= v.length - 1 - k; i++) {
    let alto = true, bajo = true;
    for (let j = 1; j <= k; j++) {
      if (!(v[i].high > v[i - j].high && v[i].high >= v[i + j].high)) alto = false;
      if (!(v[i].low < v[i - j].low && v[i].low <= v[i + j].low)) bajo = false;
    }
    if (alto) altos.push({ i, precio: v[i].high });
    if (bajo) bajos.push({ i, precio: v[i].low });
  }
  return { altos, bajos };
}
function cercaDeSR(v, i, atr, piv) {
  const zona = P.zonaATR * atr, precio = v[i].close;
  const minimo = Math.min(v[i].low, v[i - 1].low), maximo = Math.max(v[i].high, v[i - 1].high);
  let soporte = null, resistencia = null;
  for (const b of piv.bajos) {
    if (Math.abs(minimo - b.precio) <= zona) {
      const sube = Math.max(...v.slice(b.i + 1, b.i + 11).map(c => c.high)) - b.precio;
      const cand = { precio: redondear(b.precio), tipo: sube >= 2 * atr ? 'soporte mayor' : 'soporte menor' };
      if (!soporte || (cand.tipo === 'soporte mayor' && soporte.tipo !== 'soporte mayor')) soporte = cand;
    }
  }
  for (const a of piv.altos) {                       // una resistencia superada pasa a soporte menor
    if (precio > a.precio && Math.abs(minimo - a.precio) <= zona && !soporte) {
      soporte = { precio: redondear(a.precio), tipo: 'soporte menor (resistencia superada)' };
    }
    if (precio < a.precio && Math.abs(a.precio - maximo) <= zona) resistencia = { precio: redondear(a.precio), tipo: 'resistencia' };
  }
  return { soporte, resistencia };
}
// 6. Retrocesos (libro, pp. 319-324): cuánto del último avance se ha devuelto.
function retroceso(v, i, piv) {
  const ph = piv.altos.at(-1);
  if (!ph || i - ph.i > P.retrocesoMaxBarras) return null;
  const pl = piv.bajos.filter(b => b.i < ph.i).at(-1);
  if (!pl) return null;
  const mov = ph.precio - pl.precio;
  if (!(mov > 0)) return null;
  const pct = (ph.precio - v[i].close) / mov;
  if (pct < 0) return null;
  const cerca = P.nivelesRetroceso.find(n => Math.abs(pct - n) <= P.toleranciaRetroceso) ?? null;
  return { pct: redondear(pct), nivelCercano: cerca, desde: redondear(ph.precio), hasta: redondear(pl.precio) };
}

// ---------- Compra clave (libro, pp. 410-412) ----------
// 1) El valor marcó un nuevo máximo como mucho 8 barras atrás.
// 2) Desde entonces hay 3 o más barras con máximos consecutivos más bajos.
// Entrada: 1/16 a 1/8 por encima del máximo de la barra anterior (aquí, holguraEntradaATR).
// Stop inicial: método de la barra anterior (libro, p. 427) y, si arriesga demasiado,
// método de la barra actual (libro, p. 428).
function compraClave(v, cur, atr, plazo) {
  const p = v.length - 1;                            // barra anterior a la de entrada
  if (p < P.ventanaNuevoMaximo + P.maxBarrasDesdeMaximo) return { estado: 'SIN_SETUP', motivo: 'pocas barras' };

  for (let k = P.minBarrasMaximosBajos; k <= P.maxBarrasDesdeMaximo; k++) {
    const h = p - k;
    const previas = v.slice(h - P.ventanaNuevoMaximo + 1, h);
    if (!previas.every(c => v[h].high > c.high)) continue;          // la barra h no es un nuevo máximo
    let bajando = true;
    for (let j = h + 1; j <= p; j++) if (!(v[j].high < v[j - 1].high)) { bajando = false; break; }
    if (!bajando) continue;

    const disparo = v[p].high + P.holguraEntradaATR * atr;
    const disparada = cur.high >= disparo;
    let estado = disparada ? 'DISPARADA' : 'ARMADA';
    if (disparada && (cur.close - disparo) > P.perseguirMaxATR * atr) estado = 'NO_PERSEGUIR';

    const stopAnterior = v[p].low - P.holguraStopATR * atr;
    const stopActual = disparada ? cur.low - P.holguraStopATR * atr : null;
    const maxRiesgo = P.riesgoMaxATR * atr;
    let stop = stopAnterior, metodoStop = 'barra anterior (libro, p. 427)', valido = true, motivo = null;
    if (disparo - stop > maxRiesgo) {
      if (stopActual !== null && stopActual < disparo && disparo - stopActual <= maxRiesgo) {
        stop = stopActual; metodoStop = 'barra actual (libro, p. 428)';
      } else {
        valido = false;
        motivo = stopActual === null
          ? 'riesgo excesivo con la barra anterior; se reevalúa con la barra actual al dispararse'
          : 'riesgo excesivo con ambos métodos de stop';
      }
    }
    const resultado = {
      estado, valido, motivo,
      nuevoMaximoHaceBarras: k, barrasConMaximosBajos: k,
      regla: 'Compra clave (libro, pp. 410-412)',
      disparo: redondear(disparo)
    };
    if (valido) {
      const R = disparo - stop;
      resultado.plan = {
        entrada: redondear(disparo),
        stop: redondear(stop), metodoStop,
        riesgo: redondear(R), riesgoATR: redondear(R / atr),
        breakeven: redondear(disparo + P.breakevenR * R),
        ventaParcial: { en: redondear(disparo + P.breakevenR * R), fraccion: 0.5 },   // venta incremental (libro, pp. 438-441)
        objetivo: redondear(disparo + P.objetivoR * R),
        timeStopBarras: P.timeStopBarras[plazo] ?? null                              // (libro, p. 436)
      };
    }
    return resultado;
  }
  return { estado: 'SIN_SETUP' };
}

// ---------- Lectura de un plazo ----------
function leerPlazo(plazo, velas) {
  if (!Array.isArray(velas) || velas.length < 40) {
    return { plazo, ok: false, avisos: [`pocas velas (${Array.isArray(velas) ? velas.length : 0})`] };
  }
  const v = velas.slice(0, -1);                       // barras cerradas
  const cur = velas.at(-1);                           // barra en curso
  const i = v.length - 1;
  const atr = atrEn(v, P.periodosATR, i);
  if (!(atr > 0)) return { plazo, ok: false, avisos: ['no se pudo calcular el ATR'] };

  const cierres = v.map(c => c.close);
  const avisos = [];
  const medias = {}, cercaDeMedia = [];
  for (const n of P.mediasPorPlazo[plazo] ?? []) {
    const m = smaEn(cierres, n, i);
    medias['sma' + n] = redondear(m);
    if (m === null) { avisos.push(`faltan velas para la media de ${n}`); continue; }
    if (Math.abs(v[i].close - m) <= P.zonaATR * atr || (v[i].low <= m && m <= v[i].high)) cercaDeMedia.push('SMA' + n);
  }
  const pend20 = pendienteMedia(cierres, 20, i, atr);

  const piv = pivotes(v);
  const sr = cercaDeSR(v, i, atr, piv);
  const retro = retroceso(v, i, piv);
  const nrb = esNRB(v, i);
  const rb = tipoRB(v, i);
  const cola = colas(v[i]);
  const caida = barrasBajistas(v, i);
  const caida3a5 = caida >= P.caidaMin && caida <= P.caidaMax;

  const confluencias = [];
  if (nrb) confluencias.push('barra de rango estrecho');
  if (rb === 'alcista') confluencias.push('barra reversa alcista');
  if (cola.fondo) confluencias.push('cola de fondo');
  if (caida3a5) confluencias.push(`caída de ${caida} barras`);
  if (sr.soporte) confluencias.push(sr.soporte.tipo);
  if (cercaDeMedia.length) confluencias.push('cerca de ' + cercaDeMedia.join(' y '));
  if (retro && retro.nivelCercano !== null) confluencias.push(`retroceso del ${Math.round(retro.nivelCercano * 100)} %`);

  return {
    plazo, ok: true,
    ultimaCerrada: v[i].time, precioActual: cur.close, atr: redondear(atr),
    medias, pendienteSMA20: pend20,
    herramientas: {
      nrb, rb, cola, barrasBajistas: caida, caida3a5,
      soporte: sr.soporte, resistencia: sr.resistencia, retroceso: retro, cercaDeMedia
    },
    compraClave: compraClave(v, cur, atr, plazo),
    confluencias, nConfluencias: confluencias.length,
    avisos
  };
}

// ---------- Contexto diario (no bloquea entradas) ----------
function contextoDiario(velas, precio) {
  if (!Array.isArray(velas) || velas.length < 30) return { ok: false, aviso: 'pocas velas diarias' };
  const v = velas.slice(0, -1), cierres = v.map(c => c.close), fin = v.length - 1;
  const atr = atrEn(v, P.periodosATR, fin);
  const medias = {};
  for (const n of P.mediasPorPlazo['1day']) medias['sma' + n] = redondear(smaEn(cierres, n, fin));
  return {
    ok: true, ultimaCerrada: v[fin].time, medias,
    pendienteSMA20: pendienteMedia(cierres, 20, fin, atr),
    precioSobreSMA200: medias.sma200 === null ? null : precio > medias.sma200
  };
}

// ---------- Resultado ----------
const lecturas = {};
for (const plazo of ['5min', '15min']) {
  const velas = plazo === '5min' ? entrada.candles5m : entrada.candles15m;
  lecturas[plazo] = leerPlazo(plazo, velas);
}
const precioActual = entrada.lastPrice ?? lecturas['5min'].precioActual ?? null;
const diario = contextoDiario(entrada.candles1d, precioActual);

const senales = [];
for (const plazo of P.plazosEntrada) {
  const l = lecturas[plazo];
  const ck = l?.ok ? l.compraClave : null;
  if (ck && ['ARMADA', 'DISPARADA'].includes(ck.estado) && ck.valido) {
    senales.push({
      plazo, tipo: 'COMPRA', estado: ck.estado, regla: ck.regla,
      ...ck.plan, confluencias: l.confluencias, nConfluencias: l.nConfluencias
    });
  }
}
senales.sort((a, b) => b.nConfluencias - a.nConfluencias);
const decision = senales[0] ?? null;

const avisos = [];
for (const plazo of Object.keys(lecturas)) for (const a of lecturas[plazo].avisos ?? []) avisos.push(`${plazo}: ${a}`);
if (!diario.ok) avisos.push(`1day: ${diario.aviso}`);

const resumen = decision
  ? `${decision.plazo}: compra clave ${decision.estado} · entrada ${decision.entrada} · stop ${decision.stop} · objetivo ${decision.objetivo} · ${decision.nConfluencias} confluencia(s)`
  : 'Sin señal de compra clave en 5 min ni 15 min.';

return [{ json: {
  ok: true,
  ticker: entrada.ticker ?? null,
  generadoEn: new Date().toISOString(),
  precioActual: redondear(precioActual),
  resumen,
  decision,
  senales,
  contextoDiario: diario,
  plazos: lecturas,
  avisos
} }];
