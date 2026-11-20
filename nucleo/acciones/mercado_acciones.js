// Mercado histórico de acciones a partir de velas de 5 minutos (hora de Nueva York en los CSV, sesión regular).
// Entrega, en cada instante t, lo que habría visto TwelveData: velas de 5 min, 15 min y diarias ya cerradas, más
// la vela en formación SIN mirar el futuro (solo velas de 5 min cerradas antes de t y el precio de apertura de la vela que empieza en t).
const fs = require('fs');
const path = require('path');
const { nyAUtc, MIN, DIA } = require('../backtest/mercado_historico.js');
const P15 = 15 * MIN;

function cargarCSV(ruta) {
  const lineas = fs.readFileSync(ruta, 'utf8').split('\n');
  const T = [], O = [], Hh = [], L = [], C = [], V = [], F = [];
  for (let i = 1; i < lineas.length; i++) {
    const ln = lineas[i];
    if (!ln) continue;
    const p = ln.split(',');
    const d = p[0];
    const hh = +d.slice(11, 13), mi = +d.slice(14, 16);
    if (hh * 60 + mi < 9 * 60 + 30 || hh * 60 + mi > 15 * 60 + 55) continue;      // solo sesión regular
    const o = +p[1], h = +p[2], l = +p[3], c = +p[4], v = +p[5] || 0;
    if (!(o > 0 && c > 0 && h >= l && h >= Math.max(o, c) - 1e-9 && l <= Math.min(o, c) + 1e-9)) continue;
    T.push(nyAUtc(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10), hh, mi));
    O.push(o); Hh.push(h); L.push(l); C.push(c); V.push(v); F.push(d.slice(0, 10));
  }
  return { T, O, H: Hh, L, C, V, F };
}

function lowerBound(arr, x) {                  // primer índice con arr[i] >= x
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

function prepararSimbolo(d) {
  // sesiones (un día de bolsa cada una)
  const dias = [];
  for (let i = 0; i < d.T.length;) {
    let j = i;
    while (j < d.T.length && d.F[j] === d.F[i]) j++;
    let h = -Infinity, l = Infinity, v = 0;
    for (let k = i; k < j; k++) { if (d.H[k] > h) h = d.H[k]; if (d.L[k] < l) l = d.L[k]; v += d.V[k]; }
    dias.push({ fecha: d.F[i], i0: i, i1: j, o: d.O[i], h, l, c: d.C[j - 1], v, cierreMs: d.T[j - 1] + 5 * MIN });
    i = j;
  }
  // velas de 15 minutos a partir de las de 5
  const T15 = [], O15 = [], H15 = [], L15 = [], C15 = [], V15 = [];
  let cur = null;
  for (let i = 0; i < d.T.length; i++) {
    const s = Math.floor(d.T[i] / P15) * P15;
    if (cur !== s) { T15.push(s); O15.push(d.O[i]); H15.push(d.H[i]); L15.push(d.L[i]); C15.push(d.C[i]); V15.push(d.V[i]); cur = s; }
    else { const k = T15.length - 1; if (d.H[i] > H15[k]) H15[k] = d.H[i]; if (d.L[i] < L15[k]) L15[k] = d.L[i]; C15[k] = d.C[i]; V15[k] += d.V[i]; }
  }
  return { ...d, dias, diasCierre: dias.map(x => x.cierreMs), s15: { T: T15, O: O15, H: H15, L: L15, C: C15, V: V15 } };
}

const iso = ms => new Date(ms).toISOString();

function crearMercadoAcciones(dirCsv, simbolos) {
  const S = {};
  for (const s of simbolos) {
    const ruta = path.join(dirCsv, `${s}.csv`);
    if (!fs.existsSync(ruta)) continue;
    const d = cargarCSV(ruta);
    if (d.T.length) S[s] = prepararSimbolo(d);
  }

  function velas(sym, t, cuantas = 500) {
    const d = S[sym];
    // 5 minutos
    const n5 = lowerBound(d.T, t - 5 * MIN + 1);                        // velas con inicio <= t-5min = ya cerradas
    const c5 = [];
    for (let k = Math.max(0, n5 - cuantas); k < n5; k++) c5.push({ time: iso(d.T[k]), open: d.O[k], high: d.H[k], low: d.L[k], close: d.C[k], volume: d.V[k] });
    if (n5 < d.T.length && d.T[n5] === t) { const o = d.O[n5]; c5.push({ time: iso(t), open: o, high: o, low: o, close: o, volume: 0 }); if (c5.length > cuantas) c5.shift(); }
    // 15 minutos (cerradas: inicio + 15 min <= t)
    const s15 = d.s15;
    const n15 = lowerBound(s15.T, t - P15 + 1);
    const c15 = [];
    for (let k = Math.max(0, n15 - cuantas); k < n15; k++) c15.push({ time: iso(s15.T[k]), open: s15.O[k], high: s15.H[k], low: s15.L[k], close: s15.C[k], volume: s15.V[k] });
    {
      const s = Math.floor(t / P15) * P15;
      const i0 = lowerBound(d.T, s);
      let o = null, h = -Infinity, l = Infinity, c = null;
      for (let i = i0; i < n5; i++) { if (o === null) o = d.O[i]; if (d.H[i] > h) h = d.H[i]; if (d.L[i] < l) l = d.L[i]; c = d.C[i]; }
      if (n5 < d.T.length && d.T[n5] === t) { const p = d.O[n5]; if (o === null) o = p; if (p > h) h = p; if (p < l) l = p; c = p; }
      if (o !== null) { c15.push({ time: iso(s), open: o, high: h, low: l, close: c, volume: 0 }); if (c15.length > cuantas) c15.shift(); }
    }
    // diarias: sesiones ya terminadas + la de hoy en formación
    const nd = lowerBound(d.diasCierre, t + 1);                              // sesiones con cierre <= t
    const c1d = [];
    for (let k = Math.max(0, nd - cuantas); k < nd; k++) { const x = d.dias[k]; c1d.push({ time: `${x.fecha}T00:00:00.000Z`, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v }); }
    if (nd < d.dias.length) {
      const x = d.dias[nd];
      if (d.T[x.i0] <= t) {
        let o = null, h = -Infinity, l = Infinity, c = null;
        for (let i = x.i0; i < x.i1 && d.T[i] + 5 * MIN <= t; i++) { if (o === null) o = d.O[i]; if (d.H[i] > h) h = d.H[i]; if (d.L[i] < l) l = d.L[i]; c = d.C[i]; }
        const j = lowerBound(d.T, t);
        if (j < x.i1 && d.T[j] === t) { const p = d.O[j]; if (o === null) o = p; if (p > h) h = p; if (p < l) l = p; c = p; }
        if (o !== null) { c1d.push({ time: `${x.fecha}T00:00:00.000Z`, open: o, high: h, low: l, close: c, volume: 0 }); if (c1d.length > cuantas) c1d.shift(); }
      }
    }
    return { c5, c15, c1d };
  }

  return {
    simbolos: Object.keys(S),
    datos: S,
    en: (sym, t) => velas(sym, t),
    primera: Math.min(...Object.values(S).map(d => d.T[0])),
    ultima: Math.max(...Object.values(S).map(d => d.T[d.T.length - 1])),
    // Velas de 5 min completas con inicio en [desde, hasta) que ya cerraron antes de 'hasta' (para el control al azar)
    barrasEntre: (sym, desde, hasta) => {
      const d = S[sym], out = [];
      for (let i = lowerBound(d.T, desde); i < d.T.length && d.T[i] + 5 * MIN <= hasta; i++) out.push({ time: iso(d.T[i]), open: d.O[i], high: d.H[i], low: d.L[i], close: d.C[i], volume: d.V[i] });
      return out;
    },
    precioEn: (sym, t) => { const d = S[sym]; const i = lowerBound(d.T, t); return i < d.T.length && d.T[i] === t ? d.O[i] : null; },
    // Filtro de "acciones en juego" con datos disponibles a las 9:45 (velas de 9:30, 9:35 y 9:40 cerradas)
    // gap = apertura de hoy / cierre de la sesión anterior - 1 ; rvol = volumen de las 3 primeras velas / media de las mismas 3 velas en las 20 sesiones anteriores
    enJuego: (sym, fecha, nPrevias = 20) => {
      const d = S[sym];
      if (!d) return null;
      const idx = d.dias.findIndex(x => x.fecha === fecha);
      if (idx < nPrevias) return null;
      const hoy = d.dias[idx], ayer = d.dias[idx - 1];
      if (hoy.i1 - hoy.i0 < 3) return null;
      const vol3 = x => d.V[x.i0] + d.V[x.i0 + 1] + d.V[x.i0 + 2];
      let m = 0;
      for (let k = idx - nPrevias; k < idx; k++) m += vol3(d.dias[k]);
      m /= nPrevias;
      return { gap: hoy.o / ayer.c - 1, rvol: m > 0 ? vol3(hoy) / m : null };
    },
    sesionesDe: sym => S[sym]?.dias.map(x => x.fecha) ?? []
  };
}
module.exports = { crearMercadoAcciones, cargarCSV, lowerBound, MIN, DIA };
