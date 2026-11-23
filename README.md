# Agente de trading intradía · cuenta DEMO de Alpaca

Estrategia "compra clave" del libro *Day trading* (Oliver Vélez y Greg Capra): solo posiciones largas, solo análisis técnico, 48 acciones de EE. UU.
**Opera únicamente en la cuenta demo (paper) de Alpaca.** La dirección está fija en `paper-api.alpaca.markets` dentro del código; no hay forma de
apuntarla a la cuenta real con una configuración.

> Resultado del backtest (22 meses, 311 operaciones): **la estrategia no mostró ventaja** (R medio neto −0,15 con costos tipo Interactive Brokers).
> Esta demo sirve para comprobar que el agente funciona igual que el backtest y ver qué pasa con datos nuevos. No es una prueba de rentabilidad.

## Cómo funciona

```
Alpaca (velas de 5 min, feed IEX) ──► SOMBRA: Agentes 1 a 4 (código real del orquestador) ──► decisiones
                                                                                               │
Alpaca (cuenta demo) ◄── ESPEJO: copia las decisiones como órdenes reales y vigila cada 20 s ◄─┘
```

* **Sombra** (`src/sombra.js`, `nucleo/`): el mismo código que se probó en el backtest. Decide qué acciones mirar (gap ≥ 1 % y volumen relativo ≥ 1,5 a las 9:45),
  cuándo hay señal, cuánto comprar (0,5 % de 10.000 USD de riesgo por operación) y cómo se desarrolla cada operación.
* **Espejo** (`src/espejo.js`): copia esas decisiones a Alpaca.
  * Orden pendiente de la sombra → orden de compra con stop en Alpaca (se activa al romper el nivel).
  * Al ejecutarse la compra → dos órdenes de salida OCO: la mitad con objetivo en 1R y el resto con el objetivo final, ambas con el stop-loss.
  * Cuando la sombra sube el stop a equilibrio, el espejo sube también el de Alpaca.
  * Si la sombra cierra (p. ej. salida por tiempo) y en Alpaca sigue abierta, se cierra a mercado. A las 15:55 (hora de Nueva York) se cierra todo.
* Los precios de ejecución los pone Alpaca. La diferencia entre lo que "debería" pasar (sombra) y lo que pasó (cuenta demo) es justo lo que se quiere medir.

## Modos

En `config/agente.json`:

| Campo | Valores | Qué hace |
|---|---|---|
| `modo` | `"mirar"` | Hace todo menos enviar órdenes: escribe en la bitácora lo que haría. |
| | `"operar"` (actual) | Envía las órdenes a la cuenta demo. |
| `apagado` | `true` | Interruptor de emergencia: el agente no hace nada. |

Interruptor sin tocar el código: en GitHub, *Settings → Secrets and variables → Actions → Variables*, crea `AGENTE_APAGADO` con valor `1`.

## Puesta en marcha (una sola vez)

1. **Claves de Alpaca (demo).** En alpaca.markets, cuenta *Paper Trading* → generar claves de API. Copia la clave y el secreto.
2. **Guardarlas en GitHub (nunca en un archivo ni en un chat).** En este repositorio: *Settings → Secrets and variables → Actions → New repository secret*.
   Crea dos secretos: `ALPACA_KEY_ID` y `ALPACA_SECRET_KEY`.
3. **Sonda.** *Actions → "Sonda de Alpaca (manual)" → Run workflow*, **con el mercado abierto** (9:30 a 16:00 hora de Nueva York, lunes a viernes).
   Compra 2 acciones de Ford, prueba las órdenes que usa el agente muy lejos del precio y deja todo cerrado. El resultado queda en `datos/sonda.json`.
4. **Un día en modo `mirar`.** El flujo "Agente de trading (demo)" corre solo cada 15 minutos. Revisa `datos/bitacora.jsonl`.
5. **Pasar a `operar`.** Cuando la sonda salga completa y el día en `mirar` se vea bien, cambia `"modo": "operar"` en `config/agente.json`.

## Archivos

* `src/agente.js` bucle principal · `src/alpaca.js` cliente (solo demo) · `src/datos.js` velas de Alpaca en el formato del backtest
* `src/sombra.js` decisiones · `src/espejo.js` órdenes · `src/sonda.js` comprobación de compatibilidad
* `nucleo/` agentes 1 a 4 y simulador de orquestador, copiados sin cambios del proyecto original (excepto `fijarAlmacen`, para guardar el estado entre ejecuciones)
* `datos/estado.json` estado entre ejecuciones · `datos/bitacora.jsonl` registro de todo lo que ocurre
* `test/` pruebas con un Alpaca simulado (necesitan los CSV históricos, que no están en el repositorio)

## Cómo corre en GitHub

Una sola ejecución por día de bolsa, que arranca antes de la apertura (7:53 a. m. de Nueva York en invierno) y vigila cada 20 segundos hasta que termina la
ventana de entradas (11:15) y no queda nada abierto; si hay una operación abierta, sigue hasta que se cierra (como máximo unas 2 horas después). Dura entre 2 y 6 horas.
Hay una segunda hora de arranque como respaldo por si GitHub omite la primera. Con el repositorio **público** los minutos son ilimitados; en uno privado
(2.000 minutos al mes) no alcanzan.

*Por qué no cada 15 minutos:* GitHub no respeta con puntualidad los horarios automáticos frecuentes; el 20 de noviembre de 2026 corrió 9 veces en vez de ~26 y la
primera una hora tarde, así que el agente solo evaluó 1 de las 7 ocasiones de entrada. El modo `pasada` (`--ejecucion pasada`) sigue en el código, pero no se usa.

El agente usa el reloj de Nueva York, así que el horario de verano no obliga a cambiar nada.

## Diferencias conocidas frente al backtest

* **Datos:** el backtest usó velas de todas las bolsas (TwelveData); la demo de Alpaca solo trae el feed IEX en tiempo real (una fracción del volumen).
  Faltan velas en acciones poco negociadas (se rellenan con una vela plana) y el volumen relativo se calcula contra el propio historial IEX.
* **Ejecución:** Alpaca demo no simula deslizamiento ni colas; las compras con stop se ejecutan a mercado al activarse.
* **Stops:** Alpaca no permite poner el stop-loss a una orden de compra con stop, así que se coloca en cuanto el agente ve la posición (hasta ~20 s después).
* **Horario de la cuenta demo:** si Alpaca aplica reglas de operaciones intradía a la cuenta demo, algunas órdenes podrían rechazarse; quedaría en la bitácora.
