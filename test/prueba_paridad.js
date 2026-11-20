// Prueba de paridad: el agente en vivo (con Alpaca de mentira y un reloj simulado) repite días históricos y sus decisiones deben ser
// IDÉNTICAS a las del backtest. Con modo "operar" además revisa el espejo (qué pasó en la cuenta demo simulada).
// Uso: node test/prueba_paridad.js <carpeta_csv> <desde> <hasta> <mirar|operar> <carpeta_salida> [huecos]
const fs = require('fs');
const path = require('path');
const { AlpacaFalso } = require('./alpaca_falso.js');
const { ejecutar } = require('../src/agente.js');
const { nyAUtc } = require('../nucleo/backtest/mercado_historico.js');
const [dirCsv, desde, hasta, modo, salida, huecos = '0', forma = 'diario'] = process.argv.slice(2);
fs.rmSync(salida, { recursive: true, force: true }); fs.mkdirSync(salida, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agente.json'), 'utf8'));
cfg.modo = modo;
let sim = 0;
const reloj = { ahora: () => sim, dormir: async ms => { sim += ms; } };
const fake = new AlpacaFalso({ dirCsv, simbolos: cfg.simbolos, ahora: () => sim, huecos: +huecos });
const rutas = { estado: path.join(salida, 'estado.json'), bitacora: path.join(salida, 'bitacora.jsonl'), trabajo: path.join(salida, 'velas') };
(async () => {
  const dias = fake.fechas.filter(f => f >= desde && f <= hasta);
  const t0 = Date.now();
  for (const [i, f] of dias.entries()) {
    const [y, m, d] = f.split('-').map(Number);
    let r;
    if (forma === 'pasada') {                                    // una ejecución por cada pasada de 15 minutos, como haría GitHub Actions
      cfg.ejecucion = 'pasada';
      for (let m15 = 9 * 60 + 45; m15 <= 16 * 60; m15 += 15) {
        sim = nyAUtc(y, m, d, 0, 0) + m15 * 60000 + 25000;
        fake._procesar();
        r = await ejecutar({ cliente: fake, cfg, reloj, rutas, salida: () => {} });
        if (r.terminado === 'sin_mercado') break;
      }
    } else {
      sim = nyAUtc(y, m, d, 9, 40);
      fake._procesar(); fake.proc = null;
      r = await ejecutar({ cliente: fake, cfg, reloj, rutas, salida: () => {} });
    }
    if (i % 10 === 9 || i === dias.length - 1) console.error(`día ${i + 1}/${dias.length} ${f} · ${r.terminado} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const L = fs.readFileSync(rutas.bitacora, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  const trades = L.filter(x => x.tipo === 'OPERACION_SOMBRA');
  fs.writeFileSync(path.join(salida, 'operaciones_sombra.json'), JSON.stringify(trades));
  const conteo = {}; for (const x of L) conteo[x.tipo] = (conteo[x.tipo] || 0) + 1;
  console.log('días', dias.length, '· operaciones de la sombra', trades.length, '· eventos', JSON.stringify(conteo));
  console.log('Alpaca simulada: resultado realizado', fake.realizado.toFixed(2), 'USD · posiciones abiertas al final', fake.pos.size, '· llamadas', JSON.stringify(fake.llamadas));
  fs.writeFileSync(path.join(salida, 'real_simulado.json'), JSON.stringify({ realizado: fake.realizado, ordenes: [...fake.ordenes.values()] }));
})().catch(e => { console.error('ERROR', e); process.exit(1); });
