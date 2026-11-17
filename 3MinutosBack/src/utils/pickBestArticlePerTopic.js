const { searchArticlesBySimilarityAtlas } = require('../embeddings/searchArticlesBySimilarityAtlas');
const { selectBestCandidate, inferCorralCategory } = require('./topicMatching');
const { MAX_ARTICLE_AGE_HOURS } = require('./freshness');
const { resolveOfficialTopic, ALL_CATEGORIES } = require('./officialTopics');
const { checkEligibility, rankEligible, hintLevel, normalizeText } = require('./eligibility');
const { pickOfficialArticle, pickRescueArticle, firstNotRepeated, withoutEmbedding } = require('./officialPick');
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
 * Un tópico libre se rinde en tres escalones, no en uno: primero busca una nota donde el tema sea el FOCO (juez de
 * tema: SI); si no hay ninguna, acepta una donde el tema aparezca de costado (PARCIAL), porque para quien pidió
 * "boca juniors" una nota que lo nombra al pasar le sirve más que una nota impecable de otro tema; y solo si tampoco
 * hay eso, entrega una nota del rubro marcada como "sugerida" (el rescate). El NO no pasa en ningún escalón.
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
 *
 * Si un tópico libre no encuentra nada, el RESCATE entrega una nota "sugerida" del mismo rubro (officialPick.js,
 * pickRescueArticle: la misma que usan los subtemas oficiales): se lee por etiqueta, solo notas "buenas", y a igual
 * calidad pasan primero las del subtema y la categoría que la IA sugirió al expandir el tópico.
 */

// Cuántas veces perTopicLimit se pide a la búsqueda como ventana de candidatos (antes 2; ahora 30 con el límite por defecto).
const SEARCH_WINDOW_FACTOR = 3;

// Cuántos tópicos libres hacen su trabajo de red (expansión + búsqueda) a la vez en la fase 1. Un usuario tiene 3 tópicos
// (userRoutes.normalizeTopics), así que nunca espera; el tope evita una ráfaga de decenas de llamadas a OpenAI y a Atlas si
// alguien invoca el motor con una lista larga.
const MAX_PARALLEL_FREE_TOPICS = 6;

/** La categoría oficial que sugirió la IA al expandir el tópico (con su escritura exacta), o null. */
function hintedCategory(expansion) {
  const key = normalizeText(expansion?.cat);
  return key ? (ALL_CATEGORIES.find((cat) => normalizeText(cat) === key) || null) : null;
}

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
    // Votan para el ancla y el corral las notas entregables EN GENERAL (sin mirar lo que este usuario ya vio ni lo que
    // se eligió para otros tópicos): el significado de un tema no depende del historial de quien lo pide.
    isRepresentative: (a) => checkEligibility(a, { now: ctx.now }).ok,
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
  now, usedUrls, seenEmbeddings, store, judge = null, topicJudge = null,
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

    const corralOf = (a) => Boolean(accepted.get(a)?.outOfCorral);
    const topicCheck = softCorral
      ? createTopicCheck({ judge: topicJudge, topic: trimmedTopic, isOutOfCorral: corralOf })
      : null;
    let found = await firstNotRepeated(eligible, { seenEmbeddings, loadDocs, needsDoc: false, judge, topicCheck });
    if (found.offTopic.length) {
      console.log(`[Juez tema] "${trimmedTopic}": ${found.offTopic.length} descartadas por no ser del tema (${found.offTopic.map((o) => o.verdict || o.reason).join(', ')})`);
    }

    // SEGUNDA PASADA. Si no quedó ninguna nota donde el tema sea el foco, antes de rendirse y entregar una nota de
    // otro tema (el rescate) se vuelve a mirar la MISMA lista aceptando las PARCIAL: el tema aparece aunque no sea
    // el foco. Para el lector que pidió "boca juniors", una nota donde Boca se menciona de costado es mejor que
    // una nota impecable del Balón de Oro. El NO sigue sin pasar.
    //
    // No cuesta otra ronda de IA: los veredictos del juez quedaron en la caché de llmJudge al preguntarlos en la
    // primera pasada, así que esta segunda los lee de ahí.
    if (!found.hit && topicCheck && found.offTopic.some((o) => o.verdict === 'PARCIAL')) {
      const conParciales = createTopicCheck({
        judge: topicJudge, topic: trimmedTopic, isOutOfCorral: corralOf, allowPartial: true,
      });
      const segunda = await firstNotRepeated(eligible, {
        seenEmbeddings, loadDocs, needsDoc: false, judge, topicCheck: conParciales,
      });
      if (segunda.hit) {
        console.log(`[Juez tema] "${trimmedTopic}": sin notas del foco, se acepta una PARCIAL antes que irse a otro tema`);
        found = segunda;
      }
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
        `${entry.tier} ${out.ageHours} h imp=${entry.importance} puntaje=${entry.score.toFixed(1)} | candidato #${aceptado.rank}${juez}`
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
  console.log(`[RESCATE] No hubo resultados para "${trimmedTopic}". Buscando una nota buena del rubro...`);
  try {
    // Rubro del rescate: el que votaron los candidatos del propio tema; si no hubo candidatos (o la búsqueda falló), la
    // categoría que la IA sugirió al expandir el tema; y si tampoco, Sociedad.
    const rescueCategory = out.corralCategory || hintedCategory(expansion) || 'Sociedad';

    // Solo valen notas de nivel "buena" (importancia >= 50). Se lee por etiqueta (como un tema oficial), no con una
    // búsqueda: así el rescate anda aunque la búsqueda o OpenAI estén caídos y no hay consulta que sesgue el resultado.
    const rescued = await pickRescueArticle(
      { category: rescueCategory, hintOf: (a) => hintLevel(a, expansion) },
      { ctx, since, seenEmbeddings, store, judge },
    );

    if (rescued.hit) {
      const { entry, doc, embedding } = rescued.hit;
      out.article = withoutEmbedding(doc);
      out.embedding = embedding;
      out.usedFallback = true;
      out.fallbackCategory = out.article.category || rescueCategory;
      out.matchZone = 'RESCATE';
      out.matchScore = null; // sin búsqueda no hay puntaje de similitud con el tema
      out.tier = 'sugerida';
      out.ageHours = redondear(entry.ageHours);
      console.log(`[RESCATE EXITOSO] Entregado: "${out.article.title}"`);
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
        now, usedUrls, seenEmbeddings: dynamicSeenEmbeddings, store, judge, topicJudge,
      });
    }

    const article = picked.article;
    if (article) {
      usedUrls.add(article.url);
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
