const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');

const Article = require('../models/Article');
const { openai, OPENAI_MODEL } = require('../config/openai');

const NeutralCurationSchema = z.object({
  neutralTitle: z.string().min(8).max(90),
  neutralLead: z.string().min(20).max(180),
  neutralSummary: z.string().min(40).max(500),
  neutralityScore: z.number().min(0).max(100),
  politicalBiasRisk: z.enum(['low', 'medium', 'high']),
});

function cleanText(value) {
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

function truncateWords(text, maxWords) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);

  if (words.length <= maxWords) {
    return words.join(' ');
  }

  return words.slice(0, maxWords).join(' ');
}

function buildFallbackTitle(article) {
  const title = cleanText(article.title);

  if (!title) return 'Noticia relevante del día';

  return truncateWords(title, 12);
}

function buildFallbackLead(article) {
  const sourceText = cleanText(article.rawSummary || article.contentSnippet);

  if (sourceText) {
    return truncateWords(sourceText, 24);
  }

  return buildFallbackTitle(article);
}

function buildFallbackSummary(article) {
  const sourceText = cleanText(article.rawSummary || article.contentSnippet);

  if (sourceText) {
    return truncateWords(sourceText, 70);
  }

  return buildFallbackLead(article);
}

function buildArticlePayload(article) {
  return {
    sourceName: article.sourceName || '',
    title: article.title || '',
    rawSummary: article.rawSummary || '',
    contentSnippet: article.contentSnippet || '',
    section: article.section || '',
    region: article.region || '',
    tags: article.tags || [],
    publishedAt: article.publishedAt || null,
  };
}

function buildPrompt(article) {
  const payload = buildArticlePayload(article);

  return `
Sos un editor de una app mobile de noticias cortas llamada 3 Minutos.

Objetivo editorial:
- La noticia debe quedar corta, clara, informativa y neutral.
- La neutralidad política es prioritaria.
- No cambies los hechos.
- No inventes datos.
- No ocultes que hay conflicto, críticas, denuncias o posturas enfrentadas si son parte central de la noticia.
- Sí eliminá adjetivos cargados, tono partidario, dramatización, bajada ideológica, épica, sarcasmo, acusaciones no atribuidas y clickbait.
- Si hay posturas enfrentadas, atribuí de forma neutral: "el Gobierno dijo", "la oposición cuestionó", "según el informe", "el tribunal resolvió".
- Evitá verbos como: destrozó, fulminó, arrasó, humilló, golpeó, festejó, cruzó fuerte, escándalo, bomba.
- Usá verbos neutros: dijo, afirmó, cuestionó, aprobó, rechazó, anunció, informó, presentó, resolvió.
- No uses bajada política ni opinión.
- No tomes partido.
- No suavices hechos graves: neutral no significa minimizar.

Campos a devolver:

1. neutralTitle:
   - 6 a 12 palabras.
   - Corto, informativo y atractivo sin clickbait.
   - Sin opinión.
   - Sin adjetivos cargados.
   - No uses dos puntos salvo que sea imprescindible.
   - Debe invitar a leer porque el resumen estará oculto.

2. neutralLead:
   - Copete de 1 oración.
   - Máximo 22 palabras.
   - Debe sumar contexto sin repetir el título.
   - Debe ser neutral.

3. neutralSummary:
   - 2 a 4 oraciones.
   - Claro y completo.
   - Neutral.
   - Debe explicar el hecho principal y contexto mínimo.
   - No debe tener tinte político ni editorializante.

4. neutralityScore:
   - 0 a 100.
   - 100 = completamente neutral.
   - Bajá puntaje si el tema o el texto fuente tiene mucho framing político, acusaciones fuertes o lenguaje cargado.

5. politicalBiasRisk:
   - low: texto fácil de neutralizar, poca carga política.
   - medium: tema político o económico sensible, pero neutralizable.
   - high: fuerte riesgo de sesgo, polarización, acusaciones o framing partidario.

Artículo:
${JSON.stringify(payload, null, 2)}
`.trim();
}

async function saveFallbackCuration(article, errorMessage = '') {
  const fallbackTitle = buildFallbackTitle(article);
  const fallbackLead = buildFallbackLead(article);
  const fallbackSummary = buildFallbackSummary(article);

  article.neutralTitle = fallbackTitle;
  article.neutralLead = fallbackLead;
  article.neutralSummary = fallbackSummary;
  article.neutralityScore = 50;
  article.politicalBiasRisk = 'unknown';
  article.curationStatus = 'error';
  article.curationGeneratedAt = new Date();
  article.curationError = errorMessage || 'Neutral curation failed';
  article.curationModel = OPENAI_MODEL;

  await article.save();

  return {
    article,
    neutralTitle: fallbackTitle,
    neutralLead: fallbackLead,
    neutralSummary: fallbackSummary,
    neutralityScore: 50,
    politicalBiasRisk: 'unknown',
    cached: false,
    fallback: true,
  };
}

async function generateNeutralCuration(articleId, options = {}) {
  const { force = false } = options;

  const article = await Article.findById(articleId);

  if (!article) {
    throw new Error('Article not found');
  }

  if (
    !force &&
    article.curationStatus === 'done' &&
    article.neutralTitle &&
    article.neutralLead &&
    article.neutralSummary
  ) {
    return {
      article,
      neutralTitle: article.neutralTitle,
      neutralLead: article.neutralLead,
      neutralSummary: article.neutralSummary,
      neutralityScore: article.neutralityScore,
      politicalBiasRisk: article.politicalBiasRisk,
      cached: true,
      fallback: false,
    };
  }

  const prompt = buildPrompt(article);

  try {
    const response = await openai.responses.parse({
      model: OPENAI_MODEL,
      store: false,
      input: [
        {
          role: 'system',
          content:
            'Sos un editor periodístico neutral. Devolvés solo datos estructurados válidos. No inventás hechos.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      text: {
        format: zodTextFormat(NeutralCurationSchema, 'neutral_article_curation'),
      },
    });

    const parsed = response.output_parsed;

    article.neutralTitle = cleanText(parsed.neutralTitle);
    article.neutralLead = cleanText(parsed.neutralLead);
    article.neutralSummary = cleanText(parsed.neutralSummary);
    article.neutralityScore = Number(parsed.neutralityScore);
    article.politicalBiasRisk = parsed.politicalBiasRisk;
    article.curationStatus = 'done';
    article.curationGeneratedAt = new Date();
    article.curationError = '';
    article.curationModel = OPENAI_MODEL;

    await article.save();

    return {
      article,
      neutralTitle: article.neutralTitle,
      neutralLead: article.neutralLead,
      neutralSummary: article.neutralSummary,
      neutralityScore: article.neutralityScore,
      politicalBiasRisk: article.politicalBiasRisk,
      cached: false,
      fallback: false,
    };
  } catch (error) {
    console.error('❌ Error generando curación neutral');
    console.error('articleId:', String(article._id));
    console.error('title:', article.title);
    console.error('error:', error.message);

    return saveFallbackCuration(
      article,
      error.message || 'Neutral curation generation failed'
    );
  }
}

module.exports = {
  generateNeutralCuration,
};