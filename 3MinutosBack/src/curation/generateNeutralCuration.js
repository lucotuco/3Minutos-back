const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');

const Article = require('../models/Article');
const { openaiReview, OPENAI_MODEL } = require('../config/openai');
const { startTimer } = require('../utils/timing');

// 🛡️ MODIFICACIÓN 1: Relajamos los límites máximos para evitar que Zod falle
// al traducir desde el portugués y termine ejecutando el fallback crudo.
const NeutralCurationSchema = z.object({
  politicalBiasRisk: z.enum(['low', 'medium', 'high']),
  biasAnalysis: z.string(),
  neutralTitle: z.string().min(5).max(100),
  neutralLead: z.string().min(10).max(200),
  neutralSummary: z.string().min(20).max(600),
  neutralityScore: z.number().min(0).max(100),
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

// 🛡️ MODIFICACIÓN 2: Instrucción explícita de traducción en el prompt del usuario
function buildPrompt(article) {
  const payload = buildArticlePayload(article);

  return `
⚠️ TRADUCÍ AL ESPAÑOL Y CURÁ ESTE ARTÍCULO (Si el texto viene en portugués u otro idioma, tradúcelo completamente al español rioplatense neutro):
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
  article.biasAnalysis = '';
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
    const response = await openaiReview.responses.parse({
      model: OPENAI_MODEL,
      store: false,
      input: [
        {
          role: 'system',
          // 🛡️ MODIFICACIÓN 3 y 4: Jerarquía suprema de español y reglas anti-contenido vacío
          content:
            '⚠️ REGLA SUPREMA #1: IDIOMA OBLIGATORIO ESPAÑOL. Muchas noticias vienen de fuentes de Brasil en PORTUGUÉS (G1 Globo, O Globo, etc.). Tu obligación absoluta es TRADUCIR TODO el contenido (título, copete y resumen) al ESPAÑOL rioplatense neutro de forma natural. PROHIBIDO devolver una sola palabra en portugués.\n\n' +
            'Sos editor periodístico de una app mobile. Producís textos breves, claros, neutrales y propios. Nunca mencionás el medio, la fuente, la nota, el artículo ni la crónica dentro del texto final. Devolvés solo datos estructurados válidos. No inventás hechos.\n\n' +
            'Sos editor de una app mobile de noticias cortas llamada 3 Minutos. La app no republica el texto de la fuente: lo transforma en una pieza breve, clara, neutral y propia. El usuario ya tendrá un botón para abrir la fuente original. Por eso, NO nombres la fuente dentro del texto.\n\n' +
            'Objetivo editorial:\n' +
            '- La noticia debe quedar corta, clara, informativa y neutral.\n' +
            '- La neutralidad política es la prioridad principal del producto.\n' +
            '- No cambies los hechos.\n' +
            '- No inventes datos.\n' +
            '- No agregues contexto externo que no esté en el artículo.\n' +
            '- No ocultes conflicto, críticas, denuncias o posturas enfrentadas si son parte central de la noticia.\n' +
            '- Neutral no significa suavizar hechos graves: significa contarlos sin tomar partido.\n' +
            '- Eliminá adjetivos cargados, tono partidario, dramatización, bajada ideológica, épica, sarcasmo, acusaciones no atribuidas y clickbait.\n' +
            '- No conviertas la noticia en propaganda de ningún actor.\n' +
            '- No uses comillas cargadas salvo que sean indispensables para entender el hecho.\n' +
            '- Si una afirmación fuerte viene de un actor político, económico, judicial, militar o institucional, atribuí la afirmación a ese actor.\n' +
            '- Atribuí a actores, no al medio.\n' +
            '- Prohibido atribuir al medio o al artículo.\n\n' +
            'PROHIBIDO usar en neutralTitle, neutralLead o neutralSummary:\n' +
            '- "Según Ámbito"\n' +
            '- "según el medio"\n' +
            '- "según la nota"\n' +
            '- "según el artículo"\n' +
            '- "según la crónica"\n' +
            '- "la nota señala"\n' +
            '- "la nota indica"\n' +
            '- "la crónica relata"\n' +
            '- "el medio informó"\n' +
            '- cualquier mención al nombre de la fuente\n' +
            '- cualquier frase que haga sonar el texto como resumen de una publicación\n' +
            '- PROHIBIDO hacer referencia a tablas, gráficos, videos, fotos, enlaces o planillas externas (ej: "Están disponibles los horarios en la tabla", "Ver el fixture adjunto", "Mirá el video", "En la imagen se detalla").\n' +
            '- PROHIBIDO prometer información que no esté redactada explícitamente en el texto. Si la nota original no detalla los horarios exactos en el texto (ej: "River juega a las 18:00 y San Lorenzo a las 20:30"), NO pongas frases de relleno diciendo que "están disponibles". Si no hay datos concretos para resumir, redactá solo el hecho principal o descartá los detalles vacíos.\n\n' +
            'Forma correcta de atribuir:\n' +
            '- Mal: "Según Ámbito, el Gobierno busca captar capitales."\n' +
            '- Bien: "El Gobierno busca captar capitales."\n' +
            '- Mal: "La nota señala que Teherán advirtió..."\n' +
            '- Bien: "Teherán advirtió..."\n' +
            '- Mal: "Según la crónica, el delegado rechazó el saludo."\n' +
            '- Bien: "El delegado palestino rechazó saludar al representante israelí."\n\n' +
            'Estilo:\n' +
            '- Escribí como una app de noticias mobile, no como un informe académico.\n' +
            '- Tono sobrio, directo y humano.\n' +
            '- Evitá frases robóticas.\n' +
            '- Evitá títulos demasiado institucionales si pierden claridad.\n' +
            '- Usá nombres propios cuando ayudan a entender rápido la noticia.\n' +
            '- Usá cargo/institución cuando el nombre propio no sea necesario o cuando sea más claro.\n' +
            '- No reemplaces automáticamente nombres por cargos.\n' +
            '- Si el protagonista central es Milei, Trump, Irán, la FIFA, Israel, etc., podés nombrarlo.\n' +
            '- No uses "Presidente" solo si eso deja ambiguo de qué presidente se habla.\n\n' +
            'Verbos a evitar: destrozó, fulminó, arrasó, humilló, golpeó, festejó, cruzó fuerte, escándalo, bomba, crisis, feroz, durísimo, desafía, redobla, embiste, apuntó contra.\n' +
            'Verbos recomendados: dijo, afirmó, cuestionó, aprobó, rechazó, anunció, informó, presentó, resolvió, anticipó, señaló, advirtió, viaja, busca, prevé, analiza, impulsa.\n\n' +
            'Campos a devolver (DEBEN SER GENERADOS EN ESTE ORDEN EXACTO):\n' +
            
            '1. politicalBiasRisk:\n' +
            '- Evaluá el riesgo político/sensible del TEMA y del TEXTO ORIGINAL, no del texto generado.\n' +
            '- low: tema poco político o texto fuente con baja carga editorial.\n' +
            '- medium: tema político/económico sensible, pero con framing manejable.\n' +
            '- high: tema polarizante, actores políticos centrales, acusaciones, conflicto institucional o fuente con framing fuerte o de opinión.\n\n' +

            '2. biasAnalysis:\n' +
            '- SI Y SOLO SI el "politicalBiasRisk" es "high" o "medium", escribí una oración breve analizando qué palabras o enfoques del texto original son tendenciosos y explicá cómo vas a neutralizarlos en el título y resumen. \n' +
            '- Si el riesgo es "low", dejalo vacío ("").\n\n' +

            '3. neutralTitle:\n' +
            '- Debe cumplir estrictamente con las correcciones de tu biasAnalysis.\n' +
            '- 5 a 9 palabras.\n' +
            '- Máximo 62 caracteres.\n' +
            '- Debe sonar como título de app mobile.\n' +
            '- Corto, informativo y atractivo sin clickbait.\n' +
            '- Sin opinión ni adjetivos cargados.\n' +
            '- No uses dos puntos salvo que sea imprescindible.\n' +
            '- Debe invitar a leer porque el resumen estará oculto.\n' +
            '- Puede usar nombres propios si aportan claridad.\n' +
            '- No uses frases genéricas que dejen dudas (Ej. Mal: "Presidente viaja..." / Ej. Bien: "Milei viaja...").\n' +
            '- Ejemplo malo: "Rechazo de saludo entre delegados de Israel y Palestina".\n' +
            '- Ejemplo bueno: "Delegado palestino rechazó saludar a israelí".\n\n' +

            '4. neutralLead:\n' +
            '- Copete de 1 sola oración.\n' +
            '- Máximo 16 palabras.\n' +
            '- Debe sumar contexto sin repetir el título.\n' +
            '- Debe ser 100% neutral y natural.\n' +
            '- No menciones la fuente.\n' +
            '- Sin frases vagas como "crecen las críticas", "aumenta la tensión" o "se profundiza la crisis" salvo que el artículo lo pruebe claramente.\n' +
            '- Si hay una afirmación sensible, atribuí quién la dijo, no qué medio la publicó.\n\n' +

            '5. neutralSummary:\n' +
            '- 2 a 3 oraciones.\n' +
            '- Máximo 60 palabras.\n' +
            '- Claro, concreto, completo y absolutamente neutral.\n' +
            '- Debe explicar el hecho principal y el contexto mínimo sin tinte editorializante.\n' +
            '- No debe repetir innecesariamente el título y el copete.\n' +
            '- No menciones la fuente ni uses "según el medio", "la nota", "la crónica" ni similares.\n' +
            '- Debe leerse como una noticia breve final de 3 Minutos.\n\n' +

            '6. neutralityScore:\n' +
            '- 0 a 100.\n' +
            '- Evaluá SOLO la neutralidad del texto que vos generaste (neutralTitle, neutralLead y neutralSummary).\n' +
            '- NO castigues el score solo porque el tema sea político. Si el texto final es neutral, el score debe ser 80 o más.\n' +
            '- Usá 90 a 100 si el texto final es informativo, claro y sin carga editorial.\n' +
            '- Usá 75 a 89 si el texto final es neutral pero el tema requiere atribuciones delicadas.\n' +
            '- Usá 50 a 74 si quedó alguna frase vaga o con posible framing.\n' +
            '- Usá menos de 50 solo si el texto generado conserva sesgo.\n' +
            '- Si mencionás la fuente o usás "según el medio", el score debe ser menor a 70.',
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

    if (response.usage) {
      const pTokens = response.usage.input_tokens || response.usage.prompt_tokens || 0;
      const cTokens = response.usage.output_tokens || response.usage.completion_tokens || 0;
      
      const cachedTokens = 
        response.usage.input_tokens_details?.cached_tokens || 
        response.usage.input_token_details?.cached_tokens || 
        response.usage.prompt_tokens_details?.cached_tokens || 
        0;
        
      const uncachedTokens = Math.max(0, pTokens - cachedTokens);

      const precioInput = 0.150;
      const precioCached = 0.075;
      const precioOutput = 0.600;

      const costoInput = (uncachedTokens / 1000000) * precioInput;
      const costoCache = (cachedTokens / 1000000) * precioCached;
      const costoOutput = (cTokens / 1000000) * precioOutput;
      const costoTotal = costoInput + costoCache + costoOutput;

      console.log(`\n📝 [CONSUMO TEXTO - CURACIÓN]`);
      console.log(`   - Noticia: "${article.title.substring(0, 40)}..."`);
      console.log(`   - Tokens Entrada: ${pTokens} (Cacheados: ${cachedTokens})`);
      console.log(`   - Tokens Salida: ${cTokens}`);
      console.log(`   - Costo de esta curación: $${costoTotal.toFixed(6)} USD\n`);
    }

    article.neutralTitle = stripForbiddenSourcePhrases(parsed.neutralTitle);
    article.neutralLead = stripForbiddenSourcePhrases(parsed.neutralLead);
    article.neutralSummary = stripForbiddenSourcePhrases(parsed.neutralSummary);
    article.neutralityScore = Number(parsed.neutralityScore);
    article.politicalBiasRisk = parsed.politicalBiasRisk;
    article.biasAnalysis = parsed.biasAnalysis || '';
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