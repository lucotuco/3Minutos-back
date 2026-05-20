const Article = require('../models/Article');
const { enrichArticleRanking } = require('./articleRanking');
const { ALL_CATEGORIES } = require('../ingestion/classifyArticleTopic');

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
  // 72hs de ventana para tener suficiente volumen
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);

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

  for (const rawTopic of topics) {
    const topic = String(rawTopic || '').trim();
    if (!topic) continue;

    // Intentar encontrar artículo para el topic específico
    let candidates = await findCandidatesForTopic(topic, perTopicLimit);
    let bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls));
    let usedFallback = false;
    let fallbackCategory = null;

    // Si no hay artículo del topic, hacer fallback a la categoría padre
    if (!bestUnused) {
      const category = TOPIC_TO_CATEGORY[topic];
      
      if (category && category !== topic) {
        // Buscar en la categoría padre
        candidates = await findCandidatesForTopic(category, perTopicLimit);
        bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls));
        
        if (bestUnused) {
          usedFallback = true;
          fallbackCategory = category;
          console.warn(
            `⚠️  No hay artículos para topic "${topic}". Usando del tema padre "${category}".`
          );
        }
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