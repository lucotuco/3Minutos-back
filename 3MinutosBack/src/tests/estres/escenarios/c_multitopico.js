'use strict';

/**
 * Escenario C - Digests de 3 tópicos que se pisan entre sí.
 * Un digest real son exactamente 3 tópicos. Acá se arman tríos con tópicos solapados
 * (categoría + subtemas de la misma categoría, tríos reales de usuarios, populares contiguos)
 * y se prueban en las 6 permutaciones. Busca:
 *   - la misma nota (o la misma historia) para dos tópicos del mismo digest,
 *   - tópicos cuyo resultado cambia según la posición en la lista ("el 3.º recibe las sobras"),
 *   - llamadas que fallan o violan invariantes.
 */

const { norm } = require('../../comparar/utilidades');
const { CATEGORIAS } = require('../../comparar/temas');
const { CONTRATO } = require('../config');
const { analizarMultitopico } = require('../analisis_cef');
const { muestrear, barajar, permutaciones } = require('../estadisticas');
const { verificarLlamada } = require('../invariantes');
const { pool, progreso, resultadosCompactos, clasificarTema } = require('./util');

const ID = 'C';
const NOMBRE = 'Digests de 3 tópicos solapados';

/** Intercala varias listas de tríos y devuelve hasta n sin repetir (ni tópicos repetidos dentro de un trío). */
function armarTriplas(ctx, n) {
  const oficiales = Object.entries(CATEGORIAS).map(([cat, subs]) => [cat, subs[0], subs[1]]);
  const reales = muestrear(ctx.usuarios, n, ctx.rng).map((u) => u.topics.slice(0, CONTRATO.topicosPorUsuario));
  const libres = ctx.temas.libres.map((t) => t.tema);
  const contiguos = [];
  for (let i = 0; i + 2 < libres.length; i += 3) contiguos.push(libres.slice(i, i + 3));

  const fuentes = [oficiales, reales, contiguos].map((l) => [...l]);
  const out = [];
  const vistos = new Set();
  while (out.length < n && fuentes.some((f) => f.length)) {
    for (const f of fuentes) {
      const trio = f.shift();
      if (!trio || out.length >= n) continue;
      const claves = trio.map((t) => norm(t).replace(/\s+/g, ' '));
      const clave = [...claves].sort().join('|');
      if (trio.length !== CONTRATO.topicosPorUsuario || new Set(claves).size !== trio.length || vistos.has(clave)) continue;
      vistos.add(clave);
      out.push(trio);
    }
  }
  return out;
}

async function correr(ctx) {
  const { nivel } = ctx;
  const triplas = armarTriplas(ctx, nivel.C.triplas);
  const tareas = [];
  triplas.forEach((topics, tripla) => {
    const ordenes = nivel.C.permutar ? permutaciones(topics) : [topics];
    for (const orden of ordenes) for (let rep = 1; rep <= nivel.C.repeticiones; rep++) tareas.push({ tripla, orden, rep });
  });
  const tick = progreso(ctx, 'C multi-tópico', tareas.length);
  const filas = [];

  const erroresInternos = await pool(barajar(tareas, ctx.rng), nivel.concurrencia, async ({ tripla, orden, rep }) => {
    const salida = await ctx.pick(orden);
    const esperados = orden.map((t) => clasificarTema(t));
    filas.push({
      t: Date.now(), tripla, orden, rep, ms: salida.ms, error: salida.error, timeout: salida.timeout,
      resultados: resultadosCompactos(salida),
      violaciones: salida.resultados ? verificarLlamada({ topics: orden, resultados: salida.resultados, esperados, ahora: salida.ahora }) : [],
      logs: salida.logs || null,
    });
    tick();
  }, ctx.detener);

  let vectores = null;
  try {
    const ids = filas.flatMap((f) => f.resultados.map((r) => r.art?.id)).filter(Boolean);
    vectores = ids.length ? await ctx.embeddings(ids) : null;
  } catch (e) {
    erroresInternos.push(`no se pudieron leer embeddings: ${e.message}`);
  }

  const analisis = analizarMultitopico(filas, { vectores });
  return {
    id: ID, nombre: NOMBRE, parcial: filas.length < tareas.length, llamadasPlaneadas: tareas.length,
    triplas, filas, erroresInternos, usoEmbeddingsReales: Boolean(vectores && vectores.size), ...analisis,
  };
}

module.exports = { ID, NOMBRE, correr, armarTriplas };
