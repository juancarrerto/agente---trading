// Pruebas de robustez: fallos de red, interruptor de apagado, guardia de solo-demo, cliente HTTP contra un servidor local, reinicios.
// Uso: node test/pruebas.js <carpeta_csv>
const fs = require('fs'); const path = require('path'); const http = require('http');
const { AlpacaFalso } = require('./alpaca_falso.js');
const { ejecutar } = require('../src/agente.js');
const { crearCliente, ErrorAlpaca } = require('../src/alpaca.js');
const { nyAUtc } = require('../nucleo/backtest/mercado_historico.js');
const dirCsv = process.argv[2];
const cfg0 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agente.json'), 'utf8'));
let ok = 0, mal = 0;
const prueba = (nombre, cond, extra = '') => { (cond ? ok++ : mal++); console.log(`${cond ? 'OK  ' : 'FALLA'} ${nombre}${extra ? ' · ' + extra : ''}`); };
const tmp = n => { const d = path.join('/tmp/claude-0', 'pr_' + n); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const rutasDe = d => ({ estado: path.join(d, 'estado.json'), bitacora: path.join(d, 'bitacora.jsonl'), trabajo: path.join(d, 'velas') });
const leer = d => fs.readFileSync(path.join(d, 'bitacora.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));

(async () => {
  // 1) Guardia: solo cuenta demo
  let msg = ''; try { crearCliente({ keyId: 'x', secret: 'y', urlOperaciones: 'https://api.alpaca.markets/v2' }); } catch (e) { msg = e.message; }
  prueba('el cliente rechaza el servidor de la cuenta real', /solo opera en la cuenta demo/.test(msg));
  msg = ''; try { crearCliente({ keyId: '', secret: '' }); } catch (e) { msg = e.message; }
  prueba('sin claves el cliente no arranca', /Faltan las claves/.test(msg));

  // 2) Cliente HTTP contra un servidor local (formas de las respuestas según la documentación)
  const visto = [];
  const srv = http.createServer((req, res) => {
    let cuerpo = ''; req.on('data', c => cuerpo += c); req.on('end', () => {
      visto.push({ m: req.method, u: req.url, k: req.headers['apca-api-key-id'], s: req.headers['apca-api-secret-key'], cuerpo });
      const url = new URL(req.url, 'http://x');
      const json = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url.pathname === '/data/v2/stocks/bars') {
        if (!url.searchParams.get('page_token')) return json(200, { bars: { AAPL: [{ t: '2025-03-03T14:30:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: 'p2' });
        return json(200, { bars: { AAPL: [{ t: '2025-03-03T14:35:00Z', o: 1.5, h: 2, l: 1, c: 1.8, v: 12 }] }, next_page_token: null });
      }
      if (url.pathname === '/v2/orders' && req.method === 'POST') { const b = JSON.parse(cuerpo); return b.symbol === 'MALO' ? json(422, { message: 'stop price must be greater than base price' }) : json(200, { id: 'o1', status: 'new' }); }
      if (url.pathname === '/v2/account') { if (!global.__falla429) { global.__falla429 = 1; return json(429, { message: 'rate limit' }); } return json(200, { status: 'ACTIVE', equity: '100000' }); }
      json(404, { message: 'no' });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const puerto = srv.address().port;
  const c = crearCliente({ keyId: 'KEY123', secret: 'SEC456', urlOperaciones: `http://127.0.0.1:${puerto}/v2`, urlDatos: `http://127.0.0.1:${puerto}/data/v2`, esperar: async () => {} });
  const v = await c.velas(['AAPL'], '2025-03-03T00:00:00Z', '2025-03-04T00:00:00Z');
  prueba('velas: sigue las páginas', v.AAPL?.length === 2);
  prueba('velas: pide feed IEX y ajuste por splits', visto.some(x => /feed=iex/.test(x.u) && /adjustment=split/.test(x.u) && /timeframe=5Min/.test(x.u)));
  prueba('las claves viajan en las cabeceras', visto.every(x => x.k === 'KEY123' && x.s === 'SEC456'));
  const cu = await c.cuenta();
  prueba('una lectura con error 429 se reintenta y funciona', cu.status === 'ACTIVE' && visto.filter(x => x.u === '/v2/account').length === 2);
  let e422; try { await c.enviarOrden({ symbol: 'MALO', qty: '1', side: 'buy', type: 'stop', stop_price: '1', time_in_force: 'day' }); } catch (e) { e422 = e; }
  prueba('error 422 de una orden: se informa y no se reintenta', e422 instanceof ErrorAlpaca && e422.estado === 422 && visto.filter(x => x.m === 'POST').length === 1);
  srv.close();

  // 3) Interruptor de apagado
  { const d = tmp('apagado'); let sim = nyAUtc(2025, 3, 5, 9, 40); const reloj = { ahora: () => sim, dormir: async ms => { sim += ms; } };
    const f = new AlpacaFalso({ dirCsv, simbolos: cfg0.simbolos.slice(0, 3), ahora: () => sim });
    process.env.AGENTE_APAGADO = '1';
    const r = await ejecutar({ cliente: f, cfg: { ...cfg0, modo: 'operar' }, reloj, rutas: rutasDe(d), salida: () => {} });
    delete process.env.AGENTE_APAGADO;
    prueba('interruptor de apagado: no hace nada', r.terminado === 'apagado' && !f.llamadas.enviarOrden && !f.llamadas.velas); }

  // 4) Día sin mercado (fin de semana)
  { const d = tmp('feriado'); let sim = nyAUtc(2025, 3, 8, 9, 40); const reloj = { ahora: () => sim, dormir: async ms => { sim += ms; } };
    const f = new AlpacaFalso({ dirCsv, simbolos: cfg0.simbolos.slice(0, 3), ahora: () => sim });
    const r = await ejecutar({ cliente: f, cfg: cfg0, reloj, rutas: rutasDe(d), salida: () => {} });
    prueba('sábado: no opera', r.terminado === 'sin_mercado'); }

  // 5) Fallos aleatorios de red durante 12 jornadas, operando: nada se rompe ni se duplica
  { const d = tmp('fallos'); let sim = 0; const reloj = { ahora: () => sim, dormir: async ms => { sim += ms; } };
    const f = new AlpacaFalso({ dirCsv, simbolos: cfg0.simbolos, ahora: () => sim });
    let s = 7; const az = () => (s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296;
    const cliente = new Proxy(f, { get(t, k) { const v = t[k]; if (typeof v !== 'function' || ['_cuenta', '_procesar'].includes(k)) return typeof v === 'function' ? v.bind(t) : v;
      return async (...a) => { const p = /orden|cerrar|enviar|cancelar|reemplazar/i.test(k) ? 0.04 : 0.08; if (az() < p) { if (az() < 0.5) throw new ErrorAlpaca(`Alpaca ${k}: sin respuesta (tiempo agotado)`, 0, null); throw new ErrorAlpaca(`Alpaca ${k} respondió 503: Service Unavailable`, 503, null); } return v.apply(t, a); }; } });
    const dias = f.fechas.filter(x => x >= '2025-03-03' && x <= '2025-03-20');
    for (const fecha of dias) { const [y, m, dd] = fecha.split('-').map(Number); sim = nyAUtc(y, m, dd, 9, 40); f._procesar(); f.proc = null;
      try { await ejecutar({ cliente, cfg: { ...cfg0, modo: 'operar' }, reloj, rutas: rutasDe(d), salida: () => {} }); } catch (e) { console.log('  (la ejecución del', fecha, 'terminó con error:', e.message, ')'); } }
    const L = leer(d);
    const ids = [...f.ordenes.values()].filter(o => o.side === 'buy' && !o.parent_order_id).map(o => o.client_order_id);
    prueba('con fallos de red: no queda ninguna posición abierta', f.pos.size === 0, `${f.pos.size} abiertas`);
    prueba('con fallos de red: no hay entradas duplicadas ni rechazos por id repetido', new Set(ids).size === ids.length && !L.some(x => /must be unique/.test(x.error ?? '')));
    const huerfanas = [...f.ordenes.values()].filter(o => ['new', 'held', 'accepted'].includes(o.status));
    prueba('con fallos de red: no quedan órdenes abiertas al final', huerfanas.length === 0, `${huerfanas.length} abiertas`);
    prueba('hubo fallos y el agente siguió', L.some(x => x.tipo === 'ERROR_LECTURA' || x.tipo === 'ERROR_ORDEN' || x.tipo === 'REINTENTO_DATOS') && L.filter(x => x.tipo === 'FIN').length >= dias.length - 1, `${L.filter(x => /ERROR|REINTENTO/.test(x.tipo)).length} incidentes`); }

  // 6) Velas que faltan (como en IEX): 4 % de huecos, solo mirar
  { const d = tmp('huecos'); let sim = 0; const reloj = { ahora: () => sim, dormir: async ms => { sim += ms; } };
    const f = new AlpacaFalso({ dirCsv, simbolos: cfg0.simbolos, ahora: () => sim, huecos: 0.04, semilla: 3 });
    let errores = 0;
    for (const fecha of f.fechas.filter(x => x >= '2025-03-03' && x <= '2025-03-14')) { const [y, m, dd] = fecha.split('-').map(Number); sim = nyAUtc(y, m, dd, 9, 40); f._procesar(); f.proc = null;
      try { await ejecutar({ cliente: f, cfg: cfg0, reloj, rutas: rutasDe(d), salida: () => {} }); } catch (e) { errores++; console.log('  ', e.message); } }
    const L = leer(d);
    prueba('con 4 % de velas faltantes: corre sin errores', errores === 0 && !L.some(x => x.tipo === 'ERROR_PASADA'), `${L.filter(x => x.tipo === 'PASADA').length} pasadas, ${L.filter(x => x.tipo === 'OPERACION_SOMBRA').length} operaciones`); }

  // 7) La sonda de compatibilidad, contra el Alpaca simulado, con el mercado abierto
  { const { sonda } = require('../src/sonda.js'); let sim = nyAUtc(2025, 3, 5, 11, 2);
    const f = new AlpacaFalso({ dirCsv, simbolos: ['F', 'AAPL'], ahora: () => sim });
    const r = await sonda({ cliente: f, esperar: async ms => { sim += ms; }, ahora: () => sim, salida: '/tmp/claude-0/pr_sonda.json' });
    prueba('la sonda completa todos los pasos contra el simulador', r.todoBien === true, r.pasos.filter(p => !p.ok).map(p => p.nombre + ': ' + p.error).join(' | '));
    prueba('la sonda deja la cuenta limpia', f.pos.size === 0 && [...f.ordenes.values()].every(o => !['new', 'held', 'accepted'].includes(o.status)));
    sim = nyAUtc(2025, 3, 5, 17, 0);
    const f2 = new AlpacaFalso({ dirCsv, simbolos: ['F'], ahora: () => sim });
    const r2 = await sonda({ cliente: f2, esperar: async ms => { sim += ms; }, ahora: () => sim });
    prueba('la sonda sin mercado abierto lo avisa y no opera', r2.pasos[0]?.nombre === 'mercado abierto' && r2.pasos[0].ok === false && !f2.llamadas.enviarOrden); }

  console.log(`\n${ok} pruebas bien, ${mal} con falla`);
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
