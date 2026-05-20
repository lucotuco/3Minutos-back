// src/ingestion/classifyArticleTopic.js
const { openai } = require('../config/openai');

const CATEGORIES = {
  'Política':       ['Gobierno Nacional', 'Justicia y Corrupción', 'Elecciones', 'Política Provincial', 'Seguridad'],
  'Economía':       ['Dólar e Inflación', 'Mercados', 'Empresas y Negocios', 'Trabajo y Salarios', 'Criptomonedas'],
  'Mundo':          ['EEUU', 'Medio Oriente', 'Europa', 'América Latina', 'Salud Global'],
  'Deportes':       ['Fútbol Local', 'Fútbol Internacional', 'Mundial 2026', 'Básquet', 'Tenis', 'Otros Deportes'],
  'Sociedad':       ['Salud', 'Educación', 'Clima y Ambiente', 'Género', 'Seguridad Ciudadana'],
  'Tecnología':     ['Inteligencia Artificial', 'Ciencia y Espacio', 'Gadgets', 'Internet'],
  'Cultura y Vida': ['Cine y Series', 'Música', 'Turismo y Viajes', 'Libros', 'Autos', 'Bienestar'],
};

const DEFAULT_TOPIC_PER_CATEGORY = {
  'Política':       'Política',
  'Economía':       'Economía',
  'Mundo':          'Mundo',
  'Deportes':       'Deportes',
  'Sociedad':       'Sociedad',
  'Tecnología':     'Tecnología',
  'Cultura y Vida': 'Cultura y Vida',
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

function buildPrompt(article) {
  const title   = String(article.title || '').trim();
  const summary = String(article.rawSummary || article.contentSnippet || '').trim();
  const source  = String(article.sourceName || '').trim();
  const section = String(article.section   || '').trim();

  return `Sos un clasificador de noticias argentinas. Tu única tarea es elegir UNA categoría y UN subtema de la lista de abajo.

LISTA COMPLETA DE OPCIONES (solo podés usar estos valores, copiados exactamente):
${buildCategoryListText()}

ARTÍCULO A CLASIFICAR:
Titular: ${title}
${summary  ? `Resumen: ${summary}`     : ''}
${source   ? `Fuente: ${source}`       : ''}
${section  ? `Sección RSS: ${section}` : ''}

REGLAS ESTRICTAS:
- Respondé ÚNICAMENTE con JSON válido. Sin texto antes ni después. Sin backticks.
- Formato exacto: {"category": "...", "topic": "..."}
- Los valores deben ser COPIA EXACTA de los nombres de la lista de arriba.
- NUNCA inventes un subtema que no esté en la lista.

REGLAS DE CLASIFICACIÓN PARA ARGENTINA:
- Clubes argentinos (Boca, River, Racing, San Lorenzo, Huracán, Belgrano, etc.) o torneos locales (Apertura, Clausura, Copa Argentina, Sudamericana, Libertadores) → topic: "Fútbol Local"
- Fútbol europeo, Champions League, ligas europeas → topic: "Fútbol Internacional"
- Dólar, tipo de cambio, blue, MEP, CCL, cepo, reservas BCRA → topic: "Dólar e Inflación"
- ADRs, bonos, acciones, riesgo país, Wall Street, bolsa → topic: "Mercados"
- Empresas, PyMES, exportaciones, negocios corporativos, YPF, energía → topic: "Empresas y Negocios"
- Milei, Casa Rosada, Adorni, gabinete, decretos del Ejecutivo → topic: "Gobierno Nacional"
- Gobernadores, intendentes, legislaturas provinciales, coparticipación → topic: "Política Provincial"
- Corte Suprema, juicios, causas penales, corrupción → topic: "Justicia y Corrupción"
- Sustentabilidad, cambio climático, medio ambiente → topic: "Clima y Ambiente"
- Salud pública, hospitales, vacunas, enfermedades (Argentina) → topic: "Salud"
- Brotes, pandemias, salud mundial → topic: "Salud Global"
- Moda, hogar, mascotas, gastronomía, vinos, psicología cotidiana, recetas, feng shui → topic: "Bienestar"
- Turismo, viajes, destinos, hoteles → topic: "Turismo y Viajes"
- Series, películas, streaming (Netflix, Prime, Disney+) → topic: "Cine y Series"
- Conciertos, artistas musicales → topic: "Música"`;
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

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
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

  // Categoría inválida → error real
  if (!ALL_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: "${category}"`);
  }

  // Topic correcto en la categoría correcta → perfecto
  if (CATEGORIES[category].includes(topic)) {
    return { category, topic };
  }

  // Topic válido pero en categoría incorrecta → buscar la categoría correcta
  const correctCategory = ALL_CATEGORIES.find((cat) => CATEGORIES[cat].includes(topic));
  if (correctCategory) {
    console.warn(`⚠️  Topic "${topic}" movido de "${category}" → "${correctCategory}"`);
    return { category: correctCategory, topic };
  }

  // Topic realmente inválido → fallback
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