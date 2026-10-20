'use strict';

/**
 * topicExpansionStore.js
 *
 * Copia en Mongo de las expansiones de los temas libres (topicExpansion.js). Sin esto, cada reinicio o deploy del
 * servidor arranca con la caché en memoria vacía y el primer usuario de cada tema paga la llamada a la IA (~1,2 s de
 * más en un digest que mira alguien en pantalla). Con esto, esa primera vez es una lectura de ~30 ms.
 *
 * Orden de búsqueda (lo arma el expansor): memoria -> llamada en curso -> ESTA copia -> IA. Qué garantiza:
 *
 *   - La clave es un hash del modelo, la semilla, el prompt del año (que incluye la taxonomía de temas oficiales) y el
 *     tema: cambiar el prompt, la taxonomía o el año hace que las copias viejas dejen de usarse solas, sin migrar nada.
 *   - Lo que se lee pasa por el MISMO validador que la respuesta de la IA (parseExpansion): categoría y subtema
 *     tienen que seguir siendo de la taxonomía actual y la consulta siempre empieza con las palabras del usuario.
 *     Una copia que no pasa se ignora (se pregunta a la IA) y se pisa con la respuesta nueva.
 *   - Solo se guardan respuestas válidas de la IA: nunca el "no pude expandir" de un fallo.
 *   - Una copia vale STORE_TTL_MS (7 días); la edad se revisa en cada lectura, no se confía en el índice TTL de Mongo.
 *   - Si Mongo falla o tarda más de STORE_READ_TIMEOUT_MS en contestar, es como si no hubiera copia: el digest sigue
 *     con la IA. Si la escritura falla, se avisa en el log y nada más; el expansor nunca espera a que termine.
 *
 * SOLO LO ACTIVA EL SERVIDOR (server.js llama a enablePersistentExpansionCache() después de conectar a Mongo). El test
 * de estrés y el comparador importan topicExpansion.js sin almacén: siguen siendo de solo lectura. Interruptor:
 * TOPIC_EXPANSION_STORE=off lo apaga sin tocar código. Para forzar que todos los temas se vuelvan a expandir, vaciar la
 * colección `topic_expansions`.
 *
 * Todo lo que toca Mongo entra por parámetro (getModel, now, warn): se prueba con un modelo falso.
 */

const crypto = require('crypto');
const {
  EXPANSION_MODEL, EXPANSION_SEED, buildSystemPrompt, parseExpansion, setExpansionStore,
} = require('./topicExpansion');
const { isSwitchedOff, raceWithTimeout, TIMED_OUT } = require('./llmJudge');

const STORE_TTL_MS = 7 * 24 * 3600e3;
const STORE_READ_TIMEOUT_MS = 800;
const STORE_SWITCH = 'TOPIC_EXPANSION_STORE';

function defaultModel() {
  // Carga perezosa: el modelo se compila recién cuando el servidor activa el almacén.
  return require('../models/TopicExpansion');
}

/** Clave de una copia: sha1 del modelo, la semilla, el prompt de ese año y el tema normalizado. */
function storeKey(topicKey, year) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify([EXPANSION_MODEL, EXPANSION_SEED, buildSystemPrompt(year), topicKey]))
    .digest('hex');
}

/**
 * @returns {{ get:(topicKey:string, ctx:{topic:string,year:number})=>Promise<{q:string,cat:string,sub:string}|null>,
 *             set:(topicKey:string, value:{q:string,cat:string,sub:string}, ctx:{topic:string,year:number})=>Promise<void>,
 *             keyFor:(topicKey:string, year:number)=>string }}
 */
function createExpansionStore({
  getModel = defaultModel,
  now = Date.now,
  ttlMs = STORE_TTL_MS,
  readTimeoutMs = STORE_READ_TIMEOUT_MS,
  warn = (m, e) => console.warn(m, e),
} = {}) {
  /** La expansión guardada del tema, validada, o null (no hay, venció, no sirve, Mongo falló o tardó). Nunca lanza. */
  async function get(topicKey, { topic = topicKey, year = new Date(now()).getFullYear() } = {}) {
    let doc;
    try {
      const found = await raceWithTimeout(
        getModel().findOne({ key: storeKey(topicKey, year) }).maxTimeMS(readTimeoutMs).lean(),
        readTimeoutMs,
      );
      if (found === TIMED_OUT) {
        warn(`Copia de expansiones: no se pudo leer "${topic}", se pregunta a la IA:`, `sin respuesta en ${readTimeoutMs} ms`);
        return null;
      }
      doc = found;
    } catch (error) {
      warn(`Copia de expansiones: no se pudo leer "${topic}", se pregunta a la IA:`, error.message);
      return null;
    }
    if (!doc) return null;

    const age = now() - new Date(doc.createdAt).getTime(); // una fecha ilegible da NaN y no pasa
    if (!(age >= 0 && age <= ttlMs)) return null;
    if (typeof doc.q !== 'string' || !doc.q.trim()) return null;

    return parseExpansion(JSON.stringify({ q: doc.q, cat: doc.cat, sub: doc.sub }), topic);
  }

  /** Guarda (o renueva) la expansión del tema. Nunca lanza ni rechaza: si falla, avisa y sigue. */
  async function set(topicKey, value, { topic = topicKey, year = new Date(now()).getFullYear() } = {}) {
    try {
      await getModel().updateOne(
        { key: storeKey(topicKey, year) },
        {
          $set: {
            topic: topicKey, q: value.q, cat: value.cat, sub: value.sub, model: EXPANSION_MODEL, createdAt: new Date(now()),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      warn(`Copia de expansiones: no se pudo guardar "${topic}":`, error.message);
    }
  }

  return { get, set, keyFor: storeKey };
}

/**
 * Conecta el almacén al expansor del servidor. Devuelve true si quedó activo. Lo llama server.js después de conectar a
 * Mongo; compila el modelo ya (así Mongoose arma sus índices al arrancar y no en el primer pedido). Cualquier problema
 * al activarlo deja el servidor funcionando como antes, solo con la caché en memoria.
 */
function enablePersistentExpansionCache({
  env = process.env,
  loadModel = defaultModel,
  setStore = setExpansionStore,
  warn = (m, e) => console.warn(m, e),
  ...options
} = {}) {
  if (isSwitchedOff(STORE_SWITCH, env)) return false;
  try {
    const model = loadModel();
    setStore(createExpansionStore({ getModel: () => model, warn, ...options }));
    return true;
  } catch (error) {
    warn('No se pudo activar la copia de expansiones en Mongo:', error.message);
    return false;
  }
}

module.exports = {
  STORE_TTL_MS,
  STORE_READ_TIMEOUT_MS,
  STORE_SWITCH,
  storeKey,
  createExpansionStore,
  enablePersistentExpansionCache,
};
