'use strict';

/**
 * Tests del juez de TEMA de los tópicos libres (utils/topicJudge.js): la pregunta a la IA, la lectura del veredicto
 * (SI / PARCIAL / NO), el presupuesto de espera compartido y el filtro que usa el motor (createTopicCheck).
 * La IA es FALSA: ningún test llama a OpenAI.
 * Correr:  npm run test:unit
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { JudgeSession } = require('../../utils/llmJudge');
const {
  SYSTEM_PROMPT, keyFor, createTopicLlm, createTopicJudge, createTopicCheck,
} = require('../../utils/topicJudge');

// ---------------------------------------------------------------- IA falsa
const respuesta = (texto) => ({ choices: [{ message: { content: texto } }] });

function clienteFalso(responder = () => respuesta('SI')) {
  const llamadas = [];
  return {
    llamadas,
    chat: {
      completions: {
        create: async (body, opts) => {
          llamadas.push({ body, opts });
          return responder(body, opts, llamadas.length);
        },
      },
    },
  };
}

function clienteManual(texto = 'SI') {
  const cliente = clienteFalso(() => new Promise((ok) => { cliente.liberar = () => ok(respuesta(texto)); }));
  return cliente;
}

function nuevoJuez({ cliente = clienteFalso(), env = {}, session = new JudgeSession({ budgetMs: 1000 }) } = {}) {
  const logs = [];
  const llm = createTopicLlm({ getClient: () => cliente, env, log: (m) => logs.push(m) });
  return { juez: createTopicJudge({ session, llm }), llm, cliente, session, logs };
}

const nota = (extra = {}) => ({ id: 'n1', title: 'River ganó en el Monumental', lead: 'El Millonario se impuso 2 a 0.', ...extra });
const pasarTurno = () => new Promise((ok) => setImmediate(ok));

// ================================================================ la pregunta
test('las instrucciones: SI / PARCIAL / NO, la regla de persona o club y la regla de calificadores', () => {
  assert.match(SYSTEM_PROMPT, /- SI: la noticia trata directamente sobre ese tema \(es protagonista o foco principal\)\./);
  assert.match(SYSTEM_PROMPT, /- PARCIAL: el tema aparece mencionado pero no es el foco de la noticia\./);
  assert.match(SYSTEM_PROMPT, /- NO: la noticia no tiene relación con el tema\./);
  assert.match(SYSTEM_PROMPT, /Respondé con UNA sola palabra/);
  assert.match(SYSTEM_PROMPT, /Si el tema es una persona o un club, la noticia debe ser sobre esa persona o club \(no sobre un rival que lo nombra de pasada\)\./);
  assert.match(SYSTEM_PROMPT, /calificador \(un país, una ciudad, un deporte, una época: "tenis argentino", "economía de Brasil"\)/);
  assert.match(SYSTEM_PROMPT, /si no lo cumple, es NO\./);
});

test('el criterio de base es el MISMO que usa el comparador para medir si el motor eligió bien (tests/comparar/corrida.js)', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'comparar', 'corrida.js'), 'utf8');
  const bloque = fuente.match(/const PROMPT_JUEZ = \[([\s\S]*?)\]\.join\(/);
  assert.ok(bloque, 'no encuentro PROMPT_JUEZ en tests/comparar/corrida.js: si lo movieron, actualizar este test');
  const lineas = [...bloque[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  assert.ok(lineas.length >= 6, `PROMPT_JUEZ debería tener al menos 6 líneas y tiene ${lineas.length}`);
  for (const linea of lineas) {
    assert.ok(SYSTEM_PROMPT.includes(linea), `el juez del motor no tiene esta línea del comparador: "${linea}"`);
  }
});

test('keyFor: el mismo tema (sin importar mayúsculas ni tildes) y la misma nota son la misma pregunta', () => {
  const a = keyFor({ topic: 'River Plate', note: nota() });
  assert.equal(keyFor({ topic: 'river plate', note: nota() }), a);
  assert.equal(keyFor({ topic: ' RÍVER plate ', note: nota() }), a);
  assert.notEqual(keyFor({ topic: 'boca', note: nota() }), a, 'otro tema, otra pregunta');
  assert.notEqual(keyFor({ topic: 'river plate', note: nota({ id: 'n2' }) }), a, 'otra nota, otra pregunta');
});

test('keyFor: la nota se identifica por id; sin id, por su título normalizado', () => {
  const sinId = keyFor({ topic: 'river plate', note: { title: 'River GANÓ en el Monumental', lead: 'x' } });
  assert.equal(keyFor({ topic: 'river plate', note: { id: '', title: 'river ganó en el monumental', lead: 'otra bajada' } }), sinId);
  assert.notEqual(keyFor({ topic: 'river plate', note: { title: 'Otro título' } }), sinId);
  assert.notEqual(sinId, keyFor({ topic: 'river plate', note: nota({ id: 'river ganó en el monumental' }) }), 'un id no se confunde con un título');
});

test('el pedido: tema, título y resumen; una temperatura 0, semilla fija, 4 tokens, 8 s y sin reintentos', async () => {
  const { juez, cliente } = nuevoJuez();
  await juez.verdictFor('river plate', nota());

  assert.equal(cliente.llamadas.length, 1);
  const { body, opts } = cliente.llamadas[0];
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.temperature, 0);
  assert.equal(body.seed, 7);
  assert.equal(body.max_tokens, 4);
  assert.deepEqual(body.messages[0], { role: 'system', content: SYSTEM_PROMPT });
  assert.deepEqual(body.messages[1], {
    role: 'user',
    content: 'TEMA: river plate\nTÍTULO: River ganó en el Monumental\nRESUMEN: El Millonario se impuso 2 a 0.',
  });
  assert.deepEqual(opts, { timeout: 8000, maxRetries: 0 });
});

test('una nota sin resumen se pregunta igual, con "(sin resumen)"', async () => {
  const { juez, cliente } = nuevoJuez();
  await juez.verdictFor('river plate', nota({ lead: '' }));
  assert.match(cliente.llamadas[0].body.messages[1].content, /\nRESUMEN: \(sin resumen\)$/);
});

// ================================================================ el veredicto
test('verdictFor: SI, PARCIAL y NO (con tilde, punto, mayúsculas o explicación) se entienden', async () => {
  const esperado = { SI: 'SI', 'Sí.': 'SI', ' si ': 'SI', PARCIAL: 'PARCIAL', 'Parcial.': 'PARCIAL', NO: 'NO', 'no, es de otro tema': 'NO' };
  let i = 0;
  for (const [texto, veredicto] of Object.entries(esperado)) {
    const { juez } = nuevoJuez({ cliente: clienteFalso(() => respuesta(texto)) });
    const r = await juez.verdictFor('river plate', nota({ id: `nota-${i++}` }));
    assert.equal(r.verdict, veredicto, JSON.stringify(texto));
    assert.equal(r.source, 'llm');
  }
});

test('verdictFor: lo que la IA conteste fuera de eso, o un error de red, es "sin veredicto" y nunca lanza', async () => {
  for (const mala of ['', 'tal vez', 'siempre', 'parcialmente', null]) {
    const { juez, logs } = nuevoJuez({ cliente: clienteFalso(() => respuesta(mala)) });
    const r = await juez.verdictFor('river plate', nota());
    assert.equal(r.verdict, null, JSON.stringify(mala));
    assert.equal(r.source, 'error');
    assert.equal(logs.length, 1);
  }
  const { juez } = nuevoJuez({ cliente: clienteFalso(() => { throw new Error('429 Too Many Requests'); }) });
  assert.deepEqual({ ...(await juez.verdictFor('river plate', nota())), waitedMs: 0 }, { verdict: null, source: 'error', waitedMs: 0 });
});

// ================================================================ caché, llamadas en curso y presupuesto
test('la misma pregunta se contesta una sola vez: la segunda sale de la caché', async () => {
  const { juez, cliente, session } = nuevoJuez();
  assert.equal((await juez.verdictFor('river plate', nota())).source, 'llm');
  const otra = await juez.verdictFor('River Plate', nota());
  assert.deepEqual({ verdict: otra.verdict, source: otra.source }, { verdict: 'SI', source: 'cache' });
  assert.equal(cliente.llamadas.length, 1);
  assert.deepEqual({ llamadas: session.counts.llamadas, cache: session.counts.cache }, { llamadas: 1, cache: 1 });
});

test('prefetch arranca la pregunta sin esperarla, y verdictFor se engancha a la que ya está en curso', async () => {
  const cliente = clienteManual('SI');
  const { juez, session } = nuevoJuez({ cliente });

  juez.prefetch('river plate', nota());
  await pasarTurno();
  assert.equal(cliente.llamadas.length, 1, 'la pregunta salió sin que nadie la esperara');

  const espera = juez.verdictFor('river plate', nota());
  await pasarTurno();
  assert.equal(cliente.llamadas.length, 1, 'no se hace una segunda llamada');
  cliente.liberar();
  assert.equal((await espera).verdict, 'SI');
  assert.equal(session.counts.llamadas, 1);
});

test('prefetch no hace nada con una nota sin título ni resumen, ni con presupuesto 0, ni con el juez apagado', async () => {
  const sinNada = nuevoJuez();
  sinNada.juez.prefetch('river plate', { id: 'x', title: '', lead: '' });
  sinNada.juez.prefetch('river plate', null);
  await pasarTurno();
  assert.equal(sinNada.cliente.llamadas.length, 0);

  const soloCache = nuevoJuez({ session: new JudgeSession({ budgetMs: 0 }) });
  soloCache.juez.prefetch('river plate', nota());
  await pasarTurno();
  assert.equal(soloCache.cliente.llamadas.length, 0, 'presupuesto 0 = solo caché');

  const apagado = nuevoJuez({ env: { TOPIC_JUDGE: 'off' } });
  apagado.juez.prefetch('river plate', nota());
  await pasarTurno();
  assert.equal(apagado.cliente.llamadas.length, 0);
});

test('verdictFor de una nota sin título ni resumen: no hay qué juzgar y no se llama a la IA', async () => {
  const { juez, cliente } = nuevoJuez();
  const r = await juez.verdictFor('river plate', { id: 'x', title: '', lead: '' });
  assert.deepEqual({ verdict: r.verdict, source: r.source }, { verdict: null, source: 'skipped' });
  assert.equal(cliente.llamadas.length, 0);
});

test('interruptor TOPIC_JUDGE=off: el juez dice que está apagado y no pregunta nada', async () => {
  const { juez, cliente } = nuevoJuez({ env: { TOPIC_JUDGE: 'off' } });
  assert.equal(juez.enabled(), false);
  const r = await juez.verdictFor('river plate', nota());
  assert.deepEqual({ verdict: r.verdict, source: r.source }, { verdict: null, source: 'off' });
  assert.equal(cliente.llamadas.length, 0);

  assert.equal(nuevoJuez().juez.enabled(), true, 'prendido por defecto');
  assert.equal(nuevoJuez({ env: { SAME_STORY_JUDGE: 'off' } }).juez.enabled(), true, 'el interruptor del otro juez no lo apaga');
});

test('si la IA tarda más que el presupuesto del digest: sin veredicto, y la respuesta tardía queda en la caché para la próxima', async () => {
  const cliente = clienteManual('PARCIAL');
  const { juez, session } = nuevoJuez({ cliente, session: new JudgeSession({ budgetMs: 25 }) });

  const t0 = Date.now();
  const r = await juez.verdictFor('river plate', nota());
  assert.deepEqual({ verdict: r.verdict, source: r.source }, { verdict: null, source: 'timeout' });
  assert.ok(Date.now() - t0 < 500, 'no esperó más que el presupuesto');
  assert.equal(session.remainingMs, 0);
  assert.equal(session.counts.timeouts, 1);

  cliente.liberar();
  await pasarTurno();
  const proxima = await juez.verdictFor('river plate', nota());
  assert.deepEqual({ verdict: proxima.verdict, source: proxima.source }, { verdict: 'PARCIAL', source: 'cache' });
  assert.equal(cliente.llamadas.length, 1);
});

test('sin presupuesto y sin nada en la caché se saltea la pregunta; con la respuesta en la caché se usa igual', async () => {
  const agotada = new JudgeSession({ budgetMs: 1000 });
  const { juez, llm, cliente } = nuevoJuez({ session: agotada });
  await juez.verdictFor('river plate', nota({ id: 'guardada' })); // queda en la caché
  agotada.charge(1000);

  const sinCache = await juez.verdictFor('river plate', nota({ id: 'nueva' }));
  assert.deepEqual({ verdict: sinCache.verdict, source: sinCache.source }, { verdict: null, source: 'skipped' });
  const conCache = await juez.verdictFor('river plate', nota({ id: 'guardada' }));
  assert.deepEqual({ verdict: conCache.verdict, source: conCache.source }, { verdict: 'SI', source: 'cache' });
  assert.equal(cliente.llamadas.length, 1);
  assert.equal(llm.cacheSize, 1);
});

// ================================================================ createTopicCheck (lo que usa el motor)
/** Un juez falso con la forma de createTopicJudge: contesta lo que diga `decide(tema, nota)`. */
function juezFalso(decide) {
  const registro = { prefetch: [], preguntas: [] };
  return {
    registro,
    prefetch: (tema, n) => registro.prefetch.push({ tema, nota: n }),
    verdictFor: async (tema, n) => {
      registro.preguntas.push({ tema, nota: n });
      const v = decide(tema, n);
      if (v instanceof Error) throw v;
      return { verdict: v, source: 'llm' };
    },
  };
}

const entrada = (extra = {}) => ({ article: { _id: 'a1', title: 'River ganó', rawSummary: '', category: 'Deportes', ...extra }, tier: 'buena' });

test('createTopicCheck: solo el SI pasa; PARCIAL y NO descartan y dicen por qué', async () => {
  const resultados = {};
  for (const veredicto of ['SI', 'PARCIAL', 'NO']) {
    const check = createTopicCheck({ judge: juezFalso(() => veredicto), topic: 'river plate' });
    resultados[veredicto] = await check.check(entrada(), null);
  }
  assert.deepEqual(resultados.SI, { ok: true, verdict: 'SI', reason: null });
  assert.deepEqual(resultados.PARCIAL, { ok: false, verdict: 'PARCIAL', reason: 'tema_parcial' });
  assert.deepEqual(resultados.NO, { ok: false, verdict: 'NO', reason: 'tema_no' });
});

test('createTopicCheck: sin veredicto se sigue como antes del juez: pasa la que está dentro del corral y no la de afuera', async () => {
  const sinVeredicto = juezFalso(() => null);
  const dentro = createTopicCheck({ judge: sinVeredicto, topic: 'river plate', isOutOfCorral: () => false });
  assert.deepEqual(await dentro.check(entrada(), null), { ok: true, verdict: null, reason: null });

  const afuera = createTopicCheck({ judge: sinVeredicto, topic: 'river plate', isOutOfCorral: () => true });
  assert.deepEqual(await afuera.check(entrada(), null), { ok: false, verdict: null, reason: 'fuera_del_corral_sin_juez' });

  const sinCorral = createTopicCheck({ judge: sinVeredicto, topic: 'river plate' });
  assert.equal((await sinCorral.check(entrada(), null)).ok, true, 'sin isOutOfCorral nadie está afuera');
});

test('createTopicCheck: isOutOfCorral recibe la nota (no la entrada) y solo se consulta cuando no hay veredicto', async () => {
  const vistas = [];
  const isOutOfCorral = (a) => { vistas.push(a._id); return true; };
  const conSi = createTopicCheck({ judge: juezFalso(() => 'SI'), topic: 't', isOutOfCorral });
  await conSi.check(entrada({ _id: 'con-si' }), null);
  assert.deepEqual(vistas, [], 'una nota de afuera con SI pasa sin mirar el corral');

  const sinNada = createTopicCheck({ judge: juezFalso(() => null), topic: 't', isOutOfCorral });
  await sinNada.check(entrada({ _id: 'sin-nada' }), null);
  assert.deepEqual(vistas, ['sin-nada']);
});

test('createTopicCheck: un juez que lanza un error es "sin veredicto" y nunca frena la elección', async () => {
  const roto = juezFalso(() => new Error('se cayó'));
  const dentro = createTopicCheck({ judge: roto, topic: 't', isOutOfCorral: () => false });
  assert.equal((await dentro.check(entrada(), null)).ok, true);
  const afuera = createTopicCheck({ judge: roto, topic: 't', isOutOfCorral: () => true });
  assert.equal((await afuera.check(entrada(), null)).ok, false);

  const prefetchRoto = { prefetch() { throw new Error('boom'); }, verdictFor: async () => ({ verdict: 'SI' }) };
  assert.doesNotThrow(() => createTopicCheck({ judge: prefetchRoto, topic: 't' }).prefetch(entrada(), null));
});

test('createTopicCheck: al juez le llega { id, título, bajada } con lo que trajo la lectura completa por encima de la liviana', async () => {
  const juez = juezFalso(() => 'SI');
  const check = createTopicCheck({ judge: juez, topic: 'river plate' });
  const doc = { rawSummary: 'Bajada <b>completa</b> de la nota', neutralTitle: 'Título neutral' };

  check.prefetch(entrada(), doc);
  await check.check(entrada(), doc);
  assert.deepEqual(juez.registro.prefetch[0], { tema: 'river plate', nota: { id: 'a1', title: 'Título neutral', lead: 'Bajada completa de la nota' } });
  assert.deepEqual(juez.registro.preguntas[0], juez.registro.prefetch[0], 'prefetch y pregunta son la misma pregunta (misma clave de caché)');

  await check.check(entrada({ neutralTitle: '', title: 'Solo liviana' }), null);
  assert.deepEqual(juez.registro.preguntas[1].nota, { id: 'a1', title: 'Solo liviana', lead: '' });
});

test('createTopicCheck con el juez real: PARCIAL descarta, SI pasa, y prefetch + check hacen una sola llamada', async () => {
  const cliente = clienteFalso((body) => respuesta(/TÍTULO: River/.test(body.messages[1].content) ? 'SI' : 'PARCIAL'));
  const { juez } = nuevoJuez({ cliente });
  const check = createTopicCheck({ judge: juez, topic: 'river plate' });
  const rival = entrada({ _id: 'a2', title: 'Racing venció a Lanús' });

  check.prefetch(entrada(), null);
  const ok = await check.check(entrada(), null);
  const descartada = await check.check(rival, null);
  assert.equal(ok.ok, true);
  assert.deepEqual({ ok: descartada.ok, reason: descartada.reason }, { ok: false, reason: 'tema_parcial' });
  assert.equal(cliente.llamadas.length, 2, 'una por nota, sin repetir');
});
