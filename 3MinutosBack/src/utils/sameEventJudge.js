'use strict';

/**
 * sameEventJudge.js
 *
 * El juez de "misma historia". El coseno entre embeddings descarta como repetida toda nota con 0,88 o más de parecido
 * con algo que el usuario ya vio. Pero hay notas que cuentan EL MISMO hecho y quedan por debajo (otro medio, otro
 * título, otro enfoque: en los reportes del test de estrés, "Milićević" y "grupos de tarea" volvieron a salir en la
 * ronda siguiente con 0,80-0,87). Para esa banda el coseno no alcanza y se le pregunta a un modelo chico:
 *
 *      coseno >= 0,88            misma historia, sin preguntar          (como siempre)
 *      0,80 <= coseno < 0,88     pregunta al juez: SI -> repetida, NO -> pasa
 *      coseno <  0,80            hechos distintos, sin preguntar
 *
 * Que el juez falle, tarde más del presupuesto de espera del digest o esté apagado (SAME_STORY_JUDGE=off) no cambia
 * el resultado respecto de antes: la nota pasa como pasaba con el coseno solo. La infraestructura (caché compartida,
 * llamadas en curso compartidas, presupuesto por digest, interruptor) está en llmJudge.js.
 *
 * Latencia: las preguntas de las primeras candidatas en banda se lanzan JUNTAS (prefetchSameStory) antes de mirar
 * una por una, así el digest espera lo que tarda la más lenta y no la suma.
 */

const { createLlmJudge, parseYesNo, JudgeSession } = require('./llmJudge');
const { noteForJudge, canJudge } = require('./judgeNote');
const { normalizeText, findSameStory, seenInJudgeBand } = require('./eligibility');

const PREFETCH_MAX_CANDIDATES = 3; // de cuántas candidatas en banda se lanzan las preguntas por adelantado

const SYSTEM_PROMPT = [
  'Sos el editor de un resumen diario de noticias argentinas. Te doy dos notas y tenés que decidir si cuentan EL MISMO HECHO.',
  '',
  'Respondé SI cuando las dos informan el mismo suceso puntual: la misma noticia contada por dos medios, o con otro título u otro enfoque,',
  'o la misma declaración, decisión, partido, fallo, accidente o anuncio. Un lector que ya leyó una no se entera de nada nuevo con la otra.',
  '',
  'Respondé NO cuando son hechos distintos, aunque compartan el tema, la persona, el club, el lugar o la institución. Ejemplos de NO:',
  'dos partidos distintos del mismo equipo; dos declaraciones distintas del mismo político; una medida del Gobierno y la reacción posterior',
  'de un sector; un hecho y un hecho nuevo que ocurrió después (la audiencia y la sentencia, el anuncio y su aplicación); dos accidentes en el mismo lugar.',
  'Si una nota agrega un hecho nuevo e importante que la otra no tiene, son hechos distintos: NO.',
  '',
  'Respondé con una sola palabra: SI o NO.',
].join('\n');

// ---------------------------------------------------------------- la pareja de notas (clave de caché y pregunta)
function identityOf(note) {
  if (note.id) return `id:${note.id}`;
  return `txt:${normalizeText(note.title)}~${normalizeText(note.lead).slice(0, 100)}`;
}

/** Clave de caché de una pareja: no depende de cuál es la candidata y cuál la vista. */
function pairKey({ a, b }) {
  const ka = identityOf(a);
  const kb = identityOf(b);
  return ka < kb ? `same|${ka}|${kb}` : `same|${kb}|${ka}`;
}

function buildUser({ a, b }) {
  return `Nota A: ${a.title}\n${a.lead}\n\nNota B: ${b.title}\n${b.lead}\n\n¿Las dos notas cuentan el mismo hecho? Respondé SI o NO.`;
}

/** Arma el juez con IA de "misma historia" (los tests le pasan un cliente falso, un reloj o un entorno propios). */
function createSameEventLlm(overrides = {}) {
  return createLlmJudge({
    name: 'misma historia',
    switchEnv: 'SAME_STORY_JUDGE',
    system: SYSTEM_PROMPT,
    buildUser,
    parse: parseYesNo,
    keyFor: pairKey,
    ...overrides,
  });
}

// Una sola instancia para todo el proceso: la caché y las llamadas en curso se comparten entre usuarios.
const sameEventLlm = createSameEventLlm();

// ---------------------------------------------------------------- el juez de UN digest
/**
 * Juez atado al presupuesto de espera de un digest (`session`). Es lo que recibe el motor.
 *   enabled()                    false si SAME_STORY_JUDGE=off
 *   prefetch(candidata, vista)   arranca la pregunta sin esperarla
 *   isSameEvent(candidata, vista) -> { same: true|false|null, source }   (null = sin veredicto: se sigue como si no existiera)
 */
function createSameStoryJudge({ session = new JudgeSession(), llm = sameEventLlm } = {}) {
  return {
    session,
    enabled: () => llm.enabled(),
    prefetch(candidate, seenEntry) {
      if (!canJudge(candidate) || !canJudge(seenEntry)) return;
      llm.prefetch({ a: candidate, b: seenEntry }, { session });
    },
    async isSameEvent(candidate, seenEntry) {
      if (!canJudge(candidate) || !canJudge(seenEntry)) return { same: null, source: 'skipped' };
      const result = await llm.ask({ a: candidate, b: seenEntry }, { session });
      const same = result.verdict === 'SI' ? true : result.verdict === 'NO' ? false : null;
      return { same, source: result.source, waitedMs: result.waitedMs };
    },
  };
}

// ---------------------------------------------------------------- decisión sobre una candidata
/**
 * Mira de una vez cómo está una candidata frente a lo visto, y arranca las preguntas al juez si cae en la banda.
 * @returns {'coseno'|'banda'|'limpia'}  coseno = ya es repetida sin juez; banda = depende del juez; limpia = pasa
 */
function prefetchSameStory({ embedding, candidate, seen = [], judge = null }) {
  if (!Array.isArray(embedding) || embedding.length === 0) return 'limpia';
  if (findSameStory(embedding, seen)) return 'coseno';
  if (!judge || !judge.enabled()) return 'limpia';
  const band = seenInJudgeBand(embedding, seen);
  for (const near of band) {
    try { judge.prefetch(candidate, near.entry); } catch { /* un juez que falla nunca frena la elección */ }
  }
  return band.length > 0 ? 'banda' : 'limpia';
}

/**
 * ¿La candidata es "la misma historia" que algo visto?
 * @returns {Promise<null | {similarity:number, title:string|null, by:'coseno'|'juez'}>} null = no es repetida
 */
async function resolveSameStory({ embedding, candidate, seen = [], judge = null, log = (m) => console.log(m) }) {
  const hard = findSameStory(embedding, seen);
  if (hard) return { similarity: hard.similarity, title: hard.title, by: 'coseno' };
  if (!judge || !judge.enabled()) return null;

  for (const near of seenInJudgeBand(embedding, seen)) {
    let verdict;
    try {
      verdict = await judge.isSameEvent(candidate, near.entry);
    } catch {
      continue; // un juez que falla es un juez sin veredicto: la nota pasa como pasaba con el coseno solo
    }
    if (verdict?.same === true) {
      log(
        `[Juez misma historia] SI (coseno ${near.similarity.toFixed(3)}): ` +
        `"${candidate.title}" cuenta lo mismo que "${near.entry.title}"`,
      );
      return { similarity: near.similarity, title: near.entry.title ?? null, by: 'juez' };
    }
  }
  return null;
}

module.exports = {
  PREFETCH_MAX_CANDIDATES,
  SYSTEM_PROMPT,
  noteForJudge, // de judgeNote.js
  canJudge,     // de judgeNote.js
  pairKey,
  sameEventLlm,
  createSameEventLlm,
  createSameStoryJudge,
  prefetchSameStory,
  resolveSameStory,
};
