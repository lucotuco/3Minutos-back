'use strict';

/**
 * topicJudge.js
 *
 * El juez de TEMA, para los tópicos libres ("river plate", "Zverev", "tenis argentino"). La búsqueda híbrida trae notas
 * PARECIDAS al tema, y parecido no es lo mismo que "de eso": una nota donde el rival nombra a River de pasada, o una de
 * tenis internacional para quien pidió "tenis argentino", tienen buen puntaje. El juez lee título y resumen y contesta:
 *
 *   SI       la nota trata directamente del tema (es protagonista o foco principal)
 *   PARCIAL  el tema aparece pero no es el foco
 *   NO       no tiene relación
 *
 * El SI pasa siempre. El PARCIAL pasa solo en la segunda pasada, cuando la alternativa es entregar una nota de
 * OTRO tema (el rescate): una nota donde el club que pediste aparece de costado le sirve más al lector que una
 * nota impecable de un tema que no pidió. El NO no pasa nunca.
 *
 * Criterio: el mismo que usa el comparador (tests/comparar/corrida.js, PROMPT_JUEZ) para medir si el
 * motor eligió bien, más una regla de calificadores (país, ciudad, deporte): "tenis argentino" exige que la nota sea
 * de tenis Y argentina.
 *
 * Si el juez no contesta (tarda más que el presupuesto del digest, falla o está apagado con TOPIC_JUDGE=off), el motor
 * sigue como antes: pasa la candidata que está dentro del corral de categoría del tema y no pasa la que está afuera
 * (ver pickBestArticlePerTopic.js). Con juez, el corral deja de ser un descarte y pasa a ser una duda que el juez resuelve.
 * La infraestructura (caché de 36 h compartida, presupuesto de espera, interruptor) está en llmJudge.js.
 */

const { createLlmJudge, parseYesPartialNo, JudgeSession } = require('./llmJudge');
const { canJudge, noteForJudge } = require('./judgeNote');
const { normalizeText } = require('./eligibility');

const SYSTEM_PROMPT = [
  'Sos un evaluador estricto de relevancia periodística.',
  'Te doy un TEMA que eligió un usuario y una NOTICIA (título y resumen).',
  'Respondé con UNA sola palabra:',
  '- SI: la noticia trata directamente sobre ese tema (es protagonista o foco principal).',
  '- PARCIAL: el tema aparece mencionado pero no es el foco de la noticia.',
  '- NO: la noticia no tiene relación con el tema.',
  'Si el tema es una persona o un club, la noticia debe ser sobre esa persona o club (no sobre un rival que lo nombra de pasada).',
  'Si el tema trae un calificador (un país, una ciudad, un deporte, una época: "tenis argentino", "economía de Brasil"), la noticia debe cumplirlo; si no lo cumple, es NO.',
].join('\n');

function keyFor({ topic, note }) {
  const who = note.id ? `id:${note.id}` : `txt:${normalizeText(note.title)}`;
  return `tema|${normalizeText(topic)}|${who}`;
}

function buildUser({ topic, note }) {
  return `TEMA: ${topic}\nTÍTULO: ${note.title}\nRESUMEN: ${note.lead || '(sin resumen)'}`;
}

/** Arma el juez con IA de tema (los tests le pasan un cliente falso, un reloj o un entorno propios). */
function createTopicLlm(overrides = {}) {
  return createLlmJudge({
    name: 'tema',
    switchEnv: 'TOPIC_JUDGE',
    system: SYSTEM_PROMPT,
    buildUser,
    parse: parseYesPartialNo,
    keyFor,
    maxTokens: 4,
    ...overrides,
  });
}

// Una sola instancia para todo el proceso: la caché y las llamadas en curso se comparten entre usuarios.
const topicLlm = createTopicLlm();

/**
 * Juez atado al presupuesto de espera de un digest (`session`, compartida con el de misma historia). Es lo que recibe el motor.
 *   enabled()                      false si TOPIC_JUDGE=off
 *   prefetch(tema, nota)           arranca la pregunta sin esperarla
 *   verdictFor(tema, nota)         -> { verdict: 'SI'|'PARCIAL'|'NO'|null, source }   (null = sin veredicto)
 * `nota` es { id, title, lead } (judgeNote.noteForJudge).
 */
function createTopicJudge({ session = new JudgeSession(), llm = topicLlm } = {}) {
  return {
    session,
    enabled: () => llm.enabled(),
    prefetch(topic, note) {
      if (!canJudge(note)) return;
      llm.prefetch({ topic, note }, { session });
    },
    async verdictFor(topic, note) {
      if (!canJudge(note)) return { verdict: null, source: 'skipped' };
      const result = await llm.ask({ topic, note }, { session });
      return { verdict: result.verdict ?? null, source: result.source, waitedMs: result.waitedMs };
    },
  };
}

/**
 * El filtro de tema de UN tópico libre, con la forma que espera officialPick.firstNotRepeated:
 *   prefetch(entry, doc)   arranca la pregunta de esa candidata
 *   check(entry, doc)      -> { ok, verdict, reason }
 *
 * Con `allowPartial` en false (la pasada normal) solo el SI pasa. Con `allowPartial` en true también pasa el
 * PARCIAL: es la segunda pasada, la que corre ANTES de rendirse y entregar una nota de otro tema (ver
 * pickBestArticlePerTopic.pickFreeTopic). El NO no pasa nunca, en ninguna de las dos: "el tema aparece de costado"
 * es una nota del tema, "no tiene relación" no.
 *
 * Sin veredicto (tardó más que el presupuesto, falló, está apagado) se sigue como antes de que existiera el juez:
 * la nota que está dentro del corral de categoría pasa, la que está afuera no (`isOutOfCorral`).
 */
function createTopicCheck({ judge, topic, isOutOfCorral = () => false, allowPartial = false }) {
  const noteOf = (entry, doc) => noteForJudge({ ...entry.article, ...(doc || {}) });
  return {
    allowPartial,
    prefetch(entry, doc) {
      try { judge.prefetch(topic, noteOf(entry, doc)); } catch { /* un juez que falla nunca frena la elección */ }
    },
    async check(entry, doc) {
      let result;
      try {
        result = await judge.verdictFor(topic, noteOf(entry, doc));
      } catch {
        result = { verdict: null };
      }
      const verdict = result?.verdict ?? null;
      if (verdict === 'SI') return { ok: true, verdict, reason: null };
      if (verdict === 'PARCIAL' && allowPartial) return { ok: true, verdict, reason: null };
      if (verdict === 'PARCIAL' || verdict === 'NO') return { ok: false, verdict, reason: `tema_${verdict.toLowerCase()}` };
      return isOutOfCorral(entry.article)
        ? { ok: false, verdict: null, reason: 'fuera_del_corral_sin_juez' }
        : { ok: true, verdict: null, reason: null };
    },
  };
}

module.exports = {
  SYSTEM_PROMPT,
  keyFor,
  topicLlm,
  createTopicLlm,
  createTopicJudge,
  createTopicCheck,
};
