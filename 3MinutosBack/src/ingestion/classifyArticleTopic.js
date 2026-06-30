const { openai } = require('../config/openai');

const CATEGORIES = {
  'Política':       ['Gobierno Nacional', 'Justicia', 'Elecciones', 'Educación', 'Seguridad'],
  'Economía':       ['Dólar y Mercados', 'Inflación y Consumo', 'Empresas y Negocios', 'Inversiones', 'Emprendedores'],
  'Internacional':  ['EEUU', 'Medio Oriente', 'Europa', 'América Latina', 'Conflictos', 'Geopolítica'],
  'Deportes':       ['Fútbol', 'Mundial 2026', 'Básquet', 'Tenis', 'Rugby'],
  'Sociedad':       ['Salud', 'Bienestar', 'Clima y Ambiente', 'Historias Humanas', 'Tendencias Y Vida'],
  'Tecnología':     ['Inteligencia Artificial', 'Ciencia y Espacio', 'Apps y Redes', 'Innovación', 'Videojuegos'],
  'Entretenimiento/Cultura': ['Cine y Series', 'Música', 'Turismo y Viajes', 'Streaming', 'Autos', 'Viral y Trending','Teatro y Literatura'],
};

const DEFAULT_TOPIC_PER_CATEGORY = {
  'Política':       'Política',
  'Economía':       'Economía',
  'Internacional':  'Internacional',
  'Deportes':       'Deportes',
  'Sociedad':       'Sociedad',
  'Tecnología':     'Tecnología',
  'Entretenimiento/Cultura': 'Entretenimiento/Cultura',
};

const ALL_CATEGORIES = Object.keys(CATEGORIES);
const ALL_TOPICS     = Object.values(CATEGORIES).flat();

function buildCategoryListText() {
  return Object.entries(CATEGORIES)
    .map(([cat, topics]) => {
      const lines = topics.map((t, i) => `     ${i + 1}. "${t}"`).join('\n');
      return `  Categoría: "${cat}"\n  Subtemas:\n${lines}`;
    })
    .join('\n\n');
}

function buildPromptReglasYCategorias() {
  return `Sos un clasificador de noticias argentinas. Tu única tarea es elegir UNA categoría y UN subtema de la lista de abajo.
  LISTA COMPLETA DE OPCIONES (solo podés usar estos valores, copiados exactamente):
${buildCategoryListText()}
REGLAS ESTRICTAS:
- Respondé ÚNICAMENTE con JSON válido. Sin texto antes ni después. Sin backticks.
- Formato exacto: {"category": "...", "topic": "..."}
- Los valores deben ser COPIA EXACTA de los nombres de la lista de arriba.
- NUNCA inventes un subtema que no esté en la lista.

REGLAS DE CLASIFICACIÓN PARA ARGENTINA:
- Fútbol (clubes locales, Europa, torneos, etc.) → topic: "Fútbol"
- Dólar, blue, MEP, CCL, reservas, bolsa, acciones, riesgo país → topic: "Dólar y Mercados"
- Precios, inflación, IPC, consumo, aumentos → topic: "Inflación y Consumo"
- Empresas, PyMES, exportaciones, negocios corporativos → topic: "Empresas y Negocios"
- Milei, Casa Rosada, Adorni, decretos del Ejecutivo → topic: "Gobierno Nacional"
- Corte Suprema, juicios, causas penales, tribunales → topic: "Justicia"
- Escuelas, universidades, paros docentes, políticas educativas → topic: "Educación"
- Asesinatos, robos, policía, inseguridad → topic: "Seguridad"
- Salud mental, nutrición, fitness, calidad de vida → topic: "Bienestar"
- Historias de vida, relatos personales inspiradores, solidaridad → topic: "Historias Humanas"
- Moda, diseño, estilo de vida, hábitos sociales modernos → topic: "Tendencias Y Vida"
- Netflix, Prime, Disney+, plataformas digitales → topic: "Streaming"
- Influencers, memes, redes sociales, contenido viral, TikTok → topic: "Viral y Trending"
- Guerras, tensiones militares o diplomáticas entre países → topic: "Conflictos" o "Geopolítica"`;
}

function buildPrompt(article) {
  const title   = String(article.title || '').trim();
  const summary = String(article.rawSummary || article.contentSnippet || '').trim();
  const source  = String(article.sourceName || '').trim();
  const section = String(article.section   || '').trim();

  return `ARTÍCULO A CLASIFICAR:
Titular: ${title}
${summary  ? `Resumen: ${summary}`     : ''}
${source   ? `Fuente: ${source}`       : ''}
${section  ? `Sección RSS: ${section}` : ''}`;
}

function findClosestTopic(category, rawTopic) {
  if (!CATEGORIES[category]) return DEFAULT_TOPIC_PER_CATEGORY[category];

  const normalized = String(rawTopic || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  const match = CATEGORIES[category].find((validTopic) => {
    const validNorm = validTopic
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return validNorm.includes(normalized) || normalized.includes(validNorm.split(' ')[0]);
  });

  return match || DEFAULT_TOPIC_PER_CATEGORY[category];
}

async function classifyArticleTopic(article = {}) {
  const title = String(article.title || '').trim();
  if (!title) throw new Error('Missing article title for classification');

  const prompt = buildPrompt(article);
  const promptDeReglasYCategorias= buildPromptReglasYCategorias();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: promptDeReglasYCategorias },
      { role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 80,
  });

  const raw   = String(response.choices?.[0]?.message?.content || '').trim();
  const clean = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Classifier returned invalid JSON: ${raw}`);
  }

  const category = String(parsed.category || '').trim();
  const topic    = String(parsed.topic    || '').trim();

  if (!ALL_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: "${category}"`);
  }

  if (CATEGORIES[category].includes(topic)) {
    return { category, topic };
  }

  const correctCategory = ALL_CATEGORIES.find((cat) => CATEGORIES[cat].includes(topic));
  if (correctCategory) {
    console.warn(`⚠️  Topic "${topic}" movido de "${category}" → "${correctCategory}"`);
    return { category: correctCategory, topic };
  }

  const fallback = findClosestTopic(category, topic);
  console.warn(`⚠️  Topic inválido "${topic}" en "${category}" → fallback: "${fallback}"`);
  return { category, topic: fallback };
}

module.exports = {
  classifyArticleTopic,
  CATEGORIES,
  ALL_CATEGORIES,
  ALL_TOPICS,
};