'use strict';

/**
 * officialPick.js
 *
 * Elige la nota de un tópico OFICIAL (categoría o subtema) leyendo `articles` por etiqueta, sin
 * búsqueda por significado ni expansión con IA. La relevancia es sí/no: la etiqueta que la IA le
 * puso a la nota al ingestarla (topic = subtema, o category = categoría).
 *
 * Flujo:
 *   1. notas del tema exacto de las últimas 24 h con importancia >= 40
 *   2. se descartan las no elegibles (eligibility.js) y se ordenan (nivel, banda de edad, importancia, edad, _id)
 *   3. se trae el documento completo de los primeros finalistas y se descarta la "misma historia" (coseno >= 0,88)
 *   4. si no queda ninguna y el tópico es un SUBTEMA: rescate = misma categoría, importancia >= 50,
 *      marcada como "sugerida" (usedFallback). Las categorías no tienen rescate: cualquier nota de la categoría ya vale.
 *   5. si tampoco hay: sin nota (mejor un hueco que una mala).
 *
 * El acceso a Mongo llega por `store` (articleStore.js), así esto se prueba con datos falsos.
 */

const { MAX_ARTICLE_AGE_HOURS } = require('./freshness');
const {
  IMPORTANCE_GOOD_MIN, IMPORTANCE_ACCEPTABLE_MIN, rankEligible, findSameStory,
} = require('./eligibility');

const BATCH_SIZE = 8;   // finalistas cuyo documento completo se trae por vez
const MAX_BATCHES = 4;  // como mucho 32 finalistas por tópico antes de rendirse

const redondear = (n) => Math.round(n * 10) / 10;

/**
 * Recorre `ranked` (ya ordenado) y devuelve la primera nota que NO es la misma historia que algo visto.
 *
 * @param {object[]} ranked  salida de rankEligible().eligible
 * @param {object} p
 * @param {{title?:string, vector:number[]}[]} p.seenEmbeddings  historial + lo ya elegido en este digest
 * @param {(ids:any[])=>Promise<Map<string,object>>} p.loadDocs  String(_id) -> { embedding, ... }
 * @param {boolean} [p.needsDoc]  true si el resultado debe ser el documento cargado (si falta, se saltea)
 * @returns {Promise<{hit:{entry:object, doc:object|null, embedding:number[]|null}|null, examined:number, skipped:object[]}>}
 */
async function firstNotRepeated(ranked, { seenEmbeddings = [], loadDocs, needsDoc = false }) {
  const skipped = [];
  let examined = 0;
  if (!ranked.length) return { hit: null, examined, skipped };

  // Sin historial ni notas ya elegidas no hay con qué comparar: alcanza con traer la primera
  // (su embedding igual se necesita para comparar contra los tópicos que vienen después).
  // Si esa única nota se borró entre la lectura liviana y la completa, se prueba con las siguientes.
  const batchSize = seenEmbeddings.length ? BATCH_SIZE : 1;
  const maxBatches = seenEmbeddings.length ? MAX_BATCHES : 4;

  for (let b = 0; b < maxBatches; b++) {
    const batch = ranked.slice(b * batchSize, (b + 1) * batchSize);
    if (!batch.length) break;
    const docs = await loadDocs(batch.map((e) => e.article._id));

    for (const entry of batch) {
      examined++;
      const doc = docs.get(String(entry.article._id)) || null;
      if (needsDoc && !doc) continue; // se borró entre la lectura liviana y la completa
      const embedding = Array.isArray(doc?.embedding) && doc.embedding.length ? doc.embedding : null;
      const same = embedding ? findSameStory(embedding, seenEmbeddings) : null;
      if (same) {
        skipped.push({ title: entry.article.title, similarity: same.similarity, con: same.title });
        continue;
      }
      return { hit: { entry, doc, embedding }, examined, skipped };
    }
  }
  return { hit: null, examined, skipped };
}

function withoutEmbedding(doc) {
  if (!doc) return doc;
  const { embedding, ...rest } = doc; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * @param {{kind:'category'|'subtopic', name:string, category:string}} official  salida de resolveOfficialTopic
 * @param {object} p
 * @param {number} [p.now]
 * @param {Set<string>} p.usedUrls
 * @param {{title?:string, vector:number[]}[]} p.seenEmbeddings
 * @param {object} p.store  articleStore (o uno falso con listCandidates y loadFull)
 */
async function pickOfficialArticle(official, { now = Date.now(), usedUrls = new Set(), seenEmbeddings = [], store }) {
  const since = new Date(now - MAX_ARTICLE_AGE_HOURS * 3600e3);
  const ctx = { now, usedUrls };

  const out = {
    article: null,
    embedding: null,
    usedFallback: false,
    fallbackCategory: null,
    matchZone: null,
    matchScore: null,
    matchReason: 'sin_candidatos',
    corralCategory: official.category,
    candidatesEvaluated: 0,
    tier: null,
    ageHours: null,
    rechazadas: {},        // motivo -> cantidad (trazabilidad)
    mismaHistoria: [],     // finalistas descartadas por ser la misma historia
  };

  // ---------------------------------------------------------------- 1) el tema exacto
  const exact = await store.listCandidates({
    category: official.category,
    topic: official.kind === 'subtopic' ? official.name : null,
    minImportance: IMPORTANCE_ACCEPTABLE_MIN,
    since,
  });
  const ranked = rankEligible(exact, ctx);
  for (const r of ranked.rejected) for (const m of r.reasons) out.rechazadas[m] = (out.rechazadas[m] || 0) + 1;

  const found = await firstNotRepeated(ranked.eligible, { seenEmbeddings, loadDocs: store.loadFull, needsDoc: true });
  out.candidatesEvaluated = found.examined || exact.length;
  out.mismaHistoria = found.skipped;

  if (found.hit) {
    const { entry, doc, embedding } = found.hit;
    out.article = withoutEmbedding(doc);
    out.embedding = embedding;
    out.matchZone = 'ETIQUETA';
    out.tier = entry.tier;
    out.ageHours = redondear(entry.ageHours);
    out.matchReason =
      `ETIQUETA ${entry.tier} ${out.ageHours}h imp=${entry.importance} ` +
      `(candidato #${found.examined} de ${ranked.eligible.length} elegibles)`;
    return out;
  }
  out.matchReason = exact.length === 0 ? 'sin_candidatos' : 'ningun_candidato_valido';

  // ---------------------------------------------------------------- 2) rescate (solo subtemas)
  if (official.kind !== 'subtopic') return out;

  const near = await store.listCandidates({
    category: official.category,
    excludeTopic: official.name,
    minImportance: IMPORTANCE_GOOD_MIN,
    since,
  });
  const rankedNear = rankEligible(near, ctx, { goodOnly: true });
  const foundNear = await firstNotRepeated(rankedNear.eligible, { seenEmbeddings, loadDocs: store.loadFull, needsDoc: true });

  if (foundNear.hit) {
    const { entry, doc, embedding } = foundNear.hit;
    out.article = withoutEmbedding(doc);
    out.embedding = embedding;
    out.usedFallback = true;
    out.fallbackCategory = official.category;
    out.matchZone = 'RESCATE';
    out.tier = 'sugerida';
    out.ageHours = redondear(entry.ageHours);
    out.candidatesEvaluated += foundNear.examined;
    out.mismaHistoria = [...out.mismaHistoria, ...foundNear.skipped];
  }
  return out;
}

module.exports = {
  BATCH_SIZE,
  MAX_BATCHES,
  firstNotRepeated,
  pickOfficialArticle,
};
