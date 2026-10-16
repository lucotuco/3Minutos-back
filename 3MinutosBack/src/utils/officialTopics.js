'use strict';

/**
 * officialTopics.js
 *
 * Taxonomía oficial (7 categorías y 38 subtemas) y resolución de lo que escribe el usuario.
 * Lógica PURA (sin Mongo ni OpenAI).
 *
 * Un tópico del usuario puede ser:
 *   - una CATEGORÍA oficial        ("Deportes")           -> kind: 'category'
 *   - un SUBTEMA oficial           ("Fútbol", "futbol")   -> kind: 'subtopic'
 *   - cualquier otra cosa ("river plate", "Zverev")       -> null (tema libre)
 *
 * Las búsquedas son sin importar mayúsculas ni tildes. Se usan Map y Object.hasOwn: un objeto común
 * devolvería funciones heredadas para "constructor", "toString" o "__proto__" (y las tomaría como oficiales).
 */

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

/** subtema -> categoría. Es un Map a propósito (ver el comentario de arriba). */
const TOPIC_TO_CATEGORY = new Map(
  Object.entries(CATEGORIES).flatMap(([cat, topics]) => topics.map((t) => [t, cat]))
);

function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** clave normalizada -> { kind, name, category } */
const BY_KEY = new Map();
for (const cat of ALL_CATEGORIES) {
  BY_KEY.set(normalizeKey(cat), { kind: 'category', name: cat, category: cat });
}
for (const [topic, cat] of TOPIC_TO_CATEGORY) {
  BY_KEY.set(normalizeKey(topic), { kind: 'subtopic', name: topic, category: cat });
}

/**
 * @param {unknown} raw  lo que escribió el usuario
 * @returns {{kind:'category'|'subtopic', name:string, category:string}|null}  null = tema libre
 */
function resolveOfficialTopic(raw) {
  if (typeof raw !== 'string') return null;
  const hit = BY_KEY.get(normalizeKey(raw));
  return hit ? { ...hit } : null;
}

/** Categoría de un subtema oficial EXACTO ("Fútbol" -> "Deportes"); null si no es un subtema oficial. */
function categoryOfSubtopic(name) {
  return TOPIC_TO_CATEGORY.get(name) ?? null;
}

module.exports = {
  CATEGORIES,
  ALL_CATEGORIES,
  TOPIC_TO_CATEGORY,
  normalizeKey,
  resolveOfficialTopic,
  categoryOfSubtopic,
};
