const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');

const Article = require('../models/Article');
const { openai, OPENAI_MODEL } = require('../config/openai');

const NeutralCurationSchema = z.object({
  neutralTitle: z.string().min(8).max(62),
  neutralLead: z.string().min(15).max(120),
  neutralSummary: z.string().min(40).max(430),
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

  return truncateWords(title, 9).slice(0, 62).trim();
}

function buildFallbackLead(article) {
  const sourceText = cleanText(article.rawSummary || article.contentSnippet);

  if (sourceText) {
    return truncateWords(sourceText, 16).slice(0, 120).trim();
  }

  return buildFallbackTitle(article);
}

function buildFallbackSummary(article) {
  const sourceText = cleanText(article.rawSummary || article.contentSnippet);

  if (sourceText) {
    return truncateWords(sourceText, 60).slice(0, 430).trim();
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
- La neutralidad política es la prioridad principal del producto.
- No cambies los hechos.
- No inventes datos.
- No agregues contexto externo que no esté en el artículo.
- No ocultes conflicto, críticas, denuncias o posturas enfrentadas si son parte central de la noticia.
- Neutral no significa suavizar hechos graves: significa contarlos sin tomar partido.
- Sí eliminá adjetivos cargados, tono partidario, dramatización, bajada ideológica, épica, sarcasmo, acusaciones no atribuidas y clickbait.
- Si hay posturas enfrentadas, atribuÍ de forma neutral: "el Gobierno dijo", "la oposición cuestionó", "según el informe", "el tribunal resolvió", "según el medio".
- Evitá verbos como: destrozó, fulminó, arrasó, humilló, golpeó, festejó, cruzó fuerte, escándalo, bomba, crisis, feroz, durísimo.
- Usá verbos neutros: dijo, afirmó, cuestionó, aprobó, rechazó, anunció, informó, presentó, resolvió, anticipó, señaló.
- No uses bajada política ni opinión.
- No tomes partido.
- No conviertas la noticia en propaganda de ningún actor.
- No uses comillas cargadas salvo que sean indispensables para entender el hecho.
- Si una afirmación fuerte viene de una fuente o actor, atribuila.

Campos a devolver:

1. neutralTitle:
   - 5 a 9 palabras.
   - Máximo 62 caracteres.
   - Corto, informativo y atractivo sin clickbait.
   - Sin opinión.
   - Sin adjetivos cargados.
   - No uses dos puntos salvo que sea imprescindible.
   - Debe invitar a leer porque el resumen estará oculto.
   - No nombres políticos si no es indispensable para entender la noticia.
   - Cuando se pueda, priorizá institución/cargo antes que persona.
   - Ejemplo malo: "La crisis política de Milei impulsa a Gebel".
   - Ejemplo bueno: "Gebel suma legisladores en las provincias".
   - Ejemplo malo: "Trump desafía a la Corte y redobla su apuesta".
   - Ejemplo bueno: "Trump anuncia nuevos aranceles internacionales".

2. neutralLead:
   - Copete de 1 sola oración.
   - Máximo 16 palabras.
   - Debe sumar contexto sin repetir el título.
   - Debe ser neutral.
   - Sin frases vagas como "crecen las críticas", "aumenta la tensión" o "se profundiza la crisis" salvo que el artículo lo pruebe claramente.
   - Si hay una afirmación sensible, atribuÍ quién la dijo.

3. neutralSummary:
   - 2 a 3 oraciones.
   - Máximo 60 palabras.
   - Claro, concreto y completo.
   - Neutral.
   - Debe explicar el hecho principal y el contexto mínimo.
   - No debe tener tinte político ni editorializante.
   - No debe repetir innecesariamente el título y el copete.
   - Si el texto original trae framing fuerte, reformulalo con atribución.

4. neutralityScore:
   - 0 a 100.
   - Evaluá SOLO la neutralidad del texto que vos generaste: neutralTitle, neutralLead y neutralSummary.
   - NO castigues el score solo porque el tema sea político, polémico o sensible.
   - Si el texto final está escrito de forma neutral, el score debe ser 80 o más aunque el tema sea políticamente riesgoso.
   - Usá 90 a 100 si el texto final es informativo, atribuido y sin carga editorial.
   - Usá 75 a 89 si el texto final es neutral pero el tema requiere atribuciones delicadas.
   - Usá 50 a 74 si quedó alguna frase vaga, poco atribuida o con posible framing.
   - Usá menos de 50 solo si el texto generado conserva sesgo, opinión, acusaciones no atribuidas o lenguaje cargado.

5. politicalBiasRisk:
   - Evaluá el riesgo político/sensible del TEMA y del TEXTO ORIGINAL, no del texto generado.
   - low: tema poco político o texto fuente con baja carga editorial.
   - medium: tema político/económico sensible, pero con framing manejable.
   - high: tema polarizante, actores políticos centrales, acusaciones, conflicto institucional o fuente con framing fuerte.

Regla clave:
- neutralityScore y politicalBiasRisk miden cosas distintas.
- Ejemplo correcto: una noticia sobre Trump puede tener politicalBiasRisk: "high" y neutralityScore: 88 si el texto final quedó neutral.
- Ejemplo incorrecto: poner neutralityScore: 45 solo porque el tema es político.

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
            'Sos un editor periodístico neutral para una app mobile. Tu prioridad es producir títulos, copetes y resúmenes breves, informativos y sin tinte político. Devolvés solo datos estructurados válidos. No inventás hechos.',
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