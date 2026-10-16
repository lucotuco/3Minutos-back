const { searchArticlesBySimilarityAtlas } = require('../embeddings/searchArticlesBySimilarityAtlas');
const { selectBestCandidate, inferCorralCategory } = require('./topicMatching');
const { MAX_ARTICLE_AGE_HOURS } = require('./freshness');
const { resolveOfficialTopic } = require('./officialTopics');
const { checkEligibility, rankEligible, hintLevel } = require('./eligibility');
const { pickOfficialArticle, firstNotRepeated } = require('./officialPick');
const { JudgeSession, judgeWaitBudgetMs } = require('./llmJudge');
const { createSameStoryJudge, PREFETCH_MAX_CANDIDATES } = require('./sameEventJudge');
const { createTopicJudge, createTopicCheck } = require('./topicJudge');
const { expandTopic, asExpansion } = require('./topicExpansion');
const { noteForJudge } = require('./judgeNote');
const { createGate } = require('./concurrencyGate');
const articleStore = require('./articleStore');

/**
 * Elige UNA nota por tópico del usuario, en orden y sin repetir entre tópicos.
 *
 * Hay dos caminos según el tópico:
 *   - OFICIAL (categoría o subtema, sin importar mayúsculas ni tildes): se lee `articles` por etiqueta,
 *     sin búsqueda por significado ni IA (officialPick.js).
 *   - LIBRE ("river plate", "Zverev"): búsqueda híbrida (significado + palabras) con zonas, ancla léxica
 *     y corral de categoría (topicMatching.js); entre las notas aceptadas se elige por calidad y el juez de tema
 *     (topicJudge.js) confirma que la nota es DE ese tema.
 *
 * En los dos, una nota solo puede entregarse si es elegible (eligibility.js): 24 h como máximo,
 * importancia >= 40, no opinión, no previa, país (Sociedad), URL no vista y no ser "la misma historia"
 * (coseno >= 0,88, o entre 0,80 y 0,88 si el juez de sameEventJudge.js dice que es el mismo hecho) que algo
 * visto en 48 h o ya elegido en este mismo digest.
 *
 * Los jueces con IA esperan, como máximo, `judgeWaitMs` en total por digest (llmJudge.js); pasado ese presupuesto, o si
 * fallan o están apagados (SAME_STORY_JUDGE=off, TOPIC_JUDGE=off), las notas se eligen como si no existieran.
 *
 * Dos fases, para que los tópicos libres no se esperen entre sí:
 *   1. (en paralelo) por cada tópico libre: expandir con IA -> buscar -> dejar corriendo las preguntas del juez de tema
 *      de sus primeras candidatas.
 *   2. (en orden, como siempre) por cada tópico: elegir la nota con lo ya elegido para los anteriores. La elección es
 *      idéntica a hacerlo todo en fila; la fase 1 solo adelanta el trabajo de red.
 */

// Cuántas veces perTopicLimit se pide a la búsqueda como ventana de candidatos (antes 2; ahora 30 con el límite por defecto).
const SEARCH_WINDOW_FACTOR = 3;

// Cuántos tópicos libres hacen su trabajo de red (expansión + búsqueda) a la vez en la fase 1. Un usuario tiene 3 tópicos
// (userRoutes.normalizeTopics), así que nunca espera; el tope evita una ráfaga de decenas de llamadas a OpenAI y a Atlas si
// alguien invoca el motor con una lista larga.
const MAX_PARALLEL_FREE_TOPICS = 6;

/** loadDocs para firstNotRepeated en el camino libre: solo hace falta el embedding. */
function embeddingLoader(store) {
  return async (ids) => {
    const vectors = await store.loadEmbeddings(ids);
    return new Map([...vectors].map(([id, embedding]) => [id, { embedding }]));
  };
}

const redondear = (n) => Math.round(n * 10) / 10;

/**
 * Candidatos de un tópico libre -> los que se pueden entregar, en orden de calidad. Sirve para la elección y para
 * adelantar las preguntas al juez (con las exclusiones que haya en ese momento).
 */
function rankFreeCandidates(topic, expansion, candidates, ctx, { softCorral }) {
  const selection = selectBestCandidate(topic, candidates, {
    isUsable: (a) => checkEligibility(a, ctx).ok,
    exhaustive: true,
    softCorral,
  });
  const accepted = new Map(selection.accepted.map((x) => [x.article, x]));
  const { eligible } = rankEligible(selection.accepted.map((x) => x.article), ctx, {
    zoneOf: (a) => accepted.get(a).zone,
    hintOf: (a) => hintLevel(a, expansion),
  });
  return { selection, accepted, eligible };
}

/**
 * FASE 1 de un tópico libre: expansión, búsqueda y preguntas por adelantado al juez de tema. Nunca rechaza:
 * si la expansión falla se busca el tópico tal cual, y el error de la búsqueda lo ve la fase 2 al esperarla.
 * La expansión y la búsqueda esperan su turno en `gate` (como mucho MAX_PARALLEL_FREE_TOPICS a la vez).
 */
async function startFreeTopic(topic, { expand, search, perTopicLimit, since, now, usedUrls, topicJudge, gate }) {
  const { expansion, searchPromise } = await gate(async () => {
    let found;
    try {
      found = asExpansion(await expand(topic), topic);
    } catch (error) {
      console.warn(`Fallo la expansion de "${topic}", se busca tal cual:`, error.message);
      found = asExpansion(null, topic);
    }

    const pending = Promise.resolve().then(() => search(topic, found.q, {
      limit: perTopicLimit * SEARCH_WINDOW_FACTOR,
      minDate: since,
    }));
    pending.catch(() => {}); // el error se ve en la fase 2, al esperar la búsqueda dentro de su try
    await pending.catch(() => {}); // el lugar se libera cuando la búsqueda terminó, bien o mal
    return { expansion: found, searchPromise: pending };
  });

  if (topicJudge?.enabled()) {
    try {
      const candidates = await searchPromise;
      const { eligible } = rankFreeCandidates(topic, expansion, candidates, { now, usedUrls }, { softCorral: true });
      for (const entry of eligible.slice(0, PREFETCH_MAX_CANDIDATES)) topicJudge.prefetch(topic, noteForJudge(entry.article));
    } catch { /* sin adelanto: las preguntas salen en la fase 2 */ }
  }
  return { expansion, searchPromise };
}

/**
 * FASE 2 de un tópico libre: zonas/ancla/corral -> elegibilidad -> orden por calidad -> juez de tema -> descartar
 * "misma historia" -> (si no queda nada) rescate dentro del rubro.
 */
async function pickFreeTopic(trimmedTopic, prepared, {
  perTopicLimit, now, usedUrls, seenEmbeddings, search, store, judge = null, topicJudge = null,
}) {
  const since = new Date(now - MAX_ARTICLE_AGE_HOURS * 3600e3);
  const ctx = { now, usedUrls };
  const loadDocs = embeddingLoader(store);
  const { expansion } = prepared;

  const out = {
    article: null,
    embedding: null,
    usedFallback: false,
    fallbackCategory: null,
    matchZone: null,
    matchScore: null,
    matchReason: null,
    corralCategory: null,
    candidatesEvaluated: 0,
    tier: null,
    ageHours: null,
  };

  // Con juez de tema el corral de categoría deja de ser un descarte: una nota de otra categoría la decide el juez.
  const softCorral = Boolean(topicJudge?.enabled());

  let semanticCandidates = [];
  try {
    semanticCandidates = await prepared.searchPromise;

    // Zona, ancla léxica y corral se derivan de los propios candidatos (ver topicMatching.js).
    // Se evalúan TODOS: el orden final lo decide la calidad, no la posición que dejó la búsqueda.
    const { selection, accepted, eligible } = rankFreeCandidates(trimmedTopic, expansion, semanticCandidates, ctx, { softCorral });

    out.corralCategory = selection.corral;
    out.candidatesEvaluated = selection.candidatesEvaluated;

    const pista = expansion.cat ? `${expansion.cat}${expansion.sub ? `/${expansion.sub}` : ''}` : '-';
    console.log(
      `[Motor Hibrido] "${trimmedTopic}" -> ${semanticCandidates.length} candidatos | ` +
      `Corral: ${selection.corral || 'Libre'} | Anclas: [${selection.anchors.join(', ')}] (${selection.anchorMode}) | ` +
      `Pista: ${pista} | Aceptados: ${selection.accepted.length} de ${selection.candidatesEvaluated}`
    );

    const topicCheck = softCorral
      ? createTopicCheck({ judge: topicJudge, topic: trimmedTopic, isOutOfCorral: (a) => Boolean(accepted.get(a)?.outOfCorral) })
      : null;
    const found = await firstNotRepeated(eligible, { seenEmbeddings, loadDocs, needsDoc: false, judge, topicCheck });
    if (found.offTopic.length) {
      console.log(`[Juez tema] "${trimmedTopic}": ${found.offTopic.length} descartadas por no ser del tema (${found.offTopic.map((o) => o.verdict || o.reason).join(', ')})`);
    }

    if (found.hit) {
      const { entry, embedding, topicVerdict } = found.hit;
      const aceptado = accepted.get(entry.article);
      out.article = entry.article;
      out.embedding = embedding;
      out.matchZone = aceptado.zone;
      out.matchScore = aceptado.score;
      out.tier = entry.tier;
      out.ageHours = redondear(entry.ageHours);
      out.candidatesEvaluated = aceptado.rank;
      const juez = topicCheck ? ` | tema: ${topicVerdict || 'sin veredicto'}` : '';
      out.matchReason = `${aceptado.zone} score=${aceptado.score.toFixed(3)} (candidato #${aceptado.rank})${juez}`;
      console.log(
        `[MATCH ${aceptado.zone}] "${out.article.title}" | Score: ${aceptado.score.toFixed(3)} | ` +
        `${entry.tier} ${out.ageHours} h imp=${entry.importance} | candidato #${aceptado.rank}${juez}`
      );
      return out;
    }

    out.matchReason = semanticCandidates.length === 0 ? 'sin_candidatos' : 'ningun_candidato_valido';
    console.warn(`Ningun candidato valido para "${trimmedTopic}" (${out.matchReason}).`);
    // El corral inferido tambien sirve para que el rescate se quede en el mismo rubro.
    if (!out.corralCategory) out.corralCategory = inferCorralCategory(semanticCandidates.filter((a) => (a.score || 0) >= 0.80).slice(0, 10));
  } catch (error) {
    console.error(`Error en busqueda semantica para "${trimmedTopic}":`, error);
    out.matchReason = 'error_busqueda';
  }

  // ---------------------------------------------------------------- rescate dentro del rubro
  console.log(`[RESCATE] No hubo resultados para "${trimmedTopic}". Activando rescate hibrido enfocado en categoria general...`);
  try {
    // Rubro del rescate: el que votaron los candidatos del propio tema (sin listas manuales).
    const emergencyCategory = out.corralCategory || 'Sociedad';
    const emergencyQuery = `${emergencyCategory} Argentina actualidad nacional`;

    const emergencyCandidates = await search(emergencyQuery, emergencyQuery, {
      limit: perTopicLimit * SEARCH_WINDOW_FACTOR,
      minDate: since,
      category: emergencyCategory,
    });

    // En el rescate solo valen notas de nivel "buena" (importancia >= 50).
    const { eligible } = rankEligible(emergencyCandidates, ctx, { goodOnly: true });
    const found = await firstNotRepeated(eligible, { seenEmbeddings, loadDocs, needsDoc: false, judge });

    if (found.hit) {
      const { entry, embedding } = found.hit;
      out.article = entry.article;
      out.embedding = embedding;
      out.usedFallback = true;
      out.fallbackCategory = entry.article.category || emergencyCategory;
      out.matchZone = 'RESCATE';
      out.matchScore = entry.article.score ?? null;
      out.tier = 'sugerida';
      out.ageHours = redondear(entry.ageHours);
      console.log(`[RESCATE EXITOSO] Entregado: "${entry.article.title}"`);
    }
  } catch (emergencyErr) {
    console.error(`Error en rescate de emergencia hibrido para "${trimmedTopic}":`, emergencyErr);
  }
  return out;
}

async function pickBestArticlePerTopic(topics = [], options = {}) {
  if (!Array.isArray(topics) || topics.length === 0) return [];

  const {
    perTopicLimit = 10,
    alreadyShownUrls = [],
    alreadyShownTitles = [],
    seenEmbeddings = [],
    now = Date.now(),
    judgeWaitMs = null, // cuánto espera este digest, en total, a los jueces con IA (null = el de fábrica de un digest en vivo)
    // solo para tests: { search, expand, store, judge, topicJudge, createJudge, createTopicJudge }
    // (judge / topicJudge: undefined = el real, null = sin ese juez)
    deps = {},
  } = options;

  const search = deps.search || searchArticlesBySimilarityAtlas;
  const expand = deps.expand || expandTopic;
  const store = deps.store || articleStore;

  // El presupuesto de espera a los jueces es POR DIGEST: todos los tópicos y los dos jueces descuentan del mismo.
  const budgetMs = Number.isFinite(judgeWaitMs) && judgeWaitMs >= 0 ? judgeWaitMs : judgeWaitBudgetMs();
  const judgeSession = new JudgeSession({ budgetMs });
  const judge = deps.judge !== undefined ? deps.judge : (deps.createJudge || createSameStoryJudge)({ session: judgeSession });
  const topicJudge = deps.topicJudge !== undefined
    ? deps.topicJudge
    : (deps.createTopicJudge || createTopicJudge)({ session: judgeSession });

  const usedUrls = new Set(alreadyShownUrls);
  const usedTitles = [...alreadyShownTitles];
  const dynamicSeenEmbeddings = [...seenEmbeddings];
  const results = [];

  // FASE 1. La expansión con IA y la búsqueda son solo para los tópicos LIBRES (los oficiales se leen por etiqueta) y
  // no dependen de lo que se elija antes: salen todas juntas. Las exclusiones que se usan para adelantar las preguntas
  // al juez son una COPIA de las del arranque, así la fase 1 no depende de en qué punto está la fase 2.
  const since = new Date(now - MAX_ARTICLE_AGE_HOURS * 3600e3);
  const startUrls = new Set(alreadyShownUrls);
  const freeWork = new Map();
  const gate = createGate(MAX_PARALLEL_FREE_TOPICS);
  for (const rawTopic of topics) {
    const trimmed = String(rawTopic || '').trim();
    if (!trimmed || resolveOfficialTopic(trimmed) || freeWork.has(trimmed)) continue;
    const work = startFreeTopic(trimmed, { expand, search, perTopicLimit, since, now, usedUrls: startUrls, topicJudge, gate });
    work.catch(() => {});
    freeWork.set(trimmed, work);
  }

  // FASE 2. En orden, con lo ya elegido para los tópicos anteriores.
  for (const rawTopic of topics) {
    const trimmedTopic = String(rawTopic || '').trim();
    if (!trimmedTopic) continue;

    const official = resolveOfficialTopic(trimmedTopic);
    const topic = official ? official.name : trimmedTopic;

    let queryExpanded = trimmedTopic;
    let picked;
    if (official) {
      try {
        picked = await pickOfficialArticle(official, { now, usedUrls, seenEmbeddings: dynamicSeenEmbeddings, store, judge });
        const porJuez = picked.mismaHistoria.filter((m) => m.by === 'juez').length;
        console.log(
          `[Motor Oficial] "${topic}" (${official.kind}) -> ${picked.matchReason} | ` +
          `rechazadas: ${JSON.stringify(picked.rechazadas)} | misma historia: ${picked.mismaHistoria.length}` +
          `${porJuez ? ` (${porJuez} por el juez)` : ''}`
        );
        if (!picked.article) console.warn(`Ningun candidato valido para "${topic}" (${picked.matchReason}).`);
      } catch (error) {
        console.error(`Error en busqueda semantica para "${topic}":`, error);
        picked = {
          article: null, embedding: null, usedFallback: false, fallbackCategory: null, matchZone: null,
          matchScore: null, matchReason: 'error_busqueda', corralCategory: official.category,
          candidatesEvaluated: 0, tier: null, ageHours: null,
        };
      }
    } else {
      const prepared = await freeWork.get(trimmedTopic);
      queryExpanded = prepared.expansion.q;
      picked = await pickFreeTopic(trimmedTopic, prepared, {
        perTopicLimit, now, usedUrls, seenEmbeddings: dynamicSeenEmbeddings, search, store, judge, topicJudge,
      });
    }

    const article = picked.article;
    if (article) {
      usedUrls.add(article.url);
      usedTitles.push(article.neutralTitle || article.title || '');
      if (Array.isArray(picked.embedding) && picked.embedding.length > 0) {
        // id y bajada, además del título: son lo que ve el juez cuando una nota de otro tópico cuenta lo mismo.
        dynamicSeenEmbeddings.push({ ...noteForJudge(article), vector: picked.embedding });
      }
    }

    results.push({
      topic,
      queryExpanded,
      article,
      usedFallback: article ? picked.usedFallback : false,
      fallbackCategory: article ? picked.fallbackCategory : null,
      matchZone: article ? picked.matchZone : null,
      matchScore: article ? picked.matchScore : null,
      matchReason: picked.matchReason,
      corralCategory: picked.corralCategory,
      candidatesEvaluated: picked.candidatesEvaluated,
      tier: article ? picked.tier : null,
      ageHours: article ? picked.ageHours : null,
    });
  }

  if (judgeSession.used) console.log(judgeSession.summary());
  return results;
}

module.exports = { pickBestArticlePerTopic, expandTopicForEmbedding: expandTopic };
