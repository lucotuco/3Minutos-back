const Article = require('../models/Article');
const { openaiReview, OPENAI_MODEL } = require('../config/openai');

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  return stripHtml(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function getIncompleteReason(response) {
  return (
    response?.incomplete_details?.reason ||
    response?.incompleteDetails?.reason ||
    response?.status ||
    'unknown'
  );
}

function buildFallbackSummary(article) {
  const sourceText = cleanText(article.rawSummary || article.contentSnippet);

  if (sourceText) {
    return sourceText;
  }

  const title = cleanText(article.title);

  if (title) {
    return title;
  }

  return 'Resumen no disponible por el momento.';
}

function buildSummaryPrompt(article) {
  const title = cleanText(article.title);
  const sourceText = cleanText(article.rawSummary || article.contentSnippet);

  return `
Resumí esta noticia para una app mobile de noticias.

Reglas:
- Escribí en español.
- Hacé 1 o 2 oraciones.
- Preferentemente entre 20 y 45 palabras.
- Que sea claro, directo y completo.
- No repitas el título literalmente.
- No uses HTML.
- No uses listas.
- No inventes datos.
- No termines con puntos suspensivos.

Título: ${title}
Texto fuente: ${sourceText}

Resumen:
`.trim();
}

function extractResponseText(response) {
  const directText = cleanText(response?.output_text);

  if (directText) {
    return directText;
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  const parts = [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];

    for (const contentItem of content) {
      if (contentItem?.type === 'output_text' && contentItem?.text) {
        parts.push(contentItem.text);
      }

      if (contentItem?.type === 'text' && contentItem?.text) {
        parts.push(contentItem.text);
      }
    }
  }

  return cleanText(parts.join(' '));
}

async function saveFallbackSummary(article, errorMessage) {
  const fallbackSummary = buildFallbackSummary(article);

  article.summary = fallbackSummary;
  article.summaryStatus = 'done';
  article.summaryGeneratedAt = new Date();
  article.summaryError = errorMessage || '';

  await article.save();

  return {
    article,
    summary: fallbackSummary,
    cached: false,
    fallback: true,
  };
}

async function generateArticleSummary(articleId) {
  const article = await Article.findById(articleId);

  if (!article) {
    throw new Error('Article not found');
  }

  const existingSummary = cleanText(article.summary);

  if (existingSummary) {
    return {
      article,
      summary: existingSummary,
      cached: true,
      fallback: false,
    };
  }

  const prompt = buildSummaryPrompt(article);

  try {
    const response = await openaiReview.responses.create({
      model: OPENAI_MODEL,
      reasoning: {
        effort: 'minimal',
      },
      input: prompt,
      max_output_tokens: 1200,
    });

    const summary = extractResponseText(response);

    if (!summary) {
      const reason = getIncompleteReason(response);

      console.error('❌ OpenAI devolvió summary vacío');
      console.error('status:', response?.status);
      console.error('incomplete_details:', response?.incomplete_details);
      console.error('articleId:', String(article._id));
      console.error('title:', article.title);

      return saveFallbackSummary(
        article,
        `OpenAI returned empty summary. status=${response?.status || 'unknown'} reason=${reason}`
      );
    }

    article.summary = summary;
    article.summaryStatus = 'done';
    article.summaryGeneratedAt = new Date();
    article.summaryError = '';

    await article.save();

    return {
      article,
      summary,
      cached: false,
      fallback: false,
    };
  } catch (error) {
    console.error('❌ Error generando summary con OpenAI');
    console.error('articleId:', String(article._id));
    console.error('title:', article.title);
    console.error('error:', error.message);

    return saveFallbackSummary(
      article,
      error.message || 'OpenAI summary generation failed'
    );
  }
}

module.exports = {
  generateArticleSummary,
};