const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');

const Article = require('../models/Article');
const { openai, OPENAI_MODEL } = require('../config/openai');
const { startTimer } = require('../utils/timing');

const NeutralCurationSchema = z.object({
  neutralTitle: z.string().min(8).max(62),
  neutralLead: z.string().min(15).max(120),
  neutralSummary: z.string().min(40).max(430),
  neutralityScore: z.number().min(0).max(100),
  politicalBiasRisk: z.enum(['low', 'medium', 'high']),
});

const FORBIDDEN_SOURCE_PHRASES = [
  'según ámbito',
  'segun ámbito',
  'según ambito',
  'segun ambito',
  'según el medio',
  'segun el medio',
  'según la nota',
  'segun la nota',
  'según el artículo',
  'segun el articulo',
  'según el portal',
  'segun el portal',
  'según la crónica',
  'segun la cronica',
  'la nota señala',
  'la nota indica',
  'la nota afirma',
  'la crónica señala',
  'la cronica señala',
  'el artículo señala',
  'el articulo señala',
  'el medio señala',
  'el portal señala',
  'ámbito señaló',
  'ambito señaló',
  'ámbito informó',
  'ambito informó',
];

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

function stripForbiddenSourcePhrases(value) {
  let text = cleanText(value);

  for (const phrase of FORBIDDEN_SOURCE_PHRASES) {
    const pattern = new RegExp(phrase, 'gi');
    text = text.replace(pattern, '').replace(/\s+/g, ' ').trim();
  }

  return text
    .replace(/^,\s*/, '')
    .replace(/^\.\s*/, '')
    .replace(/\s+,/g, ',')
    .replace(/\s+\./g, '.')
    .replace(/\.\s*\./g, '.')
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

Clasificá este artículo:
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

  const timer = startTimer('generateNeutralCuration', {
    articleId: String(articleId),
    title: article?.title || '',
  });

  if (!article) {
    const error = new Error('Article not found');
    timer.fail(error, {
      articleId: String(articleId),
    });
    throw error;
  }

  if (
    !force &&
    article.curationStatus === 'done' &&
    article.neutralTitle &&
    article.neutralLead &&
    article.neutralSummary
  ) {
    timer.end({
      cached: true,
      curationStatus: article.curationStatus,
      neutralityScore: article.neutralityScore,
      politicalBiasRisk: article.politicalBiasRisk,
    });

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
            'Sos editor periodístico de una app mobile. Producís textos breves, claros, neutrales y propios. Nunca mencionás el medio, la fuente, la nota, el artículo ni la crónica dentro del texto final. Devolvés solo datos estructurados válidos. No inventás hechos.Sos editor de una app mobile de noticias cortas llamada 3 Minutos. La app no republica el texto de la fuente: lo transforma en una pieza breve, clara, neutral y propia. El usuario ya tendrá un botón para abrir la fuente original. Por eso, NO nombres la fuente dentro del texto. Objetivo editorial: - La noticia debe quedar corta, clara, informativa y neutral. - La neutralidad política es la prioridad principal del producto. - No cambies los hechos. - No inventes datos. - No agregues contexto externo que no esté en el artículo. - No ocultes conflicto, críticas, denuncias o posturas enfrentadas si son parte central de la noticia. - Neutral no significa suavizar hechos graves: significa contarlos sin tomar partido. - Eliminá adjetivos cargados, tono partidario, dramatización, bajada ideológica, épica, sarcasmo, acusaciones no atribuidas y clickbait. - No conviertas la noticia en propaganda de ningún actor. - No uses comillas cargadas salvo que sean indispensables para entender el hecho. - Si una afirmación fuerte viene de un actor político, económico, judicial, militar o institucional, atribuí la afirmación a ese actor. - Atribuí a actores, no al medio. - Prohibido atribuir al medio o al artículo. PROHIBIDO usar en neutralTitle, neutralLead o neutralSummary: - "Según Ámbito" - "según el medio" - "según la nota" - "según el artículo" - "según la crónica" - "la nota señala" - "la nota indica" - "la crónica relata" - "el medio informó" - cualquier mención al nombre de la fuente - cualquier frase que haga sonar el texto como resumen de una publicación Forma correcta de atribuir: - Mal: "Según Ámbito, el Gobierno busca captar capitales." - Bien: "El Gobierno busca captar capitales." - Mal: "La nota señala que Teherán advirtió..." - Bien: "Teherán advirtió..." - Mal: "Según la crónica, el delegado rechazó el saludo." - Bien: "El delegado palestino rechazó saludar al representante israelí." Estilo: - Escribí como una app de noticias mobile, no como un informe académico. - Tono sobrio, directo y humano. - Evitá frases robóticas. - Evitá títulos demasiado institucionales si pierden claridad. - Usá nombres propios cuando ayudan a entender rápido la noticia. - Usá cargo/institución cuando el nombre propio no sea necesario o cuando sea más claro. - No reemplaces automáticamente nombres por cargos. - Si el protagonista central es Milei, Trump, Irán, la FIFA, Israel, etc., podés nombrarlo. - No uses "Presidente" solo si eso deja ambiguo de qué presidente se habla. Verbos a evitar: destrozó, fulminó, arrasó, humilló, golpeó, festejó, cruzó fuerte, escándalo, bomba, crisis, feroz, durísimo, desafía, redobla, embiste, apuntó contra. Verbos recomendados: dijo, afirmó, cuestionó, aprobó, rechazó, anunció, informó, presentó, resolvió, anticipó, señaló, advirtió, viaja, busca, prevé, analiza, impulsa. Campos a devolver: 1. neutralTitle: - 5 a 9 palabras. - Máximo 62 caracteres. - Debe sonar como título de app mobile. - Corto, informativo y atractivo sin clickbait. - Sin opinión. - Sin adjetivos cargados. - No uses dos puntos salvo que sea imprescindible. - Debe invitar a leer porque el resumen estará oculto. - Puede usar nombres propios si aportan claridad. - No uses frases genéricas que dejen dudas, por ejemplo "Presidente viaja..." si se puede decir "Milei viaja...". - Ejemplo malo: "Presidente viaja a Los Ángeles por inversiones". - Ejemplo bueno: "Milei viaja a Los Ángeles por inversiones". - Ejemplo malo: "Rechazo de saludo entre delegados de Israel y Palestina". - Ejemplo bueno: "Delegado palestino rechazó saludar a israelí". - Ejemplo malo: "Secretario del Tesoro prevé baja del petróleo tras conflicto". - Ejemplo bueno: "EE.UU. prevé una baja del petróleo". 2. neutralLead: - Copete de 1 sola oración. - Máximo 16 palabras. - Debe sumar contexto sin repetir el título. - Debe ser neutral. - Debe sonar natural. - No menciones la fuente. - Sin frases vagas como "crecen las críticas", "aumenta la tensión" o "se profundiza la crisis" salvo que el artículo lo pruebe claramente. - Si hay una afirmación sensible, atribuí quién la dijo, no qué medio la publicó. 3. neutralSummary: - 2 a 3 oraciones. - Máximo 60 palabras. - Claro, concreto y completo. - Neutral. - Debe explicar el hecho principal y el contexto mínimo. - No debe tener tinte político ni editorializante. - No debe repetir innecesariamente el título y el copete. - No menciones la fuente. - No uses "según el medio", "la nota", "la crónica" ni similares. - Debe leerse como una noticia breve final de 3 Minutos. 4. neutralityScore: - 0 a 100. - Evaluá SOLO la neutralidad del texto que vos generaste: neutralTitle, neutralLead y neutralSummary. - NO castigues el score solo porque el tema sea político, polémico o sensible. - Si el texto final está escrito de forma neutral, el score debe ser 80 o más aunque el tema sea políticamente riesgoso. - Usá 90 a 100 si el texto final es informativo, claro y sin carga editorial. - Usá 75 a 89 si el texto final es neutral pero el tema requiere atribuciones delicadas. - Usá 50 a 74 si quedó alguna frase vaga, poco atribuida o con posible framing. - Usá menos de 50 solo si el texto generado conserva sesgo, opinión, acusaciones no atribuidas o lenguaje cargado. - Si mencionás la fuente o usás "según el medio", el score debe ser menor a 70. 5. politicalBiasRisk: - Evaluá el riesgo político/sensible del TEMA y del TEXTO ORIGINAL, no del texto generado. - low: tema poco político o texto fuente con baja carga editorial. - medium: tema político/económico sensible, pero con framing manejable. - high: tema polarizante, actores políticos centrales, acusaciones, conflicto institucional o fuente con framing fuerte. - Si el artículo es de opinión o tiene framing editorial fuerte, el riesgo debe ser high. Regla clave: - neutralityScore y politicalBiasRisk miden cosas distintas. - Ejemplo correcto: una noticia sobre Trump puede tener politicalBiasRisk: "high" y neutralityScore: 88 si el texto final quedó neutral. - Ejemplo incorrecto: poner neutralityScore: 45 solo porque el tema es político. - El texto final nunca debe nombrar el medio del que sale la información.',
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

    article.neutralTitle = stripForbiddenSourcePhrases(parsed.neutralTitle);
    article.neutralLead = stripForbiddenSourcePhrases(parsed.neutralLead);
    article.neutralSummary = stripForbiddenSourcePhrases(parsed.neutralSummary);
    article.neutralityScore = Number(parsed.neutralityScore);
    article.politicalBiasRisk = parsed.politicalBiasRisk;
    article.curationStatus = 'done';
    article.curationGeneratedAt = new Date();
    article.curationError = '';
    article.curationModel = OPENAI_MODEL;

    const combinedText = [
      article.neutralTitle,
      article.neutralLead,
      article.neutralSummary,
    ]
      .join(' ')
      .toLowerCase();

    const hasForbiddenSourcePhrase = FORBIDDEN_SOURCE_PHRASES.some((phrase) =>
      combinedText.includes(phrase)
    );

    if (hasForbiddenSourcePhrase) {
      article.neutralityScore = Math.min(article.neutralityScore, 65);
      article.curationError = 'Generated text contained forbidden source attribution';
    }

    await article.save();

    timer.end({
      cached: false,
      fallback: false,
      neutralityScore: article.neutralityScore,
      politicalBiasRisk: article.politicalBiasRisk,
    });

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

    timer.fail(error, {
      articleId: String(article._id),
      title: article.title,
    });

    return saveFallbackCuration(
      article,
      error.message || 'Neutral curation generation failed'
    );
  }
}

module.exports = {
  generateNeutralCuration,
};