'use strict';

/**
 * llmJudge.js
 *
 * Infraestructura común de los "jueces" con IA del motor de elección: preguntas cortas de sí/no a gpt-4o-mini que
 * resuelven lo que el coseno y las palabras no pueden (¿estas dos notas cuentan el mismo hecho? ¿esta nota es de
 * lo que pidió el usuario?). Cada juez concreto (sameEventJudge.js, topicJudge.js) define su pregunta; acá está lo
 * que tienen en común y lo que evita que un juez haga más lento el digest:
 *
 *   - Caché compartida entre usuarios: la misma pregunta (la misma nota contra la misma otra nota, o contra el mismo
 *     tema) se contesta una sola vez durante 36 h. Dos usuarios que piden la misma cosa casi nunca pagan la IA dos veces.
 *   - Llamadas en curso compartidas: si dos digests preguntan lo mismo a la vez, hay una sola llamada.
 *   - PRESUPUESTO DE ESPERA por digest (JudgeSession): el digest espera a los jueces como mucho este tiempo en total
 *     (1,5 s si alguien está mirando la pantalla, 4 s si lo arma el proceso de fondo). Pasado el presupuesto el motor
 *     sigue SIN el veredicto, como si el juez no existiera; la llamada sigue en segundo plano y deja su respuesta en la
 *     caché para la próxima vez. Con presupuesto 0 solo se usa lo que ya esté en la caché.
 *   - Un juez que falla, tarda o contesta algo que no se entiende nunca frena ni rompe el digest: devuelve "sin veredicto".
 *   - Interruptor por variable de entorno (SAME_STORY_JUDGE=off, TOPIC_JUDGE=off): apaga ese juez sin tocar código.
 *
 * Todo lo que toca la red entra por parámetro (getClient, now, env, log): se prueba con una IA falsa.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_TTL_MS = 36 * 3600e3;
const DEFAULT_CACHE_MAX_ENTRIES = 5000;

// Cuánto espera un digest, en total, a todos los jueces.
const DEFAULT_LIVE_WAIT_MS = 1500;
const DEFAULT_BACKGROUND_WAIT_MS = 4000;

const OFF_VALUES = new Set(['off', '0', 'false', 'no']);
const TIMED_OUT = Symbol('timed_out');

/** true si la variable de entorno apaga el juez (off / 0 / false / no). Prendido por defecto. */
function isSwitchedOff(name, env = process.env) {
  return OFF_VALUES.has(String(env?.[name] ?? '').trim().toLowerCase());
}

/**
 * Presupuesto de espera (ms) de un digest: JUDGE_WAIT_MS si lo mira alguien (1500 por defecto),
 * JUDGE_WAIT_MS_BACKGROUND si lo arma el proceso de fondo (4000). Un valor inválido vuelve al de fábrica; 0 = solo caché.
 */
function judgeWaitBudgetMs({ background = false, env = process.env } = {}) {
  const fallback = background ? DEFAULT_BACKGROUND_WAIT_MS : DEFAULT_LIVE_WAIT_MS;
  const raw = env?.[background ? 'JUDGE_WAIT_MS_BACKGROUND' : 'JUDGE_WAIT_MS'];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------- caché con vencimiento
class TtlCache {
  constructor({ maxEntries = DEFAULT_CACHE_MAX_ENTRIES, ttlMs = DEFAULT_CACHE_TTL_MS, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  get size() { return this.map.size; }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) { this.map.delete(key); return undefined; }
    this.map.delete(key); // se vuelve a insertar: lo último que se usó es lo último que se descarta
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
  }

  clear() { this.map.clear(); }
}

// ---------------------------------------------------------------- sesión (un digest)
/** Lo que un digest lleva cuenta de los jueces: cuánto le queda para esperar y qué pasó. */
class JudgeSession {
  constructor({ budgetMs = DEFAULT_LIVE_WAIT_MS } = {}) {
    this.budgetMs = budgetMs;
    this.remainingMs = budgetMs;
    this.waitedMs = 0;
    this.counts = { llamadas: 0, cache: 0, timeouts: 0, errores: 0, salteadas: 0 };
  }

  charge(ms) {
    const spent = Math.max(0, ms);
    this.waitedMs += spent;
    this.remainingMs = Math.max(0, this.remainingMs - spent);
  }

  count(kind) { this.counts[kind] = (this.counts[kind] || 0) + 1; }

  get used() { return Object.values(this.counts).some((n) => n > 0); }

  /** Línea de log del digest: "[Juez] 2 llamadas, 1 de caché, 640 ms de espera (1 sin respuesta a tiempo)". */
  summary() {
    const c = this.counts;
    const extra = [];
    if (c.timeouts) extra.push(`${c.timeouts} sin respuesta a tiempo`);
    if (c.errores) extra.push(`${c.errores} con error`);
    if (c.salteadas) extra.push(`${c.salteadas} salteadas por falta de presupuesto`);
    return `[Juez] ${c.llamadas} llamadas, ${c.cache} de caché, ${Math.round(this.waitedMs)} ms de espera`
      + `${extra.length ? ` (${extra.join(', ')})` : ''}`;
  }
}

function raceWithTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function defaultClient() {
  // Carga perezosa: config/openai exige las claves al importarse y los tests no las tienen.
  return require('../config/openai').openaiReview;
}

// ---------------------------------------------------------------- el juez
/**
 * @param {object} p
 * @param {string} p.name              para los logs ("misma historia")
 * @param {string} p.switchEnv         variable de entorno que lo apaga ("SAME_STORY_JUDGE")
 * @param {string} p.system            instrucciones fijas
 * @param {(input:object)=>string} p.buildUser   la pregunta concreta
 * @param {(text:string)=>*} p.parse   respuesta de la IA -> veredicto (null si no se entiende)
 * @param {(input:object)=>string} p.keyFor      clave de caché de la pregunta
 */
function createLlmJudge({
  name, switchEnv, system, buildUser, parse, keyFor,
  maxTokens = 5, model = DEFAULT_MODEL, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS, cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  getClient = defaultClient, now = Date.now, env = process.env, log = (m) => console.log(m),
}) {
  const cache = new TtlCache({ maxEntries: cacheMaxEntries, ttlMs: cacheTtlMs, now });
  const inflight = new Map();

  const enabled = () => !isSwitchedOff(switchEnv, env);

  /** Veredicto guardado de esta pregunta (undefined si no hay). */
  function peek(input) {
    try { return cache.get(keyFor(input)); } catch { return undefined; }
  }

  async function callModel(input, key) {
    const t0 = now();
    try {
      const response = await getClient().chat.completions.create(
        {
          model,
          temperature: 0,
          max_tokens: maxTokens,
          seed: 7,
          messages: [{ role: 'system', content: system }, { role: 'user', content: buildUser(input) }],
        },
        // Sin reintentos: si falla, el motor sigue sin el veredicto; reintentar solo sumaría espera.
        { timeout: requestTimeoutMs, maxRetries: 0 },
      );
      const text = response?.choices?.[0]?.message?.content ?? '';
      const verdict = parse(text);
      if (verdict === null || verdict === undefined) {
        return { verdict: null, source: 'error', ms: now() - t0, error: `respuesta que no se entiende: "${String(text).slice(0, 40)}"` };
      }
      cache.set(key, verdict);
      return { verdict, source: 'llm', ms: now() - t0 };
    } catch (error) {
      return { verdict: null, source: 'error', ms: now() - t0, error: error?.message || String(error) };
    }
  }

  /**
   * Arranca la consulta (o se engancha a la que ya está en curso). Devuelve una promesa que NUNCA rechaza:
   * { verdict, source: 'cache'|'llm'|'error', ms }.
   */
  function start(input) {
    const key = keyFor(input);
    const cached = cache.get(key);
    if (cached !== undefined) return Promise.resolve({ verdict: cached, source: 'cache', ms: 0 });
    if (inflight.has(key)) return inflight.get(key);

    const promise = callModel(input, key);
    inflight.set(key, promise);
    // La limpieza va en un .then (después del set): si callModel terminara sin esperar nada, un "finally" propio
    // correría antes del set y dejaría la entrada colgada para siempre.
    promise.then(() => { if (inflight.get(key) === promise) inflight.delete(key); });
    return promise;
  }

  /** Arranca la consulta sin esperarla (para tener la respuesta lista cuando se la necesite). Nunca lanza. */
  function prefetch(input, { session = null } = {}) {
    try {
      if (!enabled()) return;
      if (session && session.budgetMs <= 0) return; // presupuesto 0: solo caché
      start(input);
    } catch { /* un juez nunca frena la elección de notas */ }
  }

  async function askUnsafe(input, session) {
    if (!enabled()) return { verdict: null, source: 'off', waitedMs: 0 };

    const cached = cache.get(keyFor(input));
    if (cached !== undefined) {
      session.count('cache');
      return { verdict: cached, source: 'cache', waitedMs: 0 };
    }
    if (session.remainingMs <= 0) {
      session.count('salteadas');
      return { verdict: null, source: 'skipped', waitedMs: 0 };
    }

    const t0 = now();
    const outcome = await raceWithTimeout(start(input), session.remainingMs);
    const waitedMs = now() - t0;
    session.charge(waitedMs);

    if (outcome === TIMED_OUT) {
      session.count('timeouts');
      log(`[Juez ${name}] sin respuesta en ${Math.round(waitedMs)} ms: se sigue sin veredicto`);
      return { verdict: null, source: 'timeout', waitedMs };
    }
    if (outcome.source === 'error') {
      session.count('errores');
      log(`[Juez ${name}] error (${outcome.error}): se sigue sin veredicto`);
      return { verdict: null, source: 'error', waitedMs, error: outcome.error };
    }
    session.count(outcome.source === 'cache' ? 'cache' : 'llamadas');
    return { verdict: outcome.verdict, source: outcome.source, waitedMs };
  }

  /**
   * Pregunta y espera, pero nunca más de lo que le queda al digest. Nunca lanza.
   * @returns {Promise<{verdict:*, source:'cache'|'llm'|'timeout'|'error'|'off'|'skipped', waitedMs:number, error?:string}>}
   */
  async function ask(input, { session = new JudgeSession() } = {}) {
    try {
      return await askUnsafe(input, session);
    } catch (error) {
      session.count('errores');
      log(`[Juez ${name}] error inesperado (${error?.message || error}): se sigue sin veredicto`);
      return { verdict: null, source: 'error', waitedMs: 0, error: error?.message || String(error) };
    }
  }

  return {
    name, enabled, peek, prefetch, ask, start,
    clearCache: () => { cache.clear(); inflight.clear(); },
    get cacheSize() { return cache.size; },
  };
}

// ---------------------------------------------------------------- lectura de la respuesta
/** "SI" | "NO" | null (acepta "Sí.", "si", "NO, porque..."; no acepta "sin", "siempre"). */
function parseYesNo(text) {
  const t = String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  const m = t.match(/^["'¿¡(\s]*(SI|NO)(?![A-Z0-9])/);
  return m ? m[1] : null;
}

/** "SI" | "PARCIAL" | "NO" | null. */
function parseYesPartialNo(text) {
  const t = String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  const m = t.match(/^["'¿¡(\s]*(SI|PARCIAL|NO)(?![A-Z0-9])/);
  return m ? m[1] : null;
}

module.exports = {
  DEFAULT_LIVE_WAIT_MS,
  DEFAULT_BACKGROUND_WAIT_MS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_ENTRIES,
  isSwitchedOff,
  judgeWaitBudgetMs,
  TtlCache,
  JudgeSession,
  createLlmJudge,
  parseYesNo,
  parseYesPartialNo,
};
