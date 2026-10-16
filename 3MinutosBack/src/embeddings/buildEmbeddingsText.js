const { toPlainText } = require('../utils/plainText');

// Cuánto del resumen entra al embedding. La identidad de una noticia está en el título y el arranque; un cuerpo
// entero (las notas rescatadas pueden tener miles de caracteres) diluye el vector y puede pasarse del límite del modelo.
const EMBEDDING_SUMMARY_MAX_CHARS = 1500;

function buildEmbeddingText(article = {}) {
  // Texto plano: un <img src="...?auth=..."> o un &#xF3; no dicen nada de la noticia pero sí mueven el vector.
  const summary = toPlainText(article.rawSummary || article.contentSnippet || '', { maxChars: EMBEDDING_SUMMARY_MAX_CHARS });

  const parts = [
    Array.isArray(article.tags) && article.tags.length
      ? `Tags: ${article.tags.join(', ')}`
      : '',
    article.title ? `Título: ${article.title}` : '',
    summary ? `Resumen: ${summary}` : '',
  ];

  return parts.filter(Boolean).join('\n').trim();
}

module.exports = { buildEmbeddingText, EMBEDDING_SUMMARY_MAX_CHARS };
