// Alpaca de mentira para probar el agente sin red: mismo contrato que src/alpaca.js, con las velas históricas de los CSV y un reloj simulado.
// Reglas que imita (según la documentación de Alpaca): órdenes con stop de compra (se activan al tocar el precio), órdenes OCO de salida
// (stop-loss y objetivo; si una se ejecuta la otra se cancela), órdenes "day" que vencen al cierre, no se puede vender más de lo que hay,
// no se puede cerrar una posición que tiene acciones reservadas por órdenes abiertas, id de cliente único, stop de compra por encima del precio.
// No imita lo que pasa dentro de una vela: cada vela de 5 min se procesa completa, con el stop primero (criterio pesimista, como el backtest).
const path = require('path');
const { cargarCSV } = require('../nucleo/acciones/mercado_acciones.js');
const { ErrorAlpaca } = require('../src/alpaca.js');
const MIN = 60000;
const ABIERTAS = ['new', 'accepted', 'held', 'partially_filled', 'pending_new'];

class AlpacaFalso {
  constructor({ dirCsv, simbolos, ahora, huecos = 0, semilla = 1 }) {
    this.esPaper = true; this.ahora = ahora;
    this.datos = {}; this.indice = {};
    let s = semilla; const az = () => (s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296;
    for (const sim of simbolos) {
      const d = cargarCSV(path.join(dirCsv, `${sim}.csv`));
      this.datos[sim] = d; this.indice[sim] = new Map();
      d.T.forEach((t, i) => { if (!(huecos > 0 && az() < huecos)) this.indice[sim].set(t, i); });     // 'huecos': fracción de velas que faltan (como pasa con IEX)
    }
    this.fechas = [...new Set(Object.values(this.datos).flatMap(d => d.F))].sort();
    this.ordenes = new Map(); this.pos = new Map(); this.cids = new Set();
    this.n = 0; this.realizado = 0; this.proc = null; this.llamadas = {};
  }

  // ---- utilidades
  _cuenta(n) { this.llamadas[n] = (this.llamadas[n] || 0) + 1; this._procesar(); }
  _bar(sim, t) { const i = this.indice[sim]?.get(t); return i === undefined ? null : { o: this.datos[sim].O[i], h: this.datos[sim].H[i], l: this.datos[sim].L[i], c: this.datos[sim].C[i], v: this.datos[sim].V[i] }; }
  _ultimoPrecio(sim) {
    const now = this.ahora(); let t = Math.floor(now / (5 * MIN)) * 5 * MIN;
    for (let k = 0; k < 400; k++, t -= 5 * MIN) { const b = this._bar(sim, t); if (b) return t + 5 * MIN <= now ? b.c : b.o; }
    return null;
  }
  _abierta(o) { return ABIERTAS.includes(o.status); }
  _reservadas(sim) { let q = 0; for (const o of this.ordenes.values()) if (o.symbol === sim && o.side === 'sell' && this._abierta(o) && !o.parent_order_id) q += +o.qty; return q; }   // un grupo OCO reserva sus acciones una sola vez
  _nuevo(base) { const id = `ord-${++this.n}`; const o = { id, status: 'new', filled_qty: '0', filled_avg_price: null, submitted_ms: this.ahora(), created_at: new Date(this.ahora()).toISOString(), legs: [], ...base }; this.ordenes.set(id, o); return o; }
  _ejecutar(o, precio) {
    o.status = 'filled'; o.filled_qty = o.qty; o.filled_avg_price = String(precio); o.filled_at = new Date(this._t ?? this.ahora()).toISOString();
    const q = +o.qty, p = this.pos.get(o.symbol);
    if (o.side === 'buy') { if (p) { p.avg = (p.avg * p.qty + precio * q) / (p.qty + q); p.qty += q; } else this.pos.set(o.symbol, { qty: q, avg: precio }); }
    else { if (!p) { this.pos.set(o.symbol, { qty: -q, avg: precio }); return; } this.realizado += (precio - p.avg) * q; p.qty -= q; if (p.qty === 0) this.pos.delete(o.symbol); }
  }
  _cancelarGrupo(o, motivo = 'canceled') {
    const grupo = o.parent_order_id ? this.ordenes.get(o.parent_order_id) : o;
    for (const x of [grupo, ...grupo.legs.map(id => this.ordenes.get(id))]) if (x && this._abierta(x)) x.status = motivo;
  }

  // ---- procesa las velas de 5 min ya cerradas hasta el reloj simulado
  _procesar() {
    const now = this.ahora();
    if (this.proc === null) { this.proc = Math.floor(now / (5 * MIN)) * 5 * MIN - 5 * MIN; return; }
    while (this.proc + 10 * MIN <= now) { this.proc += 5 * MIN; this._vela(this.proc); }
  }
  _vela(t) {
    this._t = t + 5 * MIN;
    const simbolos = new Set([...this.ordenes.values()].filter(o => this._abierta(o)).map(o => o.symbol));
    for (const sim of simbolos) {
      const b = this._bar(sim, t);
      if (!b) continue;
      const abiertas = [...this.ordenes.values()].filter(o => o.symbol === sim && this._abierta(o));
      for (const o of abiertas.filter(x => x.side === 'buy' && x.type === 'stop')) {
        if (o.submitted_ms < t + 5 * MIN && b.h >= +o.stop_price) this._ejecutar(o, Math.max(+o.stop_price, b.o));
      }
      for (const padre of abiertas.filter(x => x.order_class === 'oco' && !x.parent_order_id)) {
        if (!(padre.submitted_ms <= t) || !this._abierta(padre)) continue;
        const pata = this.ordenes.get(padre.legs[0]);
        if (b.l <= +pata.stop_price) { this._ejecutar(pata, Math.min(+pata.stop_price, b.o)); padre.status = 'canceled'; }
        else if (b.h >= +padre.limit_price) { this._ejecutar(padre, Math.max(+padre.limit_price, b.o)); pata.status = 'canceled'; }
      }
    }
    const f = new Date(t + 5 * MIN);                                                      // 15:55 NY cierra el día: vencen las órdenes "day"
    const minNY = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(f).split(':').reduce((a, x, i) => a + (i ? +x : +x * 60), 0));
    if (minNY >= 16 * 60 || (minNY >= 13 * 60 && this._medioDia(t))) for (const o of this.ordenes.values()) if (this._abierta(o)) o.status = 'expired';
    this._t = undefined;
  }
  _medioDia(t) { return false; }

  // ---- contrato (igual que src/alpaca.js)
  async cuenta() { this._cuenta('cuenta'); return { status: 'ACTIVE', equity: String(100000 + this.realizado), trading_blocked: false }; }
  async reloj() {
    this._cuenta('reloj'); const now = this.ahora();
    const q = {}; for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now))) q[x.type] = x.value;
    const min = +q.hour * 60 + +q.minute;
    return { timestamp: new Date(now).toISOString(), is_open: this.fechas.includes(`${q.year}-${q.month}-${q.day}`) && min >= 570 && min < 960 };
  }
  async calendario(ini, fin) { this._cuenta('calendario'); return this.fechas.filter(f => f >= ini && f <= fin).map(f => ({ date: f, open: '09:30', close: '16:00' })); }
  async posiciones_() { return [...this.pos.entries()].map(([symbol, p]) => ({ symbol, qty: String(Math.abs(p.qty)), side: p.qty < 0 ? 'short' : 'long', avg_entry_price: String(p.avg) })); }
  async posiciones() { this._cuenta('posiciones'); return this.posiciones_(); }
  _anidar(o) { return { ...o, legs: o.legs.map(id => ({ ...this.ordenes.get(id) })) }; }
  async ordenesAbiertas() { this._cuenta('ordenesAbiertas'); return [...this.ordenes.values()].filter(o => !o.parent_order_id && (this._abierta(o) || o.legs.some(id => this._abierta(this.ordenes.get(id))))).map(o => this._anidar(o)); }
  async ordenesDesde() { this._cuenta('ordenesDesde'); return [...this.ordenes.values()].filter(o => !o.parent_order_id).map(o => this._anidar(o)); }
  async orden(id) { this._cuenta('orden'); const o = this.ordenes.get(id); if (!o) throw new ErrorAlpaca('order not found', 404); return this._anidar(o); }

  async enviarOrden(c) {
    this._cuenta('enviarOrden');
    const rechazo = (m, e = 422) => { throw new ErrorAlpaca(`Alpaca POST /orders respondió ${e}: ${m}`, e, { message: m }); };
    if (c.client_order_id && this.cids.has(c.client_order_id)) rechazo('client_order_id must be unique');
    const sim = c.symbol; const qty = Number(c.qty);
    if (!this.datos[sim]) rechazo('asset not found', 404);
    if (!(qty >= 1) || !Number.isInteger(qty)) rechazo('qty must be a whole number for this order');
    const px = this._ultimoPrecio(sim);
    if (c.client_order_id) this.cids.add(c.client_order_id);
    if (c.side === 'buy') {
      if (c.type === 'stop') {
        if (!(+c.stop_price > px)) { this.cids.delete(c.client_order_id); rechazo(`stop price must be greater than base price (${px})`); }
        return this._anidar(this._nuevo({ symbol: sim, side: 'buy', type: 'stop', order_type: 'stop', qty: String(qty), stop_price: String(c.stop_price), time_in_force: c.time_in_force, client_order_id: c.client_order_id }));
      }
      if (c.type === 'market') { const o = this._nuevo({ symbol: sim, side: 'buy', type: 'market', order_type: 'market', qty: String(qty), time_in_force: c.time_in_force, client_order_id: c.client_order_id }); this._ejecutar(o, px); return this._anidar(o); }
      rechazo('tipo de orden no soportado por el simulador');
    }
    // venta
    const p = this.pos.get(sim);
    if (c.order_class === 'oco') {
      if (!p || p.qty - this._reservadas(sim) < qty) { this.cids.delete(c.client_order_id); rechazo('insufficient qty available for order', 403); }
      if (!(+c.stop_loss?.stop_price > 0) || !(+c.take_profit?.limit_price > +c.stop_loss.stop_price + 0.0099)) { this.cids.delete(c.client_order_id); rechazo('take_profit.limit_price must be higher than stop_loss.stop_price'); }
      const padre = this._nuevo({ symbol: sim, side: 'sell', type: 'limit', order_type: 'limit', order_class: 'oco', qty: String(qty), limit_price: String(c.take_profit.limit_price), time_in_force: c.time_in_force, client_order_id: c.client_order_id });
      const pata = this._nuevo({ symbol: sim, side: 'sell', type: 'stop', order_type: 'stop', order_class: 'oco', qty: String(qty), stop_price: String(c.stop_loss.stop_price), time_in_force: c.time_in_force, status: 'held', parent_order_id: padre.id, client_order_id: `leg-${this.n}` });
      padre.legs = [pata.id];
      return this._anidar(padre);
    }
    rechazo('tipo de orden no soportado por el simulador');
  }
  async cancelarOrden(id) { this._cuenta('cancelarOrden'); const o = this.ordenes.get(id); if (!o || !this._abierta(o)) throw new ErrorAlpaca('order not cancelable', 422, null); this._cancelarGrupo(o); return null; }
  async reemplazarOrden(id, cambios) {
    this._cuenta('reemplazarOrden'); const o = this.ordenes.get(id);
    if (!o || !this._abierta(o)) throw new ErrorAlpaca('order not replaceable', 422, null);
    if (cambios.stop_price !== undefined) o.stop_price = String(cambios.stop_price);
    if (cambios.limit_price !== undefined) o.limit_price = String(cambios.limit_price);
    return this._anidar(o);
  }
  async cerrarPosicion(sim) {
    this._cuenta('cerrarPosicion'); const p = this.pos.get(sim);
    if (!p) throw new ErrorAlpaca('position does not exist', 404, null);
    if (this._reservadas(sim) > 0) throw new ErrorAlpaca('insufficient qty available for order', 403, { message: 'insufficient qty available for order' });
    const o = this._nuevo({ symbol: sim, side: p.qty > 0 ? 'sell' : 'buy', type: 'market', order_type: 'market', qty: String(Math.abs(p.qty)), client_order_id: `cierre-${this.n}` });
    this._ejecutar(o, this._ultimoPrecio(sim)); return this._anidar(o);
  }
  async velas(simbolos, iniIso, finIso) {
    this._cuenta('velas'); const ini = Date.parse(iniIso), fin = Math.min(Date.parse(finIso), this.ahora() + 1), now = this.ahora();
    const salida = {};
    for (const s of simbolos) {
      const d = this.datos[s]; if (!d) continue;
      const arr = [];
      for (const [t, i] of this.indice[s]) {
        if (t < ini || t >= fin || t > now) continue;
        const enFormacion = t + 5 * MIN > now;
        arr.push(enFormacion ? { t: new Date(t).toISOString(), o: d.O[i], h: d.O[i], l: d.O[i], c: d.O[i], v: 0 } : { t: new Date(t).toISOString(), o: d.O[i], h: d.H[i], l: d.L[i], c: d.C[i], v: d.V[i] });
      }
      arr.sort((a, b) => a.t.localeCompare(b.t)); if (arr.length) salida[s] = arr;
    }
    return salida;
  }
}
module.exports = { AlpacaFalso };
