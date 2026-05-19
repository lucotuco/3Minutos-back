const Article = require('../models/Article');
const { enrichArticleRanking } = require('./articleRanking');
const { ALL_CATEGORIES } = require('../ingestion/classifyArticleTopic');

const OPINION_KEYWORDS = ['opinion', 'opinión', 'columna', 'columnista', 'editorial', 'analisis', 'análisis'];

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

  const query = {
    topicStatus: 'done',
    publishedAt: { $gte: cutoff },
    ...(isMainCategory ? { category: topic } : { topic }),
  };

  // Traemos más candidatos de los necesarios para que el ranking elija bien
  const articles = await Article.find(query)
    .sort({ importanceScore: -1, publishedAt: -1 })
    .limit(limit * 4)
    .select([
      '_id', 'title', 'url', 'sourceName',
      'section', 'region', 'tags',
      'category', 'topic',
      'importanceScore', 'publishedAt',
      'neutralTitle', 'neutralLead', 'neutralSummary',
      'neutralityScore', 'politicalBiasRisk', 'curationStatus',
      'rawSummary', 'contentSnippet', 'imageUrl',
    ].join(' '))
    .lean();

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

    const candidates = await findCandidatesForTopic(topic, perTopicLimit);
    const bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls));

    if (!bestUnused) {
      results.push({ topic, article: null });
      continue;
    }

    usedUrls.add(bestUnused.url);
    results.push({ topic, article: bestUnused });
  }

  return results;
}

module.exports = { pickBestArticlePerTopic };