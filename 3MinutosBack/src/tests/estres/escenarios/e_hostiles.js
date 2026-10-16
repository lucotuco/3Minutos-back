'use strict';

/**
 * Escenario E - Tópicos hostiles y variantes de escritura.
 *   E1  textos que un usuario (o un bug del front) podría mandar: vacíos, gigantes, emoji, regex,
 *       operadores de Mongo, "constructor", etc. pickBestArticlePerTopic NUNCA debe lanzar una
 *       excepción ni colgarse; si la búsqueda falla por el texto, se anota como hallazgo.
 *   E2  el mismo tópico escrito de 4-5 maneras (minúsculas, MAYÚSCULAS, Capitalizado, sin acentos):
 *       tendría que resolverse igual.
 */

const { hostilesDe, describirValor, variantesDe } = require('../config');
const { analizarHostiles } = require('../analisis_cef');
const { pool, progreso, filaDeUnTopico } = require('./util');

const ID = 'E';
const NOMBRE = 'Tópicos hostiles y variantes de escritura';

async function correr(ctx) {
  const { nivel } = ctx;
  const hostiles = hostilesDe(nivel.E.hostiles);
  const tareas = [];
  for (const h of hostiles) for (let rep = 1; rep <= nivel.E.repeticiones; rep++) tareas.push({ h, rep });
  const bases = ctx.temas.libres.slice(0, nivel.E.variantes);
  const totalVariantes = bases.reduce((acc, b) => acc + variantesDe(b.tema).length, 0);
  const tick = progreso(ctx, 'E hostiles y variantes', tareas.length + totalVariantes);

  const filasHostiles = [];
  const filasVariantes = [];
  const libre = { tipo: 'libre', nivel: 'libre', categoria: null };

  const erroresInternos = await pool(tareas, nivel.concurrencia, async ({ h, rep }) => {
    const salida = await ctx.pick([h.valor]);
    const fila = filaDeUnTopico({ salida, topic: h.valor, esperado: libre });
    filasHostiles.push({
      ...fila, id: h.id, grupo: h.grupo, valorDesc: describirValor(h.valor), rep,
      lanzo: Boolean(salida.error && !salida.timeout),
      nResultados: salida.resultados ? salida.resultados.length : 0,
    });
    tick();
  }, ctx.detener);

  // Por tópico las variantes van en serie: la primera (original) deja la expansión en caché, como en producción.
  erroresInternos.push(...await pool(bases, nivel.concurrencia, async (base) => {
    for (const v of variantesDe(base.tema)) {
      if (ctx.detener()) break;
      const salida = await ctx.pick([v.valor]);
      const fila = filaDeUnTopico({ salida, topic: v.valor, esperado: libre });
      filasVariantes.push({
        base: base.tema, varianteId: v.id, valor: v.valor, clase: fila.clase, url: fila.art?.url ?? null,
        zona: fila.zona, ms: fila.ms, error: fila.error, violaciones: fila.violaciones,
      });
      tick();
    }
  }, ctx.detener));

  const analisis = analizarHostiles({ hostiles: filasHostiles, variantes: filasVariantes }, { timeoutS: nivel.timeoutS });
  const total = tareas.length + totalVariantes;
  return {
    id: ID, nombre: NOMBRE, parcial: filasHostiles.length + filasVariantes.length < total, llamadasPlaneadas: total,
    hostiles: filasHostiles, variantes: filasVariantes, erroresInternos, ...analisis,
  };
}

module.exports = { ID, NOMBRE, correr };
