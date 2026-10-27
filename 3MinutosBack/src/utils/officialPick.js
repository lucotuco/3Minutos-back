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
 *   2. se descartan las no elegibles (eligibility.js) y se ordenan (nivel, puntaje de importancia y frescura, edad, _id)
 *   3. se trae el documento completo de los primeros finalistas y se descarta la "misma historia" (coseno >= 0,88,
 *      o entre 0,80 y 0,88 si el juez de sameEventJudge.js dice que cuenta el mismo hecho)
 *   4. si no queda ninguna y el tópico es un SUBTEMA: rescate = misma categoría, importancia >= 50,
 *      marcada como "sugerida" (usedFallback). Las categorías no tienen rescate: cualquier nota de la categoría ya vale.
 *      El rescate (pickRescueArticle) es el mismo para los temas libres (pickBestArticlePerTopic.js), que antes de
 *      llegar acá prueban algo más: aceptar una nota donde el tema aparece de costado (ver pickFreeTopic).
 *      El rescate es MÁS estricto con las repetidas que el resto del motor: ver RESCUE_JUDGE_MIN_COSINE.
 *   5. si tampoco hay: sin nota (mejor un hueco que una mala).
 *
 * El acceso a Mongo llega por `store` (articleStore.js), así esto se prueba con datos falsos.
 */

const { MAX_ARTICLE_AGE_HOURS } = require('./freshness');
const {
  IMPORTANCE_GOOD_MIN, IMPORTANCE_ACCEPTABLE_MIN, rankEligible, findSameStory, RESCUE_JUDGE_MIN_COSINE,
} = require('./eligibility');
const { noteForJudge } = require('./judgeNote');
const { prefetchSameStory, resolveSameStory, PREFETCH_MAX_CANDIDATES } = require('./sameEventJudge');

const BATCH_SIZE = 8;   // finalistas cuyo documento completo se trae por vez
const MAX_BATCHES = 4;  // como mucho 32 finalistas por tópico antes de rendirse

const redondear = (n) => Math.round(n * 10) / 10;

const embeddingOf = (doc) => (Array.isArray(doc?.embedding) && doc.embedding.length ? doc.embedding : null);

/**
 * Recorre `ranked` (ya ordenado) y devuelve la primera nota que sirve: que NO sea la misma historia que algo visto y,
 * en los temas libres, que el juez de tema la dé por buena.
 *
 * @param {object[]} ranked  salida de rankEligible().eligible
 * @param {object} p
 * @param {{id?:string, title?:string, lead?:string, vector:number[]}[]} p.seenEmbeddings  historial + lo ya elegido en este digest
 * @param {(ids:any[])=>Promise<Map<string,object>>} p.loadDocs  String(_id) -> { embedding, ... }
 * @param {boolean} [p.needsDoc]  true si el resultado debe ser el documento cargado (si falta, se saltea)
 * @param {object|null} [p.judge] juez de misma historia atado al digest (sameEventJudge.createSameStoryJudge); sin juez
 *                                solo vale el coseno
 * @param {object|null} [p.topicCheck] juez de tema de un tópico libre (topicJudge.createTopicCheck):
 *                                { prefetch(entry, doc), check(entry, doc) -> { ok, verdict, reason } }
 * @returns {Promise<{hit:{entry:object, doc:object|null, embedding:number[]|null, topicVerdict:string|null}|null,
 *                    examined:number, skipped:object[], offTopic:object[]}>}
 */
async function firstNotRepeated(ranked, {
  seenEmbeddings = [], loadDocs, needsDoc = false, judge = null, topicCheck = null, sameStoryBandMin = undefined,
}) {
  const skipped = [];
  const offTopic = [];
  let examined = 0;
  if (!ranked.length) return { hit: null, examined, skipped, offTopic };

  // Sin historial ni notas ya elegidas (ni juez de tema) no hay con qué comparar: alcanza con traer la primera
  // (su embedding igual se necesita para comparar contra los tópicos que vienen después).
  // Si esa única nota se borró entre la lectura liviana y la completa, se prueba con las siguientes.
  const compares = seenEmbeddings.length > 0 || Boolean(topicCheck);
  const batchSize = compares ? BATCH_SIZE : 1;
  const maxBatches = compares ? MAX_BATCHES : 4;

  // La candidata tal como la ven los jueces: los campos livianos de la lista + lo que trajo la lectura completa.
  const candidateOf = (entry, doc) => noteForJudge({ ...entry.article, ...(doc || {}) });

  for (let b = 0; b < maxBatches; b++) {
    const batch = ranked.slice(b * batchSize, (b + 1) * batchSize);
    if (!batch.length) break;
    const docs = await loadDocs(batch.map((e) => e.article._id));

    // Las preguntas a los jueces de las primeras candidatas salen JUNTAS, antes de mirarlas una por una: el digest
    // espera lo que tarda la más lenta, no la suma. Las repetidas por coseno no gastan preguntas; con juez de tema
    // se pregunta por toda candidata que sigue en pie, y sin él se corta en la primera que pasa sin juez (esa, si
    // ninguna anterior queda, es la que se entrega). Tope: PREFETCH_MAX_CANDIDATES.
    if ((judge && seenEmbeddings.length) || topicCheck) {
      let launched = 0;
      for (const entry of batch) {
        if (launched >= PREFETCH_MAX_CANDIDATES) break;
        const doc = docs.get(String(entry.article._id)) || null;
        if (needsDoc && !doc) continue;
        const embedding = embeddingOf(doc);
        // (prefetchSameStory sin juez solo mira el coseno: una repetida no gasta preguntas ni siquiera al juez de tema)
        const kind = seenEmbeddings.length
          ? prefetchSameStory({ embedding, candidate: candidateOf(entry, doc), seen: seenEmbeddings, judge, bandMin: sameStoryBandMin })
          : 'limpia';
        if (kind === 'coseno') continue;
        if (topicCheck) topicCheck.prefetch(entry, doc);
        if (kind === 'banda' || topicCheck) launched++;
        else break;
      }
    }

    for (const entry of batch) {
      examined++;
      const doc = docs.get(String(entry.article._id)) || null;
      if (needsDoc && !doc) continue; // se borró entre la lectura liviana y la completa
      const embedding = embeddingOf(doc);

      // 1) la misma historia que algo visto, por coseno (no cuesta nada)
      const hard = embedding ? findSameStory(embedding, seenEmbeddings) : null;
      if (hard) {
        skipped.push({ title: entry.article.title, similarity: hard.similarity, con: hard.title, by: 'coseno' });
        continue;
      }

      // 2) ¿es del tema? (solo tópicos libres)
      let topicVerdict = null;
      if (topicCheck) {
        const topic = await topicCheck.check(entry, doc);
        if (!topic.ok) {
          offTopic.push({ title: entry.article.title, verdict: topic.verdict, reason: topic.reason });
          continue;
        }
        topicVerdict = topic.verdict;
      }

      // 3) la misma historia, en la banda donde el coseno no alcanza y decide el juez
      const same = embedding
        ? await resolveSameStory({
            embedding, candidate: judge ? candidateOf(entry, doc) : null, seen: seenEmbeddings, judge,
            bandMin: sameStoryBandMin,
          })
        : null;
      if (same) {
        skipped.push({ title: entry.article.title, similarity: same.similarity, con: same.title, by: same.by });
        continue;
      }
      return { hit: { entry, doc, embedding, topicVerdict }, examined, skipped, offTopic };
    }
  }
  return { hit: null, examined, skipped, offTopic };
}

function withoutEmbedding(doc) {
  if (!doc) return doc;
  const { embedding, ...rest } = doc; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * Rescate dentro del rubro: la mejor nota "buena" (importancia >= 50) de la categoría que no sea la misma historia que
 * algo visto. Se lee por etiqueta, igual que un tema oficial: sin búsqueda por significado, sin embedding de consulta y
 * sin IA más que el juez de misma historia, así que anda aunque la búsqueda o OpenAI estén caídos.
 *
 * @param {object} rubro
 * @param {string} rubro.category            categoría oficial en la que se busca
 * @param {string|null} [rubro.excludeTopic] subtema que no se mira (el del tópico que no encontró nada)
 * @param {((a:object)=>number)|null} [rubro.hintOf] pista de orden (eligibility.hintLevel): las notas del subtema o de
 *                                           la categoría que sugirió la IA pasan primero, a igual nivel de calidad
 * @param {object} p
 * @param {{now:number, usedUrls:Set<string>}} p.ctx  igual que checkEligibility
 * @param {Date} p.since
 * @param {{id?:string, title?:string, lead?:string, vector:number[]}[]} p.seenEmbeddings
 * @param {object} p.store  articleStore (o uno falso)
 * @param {object|null} [p.judge]
 * @returns {Promise<{hit:object|null, examined:number, skipped:object[], listed:number}>}
 *   hit = { entry, doc (completo, con embedding), embedding, topicVerdict } como firstNotRepeated; listed = notas leídas
 */
/**
 * La nota "sugerida" cuando el tema no dio nada: la mejor del rubro, excluyendo el subtema que ya falló.
 *
 * Es más estricta que el resto con las repetidas (`RESCUE_JUDGE_MIN_COSINE`). El rescate lee TODA la categoría y
 * entrega lo más importante y fresco, así que para dos tópicos distintos del mismo rubro suele caer en el mismo
 * hecho: dos notas del Balón de Oro, una para "boca juniors" y otra para "river plate", en el mismo digest. Con
 * enfoques distintos el coseno queda por debajo de 0,80 y se escapaban; desde 0,70 las revisa el juez.
 */
async function pickRescueArticle({ category, excludeTopic = null, hintOf = null }, { ctx, since, seenEmbeddings = [], store, judge = null }) {
  const near = await store.listCandidates({ category, excludeTopic, minImportance: IMPORTANCE_GOOD_MIN, since });
  const ranked = rankEligible(near, ctx, { goodOnly: true, hintOf });
  const found = await firstNotRepeated(ranked.eligible, {
    seenEmbeddings, loadDocs: store.loadFull, needsDoc: true, judge, sameStoryBandMin: RESCUE_JUDGE_MIN_COSINE,
  });
  return { ...found, listed: near.length };
}

/**
 * @param {{kind:'category'|'subtopic', name:string, category:string}} official  salida de resolveOfficialTopic
 * @param {object} p
 * @param {number} [p.now]
 * @param {Set<string>} p.usedUrls
 * @param {{id?:string, title?:string, lead?:string, vector:number[]}[]} p.seenEmbeddings
 * @param {object} p.store  articleStore (o uno falso con listCandidates y loadFull)
 * @param {object|null} [p.judge]  juez de misma historia (ver firstNotRepeated)
 */
async function pickOfficialArticle(official, { now = Date.now(), usedUrls = new Set(), seenEmbeddings = [], store, judge = null }) {
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

  const found = await firstNotRepeated(ranked.eligible, { seenEmbeddings, loadDocs: store.loadFull, needsDoc: true, judge });
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
      `ETIQUETA ${entry.tier} ${out.ageHours}h imp=${entry.importance} puntaje=${entry.score.toFixed(1)} ` +
      `(candidato #${found.examined} de ${ranked.eligible.length} elegibles)`;
    return out;
  }
  out.matchReason = exact.length === 0 ? 'sin_candidatos' : 'ningun_candidato_valido';

  // ---------------------------------------------------------------- 2) rescate (solo subtemas)
  if (official.kind !== 'subtopic') return out;

  const foundNear = await pickRescueArticle({ category: official.category, excludeTopic: official.name }, {
    ctx, since, seenEmbeddings, store, judge,
  });

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
  pickRescueArticle,
  pickOfficialArticle,
  withoutEmbedding,
};
