// Simulador del orquestador completo: ejecuta el código REAL de cada nodo del JSON, en el mismo orden y
// con las mismas reglas de n8n (almacén persistente entre pasadas, onError, bucle de un par a la vez).
const fs = require('fs');

const RealDate = Date;
let AHORA = Date.UTC(2026, 10, 3, 12, 2);
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(AHORA); else super(...a); }
  static now() { return AHORA; }
}
global.Date = FakeDate;
const fijarAhora = ms => { AHORA = ms; };

function cargar(base) {
  const L = f => JSON.parse(fs.readFileSync(`${base}/output/${f}`, 'utf8'));
  return { orq: L('orquestador-completo-v2.json'), a1: L('agente-1-datos-de-velas-v2-2.json'), a2: L('agente-2-estrategia.json') };
}

function crearMundo(base, opciones = {}) {
  const { orq, a1, a2 } = cargar(base);
  const cod = (wf, n) => wf.nodes.find(x => x.name === n).parameters.jsCode;
  const nodo = n => orq.nodes.find(x => x.name === n);
  let almacen = {};                       // lo que n8n guarda entre ejecuciones publicadas
  const mundo = { orq, almacen: () => almacen, fijarAlmacen: a => { almacen = a; }, mercado: {}, llamadasAgente1: [], alSalir: null };   // fijarAlmacen: único cambio frente al arnés del backtest (para restaurar el estado entre ejecuciones)
  const compiladas = new Map();
  const compilar = (clave, args, src) => { const k = clave; if (!compiladas.has(k) || compiladas.get(k).src !== src) compiladas.set(k, { src, fn: new Function(...args, src) }); return compiladas.get(k).fn; };

  function correrNodo(nombre, items) {
    const n = nodo(nombre);
    const entrada = items.map(j => ({ json: j }));
    const $input = { first: () => entrada[0], all: () => entrada, item: entrada[0] };
    const sd = almacen;
    try {
      const fn = compilar('n:' + nombre, ['$input', '$getWorkflowStaticData', '$json'], cod(orq, nombre));
      const sal = fn($input, () => sd, entrada[0]?.json);
      if (!Array.isArray(sal) || sal.some(x => !x || typeof x.json !== 'object')) throw new Error(`El nodo "${nombre}" no devolvió una lista de {json}`);
      const js = sal.map(x => x.json);
      if (mundo.alSalir) mundo.alSalir(nombre, js, entrada.map(e => e.json));
      return js;
    } catch (e) {
      if (n.onError === 'continueRegularOutput') return [{ error: e.message }];
      throw new Error(`[${nombre}] ${e.message}`);
    }
  }

  // ---- Agente 1 simulado: respuestas de TwelveData -> código REAL del Agente 1
  const aTwelve = (velas, soloFecha, sinVolumen) => ({ json: { status: 'ok', values: [...velas].reverse().map(c => {
    const s = c.time.replace('T', ' ').slice(0, 19);
    const v = { datetime: soloFecha ? s.slice(0, 10) : s, open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close) };
    if (!sinVolumen) v.volume = String(c.volume ?? 0);
    return v;
  }) } });
  function agente1(symbol) {
    mundo.llamadasAgente1.push({ symbol, ahora: new RealDate(AHORA).toISOString() });
    const m = mundo.mercado[symbol];
    if (m === 'FALLO_TOTAL') return { error: 'Request failed with status code 500' };      // el sub-workflow se rompe
    let resp;
    if (m === 'SIN_DATOS') resp = [0, 1, 2].map(() => ({ json: { status: 'error', code: 400, message: '**symbol** not found' } }));
    else {
      const d = m(AHORA);
      const forex = symbol !== 'BTC/USD' && !mundo.esAccion;
      resp = [aTwelve(d.c5, false, forex), aTwelve(d.c15, false, forex), aTwelve(d.c1d, true, forex)];
    }
    const pet = compilar('a1:prep', ['$input'], cod(a1, 'Preparar peticiones'))({ first: () => ({ json: { symbol } }) });
    return compilar('a1:armar', ['$input', '$'], cod(a1, 'Armar velas'))({ all: () => resp }, () => ({ all: () => pet }))[0].json;
  }

  // ---- Una pasada completa, como la haría n8n
  mundo.pasada = function (ahoraMs) {
    fijarAhora(ahoraMs);
    const trazas = [];
    const pares = correrNodo('Preparar pasada', [{}]);
    const filas = [];
    for (const par of pares) {
      let x = correrNodo('Marcar par', [par])[0];
      x = agente1(par.symbol);
      x = correrNodo('Guardar velas', [x])[0];
      x = correrNodo('Agente 2 · Estrategia', [x])[0];
      x = correrNodo('Preparar gestión', [x])[0];
      x = correrNodo('Agente 4 · Gestionar posiciones', [x])[0];
      x = correrNodo('Armar riesgo', [x])[0];
      x = correrNodo('Agente 3 · Riesgo y conducta', [x])[0];
      x = correrNodo('Armar orden', [x])[0];
      if (x.hayOrden === true) x = correrNodo('Agente 4 · Abrir orden', [x])[0];
      filas.push(correrNodo('Cerrar par', [x])[0]);
    }
    const final = correrNodo('Resultado final', filas)[0];
    almacen = JSON.parse(JSON.stringify(almacen));       // lo que se guarda al terminar la ejecución publicada
    return final;
  };
  return mundo;
}
module.exports = { crearMundo, fijarAhora, RealDate, cargar };
