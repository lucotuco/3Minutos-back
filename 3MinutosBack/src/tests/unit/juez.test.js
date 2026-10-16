'use strict';

/**
 * Tests de la infraestructura de los jueces con IA (utils/llmJudge.js): caché, llamadas compartidas, presupuesto de
 * espera por digest, interruptor y tolerancia a fallas. La IA es FALSA: ningún test llama a OpenAI.
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_LIVE_WAIT_MS, DEFAULT_BACKGROUND_WAIT_MS, DEFAULT_CACHE_TTL_MS,
  isSwitchedOff, judgeWaitBudgetMs, TtlCache, JudgeSession, createLlmJudge, parseYesNo, parseYesPartialNo,
} = require('../../utils/llmJudge');

// ---------------------------------------------------------------- IA falsa
const respuesta = (texto) => ({ choices: [{ message: { content: texto } }] });

/** Cliente con la forma de OpenAI: chat.completions.create(body, opts). `responder` devuelve (o lanza, o demora) la respuesta. */
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

/** Un cliente cuya respuesta se libera a mano: la llamada queda "en curso" hasta que el test la suelta. */
function clienteManual(texto = 'SI') {
  const cliente = clienteFalso(() => new Promise((ok) => { cliente.liberar = () => ok(respuesta(texto)); }));
  return cliente;
}

function nuevoJuez({ cliente = clienteFalso(), ...resto } = {}) {
  const logs = [];
  const juez = createLlmJudge({
    name: 'prueba',
    switchEnv: 'JUEZ_DE_PRUEBA',
    system: 'sistema',
    buildUser: ({ q }) => `pregunta ${q}`,
    parse: parseYesNo,
    keyFor: ({ q }) => `k|${q}`,
    getClient: () => cliente,
    env: {},
    log: (m) => logs.push(m),
    ...resto,
  });
  return { juez, cliente, logs };
}

const sesion = (budgetMs = 1000) => new JudgeSession({ budgetMs });
const pasarMicrotareas = () => new Promise((ok) => setImmediate(ok));

// ---------------------------------------------------------------- interruptor y presupuesto de fábrica
test('interruptor: off, 0, false y no apagan el juez (sin importar mayúsculas ni espacios); lo demás lo deja prendido', () => {
  for (const v of ['off', 'OFF', ' Off ', '0', 'false', 'FALSE', 'no']) assert.equal(isSwitchedOff('X', { X: v }), true, v);
  for (const v of ['on', '1', 'true', '', 'si', 'offf', undefined]) assert.equal(isSwitchedOff('X', { X: v }), false, String(v));
  assert.equal(isSwitchedOff('X', {}), false);
});

test('presupuesto de espera: 1,5 s en vivo, 4 s en segundo plano; se cambia por variable de entorno; 0 = solo caché', () => {
  assert.equal(DEFAULT_LIVE_WAIT_MS, 1500);
  assert.equal(DEFAULT_BACKGROUND_WAIT_MS, 4000);
  assert.equal(judgeWaitBudgetMs({ env: {} }), 1500);
  assert.equal(judgeWaitBudgetMs({ background: true, env: {} }), 4000);
  assert.equal(judgeWaitBudgetMs({ env: { JUDGE_WAIT_MS: '800' } }), 800);
  assert.equal(judgeWaitBudgetMs({ background: true, env: { JUDGE_WAIT_MS_BACKGROUND: '9000' } }), 9000);
  assert.equal(judgeWaitBudgetMs({ background: true, env: { JUDGE_WAIT_MS: '800' } }), 4000, 'cada variable manda sobre su caso');
  assert.equal(judgeWaitBudgetMs({ env: { JUDGE_WAIT_MS_BACKGROUND: '9000' } }), 1500);
  assert.equal(judgeWaitBudgetMs({ env: { JUDGE_WAIT_MS: '0' } }), 0, 'cero es un valor válido (solo caché)');
  for (const v of ['abc', '-5', '', '  ', 'NaN', 'Infinity']) {
    assert.equal(judgeWaitBudgetMs({ env: { JUDGE_WAIT_MS: v } }), 1500, `"${v}" vuelve al valor de fábrica`);
  }
});

// ---------------------------------------------------------------- lectura de la respuesta
test('parseYesNo: acepta SI/NO con tilde, comillas, mayúsculas o explicación; lo demás no se entiende', () => {
  const esperado = {
    SI: 'SI', Sí: 'SI', 'sí.': 'SI', ' si ': 'SI', '"SI"': 'SI', 'SI\n': 'SI', 'Sí, es el mismo hecho': 'SI',
    NO: 'NO', 'No.': 'NO', 'no, porque son distintas': 'NO', '"No"': 'NO',
  };
  for (const [texto, veredicto] of Object.entries(esperado)) assert.equal(parseYesNo(texto), veredicto, JSON.stringify(texto));
  for (const texto of ['', null, undefined, 'sin datos', 'siempre', 'NOSE', 'Nota', 'tal vez', 'PARCIAL', '42']) {
    assert.equal(parseYesNo(texto), null, JSON.stringify(texto));
  }
});

test('parseYesPartialNo: además reconoce PARCIAL, y no confunde palabras que empiezan igual', () => {
  assert.equal(parseYesPartialNo('PARCIAL'), 'PARCIAL');
  assert.equal(parseYesPartialNo('Parcial.'), 'PARCIAL');
  assert.equal(parseYesPartialNo('Sí'), 'SI');
  assert.equal(parseYesPartialNo('no'), 'NO');
  for (const texto of ['', null, 'parcialmente', 'siempre', 'sin', 'nose']) assert.equal(parseYesPartialNo(texto), null, JSON.stringify(texto));
});

// ---------------------------------------------------------------- caché con vencimiento
test('caché: vence justo a su hora, descarta lo menos usado al llenarse y distingue 0 / "" / false de "no está"', () => {
  let t = 0;
  const c = new TtlCache({ maxEntries: 2, ttlMs: 1000, now: () => t });
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1, 'a pasa a ser la más usada');
  c.set('c', 3);
  assert.equal(c.get('b'), undefined, 'sobra una: se va la menos usada (b)');
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);

  t = 999;
  assert.equal(c.get('a'), 1, 'un instante antes de vencer todavía vale');
  t = 1000;
  assert.equal(c.get('a'), undefined, 'vence justo a las 1000');
  assert.equal(c.get('c'), undefined);
  assert.equal(c.size, 0, 'lo vencido se borra al consultarlo');

  const valores = new TtlCache({ maxEntries: 10, ttlMs: 1000, now: () => t });
  valores.set('cero', 0);
  valores.set('vacio', '');
  valores.set('falso', false);
  assert.equal(valores.get('cero'), 0);
  assert.equal(valores.get('vacio'), '');
  assert.equal(valores.get('falso'), false);
  assert.equal(valores.get('nunca'), undefined);
});

test('caché: volver a guardar una clave renueva su vencimiento y la deja como la más reciente', () => {
  let t = 0;
  const c = new TtlCache({ maxEntries: 2, ttlMs: 1000, now: () => t });
  c.set('a', 1);
  c.set('b', 2);
  t = 600;
  c.set('a', 10); // renueva: vence a las 1600
  c.set('c', 3);  // sobra una: se va b (a quedó como la más reciente)
  assert.equal(c.get('b'), undefined);
  t = 1100;
  assert.equal(c.get('a'), 10, 'a vive hasta 1600');
  assert.equal(DEFAULT_CACHE_TTL_MS, 36 * 3600e3);
});

// ---------------------------------------------------------------- una pregunta
test('ask: una sola llamada, con temperatura 0, pocos tokens, semilla fija, sin reintentos y con tope de tiempo', async () => {
  const { juez, cliente } = nuevoJuez();
  const r = await juez.ask({ q: 1 }, { session: sesion() });

  assert.deepEqual([r.verdict, r.source], ['SI', 'llm']);
  assert.equal(cliente.llamadas.length, 1);
  const { body, opts } = cliente.llamadas[0];
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 5);
  assert.equal(body.seed, 7);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sistema' }, { role: 'user', content: 'pregunta 1' }]);
  assert.deepEqual(opts, { timeout: 8000, maxRetries: 0 });
});

test('ask: la segunda vez la misma pregunta sale de la caché (también para otro digest) y no llama a la IA', async () => {
  const { juez, cliente } = nuevoJuez();
  const uno = sesion();
  await juez.ask({ q: 1 }, { session: uno });
  const otra = await juez.ask({ q: 1 }, { session: uno });
  assert.deepEqual([otra.verdict, otra.source, otra.waitedMs], ['SI', 'cache', 0]);

  const otroDigest = sesion();
  const r3 = await juez.ask({ q: 1 }, { session: otroDigest });
  assert.equal(r3.source, 'cache');
  assert.equal(cliente.llamadas.length, 1);
  assert.deepEqual(uno.counts, { llamadas: 1, cache: 1, timeouts: 0, errores: 0, salteadas: 0 });
  assert.equal(otroDigest.counts.cache, 1);

  assert.equal(juez.peek({ q: 1 }), 'SI');
  assert.equal(juez.peek({ q: 2 }), undefined);
  assert.equal(juez.cacheSize, 1);
  await juez.ask({ q: 2 }, { session: uno });
  assert.equal(cliente.llamadas.length, 2, 'otra pregunta sí llama');
});

test('ask: dos digests que preguntan lo mismo a la vez comparten UNA llamada', async () => {
  const cliente = clienteManual('NO');
  const { juez } = nuevoJuez({ cliente });
  const p1 = juez.ask({ q: 1 }, { session: sesion() });
  const p2 = juez.ask({ q: 1 }, { session: sesion() });
  await pasarMicrotareas();
  assert.equal(cliente.llamadas.length, 1);
  cliente.liberar();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.verdict, 'NO');
  assert.equal(r2.verdict, 'NO');
  assert.equal(cliente.llamadas.length, 1);
});

test('prefetch: arranca la llamada sin esperarla ni descontar presupuesto; el ask posterior la aprovecha', async () => {
  const cliente = clienteManual('SI');
  const { juez } = nuevoJuez({ cliente });
  const session = sesion(1000);

  juez.prefetch({ q: 1 }, { session });
  assert.equal(cliente.llamadas.length, 1, 'la llamada ya salió');
  assert.equal(session.remainingMs, 1000, 'pero nadie esperó todavía');

  const pregunta = juez.ask({ q: 1 }, { session });
  await pasarMicrotareas();
  cliente.liberar();
  const r = await pregunta;
  assert.equal(r.verdict, 'SI');
  assert.equal(cliente.llamadas.length, 1, 'no se pidió dos veces');
});

test('prefetch: con presupuesto 0 no llama (solo se usa la caché) y apagado tampoco', async () => {
  const { juez, cliente } = nuevoJuez();
  juez.prefetch({ q: 1 }, { session: sesion(0) });
  assert.equal(cliente.llamadas.length, 0);

  const env = { JUEZ_DE_PRUEBA: 'off' };
  const apagado = nuevoJuez({ env });
  apagado.juez.prefetch({ q: 1 }, { session: sesion() });
  assert.equal(apagado.cliente.llamadas.length, 0);
});

// ---------------------------------------------------------------- presupuesto de espera
test('presupuesto: si la IA tarda más de lo que le queda al digest, se sigue sin veredicto y la respuesta llega a la caché para la próxima', async () => {
  const cliente = clienteManual('SI');
  const { juez, logs } = nuevoJuez({ cliente });
  const session = sesion(30);

  const r = await juez.ask({ q: 1 }, { session });
  assert.deepEqual([r.verdict, r.source], [null, 'timeout']);
  assert.ok(r.waitedMs >= 20 && r.waitedMs < 1000, `esperó ${r.waitedMs} ms`);
  assert.equal(session.remainingMs, 0, 'se gastó todo el presupuesto');
  assert.equal(session.counts.timeouts, 1);
  assert.match(logs[0], /\[Juez prueba\] sin respuesta/);
  assert.equal(juez.peek({ q: 1 }), undefined, 'todavía no llegó');

  cliente.liberar(); // la llamada seguía en segundo plano
  await pasarMicrotareas();
  assert.equal(juez.peek({ q: 1 }), 'SI', 'la respuesta tardía queda guardada');

  const despues = await juez.ask({ q: 1 }, { session }); // sin presupuesto, pero la caché sí se usa
  assert.deepEqual([despues.verdict, despues.source], ['SI', 'cache']);
});

test('presupuesto: es de TODO el digest; la primera pregunta lenta lo gasta y las demás se saltean (sin llamar)', async () => {
  const cliente = clienteManual('SI');
  const { juez } = nuevoJuez({ cliente });
  const session = sesion(30);

  await juez.ask({ q: 1 }, { session });
  const r2 = await juez.ask({ q: 2 }, { session });
  assert.deepEqual([r2.verdict, r2.source], [null, 'skipped']);
  assert.equal(cliente.llamadas.length, 1, 'la segunda ni se pidió');
  assert.equal(session.counts.salteadas, 1);
  cliente.liberar();
});

test('presupuesto 0: no se llama a la IA, pero lo que ya está en la caché sí se usa', async () => {
  const { juez, cliente } = nuevoJuez();
  await juez.ask({ q: 1 }, { session: sesion(1000) });

  const sinPresupuesto = sesion(0);
  const guardada = await juez.ask({ q: 1 }, { session: sinPresupuesto });
  assert.deepEqual([guardada.verdict, guardada.source], ['SI', 'cache']);
  const nueva = await juez.ask({ q: 2 }, { session: sinPresupuesto });
  assert.deepEqual([nueva.verdict, nueva.source], [null, 'skipped']);
  assert.equal(cliente.llamadas.length, 1);
});

test('JudgeSession: descuenta lo esperado sin bajar de cero, ignora negativos y resume lo que pasó', () => {
  const s = sesion(1500);
  assert.equal(s.used, false);
  s.charge(250);
  assert.equal(s.remainingMs, 1250);
  s.charge(-5);
  assert.equal(s.remainingMs, 1250, 'un valor negativo no devuelve presupuesto');
  s.count('llamadas');
  s.count('llamadas');
  s.count('cache');
  s.charge(390.4);
  assert.equal(s.used, true);
  assert.equal(s.summary(), '[Juez] 2 llamadas, 1 de caché, 640 ms de espera');

  s.count('timeouts');
  s.count('errores');
  s.count('salteadas');
  assert.equal(
    s.summary(),
    '[Juez] 2 llamadas, 1 de caché, 640 ms de espera (1 sin respuesta a tiempo, 1 con error, 1 salteadas por falta de presupuesto)',
  );

  s.charge(99999);
  assert.equal(s.remainingMs, 0);
  assert.equal(s.budgetMs, 1500);
});

// ---------------------------------------------------------------- fallas
test('si la IA falla, el digest sigue sin veredicto, el error no se guarda y la próxima vez se vuelve a intentar', async () => {
  const cliente = clienteFalso((body, opts, n) => {
    if (n === 1) throw new Error('boom 500');
    return respuesta('NO');
  });
  const { juez, logs } = nuevoJuez({ cliente });
  const session = sesion();

  const r1 = await juez.ask({ q: 1 }, { session });
  assert.deepEqual([r1.verdict, r1.source], [null, 'error']);
  assert.equal(r1.error, 'boom 500');
  assert.match(logs[0], /\[Juez prueba\] error \(boom 500\)/);
  assert.equal(session.counts.errores, 1);
  assert.equal(juez.peek({ q: 1 }), undefined);

  const r2 = await juez.ask({ q: 1 }, { session });
  assert.deepEqual([r2.verdict, r2.source], ['NO', 'llm']);
});

test('una respuesta que no se entiende (o vacía) cuenta como falla y tampoco se guarda', async () => {
  for (const contenido of ['tal vez', '', null]) {
    const cliente = clienteFalso(() => respuesta(contenido));
    const { juez } = nuevoJuez({ cliente });
    const r = await juez.ask({ q: 1 }, { session: sesion() });
    assert.deepEqual([r.verdict, r.source], [null, 'error'], JSON.stringify(contenido));
    assert.match(r.error, /no se entiende/);
    assert.equal(juez.peek({ q: 1 }), undefined);
  }
  const sinOpciones = nuevoJuez({ cliente: clienteFalso(() => ({ choices: [] })) });
  assert.equal((await sinOpciones.juez.ask({ q: 1 }, { session: sesion() })).source, 'error');
  const sinNada = nuevoJuez({ cliente: clienteFalso(() => undefined) });
  assert.equal((await sinNada.juez.ask({ q: 1 }, { session: sesion() })).source, 'error');
});

test('un juez nunca lanza: ni si el cliente no se puede crear, ni si la pregunta está mal armada', async () => {
  const sinCliente = nuevoJuez({ getClient: () => { throw new Error('faltan las claves'); } });
  const r1 = await sinCliente.juez.ask({ q: 1 }, { session: sesion() });
  assert.deepEqual([r1.verdict, r1.source, r1.error], [null, 'error', 'faltan las claves']);

  const mala = nuevoJuez({ keyFor: () => { throw new Error('clave imposible'); } });
  const r2 = await mala.juez.ask({ q: 1 }, { session: sesion() });
  assert.deepEqual([r2.verdict, r2.source], [null, 'error']);
  assert.doesNotThrow(() => mala.juez.prefetch({ q: 1 }, { session: sesion() }));
  assert.equal(mala.juez.peek({ q: 1 }), undefined);

  const sinPregunta = nuevoJuez({ buildUser: () => { throw new Error('pregunta rota'); } });
  assert.equal((await sinPregunta.juez.ask({ q: 1 }, { session: sesion() })).source, 'error');
});

test('sin sesión propia, ask usa una nueva con el presupuesto de fábrica', async () => {
  const { juez } = nuevoJuez();
  const r = await juez.ask({ q: 1 });
  assert.equal(r.verdict, 'SI');
});

// ---------------------------------------------------------------- interruptor
test('apagado por variable de entorno: no llama, no cuenta y se nota al instante (sin reiniciar)', async () => {
  const env = {};
  const { juez, cliente } = nuevoJuez({ env });
  assert.equal(juez.enabled(), true);

  env.JUEZ_DE_PRUEBA = 'off';
  assert.equal(juez.enabled(), false);
  const session = sesion();
  const r = await juez.ask({ q: 1 }, { session });
  assert.deepEqual([r.verdict, r.source, r.waitedMs], [null, 'off', 0]);
  assert.equal(cliente.llamadas.length, 0);
  assert.equal(session.used, false, 'apagado no deja huella en el resumen del digest');

  env.JUEZ_DE_PRUEBA = 'on';
  assert.equal((await juez.ask({ q: 1 }, { session })).verdict, 'SI');
});

// ---------------------------------------------------------------- caché: vencimiento y tamaño
test('la caché del juez vence a las 36 h y no antes', async () => {
  let t = 1_000_000;
  const { juez, cliente } = nuevoJuez({ now: () => t });
  await juez.ask({ q: 1 }, { session: sesion() });

  t += DEFAULT_CACHE_TTL_MS - 1;
  assert.equal((await juez.ask({ q: 1 }, { session: sesion() })).source, 'cache');
  assert.equal(cliente.llamadas.length, 1);

  t += 2;
  assert.equal((await juez.ask({ q: 1 }, { session: sesion() })).source, 'llm', 'ya venció: se pregunta de nuevo');
  assert.equal(cliente.llamadas.length, 2);
});

test('la caché del juez tiene tope: al pasarse descarta lo menos usado', async () => {
  const { juez, cliente } = nuevoJuez({ cacheMaxEntries: 2 });
  const session = sesion();
  await juez.ask({ q: 1 }, { session });
  await juez.ask({ q: 2 }, { session });
  await juez.ask({ q: 3 }, { session });
  assert.equal(juez.cacheSize, 2);
  assert.equal(juez.peek({ q: 1 }), undefined, 'la primera se descartó');
  assert.equal(juez.peek({ q: 3 }), 'SI');
  await juez.ask({ q: 1 }, { session });
  assert.equal(cliente.llamadas.length, 4);

  juez.clearCache();
  assert.equal(juez.cacheSize, 0);
});
