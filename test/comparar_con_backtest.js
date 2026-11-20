// Compara las operaciones de la sombra (agente en vivo con datos simulados) con las del backtest. Deben ser idénticas.
// Uso: node test/comparar_con_backtest.js <bt.json> <operaciones_sombra.json>
const fs = require('fs');
const bt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).trades;
const vivo = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const k = t => [t.simbolo, t.apertura, t.cierre, +t.entrada, +(t.salidaFinal ?? t.salida), t.unidades, t.motivoSalida ?? t.motivo, +t.R, +t.pnlUSD].join('|');
const A = bt.map(k).sort(), B = vivo.map(k).sort();
const soloA = A.filter(x => !B.includes(x)), soloB = B.filter(x => !A.includes(x));
console.log(`backtest: ${A.length} operaciones · agente en vivo: ${B.length} operaciones · idénticas: ${A.length - soloA.length}`);
if (soloA.length || soloB.length) { console.log('solo en backtest:', soloA.slice(0, 8)); console.log('solo en vivo:', soloB.slice(0, 8)); process.exit(1); }
console.log('PARIDAD COMPLETA');
