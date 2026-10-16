'use strict';

/**
 * Tests del juez de "misma historia" (utils/sameEventJudge.js) y de cómo lo usa el motor:
 *   - la banda de coseno [0,80; 0,88) (por debajo no se pregunta, desde 0,88 repetida sin preguntar)
 *   - qué se le muestra al juez y cómo se arma la pregunta
 *   - qué pasa si no contesta (timeout, error, apagado): la nota pasa como antes
 *   - que las preguntas de varias candidatas salgan JUNTAS, y solo las que hacen falta
 *   - el motor completo (tema oficial, tema libre, notas ya elegidas en el mismo digest)
 * La IA es FALSA: ningún test llama a OpenAI. Correr:  npm run test:unit
 */

process.env.OPENAI_API_KEY_EMBEDDINGS ||= 'test';
process.env.OPENAI_API_KEY_REVIEW ||= 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SAME_STORY_COSINE, SAME_STORY_JUDGE_MIN_COSINE, JUDGE_MAX_PAIRS_PER_CANDIDATE, seenInJudgeBand,
} = require('../../utils/eligibility');
const {
  PREFETCH_MAX_CANDIDATES, SYSTEM_PROMPT, noteForJudge, canJudge, pairKey, createSameEventLlm,
  createSameStoryJudge, prefetchSameStory, resolveSameStory,
} = require('../../utils/sameEventJudge');
const { JudgeSession } = require('../../utils/llmJudge');
const { firstNotRepeated } = require('../../utils/officialPick');
const { pickBestArticlePerTopic } = require('../../utils/pickBestArticlePerTopic');

test.before(() => {
  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
});

// ---------------------------------------------------------------- datos falsos
/** Vector cuyo coseno con [1, 0] es c. */
const conCoseno = (c) => [c, Math.sqrt(1 - c * c)];

const vista = (extra = {}) => ({
  id: 'v1', title: 'Renunció el ministro de Economía', lead: 'El ministro presentó su renuncia esta mañana', vector: [1, 0], ...extra,
});

/** Juez falso con la forma de createSameStoryJudge. `veredicto(candidata, vista)` -> true | false | null (sin veredicto). */
function juezFalso(veredicto = () => false, { activo = true } = {}) {
  const registro = { prefetch: [], preguntas: [], orden: [] };
  return {
    registro,
    session: new JudgeSession({ budgetMs: 1500 }),
    enabled: () => activo,
    prefetch(candidata, entrada) { registro.prefetch.push({ candidata, vista: entrada }); registro.orden.push('prefetch'); },
    async isSameEvent(candidata, entrada) {
      registro.preguntas.push({ candidata, vista: entrada });
      registro.orden.push('pregunta');
      const same = veredicto(candidata, entrada);
      return { same, source: same === null ? 'timeout' : 'llm' };
    },
  };
}

const candidata = (extra = {}) => ({ id: 'c1', title: 'El ministro dejó su cargo', lead: 'Renunció y ya tiene reemplazo', ...extra });

// ================================================================ la nota como la ve el juez
test('noteForJudge: título y bajada neutrales primero; si no hay, el título original y el resumen', () => {
  assert.deepEqual(
    noteForJudge({ _id: 'abc', title: 'Original', neutralTitle: 'Neutral', neutralLead: 'Bajada neutral', rawSummary: 'Resumen' }),
    { id: 'abc', title: 'Neutral', lead: 'Bajada neutral' },
  );
  assert.deepEqual(noteForJudge({ _id: 'abc', title: 'Original', rawSummary: 'Resumen' }), { id: 'abc', title: 'Original', lead: 'Resumen' });
  assert.deepEqual(noteForJudge({ _id: 'abc', title: 'Original', contentSnippet: 'Fragmento' }), { id: 'abc', title: 'Original', lead: 'Fragmento' });
  assert.deepEqual(noteForJudge({ _id: 'abc', title: 'Original' }), { id: 'abc', title: 'Original', lead: '' });
});

test('noteForJudge: sirve para un item de digest (articleId, bajada curada) y para una nota con _id de Mongo', () => {
  assert.deepEqual(
    noteForJudge({ articleId: 'x1', neutralTitle: 'Titulo', lead: 'Bajada del item', summary: 'otro' }),
    { id: 'x1', title: 'Titulo', lead: 'Bajada del item' },
  );
  const objectIdFalso = { toString: () => '65f1a2b3c4d5e6f708192a3b' };
  assert.equal(noteForJudge({ _id: objectIdFalso, title: 't' }).id, '65f1a2b3c4d5e6f708192a3b');
  assert.equal(noteForJudge({ id: 'otro', title: 't' }).id, 'otro');
  assert.equal(noteForJudge({ _id: 'a', id: 'b', articleId: 'c', title: 't' }).id, 'a', '_id manda sobre id y articleId');
});

test('noteForJudge: texto limpio (sin HTML ni entidades) y recortado; lo vacío no rompe', () => {
  const n = noteForJudge({ _id: 'a', title: 'Ministro &amp; <i>Gobierno</i>', rawSummary: '<p>Hola&nbsp;<b>mundo</b></p><script>x()</script>' });
  assert.equal(n.title, 'Ministro & Gobierno');
  assert.equal(n.lead, 'Hola mundo');

  const largo = noteForJudge({ _id: 'a', title: 'palabra '.repeat(100), rawSummary: 'frase '.repeat(200) });
  assert.ok(largo.title.length <= 200 && largo.title.endsWith('palabra'), 'título recortado en una palabra entera');
  assert.ok(largo.lead.length <= 320 && largo.lead.endsWith('frase'), 'bajada recortada en una palabra entera');

  for (const vacio of [undefined, null, {}]) assert.deepEqual(noteForJudge(vacio ?? undefined), { id: '', title: '', lead: '' });
});

test('canJudge: hace falta al menos el título o la bajada', () => {
  assert.equal(canJudge({ id: 'a', title: 'T', lead: '' }), true);
  assert.equal(canJudge({ id: 'a', title: '', lead: 'L' }), true);
  assert.equal(canJudge({ id: 'a', title: '', lead: '' }), false);
  assert.equal(canJudge(null), false);
  assert.equal(canJudge(undefined), false);
});

test('pairKey: no depende de cuál es la candidata y cuál la vista; distingue parejas; sin id usa el texto', () => {
  const a = { id: '1', title: 'A', lead: '' };
  const b = { id: '2', title: 'B', lead: '' };
  const c = { id: '3', title: 'C', lead: '' };
  assert.equal(pairKey({ a, b }), pairKey({ a: b, b: a }));
  assert.notEqual(pairKey({ a, b }), pairKey({ a, b: c }));
  assert.notEqual(pairKey({ a, b }), pairKey({ a: b, b: c }));

  const sinId1 = { id: '', title: 'Árbol caído', lead: 'En Palermo' };
  const sinId2 = { id: '', title: 'arbol caido', lead: 'EN PALERMO' };
  assert.equal(pairKey({ a: sinId1, b }), pairKey({ a: sinId2, b }), 'sin id: mismo texto sin tildes ni mayúsculas = misma nota');
  assert.notEqual(pairKey({ a: sinId1, b }), pairKey({ a: { ...sinId1, lead: 'En Belgrano' }, b }));
  assert.notEqual(pairKey({ a: { id: '', title: 'x', lead: '' }, b }), pairKey({ a: { id: 'x', title: 'x', lead: '' }, b }), 'id y texto no se confunden');
});

// ================================================================ la banda de coseno
test('banda del juez: 0,80 a 0,88 (sin incluir 0,88); por debajo y por encima no se pregunta', () => {
  assert.equal(SAME_STORY_JUDGE_MIN_COSINE, 0.80);
  assert.equal(SAME_STORY_COSINE, 0.88);
  assert.equal(JUDGE_MAX_PAIRS_PER_CANDIDATE, 2);

  const quien = (c) => seenInJudgeBand([1, 0], [{ id: 'x', title: 'x', vector: conCoseno(c) }]).length;
  assert.equal(quien(0.799), 0, 'por debajo de 0,80 son hechos distintos');
  assert.equal(quien(0.80), 1, '0,80 entra');
  assert.equal(quien(0.85), 1);
  assert.equal(quien(0.879), 1);
  assert.equal(quien(0.88), 0, '0,88 ya es repetida sin preguntar');
  assert.equal(quien(0.95), 0);
});

test('banda del juez: las más parecidas primero, hasta el máximo; sin embedding o con vectores incomparables no hay nada', () => {
  const vistos = [
    { id: 'a', title: 'a', vector: conCoseno(0.82) },
    { id: 'b', title: 'b', vector: conCoseno(0.87) },
    { id: 'c', title: 'c', vector: conCoseno(0.84) },
    { id: 'lejos', title: 'lejos', vector: conCoseno(0.3) },
    { id: 'sinvector', title: 'sin vector' },
    { id: 'otrolargo', title: 'otro largo', vector: [1, 0, 0] },
    null,
  ];
  const cerca = seenInJudgeBand([1, 0], vistos);
  assert.deepEqual(cerca.map((x) => x.entry.id), ['b', 'c'], 'las 2 más parecidas, de mayor a menor');
  assert.ok(Math.abs(cerca[0].similarity - 0.87) < 1e-9);
  assert.deepEqual(seenInJudgeBand([1, 0], vistos, { limit: 5 }).map((x) => x.entry.id), ['b', 'c', 'a']);
  assert.deepEqual(seenInJudgeBand([1, 0], vistos, { min: 0.86, max: 0.9 }).map((x) => x.entry.id), ['b']);

  for (const sin of [null, undefined, []]) assert.deepEqual(seenInJudgeBand(sin, vistos), []);
  assert.deepEqual(seenInJudgeBand([1, 0], []), []);
});

// ================================================================ resolveSameStory / prefetchSameStory
test('coseno >= 0,88: repetida sin preguntarle nada al juez', async () => {
  const juez = juezFalso(() => false);
  const r = await resolveSameStory({ embedding: conCoseno(0.9), candidate: candidata(), seen: [vista()], judge: juez });
  assert.equal(r.by, 'coseno');
  assert.equal(r.title, 'Renunció el ministro de Economía');
  assert.ok(Math.abs(r.similarity - 0.9) < 1e-9);
  assert.equal(juez.registro.preguntas.length, 0);
});

test('coseno en la banda: el juez decide; SI es repetida, NO y sin veredicto pasan', async () => {
  const embedding = conCoseno(0.85);
  const quien = async (veredicto) => {
    const juez = juezFalso(() => veredicto);
    const r = await resolveSameStory({ embedding, candidate: candidata(), seen: [vista()], judge: juez, log: () => {} });
    return { r, juez };
  };

  const si = await quien(true);
  assert.equal(si.r.by, 'juez');
  assert.equal(si.r.title, 'Renunció el ministro de Economía');
  assert.ok(Math.abs(si.r.similarity - 0.85) < 1e-9);

  assert.equal((await quien(false)).r, null, 'el juez dijo que son hechos distintos: pasa');
  assert.equal((await quien(null)).r, null, 'sin veredicto (timeout, error): pasa, como pasaba con el coseno solo');

  // al juez se le pasa la candidata y la entrada vista TAL CUAL
  const { juez } = si;
  assert.equal(juez.registro.preguntas.length, 1);
  assert.deepEqual(juez.registro.preguntas[0].candidata, candidata());
  assert.equal(juez.registro.preguntas[0].vista.id, 'v1');
});

test('coseno por debajo de 0,80: no se pregunta, pasa', async () => {
  const juez = juezFalso(() => true);
  const r = await resolveSameStory({ embedding: conCoseno(0.79), candidate: candidata(), seen: [vista()], judge: juez });
  assert.equal(r, null);
  assert.equal(juez.registro.preguntas.length, 0);
});

test('sin juez, o con el juez apagado, en la banda solo vale el coseno (todo pasa como antes)', async () => {
  const embedding = conCoseno(0.85);
  assert.equal(await resolveSameStory({ embedding, candidate: candidata(), seen: [vista()], judge: null }), null);
  const apagado = juezFalso(() => true, { activo: false });
  assert.equal(await resolveSameStory({ embedding, candidate: candidata(), seen: [vista()], judge: apagado }), null);
  assert.equal(apagado.registro.preguntas.length, 0);
  // y el coseno alto sigue valiendo aunque no haya juez
  assert.equal((await resolveSameStory({ embedding: conCoseno(0.9), candidate: candidata(), seen: [vista()], judge: null })).by, 'coseno');
});

test('varias vistas en la banda: se pregunta de la más parecida a la menos, se corta en el primer SI y hay un máximo', async () => {
  const vistos = [
    vista({ id: 'a', title: 'A', vector: conCoseno(0.82) }),
    vista({ id: 'b', title: 'B', vector: conCoseno(0.86) }),
    vista({ id: 'c', title: 'C', vector: conCoseno(0.84) }),
  ];
  const embedding = [1, 0];

  const primeroSi = juezFalso((cand, v) => v.id === 'b');
  const r1 = await resolveSameStory({ embedding, candidate: candidata(), seen: vistos, judge: primeroSi, log: () => {} });
  assert.equal(r1.title, 'B');
  assert.deepEqual(primeroSi.registro.preguntas.map((p) => p.vista.id), ['b'], 'dijo SI de la más parecida: no se pregunta más');

  const segundoSi = juezFalso((cand, v) => v.id === 'c');
  const r2 = await resolveSameStory({ embedding, candidate: candidata(), seen: vistos, judge: segundoSi, log: () => {} });
  assert.equal(r2.title, 'C');
  assert.deepEqual(segundoSi.registro.preguntas.map((p) => p.vista.id), ['b', 'c']);

  const ninguno = juezFalso(() => false);
  assert.equal(await resolveSameStory({ embedding, candidate: candidata(), seen: vistos, judge: ninguno }), null);
  assert.deepEqual(ninguno.registro.preguntas.map((p) => p.vista.id), ['b', 'c'], 'la tercera (0,82) no se pregunta: tope de 2 por candidata');
});

test('cuando el juez dice SI queda en el log con las dos notas y el coseno', async () => {
  const logs = [];
  await resolveSameStory({
    embedding: conCoseno(0.85), candidate: candidata(), seen: [vista()], judge: juezFalso(() => true), log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[Juez misma historia\] SI/);
  assert.match(logs[0], /0\.850/);
  assert.match(logs[0], /El ministro dejó su cargo/);
  assert.match(logs[0], /Renunció el ministro de Economía/);
});

test('prefetchSameStory: dice si la candidata es repetida por coseno, depende del juez o pasa limpia, y solo en la banda lanza preguntas', () => {
  const juez = juezFalso();
  const quien = (c, extra = {}) => prefetchSameStory({ embedding: conCoseno(c), candidate: candidata(), seen: [vista()], judge: juez, ...extra });

  assert.equal(quien(0.95), 'coseno');
  assert.equal(juez.registro.prefetch.length, 0);
  assert.equal(quien(0.5), 'limpia');
  assert.equal(juez.registro.prefetch.length, 0);
  assert.equal(quien(0.85), 'banda');
  assert.equal(juez.registro.prefetch.length, 1);
  assert.equal(juez.registro.prefetch[0].vista.id, 'v1');

  assert.equal(quien(0.85, { judge: null }), 'limpia', 'sin juez no hay nada que esperar');
  assert.equal(quien(0.85, { judge: juezFalso(() => true, { activo: false }) }), 'limpia');
  assert.equal(prefetchSameStory({ embedding: null, candidate: candidata(), seen: [vista()], judge: juez }), 'limpia', 'sin embedding no se puede comparar y pasa');
  assert.equal(prefetchSameStory({ embedding: [], candidate: candidata(), seen: [vista()], judge: juez }), 'limpia');
});

test('prefetchSameStory: con dos vistas en la banda lanza las dos preguntas, no más', () => {
  const juez = juezFalso();
  const vistos = [0.81, 0.83, 0.85].map((c, i) => vista({ id: `v${i}`, vector: conCoseno(c) }));
  assert.equal(prefetchSameStory({ embedding: [1, 0], candidate: candidata(), seen: vistos, judge: juez }), 'banda');
  assert.deepEqual(juez.registro.prefetch.map((p) => p.vista.id), ['v2', 'v1']);
});

// ================================================================ createSameStoryJudge (con la IA falsa de punta a punta)
function clienteIA(responder) {
  const llamadas = [];
  return {
    llamadas,
    chat: {
      completions: {
        create: async (body, opts) => {
          llamadas.push({ body, opts });
          return responder(body, llamadas.length);
        },
      },
    },
  };
}
const respuesta = (texto) => ({ choices: [{ message: { content: texto } }] });

function juezConIA(responder = () => respuesta('SI'), { env = {}, budgetMs = 1000 } = {}) {
  const cliente = clienteIA(responder);
  const llm = createSameEventLlm({ getClient: () => cliente, env, log: () => {} });
  const session = new JudgeSession({ budgetMs });
  return { juez: createSameStoryJudge({ session, llm }), cliente, session, llm };
}

test('juez de misma historia: a la IA le llegan las instrucciones y las dos notas (título y bajada); SI / NO se leen bien', async () => {
  const { juez, cliente } = juezConIA(() => respuesta('SI'));
  const r = await juez.isSameEvent(candidata(), vista());
  assert.equal(r.same, true);

  const { body } = cliente.llamadas[0];
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, SYSTEM_PROMPT);
  const pregunta = body.messages[1].content;
  assert.match(pregunta, /Nota A: El ministro dejó su cargo\nRenunció y ya tiene reemplazo/);
  assert.match(pregunta, /Nota B: Renunció el ministro de Economía\nEl ministro presentó su renuncia esta mañana/);
  assert.match(pregunta, /SI o NO/);

  const no = juezConIA(() => respuesta('No.'));
  assert.equal((await no.juez.isSameEvent(candidata(), vista())).same, false);
});

test('las instrucciones al juez dicen qué es el mismo hecho, ejemplos de hechos distintos y que se conteste con una palabra', () => {
  assert.match(SYSTEM_PROMPT, /MISMO HECHO/);
  assert.match(SYSTEM_PROMPT, /Respondé SI/);
  assert.match(SYSTEM_PROMPT, /Respondé NO/);
  assert.match(SYSTEM_PROMPT, /dos partidos distintos del mismo equipo/);
  assert.match(SYSTEM_PROMPT, /una sola palabra: SI o NO/);
});

test('juez de misma historia: la misma pareja al revés sale de la caché (una sola llamada), también entre digests', async () => {
  const { juez, cliente, llm } = juezConIA();
  const a = candidata({ id: 'a' });
  const b = vista({ id: 'b' });
  await juez.isSameEvent(a, b);
  const alReves = await juez.isSameEvent(b, a);
  assert.equal(alReves.source, 'cache');
  assert.equal(cliente.llamadas.length, 1);

  const otroDigest = createSameStoryJudge({ session: new JudgeSession({ budgetMs: 1000 }), llm });
  assert.equal((await otroDigest.isSameEvent(a, b)).source, 'cache');
  assert.equal(cliente.llamadas.length, 1);
});

test('juez de misma historia: sin veredicto (respuesta rara, error, sin presupuesto, apagado) devuelve same:null', async () => {
  const rara = juezConIA(() => respuesta('quizás'));
  assert.equal((await rara.juez.isSameEvent(candidata(), vista())).same, null);

  const falla = juezConIA(() => { throw new Error('429'); });
  const f = await falla.juez.isSameEvent(candidata(), vista());
  assert.deepEqual([f.same, f.source], [null, 'error']);

  const sinPresupuesto = juezConIA(() => respuesta('SI'), { budgetMs: 0 });
  const s = await sinPresupuesto.juez.isSameEvent(candidata(), vista());
  assert.deepEqual([s.same, s.source], [null, 'skipped']);
  assert.equal(sinPresupuesto.cliente.llamadas.length, 0);

  const apagado = juezConIA(() => respuesta('SI'), { env: { SAME_STORY_JUDGE: 'off' } });
  assert.equal(apagado.juez.enabled(), false);
  assert.equal((await apagado.juez.isSameEvent(candidata(), vista())).same, null);
  assert.equal(apagado.cliente.llamadas.length, 0);
});

test('juez de misma historia: una nota sin título ni bajada no se compara (no se le pregunta nada a la IA)', async () => {
  const { juez, cliente } = juezConIA();
  const r = await juez.isSameEvent(candidata({ title: '', lead: '' }), vista());
  assert.deepEqual([r.same, r.source], [null, 'skipped']);
  juez.prefetch(candidata(), vista({ title: '', lead: '' }));
  assert.equal(cliente.llamadas.length, 0);
});

test('juez de misma historia: el aviso en el log del digest dice cuántas llamadas, cuántas de caché y cuánto se esperó', async () => {
  const { juez, session } = juezConIA();
  await juez.isSameEvent(candidata({ id: 'a' }), vista({ id: 'b' }));
  await juez.isSameEvent(candidata({ id: 'a' }), vista({ id: 'b' }));
  assert.match(session.summary(), /^\[Juez\] 1 llamadas, 1 de caché, \d+ ms de espera$/);
});

// ================================================================ firstNotRepeated con juez
const doc = (id, vector, extra = {}) => ({ _id: id, title: `Nota ${id}`, rawSummary: `Resumen ${id}`, embedding: vector, ...extra });
const entrada = (d) => ({ article: { _id: d._id, title: d.title, url: `https://m.test/${d._id}` }, tier: 'buena', ageHours: 3, importance: 60 });
const cargador = (docs) => async (ids) => new Map(ids.map((id) => [String(id), docs.find((d) => String(d._id) === String(id))]).filter(([, d]) => d));

test('firstNotRepeated: una candidata en la banda a la que el juez dice SI se saltea (anotada como "por juez") y sigue la siguiente', async () => {
  const docs = [doc('a', conCoseno(0.85)), doc('b', conCoseno(0.2))];
  const juez = juezFalso((cand) => cand.id === 'a');
  const r = await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: true, judge: juez });
  assert.equal(r.hit.entry.article._id, 'b');
  assert.equal(r.examined, 2);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].title, 'Nota a');
  assert.equal(r.skipped[0].by, 'juez');
  assert.equal(r.skipped[0].con, 'Renunció el ministro de Economía');
  assert.ok(Math.abs(r.skipped[0].similarity - 0.85) < 1e-9);
});

test('firstNotRepeated: si el juez dice NO, o no contesta, la candidata de la banda se entrega', async () => {
  const docs = [doc('a', conCoseno(0.85)), doc('b', conCoseno(0.2))];
  for (const veredicto of [false, null]) {
    const r = await firstNotRepeated(docs.map(entrada), {
      seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: true, judge: juezFalso(() => veredicto),
    });
    assert.equal(r.hit.entry.article._id, 'a', `veredicto ${veredicto}`);
    assert.deepEqual(r.skipped, []);
  }
});

test('firstNotRepeated: sin juez todo queda como antes (banda = pasa; 0,88 o más = repetida)', async () => {
  const docs = [doc('a', conCoseno(0.9)), doc('b', conCoseno(0.85)), doc('c', conCoseno(0.2))];
  const r = await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: true });
  assert.equal(r.hit.entry.article._id, 'b');
  assert.deepEqual(r.skipped.map((x) => [x.title, x.by]), [['Nota a', 'coseno']]);
});

test('firstNotRepeated: a la IA se le muestra la candidata con lo liviano de la lista más lo que trajo la lectura completa', async () => {
  const docs = [doc('a', conCoseno(0.85), { neutralTitle: 'Titulo neutral', neutralLead: 'Bajada neutral de a' })];
  const juez = juezFalso(() => false);
  await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: true, judge: juez });
  assert.deepEqual(juez.registro.preguntas[0].candidata, { id: 'a', title: 'Titulo neutral', lead: 'Bajada neutral de a' });
});

test('firstNotRepeated: las preguntas de las candidatas en banda salen JUNTAS, antes de la primera respuesta', async () => {
  const docs = [doc('a', conCoseno(0.85)), doc('b', conCoseno(0.83)), doc('c', conCoseno(0.82))];
  const juez = juezFalso(() => true); // a todas les dice SI: se recorren las tres
  const r = await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: true, judge: juez });
  assert.equal(r.hit, null);
  assert.deepEqual(juez.registro.orden.slice(0, 3), ['prefetch', 'prefetch', 'prefetch'], 'primero salen todas...');
  assert.deepEqual(juez.registro.orden.slice(3), ['pregunta', 'pregunta', 'pregunta'], '...y después se lee cada respuesta');
});

test('firstNotRepeated: no se lanza ninguna pregunta de más allá de la primera candidata que pasa sin juez', async () => {
  // a: banda; b: limpia (pasa sin juez); c: banda (nunca se llega a mirar si a es SI y b se entrega)
  const docs = [doc('a', conCoseno(0.85)), doc('b', conCoseno(0.2)), doc('c', conCoseno(0.83))];
  const juez = juezFalso(() => true);
  const r = await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: true, judge: juez });
  assert.equal(r.hit.entry.article._id, 'b');
  assert.deepEqual(juez.registro.prefetch.map((p) => p.candidata.id), ['a']);
  assert.deepEqual(juez.registro.preguntas.map((p) => p.candidata.id), ['a']);
});

test('firstNotRepeated: las repetidas por coseno no gastan preguntas y no cortan el adelanto de las que siguen', async () => {
  const docs = [doc('a', conCoseno(0.95)), doc('b', conCoseno(0.85)), doc('c', conCoseno(0.2))];
  const juez = juezFalso(() => false);
  const r = await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: true, judge: juez });
  assert.equal(r.hit.entry.article._id, 'b');
  assert.deepEqual(juez.registro.prefetch.map((p) => p.candidata.id), ['b']);
  assert.deepEqual(r.skipped.map((x) => x.by), ['coseno']);
});

test('firstNotRepeated: se adelantan como mucho PREFETCH_MAX_CANDIDATES candidatas', async () => {
  assert.equal(PREFETCH_MAX_CANDIDATES, 3);
  const docs = ['a', 'b', 'c', 'd', 'e'].map((id) => doc(id, conCoseno(0.85)));
  const juez = juezFalso(() => true);
  await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: true, judge: juez });
  assert.deepEqual(juez.registro.prefetch.map((p) => p.candidata.id), ['a', 'b', 'c']);
  assert.equal(juez.registro.preguntas.length, 5, 'igual se pregunta por todas las que se recorren; las dos últimas esperan su turno');
});

test('firstNotRepeated: sin historial no hay con qué comparar: no se toca el juez y se trae una sola candidata', async () => {
  const docs = [doc('a', conCoseno(0.85)), doc('b', conCoseno(0.2))];
  const pedidos = [];
  const juez = juezFalso(() => true);
  const r = await firstNotRepeated(docs.map(entrada), {
    seenEmbeddings: [], needsDoc: true, judge: juez, loadDocs: async (ids) => { pedidos.push(ids.length); return cargador(docs)(ids); },
  });
  assert.equal(r.hit.entry.article._id, 'a');
  assert.deepEqual(pedidos, [1]);
  assert.equal(juez.registro.orden.length, 0);
});

test('firstNotRepeated: una candidata sin embedding pasa (no se puede comparar) y corta el adelanto', async () => {
  const docs = [doc('a', null), doc('b', conCoseno(0.85))];
  const juez = juezFalso(() => true);
  const r = await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: false, judge: juez });
  assert.equal(r.hit.entry.article._id, 'a');
  assert.equal(juez.registro.orden.length, 0);
});

test('firstNotRepeated: una candidata que se borró entre la lectura liviana y la completa se saltea sin preguntar nada', async () => {
  const docs = [doc('b', conCoseno(0.85))];
  const lista = [entrada(doc('a', null)), entrada(docs[0])]; // 'a' ya no existe
  const juez = juezFalso(() => false);
  const r = await firstNotRepeated(lista, { seenEmbeddings: [vista()], loadDocs: cargador(docs), needsDoc: true, judge: juez });
  assert.equal(r.hit.entry.article._id, 'b');
  assert.deepEqual(juez.registro.prefetch.map((p) => p.candidata.id), ['b']);
});

// ================================================================ el motor completo
let seq = 0;
const NOW = Date.parse('2026-10-15T15:00:00.000Z');
const hace = (horas) => new Date(NOW - horas * 3600e3);
const unico = (i) => Array.from({ length: 64 }, (_, k) => (k === i % 64 ? 1 : 0));

function nota(extra = {}) {
  const i = seq++;
  return {
    _id: `m${String(i).padStart(4, '0')}`,
    url: `https://medio.test/m-${i}`,
    title: `Nota ${i} sobre un hecho concreto`,
    publishedAt: hace(3),
    importanceScore: 60,
    category: 'Deportes',
    topic: 'Fútbol',
    geoScope: 'Argentina',
    section: 'deportes',
    tags: [],
    sourceName: 'Medio',
    rawSummary: `resumen de la nota ${i}`,
    embedding: unico(i),
    ...extra,
  };
}

function storeFalso(docs) {
  const liviano = (d) => { const { embedding, rawSummary, ...resto } = d; return resto; }; // eslint-disable-line no-unused-vars
  return {
    async listCandidates(q) {
      return docs
        .filter((d) => d.publishedAt >= q.since && d.importanceScore >= q.minImportance
          && (!q.category || d.category === q.category) && (!q.topic || d.topic === q.topic) && (!q.excludeTopic || d.topic !== q.excludeTopic))
        .sort((a, b) => b.publishedAt - a.publishedAt || (a._id < b._id ? -1 : 1))
        .map(liviano);
    },
    async loadFull(ids) {
      const quiero = new Set(ids.map(String));
      return new Map(docs.filter((d) => quiero.has(String(d._id))).map((d) => [String(d._id), { ...d }]));
    },
    async loadEmbeddings(ids) {
      const quiero = new Set(ids.map(String));
      return new Map(docs.filter((d) => quiero.has(String(d._id)) && d.embedding?.length).map((d) => [String(d._id), d.embedding]));
    },
  };
}

const busquedaFalsa = (...respuestas) => async () => (respuestas.shift() || []).map((d) => ({ ...d }));

async function correr(topics, { docs = [], vistos = [], juez, createJudge, busqueda = busquedaFalsa([]), judgeWaitMs } = {}) {
  // `topicJudge: null` = sin juez de tema: acá se prueba el de "misma historia" y ninguna prueba puede llamar a OpenAI
  // (el juez de tema tiene sus pruebas en temaLibre.test.js).
  const deps = { search: busqueda, expand: async (t) => `${t} expandido`, store: storeFalso(docs), topicJudge: null };
  if (juez !== undefined) deps.judge = juez;
  if (createJudge) deps.createJudge = createJudge;
  return pickBestArticlePerTopic(topics, { seenEmbeddings: vistos, now: NOW, judgeWaitMs, deps });
}

test('motor, tema oficial: la nota más importante cuenta lo mismo que algo visto (coseno 0,85) y el juez lo confirma: se entrega la siguiente', async () => {
  const repetida = nota({ importanceScore: 90, publishedAt: hace(2), embedding: conCoseno(0.85) });
  const otra = nota({ importanceScore: 60, publishedAt: hace(4), embedding: conCoseno(0.1) });
  const juez = juezFalso((cand) => cand.id === repetida._id);

  const [r] = await correr(['Fútbol'], { docs: [repetida, otra], vistos: [vista()], juez });
  assert.equal(r.article.url, otra.url);
  assert.equal(juez.registro.preguntas.length, 1);
  assert.equal(juez.registro.preguntas[0].candidata.id, repetida._id);
  assert.equal(juez.registro.preguntas[0].candidata.lead, repetida.rawSummary, 'la bajada sale del resumen de la nota (todavía no está curada)');
});

test('motor, tema oficial: si el juez dice NO, no contesta o no hay juez, la más importante se entrega igual', async () => {
  const fuerte = nota({ importanceScore: 90, publishedAt: hace(2), embedding: conCoseno(0.85) });
  const otra = nota({ importanceScore: 60, publishedAt: hace(4), embedding: conCoseno(0.1) });
  for (const juez of [juezFalso(() => false), juezFalso(() => null), null]) {
    const [r] = await correr(['Fútbol'], { docs: [fuerte, otra], vistos: [vista()], juez });
    assert.equal(r.article.url, fuerte.url);
  }
});

test('motor, tema libre: el juez también decide en la búsqueda por significado', async () => {
  const base = { category: 'Deportes', topic: 'Fútbol', tags: [], contentSnippet: '' };
  const repetida = nota({ ...base, title: 'River ganó con un golazo', score: 0.97, importanceScore: 80, publishedAt: hace(2), embedding: conCoseno(0.85) });
  const otra = nota({ ...base, title: 'River prepara el clásico', score: 0.96, importanceScore: 70, publishedAt: hace(3), embedding: conCoseno(0.1) });
  const juez = juezFalso((cand) => cand.id === repetida._id);

  const [r] = await correr(['river plate'], {
    docs: [repetida, otra], vistos: [vista()], juez, busqueda: busquedaFalsa([repetida, otra]),
  });
  assert.equal(r.article.url, otra.url);
  assert.deepEqual(juez.registro.preguntas.map((p) => p.candidata.id), [repetida._id]);
});

test('motor, mismo digest: lo ya elegido para un tópico llega al juez con id, título y bajada cuando otro tópico trae algo parecido', async () => {
  const primera = nota({ importanceScore: 90, publishedAt: hace(1), embedding: [1, 0], title: 'Gran triunfo de Boca en la Bombonera', rawSummary: 'Boca ganó 2 a 0' });
  const parecida = nota({ importanceScore: 80, publishedAt: hace(2), embedding: conCoseno(0.84), title: 'Boca se impuso con autoridad', rawSummary: 'Victoria xeneize' });
  const distinta = nota({ importanceScore: 70, publishedAt: hace(3), embedding: conCoseno(0.2) });
  const juez = juezFalso((cand) => cand.id === parecida._id);

  const r = await correr(['Deportes', 'Fútbol'], { docs: [primera, parecida, distinta], juez });
  assert.equal(r[0].article.url, primera.url);
  assert.equal(r[1].article.url, distinta.url, 'la 2.ª es otro relato del mismo partido (el juez lo dijo): sigue la 3.ª');

  const pregunta = juez.registro.preguntas[0];
  assert.equal(pregunta.candidata.id, parecida._id);
  assert.equal(pregunta.vista.id, primera._id);
  assert.equal(pregunta.vista.title, 'Gran triunfo de Boca en la Bombonera');
  assert.equal(pregunta.vista.lead, 'Boca ganó 2 a 0');
  assert.deepEqual(pregunta.vista.vector, [1, 0]);
});

test('motor: si nada cae en la banda de coseno no se le pregunta nada al juez', async () => {
  const a = nota({ importanceScore: 90, publishedAt: hace(1), embedding: [0, 1] });
  const b = nota({ importanceScore: 80, publishedAt: hace(2), embedding: conCoseno(0.2) });
  const juez = juezFalso(() => false);
  await correr(['Deportes', 'Fútbol'], { docs: [a, b], vistos: [vista()], juez });
  assert.equal(juez.registro.preguntas.length, 0, 'nada cae en la banda: no se pregunta nada');
});

test('motor, rescate de un subtema oficial: las notas del rescate también pasan por el juez', async () => {
  const enBanda = nota({ topic: 'Tenis', importanceScore: 70, embedding: conCoseno(0.85) });

  const si = juezFalso(() => true);
  const [r1] = await correr(['Fútbol'], { docs: [enBanda], vistos: [vista()], juez: si });
  assert.equal(r1.article, null, 'el juez dijo que es lo mismo que ya vio: mejor un hueco que una repetida');
  assert.equal(si.registro.preguntas.length, 1);

  const no = juezFalso(() => false);
  const [r2] = await correr(['Fútbol'], { docs: [enBanda], vistos: [vista()], juez: no });
  assert.equal(r2.article.url, enBanda.url);
  assert.equal(r2.usedFallback, true);
});

test('motor, rescate de un tema libre: las notas del rescate también pasan por el juez', async () => {
  const rescate = nota({ category: 'Sociedad', topic: 'Clima', importanceScore: 70, embedding: conCoseno(0.85) });

  const si = juezFalso(() => true);
  const [r1] = await correr(['zzz inventado'], { docs: [rescate], vistos: [vista()], juez: si, busqueda: busquedaFalsa([], [rescate]) });
  assert.equal(r1.article, null);
  assert.equal(si.registro.preguntas.length, 1);

  const no = juezFalso(() => false);
  const [r2] = await correr(['zzz inventado'], { docs: [rescate], vistos: [vista()], juez: no, busqueda: busquedaFalsa([], [rescate]) });
  assert.equal(r2.article.url, rescate.url);
  assert.equal(r2.usedFallback, true);
});

test('motor: un juez que lanza un error no rompe la elección (la nota pasa como con el coseno solo)', async () => {
  const fuerte = nota({ importanceScore: 90, publishedAt: hace(2), embedding: conCoseno(0.85) });
  const roto = juezFalso();
  roto.prefetch = () => { throw new Error('prefetch roto'); };
  roto.isSameEvent = async () => { throw new Error('juez roto'); };
  const [r] = await correr(['Fútbol'], { docs: [fuerte], vistos: [vista()], juez: roto });
  assert.equal(r.article.url, fuerte.url);
  assert.equal(r.matchReason.startsWith('ETIQUETA'), true);
});

// ---------------------------------------------------------------- presupuesto y resumen del digest
test('motor: el presupuesto de espera a los jueces es el que se le pide (null/inválido = el de un digest en vivo)', async () => {
  const presupuestos = [];
  const createJudge = ({ session }) => { presupuestos.push(session.budgetMs); return juezFalso(); };
  const docs = [nota()];

  await correr(['Fútbol'], { docs, createJudge, judgeWaitMs: 4000 });
  await correr(['Fútbol'], { docs, createJudge, judgeWaitMs: 0 });
  await correr(['Fútbol'], { docs, createJudge });
  await correr(['Fútbol'], { docs, createJudge, judgeWaitMs: null });
  await correr(['Fútbol'], { docs, createJudge, judgeWaitMs: -5 });
  await correr(['Fútbol'], { docs, createJudge, judgeWaitMs: Number.NaN });
  assert.deepEqual(presupuestos, [4000, 0, 1500, 1500, 1500, 1500]);
});

test('motor: un digest que usó al juez deja una línea de resumen en el log; uno que no lo usó, no', async () => {
  const lineas = [];
  const original = console.log;
  console.log = (m) => lineas.push(String(m));
  try {
    const nada = ({ session }) => { void session; return juezFalso(); };
    await correr(['Fútbol'], { docs: [nota()], createJudge: nada });
    assert.equal(lineas.filter((l) => l.startsWith('[Juez]')).length, 0);

    const usa = ({ session }) => {
      const j = juezFalso();
      j.session = session;
      j.isSameEvent = async () => { session.count('llamadas'); session.charge(120); return { same: false, source: 'llm' }; };
      return j;
    };
    const a = nota({ importanceScore: 90, publishedAt: hace(1), embedding: [1, 0] });
    const b = nota({ importanceScore: 80, publishedAt: hace(2), embedding: conCoseno(0.85) });
    await correr(['Deportes', 'Fútbol'], { docs: [a, b], createJudge: usa });
    assert.deepEqual(lineas.filter((l) => l.startsWith('[Juez]')), ['[Juez] 1 llamadas, 0 de caché, 120 ms de espera']);
  } finally {
    console.log = original;
  }
});
