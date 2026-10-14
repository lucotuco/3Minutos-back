const Article = require('../models/Article');
const { enrichArticleRanking } = require('./articleRanking');
const { searchArticlesBySimilarityAtlas } = require('../embeddings/searchArticlesBySimilarityAtlas');
const { openaiReview } = require('../config/openai');
const { cosineSimilarity } = require('../embeddings/searchArticlesBySimilarity');
const { selectBestCandidate, inferCorralCategory } = require('./topicMatching');

const MAX_ARTICLE_AGE_HOURS = 48;

const CATEGORIES = {
  'Política':       ['Gobierno Nacional', 'Justicia', 'Elecciones', 'Educación', 'Seguridad'],
  'Economía':       ['Dólar y Mercados', 'Inflación y Consumo', 'Empresas y Negocios', 'Inversiones', 'Emprendedores'],
  'Internacional':  ['EEUU', 'Medio Oriente', 'Europa', 'América Latina', 'Conflictos', 'Geopolítica'],
  'Deportes':       ['Fútbol', 'F1', 'Básquet', 'Tenis', 'Rugby'],
  'Sociedad':       ['Salud', 'Bienestar', 'Clima y Ambiente', 'Historias Humanas', 'Tendencias y Vida'],
  'Tecnología':     ['Inteligencia Artificial', 'Ciencia y Espacio', 'Apps y Redes', 'Innovación', 'Videojuegos'],
  'Entretenimiento/Cultura': ['Cine y Series', 'Música', 'Turismo y Viajes', 'Streaming', 'Autos', 'Viral y Trending', 'Teatro y Literatura'],
};

const ALL_CATEGORIES = Object.keys(CATEGORIES);
const TOPIC_TO_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORIES).flatMap(([cat, topics]) => topics.map((t) => [t, cat]))
);

const queryExpansionCache = new Map();

function getFreshnessCutoff() {
  return new Date(Date.now() - MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000);
}

const OPINION_KEYWORDS = ['opinion', 'opinión', 'columna', 'columnista', 'editorial', 'analisis', 'análisis'];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

async function expandTopicForEmbedding(rawTopic) {
  const topic = String(rawTopic || '').trim();
  
  if (topic.split(/\s+/).length >= 5) return topic;
  
  const normTopic = normalizeText(topic);
  if (queryExpansionCache.has(normTopic)) {
    return queryExpansionCache.get(normTopic);
  }
  
  const currentYear = new Date().getFullYear();

  try {
    const response = await openaiReview.chat.completions.create({
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
    });

    const expanded = response.choices?.[0]?.message?.content?.trim() || topic;
    console.log(`[Query Expansion IA] "${topic}" -> expandido a "${expanded}"`);
    queryExpansionCache.set(normTopic, expanded);
    return expanded;
  } catch (error) {
    console.warn(`Fallo expansion IA para "${topic}", usando original:`, error.message);
    return topic;
  }
}

function includesOpinionKeyword(value) {
  const normalized = normalizeText(value);
  return OPINION_KEYWORDS.some((kw) => normalized.includes(normalizeText(kw)));
}

function isUsableDigestArticle(article, usedUrls, seenEmbeddings = []) {
  if (!article?.url) return false;
  if (usedUrls.has(article.url)) return false;
  if (isOpinionArticle(article)) return false;

  if (article.publishedAt) {
    const pubDate = new Date(article.publishedAt).getTime();
    const diffHours = (Date.now() - pubDate) / (1000 * 60 * 60);
    if (diffHours > MAX_ARTICLE_AGE_HOURS) {
      console.log(`[CADUCIDAD ${Math.round(diffHours)} HS] BLOQUEADO POR EDAD: "${article.neutralTitle || article.title}"\n`);
      return false;
    }
  }

  if (!Array.isArray(article.embedding) || article.embedding.length === 0) {
    return true; 
  }

  const candidateTitle = article.neutralTitle || article.title || "";
  let maxSim = 0;
  let mostSimilarTitle = "";

  for (const seen of seenEmbeddings) {
    if (!Array.isArray(seen.vector) || seen.vector.length === 0) continue;
    
    const similarity = cosineSimilarity(article.embedding, seen.vector);
    if (similarity > maxSim) {
      maxSim = similarity;
      mostSimilarTitle = seen.title;
    }
  }

  if (maxSim >= 0.85) {
    console.log(`[DUPLICADO SEMANTICO ${Math.round(maxSim*100)}%] BLOQUEADO:`);
    console.log(`Intento entrar: "${candidateTitle}"`);
    console.log(`Ya habias leido el evento: "${mostSimilarTitle}"\n`);
    return false;
  } else if (maxSim > 0.50) {
    console.log(`[TEMA RELACIONADO PERO EVENTO DISTINTO ${Math.round(maxSim*100)}%] PERMITIDO:`);
    console.log(`Entro: "${candidateTitle}"`);
    console.log(`Mas cercano en historial: "${mostSimilarTitle}"\n`);
  }

  return true;
}

function isOpinionArticle(article = {}) {
  const url      = normalizeText(article.url);
  const title    = normalizeText(article.title);
  const section  = normalizeText(article.section);
  const category = normalizeText(article.category);
  const tags     = Array.isArray(article.tags) ? article.tags.map(normalizeText) : [];

  if (url.includes('/opiniones/') || url.includes('/opinion/')) return true;
  if (includesOpinionKeyword(section) || includesOpinionKeyword(category)) return true;
  if (tags.some((tag) => includesOpinionKeyword(tag))) return true;
  if (includesOpinionKeyword(title)) return true;

  return false;
}

async function findCandidatesForTopic(topic, limit, useCutoff = true) {
  const isMainCategory = ALL_CATEGORIES.includes(topic);

  const baseQuery = {
    country: 'ar',
    ...(isMainCategory ? { category: topic } : { topic: new RegExp('^' + topic + '$', 'i') }),
  };

  if (useCutoff) {
    baseQuery.publishedAt = { $gte: getFreshnessCutoff() };
  }

  const selectFields = [
    '_id', 'title', 'url', 'sourceName', 'section', 'region', 'tags', 'category', 'topic',
    'importanceScore', 'publishedAt', 'neutralTitle', 'neutralLead', 'neutralSummary',
    'neutralityScore', 'politicalBiasRisk', 'curationStatus', 'rawSummary', 'contentSnippet', 'imageUrl', 'embedding'
  ].join(' ');

  let articles = await Article.find({ ...baseQuery, topicStatus: 'done' })
    .sort({ importanceScore: -1, publishedAt: -1 })
    .limit(limit * 10)
    .select(selectFields)
    .lean();

  if (articles.length < limit) {
    const missingCount = limit - articles.length;
    const fallbackArticles = await Article.find({
      ...baseQuery,
      topicStatus: { $in: ['pending', 'error'] },
    })
      .sort({ importanceScore: -1, publishedAt: -1 })
      .limit(missingCount * 4)
      .select(selectFields)
      .lean();

    articles = articles.concat(fallbackArticles);
  }

  return articles
    .map(enrichArticleRanking)
    .sort((a, b) => b.rankingScore - a.rankingScore);
}

async function pickBestArticlePerTopic(topics = [], options = {}) {
  if (!Array.isArray(topics) || topics.length === 0) return [];

  const { perTopicLimit = 10, alreadyShownUrls = [], alreadyShownTitles = [], seenEmbeddings = [] } = options;

  const usedUrls = new Set(alreadyShownUrls);
  const usedTitles = [...alreadyShownTitles];
  const dynamicSeenEmbeddings = [...seenEmbeddings]; 
  const results  = [];

  const rawOfficialTopics = [
    ...ALL_CATEGORIES,
    ...Object.keys(TOPIC_TO_CATEGORY),
    ...Object.values(TOPIC_TO_CATEGORY)
  ];

  const officialTopicsMap = new Map();
  for (const t of rawOfficialTopics) {
    officialTopicsMap.set(normalizeText(t), t);
  }

  const expandedQueriesMap = new Map();
  await Promise.all(topics.map(async (rawTopic) => {
    const trimmed = String(rawTopic || '').trim();
    if (trimmed) {
      const expanded = await expandTopicForEmbedding(trimmed);
      expandedQueriesMap.set(trimmed, expanded);
    }
  }));

  for (const rawTopic of topics) {
    const trimmedTopic = String(rawTopic || '').trim();
    if (!trimmedTopic) continue;

    const normTopic = normalizeText(trimmedTopic);
    
    let topic = trimmedTopic;
    if (officialTopicsMap.has(normTopic)) {
      topic = officialTopicsMap.get(normTopic); 
    }
    
    let bestUnused = null;
    let usedFallback = false;
    let fallbackCategory = null;
    let matchZone = null;
    let matchScore = null;
    let corralCategory = null;
    let candidatesEvaluated = 0;
    let matchReason = null;

    const queryForEmbedding = expandedQueriesMap.get(trimmedTopic) || trimmedTopic;
    const queryExpanded = queryForEmbedding;

    let strictCategoryFilter = null;
    if (ALL_CATEGORIES.includes(topic)) {
      strictCategoryFilter = topic; 
    } else if (TOPIC_TO_CATEGORY[topic]) {
      strictCategoryFilter = TOPIC_TO_CATEGORY[topic]; 
    }

    try {
      const searchOptions = { 
        limit: perTopicLimit * 2,
        minDate: getFreshnessCutoff() 
      };

      if (strictCategoryFilter) {
        searchOptions.category = strictCategoryFilter;
      }

      const semanticCandidates = await searchArticlesBySimilarityAtlas(trimmedTopic, queryForEmbedding, searchOptions);

      // Se evalúan los candidatos EN ORDEN hasta encontrar uno valido (no solo el primero).
      // Ancla lexica y corral de categoria se derivan de los propios candidatos (ver topicMatching.js).
      const selection = selectBestCandidate(trimmedTopic, semanticCandidates, {
        isUsable: (a) => isUsableDigestArticle(a, usedUrls, dynamicSeenEmbeddings),
        strictCategory: strictCategoryFilter,
      });

      corralCategory = selection.corral;
      candidatesEvaluated = selection.candidatesEvaluated;

      console.log(
        `[Motor Hibrido] "${trimmedTopic}" -> ${semanticCandidates.length} candidatos | ` +
        `Corral: ${selection.corral || 'Libre'} | Anclas: [${selection.anchors.join(', ')}] (${selection.anchorMode}) | ` +
        `Evaluados: ${selection.candidatesEvaluated}`
      );

      if (selection.article) {
        bestUnused = selection.article;
        matchZone = selection.zone;
        matchScore = selection.score;
        usedFallback = false;
        matchReason = `${selection.zone} score=${selection.score.toFixed(3)} (candidato #${selection.candidatesEvaluated})`;
        console.log(`[MATCH ${selection.zone}] "${bestUnused.title}" | Score: ${selection.score.toFixed(3)} | candidato #${selection.candidatesEvaluated}`);
      } else {
        matchReason = semanticCandidates.length === 0 ? 'sin_candidatos' : 'ningun_candidato_valido';
        console.warn(`Ningun candidato valido para "${trimmedTopic}" (${matchReason}).`);
        // El corral inferido tambien sirve para que el rescate se quede en el mismo rubro.
        if (!corralCategory) corralCategory = inferCorralCategory(semanticCandidates.filter((a) => (a.score || 0) >= 0.80).slice(0, 10));
      }
    } catch (error) {
      console.error(`Error en busqueda semantica para "${trimmedTopic}":`, error);
      bestUnused = null;
      matchReason = 'error_busqueda';
    }

    if (!bestUnused) {
      console.log(`[RESCATE] No hubo resultados para "${topic}". Activando rescate hibrido enfocado en categoria general...`);
      try {
        // Rubro del rescate: el oficial, o el que votaron los candidatos del propio tema (sin listas manuales).
        const emergencyCategory = fallbackCategory || strictCategoryFilter || corralCategory || 'Sociedad';
        const emergencyQuery = `${emergencyCategory} Argentina actualidad nacional`;
        
        const emergencySearchOptions = { 
          limit: perTopicLimit * 3,
          minDate: getFreshnessCutoff(),
          category: emergencyCategory
        };

        const emergencyCandidates = await searchArticlesBySimilarityAtlas(
          emergencyQuery, 
          emergencyQuery, 
          emergencySearchOptions
        );

        bestUnused = emergencyCandidates.find((article) => isUsableDigestArticle(article, usedUrls, dynamicSeenEmbeddings));
        
        if (bestUnused) {
          usedFallback = true;
          fallbackCategory = bestUnused.category || emergencyCategory;
          matchZone = 'RESCATE';
          matchScore = bestUnused.score ?? null;
          console.log(`[RESCATE EXITOSO] Entregado: "${bestUnused.title}"`);
        }
      } catch (emergencyErr) {
        console.error(`Error en rescate de emergencia hibrido para "${topic}":`, emergencyErr);
      }
    }

    if (!bestUnused) {
      results.push({ 
        topic, 
        queryExpanded,
        article: null,
        usedFallback: false,
        fallbackCategory: null,
        matchZone: null,
        matchScore: null,
        matchReason,
        corralCategory,
        candidatesEvaluated,
      });
      continue;
    }

    usedUrls.add(bestUnused.url);
    usedTitles.push(bestUnused.neutralTitle || bestUnused.title || "");
    
    if (Array.isArray(bestUnused.embedding) && bestUnused.embedding.length > 0) {
      dynamicSeenEmbeddings.push({
        title: bestUnused.neutralTitle || bestUnused.title || "",
        vector: bestUnused.embedding
      });
    }
    
    results.push({ 
      topic, 
      queryExpanded,
      article: bestUnused,
      usedFallback,
      fallbackCategory,
      matchZone,
      matchScore,
      matchReason,
      corralCategory,
      candidatesEvaluated,
    });
  }

  return results;
}

module.exports = { pickBestArticlePerTopic };