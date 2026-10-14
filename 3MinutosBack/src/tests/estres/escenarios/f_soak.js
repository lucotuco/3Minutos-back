'use strict';

/**
 * Escenario F - Soak (carga sostenida).
 * Mantiene `concurrencia` llamadas en paralelo durante N minutos, con ~10 % de tópicos únicos
 * (obligan a una expansión nueva y engordan queryExpansionCache). Cada 15 s toma una muestra de
 * memoria, lag del event loop, latencia p95 y errores, y busca crecimiento sostenido de heap,
 * degradación de latencia y errores que aparecen con el tiempo.
 * Conviene correrlo con `node --expose-gc` (npm run test:estres ya lo hace) para que el heap sea comparable.
 */

const { analizarSoak } = require('../analisis_cef');
const { percentil } = require('../estadisticas');

const ID = 'F';
const NOMBRE = 'Soak (carga sostenida)';

async function correr(ctx) {
  const minutos = Number(ctx.nivel.F.minutos) || 0;
  if (minutos <= 0) return null;

  const todos = [...ctx.temas.libres, ...ctx.temas.oficiales];
  if (!todos.length) return null;
  const c = Math.max(2, ctx.nivel.concurrencia);
  const intervaloMs = ctx.nivel.F.intervaloMs || 15000;
  const nonce = Math.floor(ctx.rng() * 36 ** 4).toString(36).padStart(4, '0');
  const t0 = Date.now();
  const fin = t0 + minutos * 60000;
  const muestras = [];
  let ventana = { ms: [], tareas: 0, errores: 0 };
  let tareasTotales = 0;
  let sinteticos = 0;

  const tomarMuestra = () => {
    if (typeof global.gc === 'function') global.gc();
    const mem = ctx.memoria();
    const lag = ctx.lag.leerYReiniciar();
    muestras.push({
      minuto: (Date.now() - t0) / 60000, heapMB: mem.heapMB, rssMB: mem.rssMB, lagP99: lag.p99,
      tareas: ventana.tareas, errores: ventana.errores, p95: percentil(ventana.ms, 95),
    });
    ventana = { ms: [], tareas: 0, errores: 0 };
  };
  ctx.lag.leerYReiniciar();
  const timer = setInterval(tomarMuestra, intervaloMs);

  const worker = async (w) => {
    let i = w;
    while (Date.now() < fin && !ctx.detener()) {
      const unico = ctx.rng() < 0.1;
      const topic = unico ? `soak ${++sinteticos} ${nonce}` : todos[(i += c) % todos.length].tema;
      const salida = await ctx.pick([topic]);
      ventana.tareas++;
      tareasTotales++;
      ventana.ms.push(salida.ms);
      if (salida.error || salida.resultados?.[0]?.matchReason === 'error_busqueda') ventana.errores++;
    }
  };
  try {
    await Promise.all(Array.from({ length: c }, (_, w) => worker(w)));
  } finally {
    clearInterval(timer);
  }
  tomarMuestra();

  const analisis = analizarSoak(muestras);
  return {
    id: ID, nombre: NOMBRE, parcial: Date.now() < fin - 1000, muestras, erroresInternos: [],
    resumen: { ...analisis.resumen, tareas: tareasTotales, topicosUnicos: sinteticos, concurrencia: c },
    hallazgos: analisis.hallazgos,
  };
}

module.exports = { ID, NOMBRE, correr };
