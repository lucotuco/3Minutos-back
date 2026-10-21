'use strict';

/**
 * Piezas comunes de los escenarios. Nada acá se conecta a Mongo/OpenAI: todo pasa por el ctx
 * (ctx.pick, ctx.digest, …), que en los tests unitarios se reemplaza por funciones falsas.
 */

const { norm } = require('../../comparar/utilidades');
const { temasOficiales } = require('../../comparar/temas');
const { barajar } = require('../estadisticas');
const { clasificar, resumenArticulo, mencionaAlguna, verificarLlamada, verificarResultado } = require('../invariantes');

const OFICIALES_POR_NOMBRE = new Map(temasOficiales().map((t) => [norm(t.tema).replace(/\s+/g, ' '), t]));

/** { tipo, nivel, categoria } esperado para un texto de tópico (oficial si coincide con la taxonomía). */
function clasificarTema(nombre) {
  const oficial = OFICIALES_POR_NOMBRE.get(norm(nombre).replace(/\s+/g, ' '));
  return oficial
    ? { tipo: 'oficial', nivel: oficial.nivel, categoria: oficial.categoria }
    : { tipo: 'libre', nivel: 'libre', categoria: null };
}

/** Ejecuta trabajo(item, i) con a lo sumo `concurrencia` tareas a la vez. Devuelve los errores internos. */
async function pool(items, concurrencia, trabajo, detener = () => false) {
  const errores = [];
  let siguiente = 0;
  const workers = Array.from({ length: Math.max(1, concurrencia) }, async () => {
    while (!detener()) {
      const i = siguiente++;
      if (i >= items.length) return;
      try { await trabajo(items[i], i); } catch (e) { errores.push(e.message || String(e)); }
    }
  });
  await Promise.all(workers);
  return errores;
}

/** Devuelve tick() que imprime el avance cada ~10 % (o cada `cada` tareas). */
function progreso(ctx, etiqueta, total, cada = Math.max(1, Math.ceil(total / 10))) {
  let hechos = 0;
  const t0 = Date.now();
  return () => {
    hechos++;
    if (hechos % cada === 0 || hechos === total) {
      ctx.log(`   ${etiqueta}: ${hechos}/${total} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  };
}

/**
 * Fila estándar a partir de una llamada de UN tópico.
 * salida = lo que devuelve ctx.pick; extra = campos propios del escenario.
 */
function filaDeUnTopico({ salida, topic, esperado, historial = null, extra = {} }) {
  const r = salida.resultados && salida.resultados[0] ? salida.resultados[0] : null;
  const violaciones = salida.resultados
    ? verificarLlamada({ topics: [topic], resultados: salida.resultados, esperados: [esperado], historial, ahora: salida.ahora })
    : [];
  return {
    t: Date.now(),
    ms: salida.ms,
    error: salida.error,
    timeout: salida.timeout,
    clase: salida.error ? 'error' : clasificar(r),
    zona: r?.matchZone ?? null,
    motivo: r?.matchReason ?? null,
    corral: r?.corralCategory ?? null,
    candidatos: r?.candidatesEvaluated ?? null,
    art: r?.article ? resumenArticulo(r.article, salida.ahora) : null,
    menciona: esperado.tipo === 'libre' && r?.article ? mencionaAlguna(topic, r.article) : null,
    violaciones,
    logs: salida.logs || null,
    ...extra,
  };
}

/** Resultados de una llamada de varios tópicos, en el formato compacto de los reportes. */
function resultadosCompactos(salida) {
  return (salida.resultados || []).map((r) => ({
    topic: r.topic,
    clase: clasificar(r),
    zona: r.matchZone ?? null,
    motivo: r.matchReason ?? null,
    art: r.article ? resumenArticulo(r.article, salida.ahora) : null,
  }));
}

/** Un item de buildUserNewsDigest, en la forma de un resultado de pickBestArticlePerTopic. */
function itemComoResultado(it) {
  return {
    topic: it.topic,
    queryExpanded: typeof it.queryExpanded === 'string' ? it.queryExpanded : '',
    article: it.articleId ? {
      _id: it.articleId, url: it.url, title: it.originalTitle || it.title, category: it.category, section: it.section,
      tags: it.tags, publishedAt: it.publishedAt, score: it.score, finalScore: it.finalScore,
    } : null,
    usedFallback: Boolean(it.usedFallback),
    fallbackCategory: it.fallbackCategory ?? null,
    matchZone: it.matchZone ?? null,
    matchScore: it.matchScore ?? null,
    matchReason: it.matchReason ?? null,
    corralCategory: it.corralCategory ?? null,
    candidatesEvaluated: it.candidatesEvaluated ?? 0,
    // Los digests guardados por versiones anteriores no traen nivel: sin el campo, el chequeo del nivel no mide nada.
    ...(it.tier !== undefined ? { tier: it.tier } : {}),
  };
}

/** Invariantes sobre un digest ya armado (los items vienen sin rawSummary: no se mide el chequeo léxico). */
function violacionesDeDigest(items, ahora = Date.now()) {
  const out = [];
  for (const it of items || []) {
    const esperado = { ...clasificarTema(it.topic), sinTexto: true };
    out.push(...verificarResultado({ topic: it.topic, r: itemComoResultado(it), esperado, ahora }));
  }
  const porUrl = new Map();
  for (const it of items || []) if (it.url) porUrl.set(it.url, (porUrl.get(it.url) || 0) + 1);
  for (const [url, n] of porUrl) {
    if (n > 1) out.push({ id: 'I8-DUPLICADO-LLAMADA', severidad: 'CRITICA', mensaje: `la misma nota aparece ${n} veces en un digest`, topic: '', url });
  }
  return out;
}

/** Completa con tópicos sintéticos hasta llegar a n (para pruebas de tamaño cuando hay pocos tópicos reales). */
function completar(lista, n, prefijo = 'tema sintetico') {
  const out = [...lista];
  for (let i = 0; out.length < n; i++) out.push(`${prefijo} ${i + 1}`);
  return out.slice(0, n);
}

module.exports = {
  clasificarTema, pool, progreso, filaDeUnTopico, resultadosCompactos, itemComoResultado, violacionesDeDigest, completar, barajar,
};
