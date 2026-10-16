const { searchArticlesBySimilarityAtlas } = require('../embeddings/searchArticlesBySimilarityAtlas');
const { openaiReview } = require('../config/openai');
const { selectBestCandidate, inferCorralCategory } = require('./topicMatching');
const { MAX_ARTICLE_AGE_HOURS } = require('./freshness');
const { resolveOfficialTopic } = require('./officialTopics');
const { checkEligibility, rankEligible, normalizeText } = require('./eligibility');
const { pickOfficialArticle, firstNotRepeated } = require('./officialPick');
const { JudgeSession, judgeWaitBudgetMs } = require('./llmJudge');
const { createSameStoryJudge, noteForJudge } = require('./sameEventJudge');
const articleStore = require('./articleStore');

/**
 * Elige UNA nota por tópico del usuario, en orden y sin repetir entre tópicos.
 *
 * Hay dos caminos según el tópico:
 *   - OFICIAL (categoría o subtema, sin importar mayúsculas ni tildes): se lee `articles` por etiqueta,
 *     sin búsqueda por significado ni IA (officialPick.js).
 *   - LIBRE ("river plate", "Zverev"): búsqueda híbrida (significado + palabras) con zonas, ancla léxica
 *     y corral de categoría (topicMatching.js); entre las notas aceptadas se elige por calidad.
 *
 * En los dos, una nota solo puede entregarse si es elegible (eligibility.js): 24 h como máximo,
 * importancia >= 40, no opinión, no previa, país (Sociedad), URL no vista y no ser "la misma historia"
 * (coseno >= 0,88, o entre 0,80 y 0,88 si el juez de sameEventJudge.js dice que es el mismo hecho) que algo
 * visto en 48 h o ya elegido en este mismo digest.
 *
 * El juez espera, como máximo, `judgeWaitMs` en total por digest (llmJudge.js); pasado ese presupuesto, o si falla o
 * está apagado (SAME_STORY_JUDGE=off), las notas se eligen como si no existiera.
 */

// Una consulta de expansión que tarda más que esto se abandona: el tópico se busca tal cual.
const EXPANSION_TIMEOUT_MS = 8000;
const EXPANSION_MAX_RETRIES = 1;

// Cuántas veces perTopicLimit se pide a la búsqueda como ventana de candidatos (antes 2; ahora 30 con el límite por defecto).
const SEARCH_WINDOW_FACTOR = 3;

const queryExpansionCache = new Map();

async function expandTopicForEmbedding(rawTopic) {
  const topic = String(rawTopic || '').trim();

  if (topic.split(/\s+/).length >= 5) return topic;

  const normTopic = normalizeText(topic);
  if (queryExpansionCache.has(normTopic)) {
    return queryExpansionCache.get(normTopic);
  }

  const currentYear = new Date().getFullYear();

  try {
    const response = await openaiReview.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Sos un experto en expansión de consultas para un motor de búsqueda vectorial periodístico (${currentYear}).
          REGLA 1: Tu respuesta DEBE EMPEZAR con las palabras exactas del usuario. NUNCA las elimines ni las modifiques.
          REGLA 2: Agregá de 2 a 4 palabras clave muy específicas que ayuden a aislar el tema. Si es un club, su estadio o apodo directo. Si es un político, su partido o cargo. Si es un país, su capital.
          REGLA 3: PROHIBICIÓN ABSOLUTA de agregar nombres de rivales, opositores o conceptos contrarios. Si el tema es "River Plate", NO agregues "boca" ni "bosteros".
          REGLA 4: NO uses palabras genéricas (deporte, equipo, actualidad, noticias).
          Devolvé ÚNICAMENTE una sola línea de texto en minúsculas, sin comas ni signos de puntuación.`
          },
          { role: 'user', content: topic }
        ],
        temperature: 0,
        max_tokens: 25,
      },
      { timeout: EXPANSION_TIMEOUT_MS, maxRetries: EXPANSION_MAX_RETRIES }
    );

    const expanded = response.choices?.[0]?.message?.content?.trim() || topic;
    console.log(`[Query Expansion IA] "${topic}" -> expandido a "${expanded}"`);
    queryExpansionCache.set(normTopic, expanded);
    return expanded;
  } catch (error) {
    console.warn(`Fallo expansion IA para "${topic}", usando original:`, error.message);
    return topic;
  }
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
 * Camino de los tópicos LIBRES: búsqueda -> zonas/ancla/corral -> elegibilidad -> orden por calidad ->
 * descartar "misma historia" -> (si no queda nada) rescate dentro del rubro.
 */
async function pickFreeTopic(trimmedTopic, queryForEmbedding, { perTopicLimit, now, usedUrls, seenEmbeddings, search, store, judge = null }) {
  const since = new Date(now - MAX_ARTICLE_AGE_HOURS * 3600e3);
  const ctx = { now, usedUrls };
  const loadDocs = embeddingLoader(store);

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

  let semanticCandidates = [];
  try {
    semanticCandidates = await search(trimmedTopic, queryForEmbedding, {
      limit: perTopicLimit * SEARCH_WINDOW_FACTOR,
      minDate: since,
    });

    // Zona, ancla léxica y corral se derivan de los propios candidatos (ver topicMatching.js).
    // Se evalúan TODOS: el orden final lo decide la calidad, no la posición que dejó la búsqueda.
    const selection = selectBestCandidate(trimmedTopic, semanticCandidates, {
      isUsable: (a) => checkEligibility(a, ctx).ok,
      exhaustive: true,
    });

    out.corralCategory = selection.corral;
    out.candidatesEvaluated = selection.candidatesEvaluated;

    console.log(
      `[Motor Hibrido] "${trimmedTopic}" -> ${semanticCandidates.length} candidatos | ` +
      `Corral: ${selection.corral || 'Libre'} | Anclas: [${selection.anchors.join(', ')}] (${selection.anchorMode}) | ` +
      `Aceptados: ${selection.accepted.length} de ${selection.candidatesEvaluated}`
    );

    const zonas = new Map(selection.accepted.map((x) => [x.article, x]));
    const { eligible } = rankEligible(selection.accepted.map((x) => x.article), ctx, { zoneOf: (a) => zonas.get(a).zone });
    const found = await firstNotRepeated(eligible, { seenEmbeddings, loadDocs, needsDoc: false, judge });

    if (found.hit) {
      const { entry, embedding } = found.hit;
      const aceptado = zonas.get(entry.article);
      out.article = entry.article;
      out.embedding = embedding;
      out.matchZone = aceptado.zone;
      out.matchScore = aceptado.score;
      out.tier = entry.tier;
      out.ageHours = redondear(entry.ageHours);
      out.candidatesEvaluated = aceptado.rank;
      out.matchReason = `${aceptado.zone} score=${aceptado.score.toFixed(3)} (candidato #${aceptado.rank})`;
      console.log(
        `[MATCH ${aceptado.zone}] "${out.article.title}" | Score: ${aceptado.score.toFixed(3)} | ` +
        `${entry.tier} ${out.ageHours} h imp=${entry.importance} | candidato #${aceptado.rank}`
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
    deps = {}, // solo para tests: { search, expand, store, judge, createJudge }  (judge: undefined = el real, null = sin juez)
  } = options;

  const search = deps.search || searchArticlesBySimilarityAtlas;
  const expand = deps.expand || expandTopicForEmbedding;
  const store = deps.store || articleStore;

  // El presupuesto de espera a los jueces es POR DIGEST: todos los tópicos descuentan del mismo.
  const budgetMs = Number.isFinite(judgeWaitMs) && judgeWaitMs >= 0 ? judgeWaitMs : judgeWaitBudgetMs();
  const judgeSession = new JudgeSession({ budgetMs });
  const judge = deps.judge !== undefined ? deps.judge : (deps.createJudge || createSameStoryJudge)({ session: judgeSession });

  const usedUrls = new Set(alreadyShownUrls);
  const usedTitles = [...alreadyShownTitles];
  const dynamicSeenEmbeddings = [...seenEmbeddings];
  const results = [];

  // La expansión con IA es solo para los tópicos LIBRES: los oficiales se leen por etiqueta y no la necesitan.
  const expandedQueriesMap = new Map();
  await Promise.all(topics.map(async (rawTopic) => {
    const trimmed = String(rawTopic || '').trim();
    if (!trimmed || resolveOfficialTopic(trimmed)) return;
    expandedQueriesMap.set(trimmed, await expand(trimmed));
  }));

  for (const rawTopic of topics) {
    const trimmedTopic = String(rawTopic || '').trim();
    if (!trimmedTopic) continue;

    const official = resolveOfficialTopic(trimmedTopic);
    const topic = official ? official.name : trimmedTopic;
    const queryExpanded = official ? trimmedTopic : (expandedQueriesMap.get(trimmedTopic) || trimmedTopic);

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
      picked = await pickFreeTopic(trimmedTopic, queryExpanded, {
        perTopicLimit, now, usedUrls, seenEmbeddings: dynamicSeenEmbeddings, search, store, judge,
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

module.exports = { pickBestArticlePerTopic, expandTopicForEmbedding, queryExpansionCache };
