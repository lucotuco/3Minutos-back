const Article = require('../models/Article');
const { enrichArticleRanking } = require('./articleRanking');
const { ALL_CATEGORIES } = require('../ingestion/classifyArticleTopic');
const { searchArticlesBySimilarityAtlas } = require('../embeddings/searchArticlesBySimilarityAtlas');

const OPINION_KEYWORDS = ['opinion', 'opinión', 'columna', 'columnista', 'editorial', 'analisis', 'análisis'];

const TOPIC_TO_CATEGORY = {
  'Gobierno Nacional': 'Política',
  'Justicia': 'Política',
  'Elecciones': 'Política',
  'Educación': 'Política',
  'Seguridad': 'Política',
  'Dólar y Mercados': 'Economía',
  'Inflación y Consumo': 'Economía',
  'Empresas y Negocios': 'Economía',
  'Inversiones': 'Economía',
  'Emprendedores': 'Economía',
  'EEUU': 'Internacional',
  'Medio Oriente': 'Internacional',
  'Europa': 'Internacional',
  'América Latina': 'Internacional',
  'Conflictos': 'Internacional',
  'Geopolítica': 'Internacional',
  'Fútbol': 'Deportes',
  'Mundial 2026': 'Deportes',
  'Básquet': 'Deportes',
  'Tenis': 'Deportes',
  'Rugby': 'Deportes',
  'Salud': 'Sociedad',
  'Bienestar': 'Sociedad',
  'Clima y Ambiente': 'Sociedad',
  'Historias Humanas': 'Sociedad',
  'Tendencias Y Vida': 'Sociedad',
  'Inteligencia Artificial': 'Tecnología',
  'Ciencia y Espacio': 'Tecnología',
  'Apps y Redes': 'Tecnología',
  'Innovación': 'Tecnología',
  'Videojuegos': 'Tecnología',
  'Cine y Series': 'Entretenimiento/Cultura',
  'Música': 'Entretenimiento/Cultura',
  'Turismo y Viajes': 'Entretenimiento/Cultura',
  'Streaming': 'Entretenimiento/Cultura',
  'Autos': 'Entretenimiento/Cultura',
  'Viral y Trending': 'Entretenimiento/Cultura',
  'Teatro y Literatura': 'Entretenimiento/Cultura',
};

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

function calculateTitleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;
  
  const cleanText = (t) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\s]/g, " ");
  
  const words1 = new Set(cleanText(title1).split(/\s+/).filter(w => w.length > 3));
  const words2 = new Set(cleanText(title2).split(/\s+/).filter(w => w.length > 3));
  
  if (words1.size === 0 || words2.size === 0) return 0;
  
  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  
  const union = words1.size + words2.size - intersection;
  return intersection / union;
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


function isUsableDigestArticle(article, usedUrls, usedTitles = []) {
  if (!article?.url) return false;
  if (usedUrls.has(article.url)) return false;
  if (isOpinionArticle(article)) return false;

  // FILTRO ANTI-DUPLICADOS POR SIMILITUD (Si el título se parece más de un 40% a algo ya leído)
  const candidateTitle = article.neutralTitle || article.title || "";
  for (const seenTitle of usedTitles) {
    const similarity = calculateTitleSimilarity(candidateTitle, seenTitle);
    
    if (similarity > 0.40) {
      console.log(`      ⛔ [SIMILITUD ${Math.round(similarity*100)}%] Descartando: "${candidateTitle}" (Se parece a: "${seenTitle}")`);
      return false; // Descartamos la noticia porque ya leyó algo casi igual
    }
  }

  return true;
}

async function findCandidatesForTopic(topic, limit, useCutoff = true) {
  const isMainCategory = ALL_CATEGORIES.includes(topic);

  const baseQuery = {
    ...(isMainCategory ? { category: topic } : { topic: new RegExp('^' + topic + '$', 'i') }),
  };

  // Solo aplicamos el límite de 7 días si useCutoff es true
  if (useCutoff) {
    const cutoff = new Date(Date.now() - 168 * 60 * 60 * 1000);
    baseQuery.publishedAt = { $gte: cutoff };
  }

  const selectFields = [
    '_id', 'title', 'url', 'sourceName',
    'section', 'region', 'tags',
    'category', 'topic',
    'importanceScore', 'publishedAt',
    'neutralTitle', 'neutralLead', 'neutralSummary',
    'neutralityScore', 'politicalBiasRisk', 'curationStatus',
    'rawSummary', 'contentSnippet', 'imageUrl',
  ].join(' ');

  let articles = await Article.find({ ...baseQuery, topicStatus: 'done' })
    .sort({ importanceScore: -1, publishedAt: -1 })
    .limit(limit * 10)
    .select(selectFields)
    .lean();

  if (articles.length < limit) {
    const missingCount = limit - articles.length;
    const fallbackArticles = await Article.find({
      ...baseQuery,
      topicStatus: { $in: ['pending', 'error'] },
    })
      .sort({ importanceScore: -1, publishedAt: -1 })
      .limit(missingCount * 4)
      .select(selectFields)
      .lean();

    articles = articles.concat(fallbackArticles);
  }

  return articles
    .map(enrichArticleRanking)
    .sort((a, b) => b.rankingScore - a.rankingScore);
}

async function pickBestArticlePerTopic(topics = [], options = {}) {
  if (!Array.isArray(topics) || topics.length === 0) return [];

  // 👇 MODIFICACIÓN: Recibimos los títulos ya leídos 👇
  const { perTopicLimit = 10, alreadyShownUrls = [], alreadyShownTitles = [] } = options;

  const usedUrls = new Set(alreadyShownUrls);
  const usedTitles = [...alreadyShownTitles]; // Copiamos al array local
  const results  = [];

  // Pre-armar la lista de tópicos oficiales para que la validación sea rápida
  const rawOfficialTopics = [
    ...ALL_CATEGORIES,
    ...Object.keys(TOPIC_TO_CATEGORY),
    ...Object.values(TOPIC_TO_CATEGORY)
  ];

  const officialTopicsMap = new Map();
  for (const t of rawOfficialTopics) {
    officialTopicsMap.set(normalizeText(t), t);
  }

  for (const rawTopic of topics) {
    const trimmedTopic = String(rawTopic || '').trim();
    if (!trimmedTopic) continue;

    const normTopic = normalizeText(trimmedTopic);
    
    // Asumimos el tema tal cual viene, pero si está en nuestro mapa, usamos el oficial
    let topic = trimmedTopic;
    let isOfficial = false;

    if (officialTopicsMap.has(normTopic)) {
      topic = officialTopicsMap.get(normTopic); 
      isOfficial = true;
    }
    
    let bestUnused = null;
    let usedFallback = false;
    let fallbackCategory = null;

    if (isOfficial) {
      // INTENTO 1: Buscar notas frescas
      let candidates = await findCandidatesForTopic(topic, perTopicLimit, true);
      // 👇 MODIFICACIÓN: Le agregamos `usedTitles` a todos los filter/find 👇
      bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls, usedTitles));

      // INTENTO 2: Si no hay frescas, buscar históricas de ESE tema sin límite
      if (!bestUnused) {
        candidates = await findCandidatesForTopic(topic, perTopicLimit, false);
        bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls, usedTitles));
      }

      // INTENTO 3: Fallback a Categoría (ej: Rugby -> Deportes)
      if (!bestUnused) {
        const category = TOPIC_TO_CATEGORY[topic];
        if (category && category !== topic) {
          candidates = await findCandidatesForTopic(category, perTopicLimit, true);
          bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls, usedTitles));
          
          if (bestUnused) {
            usedFallback = true;
            fallbackCategory = category;
          }
        }
      }
    } else {
      // ============================================
      // CAMINO B: TEMA LIBRE (Búsqueda Vectorial Atlas)
      // ============================================
      try {
        const semanticCandidates = await searchArticlesBySimilarityAtlas(topic, { 
          limit: perTopicLimit * 2 
        });

        // 👇 MODIFICACIÓN: Agregamos usedTitles 👇
        const usableSemantic = semanticCandidates.filter(a => isUsableDigestArticle(a, usedUrls, usedTitles));

        if (usableSemantic.length > 0) {
          const bestMatch = usableSemantic[0];
          
          console.log(`🔍 [Tema Libre] "${topic}" -> Match: "${bestMatch.title}" | Score: ${bestMatch.score?.toFixed(3)}`);
          
          if (bestMatch.score >= 0.60) {
            bestUnused = bestMatch;
            usedFallback = false;
          } else {
            fallbackCategory = bestMatch.topic || bestMatch.category || 'Entretenimiento/Cultura';
            
            let candidates = await findCandidatesForTopic(fallbackCategory, perTopicLimit);
            bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls, usedTitles));
            usedFallback = true;
            
            console.warn(`⚠️  Score semántico bajo. Fallback a "${fallbackCategory}".`);
          }
        } else {
          fallbackCategory = 'Entretenimiento/Cultura';
          let candidates = await findCandidatesForTopic(fallbackCategory, perTopicLimit);
          bestUnused = candidates.find((article) => isUsableDigestArticle(article, usedUrls, usedTitles));
          usedFallback = true;
        }
      } catch (error) {
        console.error(`❌ Error en búsqueda semántica para "${topic}":`, error);
        usedFallback = true;
      }
    }

    if (!bestUnused) {
      results.push({ 
        topic, 
        article: null,
        usedFallback: false,
        fallbackCategory: null,
      });
      continue;
    }

    usedUrls.add(bestUnused.url);
    // 👇 MODIFICACIÓN VITAL: Bloqueamos el título nuevo para la próxima vuelta del bucle
    usedTitles.push(bestUnused.neutralTitle || bestUnused.title || "");
    
    results.push({ 
      topic, 
      article: bestUnused,
      usedFallback,
      fallbackCategory,
    });
  }

  return results;
}

module.exports = { pickBestArticlePerTopic };