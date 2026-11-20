// Cliente de Alpaca (solo cuenta DEMO / paper). Sin dependencias: usa fetch de Node 20+.
// Claves: variables de entorno ALPACA_KEY_ID y ALPACA_SECRET_KEY (en GitHub: Settings > Secrets). Nunca se escriben en archivos ni en la bitácora.
//
// Seguro por diseño: la dirección de operaciones está fija en paper-api.alpaca.markets. No hay forma de apuntarla a la cuenta real
// con una variable de entorno; hay que editar este archivo a propósito.
const URL_OPERACIONES = 'https://paper-api.alpaca.markets/v2';
const URL_DATOS = 'https://data.alpaca.markets/v2';

class ErrorAlpaca extends Error {
  constructor(mensaje, estado, cuerpo) { super(mensaje); this.estado = estado; this.cuerpo = cuerpo; }
}

function crearCliente({ keyId = process.env.ALPACA_KEY_ID, secret = process.env.ALPACA_SECRET_KEY, fetchFn = globalThis.fetch,
  urlOperaciones = URL_OPERACIONES, urlDatos = URL_DATOS, esperar = ms => new Promise(r => setTimeout(r, ms)), reintentos = 3, timeoutMs = 20000 } = {}) {
  if (!keyId || !secret) throw new Error('Faltan las claves de Alpaca (ALPACA_KEY_ID y ALPACA_SECRET_KEY).');
  // Guardia: solo se acepta el servidor de paper (el parámetro existe para las pruebas con un servidor local)
  const esLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(urlOperaciones + '/');
  if (!esLocal && new URL(urlOperaciones).host !== 'paper-api.alpaca.markets') throw new Error('Por seguridad este agente solo opera en la cuenta demo (paper-api.alpaca.markets).');
  const cabeceras = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret, accept: 'application/json' };

  async function pedir(base, metodo, ruta, { consulta, cuerpo } = {}) {
    const q = consulta ? '?' + new URLSearchParams(Object.entries(consulta).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
    let ultimo;
    for (let i = 0; i <= reintentos; i++) {
      const ctl = new AbortController();
      const temporizador = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetchFn(base + ruta + q, { method: metodo, headers: cuerpo ? { ...cabeceras, 'content-type': 'application/json' } : cabeceras, body: cuerpo ? JSON.stringify(cuerpo) : undefined, signal: ctl.signal });
        const texto = await r.text();
        let json = null;
        try { json = texto ? JSON.parse(texto) : null; } catch { /* respuesta sin JSON */ }
        if (r.ok) return json;
        const e = new ErrorAlpaca(`Alpaca ${metodo} ${ruta} respondió ${r.status}: ${json?.message ?? texto.slice(0, 200)}`, r.status, json);
        // 429 y 5xx se reintentan solo en lecturas (GET) y cancelaciones; las órdenes nuevas no se repiten solas (podrían duplicarse)
        const reintentable = (r.status === 429 || r.status >= 500) && (metodo === 'GET' || metodo === 'DELETE');
        if (!reintentable || i === reintentos) throw e;
        ultimo = e;
      } catch (e) {
        if (e instanceof ErrorAlpaca) { ultimo = e; if (!((e.estado === 429 || e.estado >= 500) && (metodo === 'GET' || metodo === 'DELETE')) || i === reintentos) throw e; }
        else {
          const sinRespuesta = new ErrorAlpaca(`Alpaca ${metodo} ${ruta}: sin respuesta (${e.name === 'AbortError' ? 'tiempo agotado' : e.message})`, 0, null);
          if (metodo !== 'GET' && metodo !== 'DELETE') throw sinRespuesta;     // una orden sin respuesta puede haber llegado: se confirma consultando, no repitiendo
          ultimo = sinRespuesta; if (i === reintentos) throw sinRespuesta;
        }
      } finally { clearTimeout(temporizador); }
      await esperar(500 * 2 ** i);
    }
    throw ultimo;
  }
  const op = (m, r, o) => pedir(urlOperaciones, m, r, o);
  const dat = (m, r, o) => pedir(urlDatos, m, r, o);

  return {
    esPaper: true,
    cuenta: () => op('GET', '/account'),
    reloj: () => op('GET', '/clock'),
    calendario: (inicio, fin) => op('GET', '/calendar', { consulta: { start: inicio, end: fin } }),
    posiciones: () => op('GET', '/positions'),
    ordenesAbiertas: () => op('GET', '/orders', { consulta: { status: 'open', nested: 'true', limit: 500, direction: 'desc' } }),
    ordenesDesde: (desdeIso) => op('GET', '/orders', { consulta: { status: 'all', nested: 'true', limit: 500, after: desdeIso, direction: 'asc' } }),
    orden: id => op('GET', `/orders/${encodeURIComponent(id)}`),
    enviarOrden: cuerpo => op('POST', '/orders', { cuerpo }),
    cancelarOrden: id => op('DELETE', `/orders/${encodeURIComponent(id)}`),
    reemplazarOrden: (id, cambios) => op('PATCH', `/orders/${encodeURIComponent(id)}`, { cuerpo: cambios }),
    cerrarPosicion: simbolo => op('DELETE', `/positions/${encodeURIComponent(simbolo)}`),
    // Velas de 5 minutos de varias acciones (feed IEX: es el único en tiempo real del plan gratuito). Devuelve { SIMBOLO: [{t,o,h,l,c,v}] }
    async velas(simbolos, inicioIso, finIso, { timeframe = '5Min', feed = 'iex' } = {}) {
      const salida = {};
      for (let i = 0; i < simbolos.length; i += 50) {
        let token;
        do {
          const r = await dat('GET', '/stocks/bars', { consulta: { symbols: simbolos.slice(i, i + 50).join(','), timeframe, start: inicioIso, end: finIso, limit: 10000, adjustment: 'split', feed, sort: 'asc', page_token: token } });
          for (const [s, arr] of Object.entries(r?.bars ?? {})) (salida[s] ||= []).push(...arr);
          token = r?.next_page_token ?? null;
        } while (token);
      }
      return salida;
    }
  };
}
module.exports = { crearCliente, ErrorAlpaca, URL_OPERACIONES, URL_DATOS };
