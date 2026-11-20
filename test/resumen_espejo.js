// Resume qué pasó en la cuenta demo simulada frente a la sombra: operaciones, errores y diferencias de resultado.
// Uso: node test/resumen_espejo.js <carpeta_salida_de_prueba_paridad>
const fs = require('fs');
const dir = process.argv[2];
const L = fs.readFileSync(`${dir}/bitacora.jsonl`, 'utf8').trim().split('\n').map(x => JSON.parse(x));
const sombra = L.filter(x => x.tipo === 'OPERACION_SOMBRA');
const real = JSON.parse(fs.readFileSync(`${dir}/real_simulado.json`, 'utf8'));
const c = {}; for (const x of L) c[x.tipo] = (c[x.tipo] || 0) + 1;
console.log('eventos:', JSON.stringify(c));
console.log('errores de órdenes:', [...new Set(L.filter(x => x.tipo === 'ERROR_ORDEN').map(x => `${x.rol}: ${x.error}`))].slice(0, 6));
const pnlSombra = sombra.reduce((a, t) => a + t.pnlUSD, 0);
const cierres = L.filter(x => x.tipo === 'POSICION_CERRADA');
console.log(`sombra: ${sombra.length} operaciones, resultado ${pnlSombra.toFixed(2)} USD · cuenta simulada: resultado ${real.realizado.toFixed(2)} USD · cierres a mercado ${cierres.length}: ${JSON.stringify(cierres.reduce((a, x) => (a[x.motivo] = (a[x.motivo] || 0) + 1, a), {}))}`);
const entradas = real.ordenes.filter(o => o.side === 'buy' && o.status === 'filled' && !o.parent_order_id);
console.log(`entradas ejecutadas en la cuenta simulada: ${entradas.length} (la sombra abrió ${sombra.length})`);
