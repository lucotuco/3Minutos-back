const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');
const { openaiReview, OPENAI_MODEL } = require('../config/openai');
const { buildEmbeddingText } = require('../embeddings/buildEmbeddingsText');
const GlobalContext = require('../models/GlobalContext');

const BatchReviewSchema = z.object({
  reviews: z.array(
    z.object({
      id: z.number().int().min(0),
      category: z.string(),
      topic: z.string(),
      geoScope: z.string(),
      tags: z.array(z.string().min(1).max(50)).max(5),
      importanceScore: z.number().min(0).max(100),
      aiConfidence: z.number().min(0).max(1),
    })
  ),
});

const CATEGORIES = {
  'Política':       ['Gobierno Nacional', 'Justicia', 'Elecciones', 'Educación', 'Seguridad'],
  'Economía':       ['Dólar y Mercados', 'Inflación y Consumo', 'Empresas y Negocios', 'Inversiones', 'Emprendedores'],
  'Internacional':  ['EEUU', 'Medio Oriente', 'Europa', 'América Latina', 'Conflictos', 'Geopolítica'],
  'Deportes':       ['Fútbol', 'F1', 'Básquet', 'Tenis', 'Rugby'],
  'Sociedad':       ['Salud', 'Bienestar', 'Clima y Ambiente', 'Historias Humanas', 'Tendencias y Vida'],
  'Tecnología':     ['Inteligencia Artificial', 'Ciencia y Espacio', 'Apps y Redes', 'Innovación', 'Videojuegos'],
  'Entretenimiento/Cultura': ['Cine y Series', 'Música', 'Turismo y Viajes', 'Streaming', 'Autos', 'Viral y Trending', 'Teatro y Literatura'],
};

const ALL_CATEGORIES = Object.keys(CATEGORIES);
const TOPIC_TO_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORIES).flatMap(([cat, topics]) => topics.map((t) => [t, cat]))
);

const LOWERCASE_WORDS = new Set(['y', 'de', 'del', 'la', 'el', 'los', 'las', 'en', 'a']);
function normalizeFreeTopic(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i > 0 && LOWERCASE_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function buildCategoryListText() {
  return Object.entries(CATEGORIES)
    .map(([cat, topics]) => {
      const lines = topics.map((t, i) => `     ${i + 1}. "${t}"`).join('\n');
      return `  Categoría: "${cat}"\n  Subtemas permitidos SOLO para esta categoría:\n${lines}`;
    })
    .join('\n\n');
}

function sanitizeTag(tag = '') {
  return String(tag).trim().toLowerCase().slice(0, 50);
}

function getImportanceLevel(score = 0) {
  const numericScore = Number(score || 0);

  if (numericScore >= 70) return 'high';
  if (numericScore >= 40) return 'medium';
  return 'low';
}

function buildArticlePayload(article = {}, index) {
  const summarySource = String(article.rawSummary || article.contentSnippet || '').trim();
  const truncatedSummary = summarySource.substring(0, 150) + (summarySource.length > 150 ? '...' : '');

  return {
    id: index,
    sourceName: article.sourceName || '',
    title: article.title || '',
    summary: truncatedSummary,
  };
}

async function reviewArticlesWithAIBatch(articles = []) {
  if (!Array.isArray(articles) || articles.length === 0) {
    return [];
  }

  const payload = articles.map((article, index) => buildArticlePayload(article, index));

  const systemPrompt = `
Sos el editor en jefe de un newsletter premium y un clasificador experto de noticias.
Tu tarea es clasificar y evaluar cada noticia de forma integral.

REGLAS DE IMPORTANCE SCORE (0 a 100 basado en NOVEDAD y VALOR CONVERSACIONAL):
- PUNTÚA ALTO (80-100): Análisis profundos, revelaciones, historias humanas, consecuencias inesperadas.
- PUNTÚA MEDIO (50-79): Noticias duras y hechos consumados muy mainstream.
- PUNTÚA BAJO (0-49): Minuto a minuto, previas, agenda, relleno, notas hiper-locales sin impacto general.

LISTA DE CATEGORÍAS Y SUBTEMAS OFICIALES:
${buildCategoryListText()}

REGLAS DE CLASIFICACIÓN:
1. "category": DEBE ser una de las Categorías Oficiales.
2. "topic": DEBE pertenecer a los Subtemas de LA MISMA "category" que elegiste. Solo si NO encaja en NINGÚN subtema oficial de su categoría, creá una etiqueta libre de 1 a 3 palabras.
3. "geoScope": El país principal donde ocurren los hechos (ej: "Argentina", "México"). Usá "Global" SOLO si afecta a todo el mundo por igual.
4. 🌍 REGLA GEOGRÁFICA ESTRICTA: Las categorías "Política" y "Economía" son EXCLUSIVAS para Argentina. Si el evento ocurre en OTRO PAÍS (ej: España, Brasil), DEBE ir a "Internacional".

OTRAS REGLAS:
- Devolvé exactamente una review por cada artículo recibido usando su "id" numérico.
- "tags": Entre 0 y 5 etiquetas cortas y útiles.
- "aiConfidence": Escala de 0 a 1 indicando tu grado de seguridad en la evaluación.
`;

  const latestContext = await GlobalContext.findOne().sort({ createdAt: -1 });
  const contextText = latestContext ? latestContext.summary : "Sin contexto global reciente.";

  const fechaActual = new Date().toLocaleDateString('es-AR', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
  });

  const userPrompt = `
DATOS DE CONTEXTO:
- Fecha de hoy: ${fechaActual}
- Contexto Mundial: "${contextText}"

REGLA DE ANACRONISMO: Si una noticia habla en tiempo futuro de un evento que ya pasó según el Contexto y la Fecha de Hoy, DEBÉS castigar su importanceScore drásticamente (0 a 30).

Artículos a evaluar:
${JSON.stringify(payload, null, 2)}
`;

  const response = await openaiReview.responses.parse({
    model: OPENAI_MODEL,
    store: false,
    input: [
      { role: 'system', content: systemPrompt.trim() },
      { role: 'user', content: userPrompt.trim() },
    ],
    text: {
      format: zodTextFormat(BatchReviewSchema, 'article_batch_review'),
    },
  });

  const parsed = response.output_parsed;
  const reviewMap = new Map();

  for (const item of parsed.reviews || []) {
    const tags = Array.from(
      new Set((item.tags || []).map(sanitizeTag).filter(Boolean))
    ).slice(0, 5);

    const tagScores = tags.reduce((acc, tag) => {
      acc[tag] = Number(item.aiConfidence || 0);
      return acc;
    }, {});

    let category = ALL_CATEGORIES.includes(item.category) ? item.category : 'Sociedad';
    let topic = String(item.topic || 'General').trim();
    const geoScope = String(item.geoScope || 'Global').trim();

    if (TOPIC_TO_CATEGORY[topic]) {
      category = TOPIC_TO_CATEGORY[topic];
    } else {
      topic = normalizeFreeTopic(topic);
    }
    
    const isForeign = geoScope !== 'Argentina' && geoScope !== 'Global';
    const domesticCategories = ['Política', 'Economía'];
    
    if (isForeign && domesticCategories.includes(category)) {
      category = 'Internacional';
      const latamCountries = ['Brasil', 'Chile', 'Uruguay', 'Perú', 'Colombia', 'México', 'Venezuela', 'Bolivia', 'Paraguay', 'Ecuador'];
      const europeCountries = ['España', 'Francia', 'Italia', 'Reino Unido', 'Alemania', 'Rusia', 'Ucrania'];
      
      if (latamCountries.includes(geoScope)) topic = 'América Latina';
      else if (europeCountries.includes(geoScope)) topic = 'Europa';
      else if (geoScope === 'Estados Unidos') topic = 'EEUU';
      else topic = 'Geopolítica';
    }

    reviewMap.set(item.id, {
      category,
      topic,
      geoScope,
      topicStatus: 'done',
      tags,
      tagScores,
      importanceScore: Number(item.importanceScore),
      importanceLevel: getImportanceLevel(item.importanceScore),
      aiConfidence: Number(item.aiConfidence),
      aiReviewed: true,
      classificationStatus: 'ai_reviewed',
    });
  }

  return articles.map((article, index) => {
    const review = reviewMap.get(index);

    if (!review) {
      return {
        ...article,
        aiReviewed: false,
        aiConfidence: 0,
        aiChangedClassification: false,
        aiReason: 'AI batch review returned no result for this article',
        classificationStatus: 'needs_review',
        importanceLevel: getImportanceLevel(article.importanceScore || 0),
      };
    }

    const enrichedArticle = {
      ...article,
      category: review.category,
      topic: review.topic,
      geoScope: review.geoScope,
      topicStatus: review.topicStatus,
      tags: review.tags,
      tagScores: review.tagScores,
      importanceScore: review.importanceScore,
      importanceLevel: review.importanceLevel,
      aiConfidence: review.aiConfidence,
      classificationStatus: review.classificationStatus,
    };

    return {
      ...enrichedArticle,
      embeddingText: article.embeddingText || buildEmbeddingText(enrichedArticle),
      embeddingStatus: article.embeddingStatus || 'pending',
      embeddingModel: article.embeddingModel || '',
      embeddingGeneratedAt: article.embeddingGeneratedAt || null,
      embeddingError: article.embeddingError || '',
      embedding: article.embedding || undefined,
    };
  });
}

module.exports = {
  reviewArticlesWithAIBatch,
};