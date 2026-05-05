const { searchArticlesBySimilarityAtlas } = require('../embeddings/searchArticlesBySimilarityAtlas');

const OPINION_KEYWORDS = [
  'opinion',
  'opinión',
  'columna',
  'columnista',
  'editorial',
  'analisis',
  'análisis',
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function includesOpinionKeyword(value) {
  const normalized = normalizeText(value);

  return OPINION_KEYWORDS.some((keyword) =>
    normalized.includes(normalizeText(keyword))
  );
}

function isOpinionArticle(article = {}) {
  const url = normalizeText(article.url);
  const title = normalizeText(article.title);
  const section = normalizeText(article.section);
  const category = normalizeText(article.category);
  const tags = Array.isArray(article.tags) ? article.tags.map(normalizeText) : [];

  if (url.includes('/opiniones/') || url.includes('/opinion/')) {
    return true;
  }

  if (includesOpinionKeyword(section) || includesOpinionKeyword(category)) {
    return true;
  }

  if (tags.some((tag) => includesOpinionKeyword(tag))) {
    return true;
  }

  if (includesOpinionKeyword(title)) {
    return true;
  }

  return false;
}

function isUsableDigestArticle(article, usedUrls) {
  if (!article?.url) {
    return false;
  }

  if (usedUrls.has(article.url)) {
    return false;
  }

  if (isOpinionArticle(article)) {
    return false;
  }

  return true;
}

async function pickBestArticlePerTopic(topics = [], options = {}) {
  if (!Array.isArray(topics) || topics.length === 0) {
    return [];
  }

  const {
    perTopicLimit = 10,
    numCandidates = 100,
    alreadyShownUrls = [],
  } = options;

  const usedUrls = new Set(alreadyShownUrls);
  const results = [];

  for (const rawTopic of topics) {
    const topic = String(rawTopic || '').trim();
    if (!topic) continue;

    const candidates = await searchArticlesBySimilarityAtlas(topic, {
      limit: perTopicLimit,
      vectorLimit: perTopicLimit,
      numCandidates,
    });

    const bestUnused = candidates.find((article) =>
      isUsableDigestArticle(article, usedUrls)
    );

    if (!bestUnused) {
      results.push({
        topic,
        article: null,
      });
      continue;
    }

    usedUrls.add(bestUnused.url);

    results.push({
      topic,
      article: bestUnused,
    });
  }

  return results;
}

module.exports = {
  pickBestArticlePerTopic,
};