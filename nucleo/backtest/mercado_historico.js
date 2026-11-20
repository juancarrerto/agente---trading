// Mercado histórico de EUR/USD a partir de velas de 1 minuto (UTC). Entrega, en cada instante, lo que habría visto
// TwelveData: velas de 5 min, 15 min y diarias ya cerradas, más la vela en formación SIN mirar el futuro
// (solo los minutos anteriores al instante y el precio de apertura del minuto actual, como primer tick).
const fs = require('fs');
const MIN = 60000, H = 3600000, DIA = 86400000;

function cargarM1(ruta) {
  const b = fs.readFileSync(ruta);
  const a = new Float64Array(b.buffer, b.byteOffset, b.length / 8);
  const n = a.length / 5;
  return { n, t: (i) => a[i * 5], o: (i) => a[i * 5 + 1], h: (i) => a[i * 5 + 2], l: (i) => a[i * 5 + 3], c: (i) => a[i * 5 + 4] };
}

function lowerBound(m1, x) {                       // primer índice con t >= x
  let lo = 0, hi = m1.n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m1.t(mid) < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// Inicio del casillero que contiene t. Diario: de 22:00 UTC a 22:00 UTC (cierre de Nueva York), la sesión del domingo cuenta para el lunes.
const inicio = (t, paso) => paso === DIA ? Math.floor((t - 22 * H) / DIA) * DIA + 22 * H : Math.floor(t / paso) * paso;
const etiqueta = (s, paso) => paso === DIA ? s + 2 * H : s;      // el día se llama como la fecha en que termina su mayor parte

function agregarTodo(m1, paso) {
  const T = [], O = [], Hh = [], L = [], C = [];
  let cur = null;
  for (let i = 0; i < m1.n; i++) {
    const s = inicio(m1.t(i), paso);
    if (cur !== s) { T.push(s); O.push(m1.o(i)); Hh.push(m1.h(i)); L.push(m1.l(i)); C.push(m1.c(i)); cur = s; }
    else { const k = T.length - 1; if (m1.h(i) > Hh[k]) Hh[k] = m1.h(i); if (m1.l(i) < L[k]) L[k] = m1.l(i); C[k] = m1.c(i); }
  }
  return { T, O, H: Hh, L, C };
}

function crearMercado(rutaBin) {
  const m1 = cargarM1(rutaBin);
  const series = { [5 * MIN]: agregarTodo(m1, 5 * MIN), [15 * MIN]: agregarTodo(m1, 15 * MIN), [DIA]: agregarTodo(m1, DIA) };

  function serie(paso, t, cuantas = 500) {
    const S = series[paso];
    // última casilla ya cerrada: start + paso <= t
    let lo = 0, hi = S.T.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (S.T[mid] + paso <= t) lo = mid + 1; else hi = mid; }
    const fin = lo;                                               // casillas [0, fin) cerradas
    const out = [];
    const desde = Math.max(0, fin - cuantas);
    for (let k = desde; k < fin; k++) out.push({ time: new Date(etiqueta(S.T[k], paso)).toISOString(), open: S.O[k], high: S.H[k], low: S.L[k], close: S.C[k], volume: 0 });
    // vela en formación: minutos anteriores a t dentro de la casilla actual + primer tick del minuto t
    const s = inicio(t, paso);
    if (s + paso > t) {
      const i0 = lowerBound(m1, s), i1 = lowerBound(m1, t);
      let o = null, hh = -Infinity, l = Infinity, c = null;
      for (let i = i0; i < i1; i++) { if (o === null) o = m1.o(i); if (m1.h(i) > hh) hh = m1.h(i); if (m1.l(i) < l) l = m1.l(i); c = m1.c(i); }
      if (i1 < m1.n && m1.t(i1) === t) { const p = m1.o(i1); if (o === null) o = p; if (p > hh) hh = p; if (p < l) l = p; c = p; }
      if (o !== null) {
        out.push({ time: new Date(etiqueta(s, paso)).toISOString(), open: o, high: hh, low: l, close: c, volume: 0 });
        if (out.length > cuantas) out.shift();
      }
    }
    return out;
  }
  return {
    m1, primera: m1.t(0), ultima: m1.t(m1.n - 1),
    en: t => ({ c5: serie(5 * MIN, t), c15: serie(15 * MIN, t), c1d: serie(DIA, t) }),
    // Velas de 1 minuto ya cerradas (inicio < t), las últimas n: para correr el motor de papel con más precisión
    m1Velas: (t, n = 3000) => {
      const i1 = lowerBound(m1, t), i0 = Math.max(0, i1 - n), out = [];
      for (let i = i0; i < i1; i++) out.push({ time: new Date(m1.t(i)).toISOString(), open: m1.o(i), high: m1.h(i), low: m1.l(i), close: m1.c(i), volume: 0 });
      return out;
    },
    // Velas completas de 'paso' ms cuyo inicio está en [desde, hasta) y que ya cerraron antes de 'hasta'
    barrasEntre: (paso, desde, hasta) => {
      const out = [];
      if (paso === MIN) {
        const i0 = lowerBound(m1, desde), i1 = lowerBound(m1, hasta);
        for (let i = i0; i < i1; i++) out.push({ time: new Date(m1.t(i)).toISOString(), open: m1.o(i), high: m1.h(i), low: m1.l(i), close: m1.c(i) });
        return out;
      }
      const S = series[paso];
      let lo = 0, hi = S.T.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (S.T[mid] < desde) lo = mid + 1; else hi = mid; }
      for (let k = lo; k < S.T.length && S.T[k] + paso <= hasta; k++) out.push({ time: new Date(S.T[k]).toISOString(), open: S.O[k], high: S.H[k], low: S.L[k], close: S.C[k] });
      return out;
    },
    precioEn: t => { const i = lowerBound(m1, t); return i < m1.n && m1.t(i) === t ? m1.o(i) : (i > 0 ? m1.c(i - 1) : null); }
  };
}

// Hora de Nueva York -> UTC (horario de verano de EE. UU.: 2.º domingo de marzo 07:00 UTC hasta 1.er domingo de noviembre 06:00 UTC)
function enHorarioDeVerano(anio, ms) {
  const dom = (mes, n) => { const d = new Date(Date.UTC(anio, mes, 1)); const primero = (7 - d.getUTCDay()) % 7; return 1 + primero + (n - 1) * 7; };
  const ini = Date.UTC(anio, 2, dom(2, 2), 7), fin = Date.UTC(anio, 10, dom(10, 1), 6);
  return ms >= ini && ms < fin;
}
function nyAUtc(anio, mes, dia, hora, min) {
  const comoUtc = Date.UTC(anio, mes - 1, dia, hora, min);
  return comoUtc + (enHorarioDeVerano(anio, comoUtc + 5 * H) ? 4 : 5) * H;
}

// Instantes de cada pasada: lunes a viernes, de 8:00 a 11:45 hora de Nueva York, cada 15 minutos
function instantesDePasada(desdeYMD, hastaMs) {
  const [y, mo, d] = desdeYMD;
  const out = [];
  for (let dia = Date.UTC(y, mo - 1, d); dia <= hastaMs; dia += DIA) {
    const f = new Date(dia), dow = f.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let h = 8; h <= 11; h++) for (let m = 0; m < 60; m += 15) {
      const t = nyAUtc(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate(), h, m);
      if (t <= hastaMs) out.push(t);
    }
  }
  return out;
}
module.exports = { crearMercado, instantesDePasada, nyAUtc, MIN, H, DIA };
