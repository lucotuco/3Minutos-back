'use strict';

/**
 * Escenario A - Repetición por tópico.
 * Cada tópico (oficiales + libres populares) se consulta N veces, SIN historial, con la misma
 * entrada. Con la base quieta, el resultado tiene que ser siempre el mismo. Busca:
 *   - tópicos que cambian de nota de ida y vuelta (no determinismo),
 *   - a veces tema / a veces rescate (errores de infraestructura disfrazados),
 *   - la misma nota entregada a muchos tópicos distintos (rescate "monocultivo"),
 *   - violaciones de invariantes (edad, categoría, zona, trazabilidad).
 */

const { analizarRepeticiones } = require('../analisis_ab');
const { barajar } = require('../estadisticas');
const { pool, progreso, filaDeUnTopico } = require('./util');

const ID = 'A';
const NOMBRE = 'Repetición por tópico';

async function correr(ctx) {
  const { nivel } = ctx;
  const temas = [...ctx.temas.oficiales, ...ctx.temas.libres];
  const reps = nivel.A.repeticiones;
  const total = temas.length * reps;
  const tick = progreso(ctx, 'A repetición', total);
  const filas = [];
  const erroresInternos = [];

  const unaLlamada = async ({ tema, rep }) => {
    const salida = await ctx.pick([tema.tema]);
    filas.push(filaDeUnTopico({
      salida,
      topic: tema.tema,
      esperado: { tipo: tema.tipo, categoria: tema.categoria },
      extra: { tema: tema.tema, tipo: tema.tipo, nivel: tema.nivel, categoria: tema.categoria, rep },
    }));
    tick();
  };

  // Pasada 1: una llamada por tópico (calienta la caché de expansiones, sin ráfagas del mismo tópico).
  const primeras = barajar(temas, ctx.rng).map((tema) => ({ tema, rep: 1 }));
  erroresInternos.push(...await pool(primeras, nivel.concurrencia, unaLlamada, ctx.detener));

  // Pasada 2: el resto de las repeticiones, mezcladas con las de otros tópicos.
  const resto = [];
  for (const tema of temas) for (let rep = 2; rep <= reps; rep++) resto.push({ tema, rep });
  erroresInternos.push(...await pool(barajar(resto, ctx.rng), nivel.concurrencia, unaLlamada, ctx.detener));

  const analisis = analizarRepeticiones(filas, { timeoutS: nivel.timeoutS });
  return { id: ID, nombre: NOMBRE, parcial: filas.length < total, llamadasPlaneadas: total, filas, erroresInternos, ...analisis };
}

module.exports = { ID, NOMBRE, correr };
