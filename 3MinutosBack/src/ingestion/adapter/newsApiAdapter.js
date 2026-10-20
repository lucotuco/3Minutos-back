const { normalizeText } = require('../../utils/normalizeText');
const { pickReadableText } = require('../../utils/plainText');

const MIN_READABLE_CHARS = 40;

// NewsAPI corta "content" a 200 caracteres y le agrega "[+1234 chars]": eso no es texto de la nota.
function withoutTruncationMark(value) {
  return typeof value === 'string' ? value.replace(/\s*\[\+\d+\s+chars\]\s*$/i, '') : value;
}

function adaptNewsApiArticle(item = {}, sourceConfig = {}) {
  const title = item.title || 'Sin título';
  const url = item.url || '';
  const description = item.description;
  const content = withoutTruncationMark(item.content);

  return {
    sourceName: item.source?.name || sourceConfig.name || 'NewsAPI',
    sourceType: 'newsapi',
    sourceUrl: sourceConfig.baseUrl || 'https://newsapi.org',
    title,
    url,
    publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
    category: sourceConfig.category || 'general',
    country: sourceConfig.country || 'global',
    language: sourceConfig.language || 'es',
    author: item.author || '',
    rawSummary: pickReadableText([description, content], { minChars: MIN_READABLE_CHARS }).text,
    imageUrl: item.urlToImage || '',
    contentSnippet: pickReadableText([content, description], { minChars: MIN_READABLE_CHARS }).text,
    normalizedTitle: normalizeText(title),
    _sourceMeta: {
      type: 'newsapi',
      source: sourceConfig,
      rawItem: item,
    },
  };
}

module.exports = {
  adaptNewsApiArticle,
};