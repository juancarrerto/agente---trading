// Datos en vivo: baja velas de 5 minutos de Alpaca (feed IEX), rellena los huecos y las entrega al agente en el MISMO formato que
// usó el backtest (un CSV por acción, hora de Nueva York). Así el agente en vivo ejecuta exactamente el mismo código de lectura de velas.
//
// Diferencias inevitables frente a los datos del backtest (TwelveData, todas las bolsas): el feed IEX solo trae las operaciones hechas
// en IEX, por lo que el volumen es una fracción del total y a veces falta una vela de 5 minutos (nadie operó en IEX en ese tramo).
// Reglas para los huecos: se rellenan con una vela plana al último cierre; si falta el comienzo de la sesión, con la apertura de la
// primera vela que sí existe (para no inventar un hueco de precio).
const fs = require('fs');
const path = require('path');
const { crearMercadoAcciones } = require('../nucleo/acciones/mercado_acciones.js');
const { nyAUtc, MIN } = require('../nucleo/backtest/mercado_historico.js');

const FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function nyPartes(ms) {
  const q = {};
  for (const x of FMT.formatToParts(new Date(ms))) q[x.type] = x.value;
  return { fecha: `${q.year}-${q.month}-${q.day}`, texto: `${q.year}-${q.month}-${q.day} ${q.hour}:${q.minute}:${q.second}`, y: +q.year, mo: +q.month, d: +q.day, minutoDelDia: +q.hour * 60 + +q.minute };
}
const num = x => Number(Number(x).toFixed(6));

class Datos {
  constructor({ cliente, dirTrabajo, diasHistorial = 95 }) {
    this.cliente = cliente; this.dir = dirTrabajo; this.diasHistorial = diasHistorial;
    this.barras = {};            // SIMBOLO -> Map(inicioMs -> {o,h,l,c,v})
    this.calendario = new Map(); // fecha -> minuto de cierre (390 + 9*60 = 960 normal; 780 medio día)
    fs.mkdirSync(dirTrabajo, { recursive: true });
  }

  async cargarCalendario(hastaMs) {
    try {
      const ini = nyPartes(hastaMs - this.diasHistorial * 86400000).fecha, fin = nyPartes(hastaMs).fecha;
      for (const d of await this.cliente.calendario(ini, fin)) {
        const [h, m] = String(d.close).split(':').map(Number);
        if (Number.isFinite(h)) this.calendario.set(d.date, h * 60 + m);
      }
    } catch (e) { this.avisoCalendario = e.message; }          // sin calendario se deduce el cierre de las propias velas
  }

  _ingerir(sim, arr) {
    const m = (this.barras[sim] ||= new Map());
    for (const b of arr) m.set(Date.parse(b.t), { o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 });
  }

  // Historial completo de las acciones pedidas (una vez por ejecución)
  async cargar(simbolos, hastaMs) {
    const ini = new Date(hastaMs - this.diasHistorial * 86400000).toISOString();
    const r = await this.cliente.velas(simbolos, ini, new Date(hastaMs + 10 * MIN).toISOString());
    for (const s of simbolos) { this.barras[s] = new Map(); if (r[s]) this._ingerir(s, r[s]); }
  }

  // Solo lo nuevo (desde la última vela conocida menos 15 minutos); si la acción no estaba cargada, trae todo el historial
  async actualizar(simbolos, hastaMs) {
    const nuevas = simbolos.filter(s => !this.barras[s] || !this.barras[s].size);
    const viejas = simbolos.filter(s => !nuevas.includes(s));
    if (nuevas.length) await this.cargar(nuevas, hastaMs);
    if (viejas.length) {
      const desde = Math.min(...viejas.map(s => Math.max(...this.barras[s].keys()))) - 15 * MIN;
      const r = await this.cliente.velas(viejas, new Date(desde).toISOString(), new Date(hastaMs + 10 * MIN).toISOString());
      for (const s of viejas) if (r[s]) this._ingerir(s, r[s]);
    }
  }

  // Minuto (de Nueva York) del cierre de una sesión: del calendario si lo hay; si no, de la última vela real de cualquier acción cargada
  _cierreSesion(fecha, ultimaRealPorFecha) {
    const c = this.calendario.get(fecha);
    if (c) return Math.min(c, 16 * 60);
    return Math.min((ultimaRealPorFecha.get(fecha) ?? 15 * 60 + 55) + 5, 16 * 60);
  }

  // Escribe un CSV por acción con velas de 5 min de 9:30 a 15:55 hasta el instante t (la vela que EMPIEZA en t solo lleva su apertura)
  escribir(simbolos, tMs) {
    // fechas de sesión presentes y última vela real por fecha (para días sin calendario)
    const ultimaReal = new Map(), fechas = new Set();
    for (const s of simbolos) for (const ms of this.barras[s]?.keys() ?? []) {
      const p = nyPartes(ms);
      if (p.minutoDelDia < 570 || p.minutoDelDia > 955) continue;
      fechas.add(p.fecha); ultimaReal.set(p.fecha, Math.max(ultimaReal.get(p.fecha) ?? 0, p.minutoDelDia));
    }
    const hoy = nyPartes(tMs).fecha;
    const orden = [...fechas].sort();
    const conDatos = [];
    for (const s of simbolos) {
      const m = this.barras[s];
      if (!m || !m.size) continue;
      const filas = [];
      for (const fecha of orden) {
        const [y, mo, d] = fecha.split('-').map(Number);
        const cierre = this._cierreSesion(fecha, ultimaReal);
        const t0 = nyAUtc(y, mo, d, 9, 30);
        const slots = [];
        for (let k = 0; t0 + k * 5 * MIN < nyAUtc(y, mo, d, 0, 0) + cierre * MIN; k++) {
          const t = t0 + k * 5 * MIN;
          if (fecha === hoy && t > tMs) break;
          slots.push(t);
        }
        // ¿hay alguna vela real cerrada este día para esta acción?
        const reales = slots.filter(t => m.has(t) && t + 5 * MIN <= tMs);
        if (!reales.length) continue;
        const primera = m.get(reales[0]);
        let prevC = null;
        for (const t of slots) {
          let b;
          const cerrada = t + 5 * MIN <= tMs;
          if (cerrada && m.has(t)) b = m.get(t);
          else if (!cerrada) {                                         // la vela que empieza en t: solo apertura
            const o = m.has(t) ? m.get(t).o : (prevC ?? primera.o);
            b = { o, h: o, l: o, c: o, v: 0 };
          } else {                                                      // hueco: vela plana
            const px = prevC ?? primera.o;
            b = { o: px, h: px, l: px, c: px, v: 0 };
          }
          prevC = b.c;
          filas.push(`${nyPartes(t).texto},${num(b.o)},${num(b.h)},${num(b.l)},${num(b.c)},${Math.round(b.v)}`);
        }
      }
      if (filas.length) { fs.writeFileSync(path.join(this.dir, `${s}.csv`), 'datetime,open,high,low,close,volume\n' + filas.join('\n') + '\n'); conDatos.push(s); }
      else { try { fs.unlinkSync(path.join(this.dir, `${s}.csv`)); } catch { /* no existía */ } }
    }
    return conDatos;
  }

  mercado(simbolos, tMs) {
    const conDatos = this.escribir(simbolos, tMs);
    return crearMercadoAcciones(this.dir, conDatos);
  }
}
module.exports = { Datos, nyPartes };
