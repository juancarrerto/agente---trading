// "Sombra": el agente completo (Agentes 1 a 4 del orquestador, código REAL de cada nodo) corriendo sobre los datos en vivo.
// Decide todo: qué acciones mirar, cuándo hay señal, cuánto comprar, y cómo se desarrolla cada operación (entrada, parcial, equilibrio,
// objetivo, salida por tiempo). El Agente 4 aquí es el motor de papel: calcula lo que DEBERÍA pasar con las velas.
// El espejo (espejo.js) copia esas decisiones a la cuenta demo de Alpaca. Los parches de abajo son los mismos del backtest.
const fs = require('fs');
const path = require('path');
const NUCLEO = path.join(__dirname, '..', 'nucleo');
const { crearMundo, RealDate } = require(path.join(NUCLEO, 'scripts', 'mundo_orquestador.js'));
const FakeDate = global.Date;          // el arnés reemplaza Date por una fecha controlable; se usa SOLO dentro de cada pasada
global.Date = RealDate;
const conFechaFalsa = fn => { global.Date = FakeDate; try { return fn(); } finally { global.Date = RealDate; } };

const SIN_COSTOS = { friccionPct: { forex: 0, cripto: 0, otros: 0 } };      // los costos reales los cobra (o no) el broker

function crearSombra(cfg) {
  const A = { ventanas: [['09:35', '11:15']], cierreSesion: null, riesgo: {}, ...cfg };
  const mundo = crearMundo(NUCLEO);
  mundo.esAccion = true;
  const nodo = n => mundo.orq.nodes.find(x => x.name === n);
  const ctx = { mercado: null, candidatos: [], enVentana: false };
  for (const s of A.simbolos) mundo.mercado[s] = ahora => ctx.mercado.en(s, ahora);

  const HORARIO = JSON.stringify({ ...A.riesgo, horario: { modo: 'personalizado', zona: 'America/New_York', ventanas: A.ventanas, dias: [1, 2, 3, 4, 5] } });
  const PARAM_A4 = JSON.stringify({ ...SIN_COSTOS, ...(A.cierreSesion ? { cierreSesion: A.cierreSesion, zonaCierre: 'America/New_York' } : {}) });
  {
    const codigo = fs.readFileSync(path.join(NUCLEO, 'agente4', 'papel_cierre.js'), 'utf8');       // el mismo motor con el cierre de sesión opcional (apagado por defecto)
    for (const n of ['Agente 4 · Gestionar posiciones', 'Agente 4 · Abrir orden']) nodo(n).parameters.jsCode = codigo;
    const prep = nodo('Preparar pasada');
    if (!/const PARES = \[[\s\S]*?\];/.test(prep.parameters.jsCode)) throw new Error('no encuentro la lista de pares');
    prep.parameters.jsCode = prep.parameters.jsCode.replace(/const PARES = \[[\s\S]*?\];/, 'const PARES = globalThis.__PARES();');
    const pg = nodo('Preparar gestión'), ao = nodo('Armar orden'), ar = nodo('Armar riesgo');
    const b = 'return [{ json: { estado: sd.estado, velas } }];';
    const c = 'velas: {} } }];';
    const d = 'cuenta: { capital: sd.estado.capital }, estado: sd.estado } }];';
    if (!pg.parameters.jsCode.includes(b) || !ao.parameters.jsCode.includes(c) || !ar.parameters.jsCode.includes(d)) throw new Error('no encuentro el texto a cambiar');
    const rev = 'revisionHecha: (sd.estado.perdidasDesdeRevision ?? 0) >= 5';     // igual que en el backtest: tras 5 pérdidas se da por revisado el diario
    pg.parameters.jsCode = pg.parameters.jsCode.replace(b, `return [{ json: { estado: sd.estado, velas, ${rev}, parametros: ${PARAM_A4} } }];`);
    ao.parameters.jsCode = ao.parameters.jsCode.replace(c, `velas: {}, parametros: ${PARAM_A4} } }];`);
    ar.parameters.jsCode = ar.parameters.jsCode.replace(d, `cuenta: { capital: sd.estado.capital }, estado: sd.estado, parametros: ${HORARIO} } }];`);
  }

  globalThis.__PARES = () => {
    const est = mundo.almacen().estado ?? {};
    const abiertos = new Set([...(est.posiciones ?? []), ...(est.ordenesPendientes ?? [])].map(x => x.simbolo));
    const hay = s => !!ctx.mercado?.datos?.[s];
    return [...new Set([...(ctx.enVentana ? ctx.candidatos : []), ...abiertos])].filter(hay);
  };

  let R;
  mundo.alSalir = (nombre, salidas) => {
    const s = salidas[0] ?? {};
    if (nombre === 'Agente 2 · Estrategia') {
      const d = s.decision;
      const k = d ? `${d.plazo}:${d.estado}` : (s.ok === false ? 'sin_datos' : 'sin_senal');
      R.senales[k] = (R.senales[k] || 0) + 1;
    } else if (nombre === 'Agente 3 · Riesgo y conducta') {
      R.veredictos[s.veredicto] = (R.veredictos[s.veredicto] || 0) + 1;
      if (s.veredicto === 'RECHAZADA') for (const m of s.motivos ?? []) { const k = m.replace(/[\d.,]+/g, '#').slice(0, 90); R.motivos[k] = (R.motivos[k] || 0) + 1; }
      if (s.orden) R.ordenes.push(s.orden);
    } else if (nombre === 'Agente 4 · Gestionar posiciones' || nombre === 'Agente 4 · Abrir orden') {
      for (const e of s.eventos ?? []) R.eventos.push(e);
      for (const f of s.diarioNuevo ?? []) R.trades.push(f);
      if (s.error) R.errores.push({ nombre, error: s.error });
    } else if (nombre === 'Cerrar par') {
      if (!s.datosOk) R.datosMalos.push(s.simbolo);
    }
  };

  return {
    mundo, ctx,
    estado: () => mundo.almacen(),
    fijarAlmacen: a => mundo.fijarAlmacen(a ?? {}),
    // Una pasada completa en el instante tMs (ms). 'mercado' = lector de velas hasta tMs; 'candidatos' = acciones en juego del día.
    pasada(tMs, { mercado, candidatos, enVentana }) {
      ctx.mercado = mercado; ctx.candidatos = candidatos; ctx.enVentana = enVentana;
      R = { senales: {}, veredictos: {}, motivos: {}, ordenes: [], eventos: [], trades: [], errores: [], datosMalos: [] };
      const pares = globalThis.__PARES();
      if (!pares.length) return { ...R, pares: 0, omitida: true };
      const final = conFechaFalsa(() => mundo.pasada(tMs));
      return { ...R, pares: pares.length, omitida: false, resumen: final };
    }
  };
}
module.exports = { crearSombra };
