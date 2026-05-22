const Article = require('../models/Article');
const { enrichArticleRanking } = require('./articleRanking');
const { ALL_CATEGORIES } = require('../ingestion/classifyArticleTopic');
const { searchArticlesBySimilarityAtlas } = require('../embeddings/searchArticlesBySimilarityAtlas');

const OPINION_KEYWORDS = ['opinion', 'opinión', 'columna', 'columnista', 'editorial', 'analisis', 'análisis'];

// Mapeo de topic → categoría padre
const TOPIC_TO_CATEGORY = {
  'Gobierno Nacional': 'Política',
  'Justicia y Corrupción': 'Política',
  'Elecciones': 'Política',
  'Política Provincial': 'Política',
  'Seguridad': 'Política',
  'Dólar e Inflación': 'Economía',
  'Mercados': 'Economía',
  'Empresas y Negocios': 'Economía',
  'Trabajo y Salarios': 'Economía',
  'Criptomonedas': 'Economía',
  'EEUU': 'Mundo',
  'Medio Oriente': 'Mundo',
  'Europa': 'Mundo',
  'América Latina': 'Mundo',
  'Salud Global': 'Mundo',
  'Fútbol Local': 'Deportes',
  'Fútbol Internacional': 'Deportes',
  'Mundial 2026': 'Deportes',
  'Básquet': 'Deportes',
  'Tenis': 'Deportes',
  'Otros Deportes': 'Deportes',
  'Salud': 'Sociedad',
  'Educación': 'Sociedad',
  'Clima y Ambiente': 'Sociedad',
  'Género': 'Sociedad',
  'Seguridad Ciudadana': 'Sociedad',
  'Inteligencia Artificial': 'Tecnología',
  'Ciencia y Espacio': 'Tecnología',
  'Gadgets': 'Tecnología',
  'Internet': 'Tecnología',
  'Cine y Series': 'Cultura y Vida',
  'Música': 'Cultura y Vida',
  'Turismo y Viajes': 'Cultura y Vida',
  'Libros': 'Cultura y Vida',
  'Autos': 'Cultura y Vida',
  'Bienestar': 'Cultura y Vida',
};

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function includesOpinionKeyword(value) {
  const normalized = normalizeText(value);
  return OPINION_KEYWORDS.some((kw) => normalized.includes(normalizeText(kw)));
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

function isUsableDigestArticle(article, usedUrls) {
  if (!article?.url)             return false;
  if (usedUrls.has(article.url)) return false;
  if (isOpinionArticle(article)) return false;
  return true;
}

async function findCandidatesForTopic(topic, limit) {
  // 48hs de ventana para tener suficiente volumen
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const isMainCategory = ALL_CATEGORIES.includes(topic);

  const baseQuery = {
    publishedAt: { $gte: cutoff },
    ...(isMainCategory ? { category: topic } : { topic }),
  };

  const selectFields = [
    '_id', 'title', 'url', 'sourceName',
    'section', 'region', 'tags',
    'category', 'topic',
    'importanceScore', 'publishedAt',
    'neutralTitle', 'neutralLead', 'neutralSummary',
    'neutralityScore', 'politicalBiasRisk', 'curationStatus',
    'rawSummary', 'contentSnippet', 'imageUrl',
  ].join(' ');

  // Primero intentar con topicStatus: 'done'
  let articles = await Article.find({
    ...baseQuery,
    topicStatus: 'done',
  })
    .sort({ importanceScore: -1, publishedAt: -1 })
    .limit(limit * 10)
    .select(selectFields)
    .lean();

  // Si no hay suficientes, hacer fallback a pending/error
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

  // Aplicar algoritmo de ranking (importanceScore 70% + freshness 30%)
  return articles
    .map(enrichArticleRanking)
    .sort((a, b) => b.rankingScore - a.rankingScore);
}

async function pickBestArticlePerTopic(topics = [], options = {}) {
  if (!Array.isArray(topics) || topics.length === 0) return [];

  const { perTopicLimit = 10, alreadyShownUrls = [] } = options;

  const usedUrls = new Set(alreadyShownUrls);
  const results  = [];

  // Pre-armar la lista de tópicos oficiales para que la validación sea rápida
  const officialTopics = new Set([
    ...ALL_CATEGORIES,
    ...Object.keys(TOPIC_TO_CATEGORY),
    ...Object.values(TOPIC_TO_CATEGORY)
  ]);

  for (const rawTopic of topics) {
    const topic = String(rawTopic || '').trim();
    if (!topic) continue;

    const isOfficial = officialTopics.has(topic);
    
    let bestUnused = null;
    let usedFallback = false;
    let fallbackCategory = null;

    if (isOfficial) {
      // ============================================
      // CAMINO A: TEMA OFICIAL (Búsqueda Tradicional)
      // ============================================
      let candidates = await findCandidatesForTopic(topic, perTopicLimit);
      bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls));

      // Si no hay artículo del topic exacto, hacer fallback manual a la categoría padre
      if (!bestUnused) {
        const category = TOPIC_TO_CATEGORY[topic];
        if (category && category !== topic) {
          candidates = await findCandidatesForTopic(category, perTopicLimit);
          bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls));
          
          if (bestUnused) {
            usedFallback = true;
            fallbackCategory = category;
          }
        }
      }
    } else {
      // ============================================
      // CAMINO B: TEMA LIBRE (Búsqueda Vectorial)
      // ============================================
      try {
        const semanticCandidates = await searchArticlesBySimilarityAtlas(topic, { 
          limit: perTopicLimit * 2 
        });

        const usableSemantic = semanticCandidates.filter(a => isUsableDigestArticle(a, usedUrls));

        if (usableSemantic.length > 0) {
          const bestMatch = usableSemantic[0];
          
          // Log para debuguear y ver qué score realmente tira Atlas
          console.log(`🔍 [Tema Libre] "${topic}" -> Match: "${bestMatch.title}" | Score: ${bestMatch.score?.toFixed(3)} | Topic Real: ${bestMatch.topic || bestMatch.category}`);
          
          // Bajamos el umbral a 0.68
          if (bestMatch.score >= 0.68) {
            bestUnused = bestMatch;
            usedFallback = false;
          } else {
            fallbackCategory = bestMatch.topic || bestMatch.category || 'Cultura y Vida';
            
            let candidates = await findCandidatesForTopic(fallbackCategory, perTopicLimit);
            bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls));
            usedFallback = true;
            
            console.warn(`⚠️  Score semántico bajo (${bestMatch.score?.toFixed(2)}) para "${topic}". Fallback a "${fallbackCategory}".`);
          }
        } else {
          fallbackCategory = 'Cultura y Vida';
          let candidates = await findCandidatesForTopic(fallbackCategory, perTopicLimit);
          bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls));
          usedFallback = true;
        }
      } catch (error) {
        console.error(`❌ Error en búsqueda semántica para "${topic}":`, error);
        usedFallback = true;
      }
    }

    if (!bestUnused) {
      results.push({ 
        topic, 
        article: null,
        usedFallback: false,
        fallbackCategory: null,
      });
      continue;
    }

    usedUrls.add(bestUnused.url);
    results.push({ 
      topic, 
      article: bestUnused,
      usedFallback,
      fallbackCategory,
    });
  }

  return results;
}

module.exports = { pickBestArticlePerTopic };