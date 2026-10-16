'use strict';

/**
 * Copia en Mongo de las expansiones de los temas libres (utils/topicExpansionStore.js + models/TopicExpansion.js).
 * Un reinicio del servidor vacía la caché en memoria; con la copia, el primer usuario de cada tema no vuelve a pagar la
 * llamada a la IA. Estos tests fijan lo importante: qué se guarda y qué NO, cuándo una copia deja de valer, que una copia
 * dañada o vieja nunca llega al motor, que si Mongo falla o tarda el digest sigue con la IA, y que SOLO el servidor la
 * activa (el estrés y el comparador siguen sin escribir nada). Mongo y OpenAI son falsos. Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { CATEGORIES } = require('../../utils/officialTopics');
const {
  EXPANSION_MODEL, EXPANSION_SEED, buildSystemPrompt, createTopicExpander,
} = require('../../utils/topicExpansion');
const {
  STORE_TTL_MS, STORE_READ_TIMEOUT_MS, STORE_SWITCH, storeKey, createExpansionStore, enablePersistentExpansionCache,
} = require('../../utils/topicExpansionStore');

const T0 = Date.parse('2026-10-16T15:00:00.000Z');
const DIA = 24 * 3600e3;
const RIVER = { q: 'river plate monumental millonario', cat: 'Deportes', sub: 'Fútbol' };

// ---------------------------------------------------------------- Mongo falso
/**
 * Un modelo con la forma de mongoose que usa el almacén: findOne(filtro).maxTimeMS(ms).lean() -> consulta que se
 * espera con await, y updateOne(filtro, cambio, opciones) con upsert. Por defecto guarda en un Map, como una colección.
 */
function modeloFalso({ leer = null, escribir = null } = {}) {
  const docs = new Map();
  const lecturas = [];
  const escrituras = [];
  const modelo = {
    docs,
    lecturas,
    escrituras,
    findOne(filtro) {
      const consulta = { filtro, maxTimeMS: null, lean: false };
      lecturas.push(consulta);
      const api = {
        maxTimeMS(ms) { consulta.maxTimeMS = ms; return api; },
        lean() { consulta.lean = true; return api; },
        then(ok, mal) {
          return Promise.resolve().then(() => (leer ? leer(filtro) : (docs.get(filtro.key) ?? null))).then(ok, mal);
        },
      };
      return api;
    },
    async updateOne(filtro, cambio, opciones) {
      escrituras.push({ filtro, cambio, opciones });
      if (escribir) return escribir(filtro, cambio, opciones);
      docs.set(filtro.key, { key: filtro.key, ...cambio.$set });
      return { acknowledged: true };
    },
  };
  return modelo;
}

function nuevoAlmacen({ modelo = modeloFalso(), reloj = { t: T0 }, ...resto } = {}) {
  const avisos = [];
  const almacen = createExpansionStore({
    getModel: () => modelo,
    now: () => reloj.t,
    warn: (m, e) => avisos.push([m, e]),
    ...resto,
  });
  return { ...almacen, modelo, reloj, avisos };
}

/** Un documento como lo lee Mongo, guardado hace `edadMs`. */
function docGuardado({ edadMs = 0, ...campos } = {}) {
  return {
    key: 'x', topic: 'river plate', q: RIVER.q, cat: RIVER.cat, sub: RIVER.sub, model: EXPANSION_MODEL,
    createdAt: new Date(T0 - edadMs), ...campos,
  };
}

/** Guarda un documento bajo la clave que el almacén va a buscar para (tema, año). */
function guardar(modelo, tema, doc, year = 2026) {
  modelo.docs.set(storeKey(tema, year), doc);
}

const CTX = { topic: 'river plate', year: 2026 };

// ================================================================ la clave
test('la clave es el sha1 del modelo, la semilla, el prompt de ese año y el tema normalizado', () => {
  const esperada = crypto.createHash('sha1')
    .update(JSON.stringify([EXPANSION_MODEL, EXPANSION_SEED, buildSystemPrompt(2026), 'river plate']))
    .digest('hex');
  assert.equal(storeKey('river plate', 2026), esperada);
  assert.match(storeKey('river plate', 2026), /^[0-9a-f]{40}$/);
});

test('la clave cambia con el tema y con el año (el prompt lleva el año); el mismo pedido da siempre la misma', () => {
  const base = storeKey('river plate', 2026);
  assert.equal(storeKey('river plate', 2026), base);
  assert.notEqual(storeKey('boca', 2026), base);
  assert.notEqual(storeKey('river plate', 2027), base);
  assert.ok(!base.includes('river'), 'es un hash: el tema no se lee en la clave');
});

test('createExpansionStore().keyFor es la misma función de clave', () => {
  assert.equal(nuevoAlmacen().keyFor('river plate', 2026), storeKey('river plate', 2026));
});

// ================================================================ leer una copia
test('lectura: busca por clave, con límite de tiempo en el servidor y sin armar documentos de mongoose (lean)', async () => {
  const { get, modelo } = nuevoAlmacen();
  guardar(modelo, 'river plate', docGuardado());

  assert.deepEqual(await get('river plate', CTX), RIVER);
  assert.equal(modelo.lecturas.length, 1);
  assert.deepEqual(modelo.lecturas[0], {
    filtro: { key: storeKey('river plate', 2026) }, maxTimeMS: STORE_READ_TIMEOUT_MS, lean: true,
  });
});

test('los valores de fábrica: una copia vale 7 días y Mongo tiene 800 ms para contestar', async () => {
  assert.equal(STORE_TTL_MS, 7 * DIA);
  assert.equal(STORE_READ_TIMEOUT_MS, 800);
  assert.equal(STORE_SWITCH, 'TOPIC_EXPANSION_STORE');

  const modelo = modeloFalso();
  const almacen = createExpansionStore({ getModel: () => modelo, now: () => T0, warn: () => {} });
  guardar(modelo, 'river plate', docGuardado({ edadMs: 7 * DIA }));
  assert.deepEqual(await almacen.get('river plate', CTX), RIVER, 'a los 7 días justos todavía vale');
  assert.equal(modelo.lecturas[0].maxTimeMS, 800);

  guardar(modelo, 'river plate', docGuardado({ edadMs: 7 * DIA + 1 }));
  assert.equal(await almacen.get('river plate', CTX), null, 'un milisegundo después ya no');
});

test('sin copia no hay nada: null, sin avisos', async () => {
  const { get, avisos } = nuevoAlmacen();
  assert.equal(await get('river plate', CTX), null);
  assert.deepEqual(avisos, []);
});

test('el año de la clave sale del contexto; sin contexto, del reloj', async () => {
  const { get, modelo, reloj } = nuevoAlmacen();
  guardar(modelo, 'river plate', docGuardado(), 2027);
  assert.equal(await get('river plate', { topic: 'river plate', year: 2026 }), null, 'la copia de 2027 no sirve para 2026');
  assert.deepEqual(await get('river plate', { topic: 'river plate', year: 2027 }), RIVER);

  reloj.t = Date.parse('2027-01-02T00:00:00.000Z');
  guardar(modelo, 'river plate', docGuardado({ createdAt: new Date(reloj.t) }), 2027);
  assert.deepEqual(await get('river plate'), RIVER, 'sin contexto: el año del reloj y el tema como clave');
});

// ================================================================ cuándo una copia no sirve
test('la edad se revisa en cada lectura: hasta el vencimiento justo vale, un milisegundo más no', async () => {
  const { get, modelo } = nuevoAlmacen({ ttlMs: 1000 });
  guardar(modelo, 'river plate', docGuardado({ edadMs: 1000 }));
  assert.deepEqual(await get('river plate', CTX), RIVER);
  guardar(modelo, 'river plate', docGuardado({ edadMs: 1001 }));
  assert.equal(await get('river plate', CTX), null);
  guardar(modelo, 'river plate', docGuardado({ edadMs: 0 }));
  assert.deepEqual(await get('river plate', CTX), RIVER, 'recién guardada');
});

test('una copia del futuro, sin fecha o con una fecha ilegible no se usa', async () => {
  const { get, modelo } = nuevoAlmacen();
  for (const createdAt of [new Date(T0 + 1), new Date(T0 + 30 * DIA), undefined, null, 'ayer', {}, new Date('x')]) {
    guardar(modelo, 'river plate', docGuardado({ createdAt }));
    assert.equal(await get('river plate', CTX), null, String(createdAt));
  }
  guardar(modelo, 'river plate', docGuardado({ createdAt: new Date(T0 - 1000).toISOString() }));
  assert.deepEqual(await get('river plate', CTX), RIVER, 'una fecha como texto ISO sí se entiende');
});

test('una copia sin consulta (q ausente, vacía, en blanco o que no es texto) no se usa', async () => {
  const { get, modelo } = nuevoAlmacen();
  for (const q of [undefined, null, '', '   ', 7, ['river'], { q: 'river' }]) {
    guardar(modelo, 'river plate', docGuardado({ q }));
    assert.equal(await get('river plate', CTX), null, JSON.stringify(q));
  }
});

// ================================================================ lo que se lee pasa por el validador de la IA
test('categoría y subtema se revalidan contra la taxonomía de HOY: lo que ya no existe se descarta, la consulta se conserva', async () => {
  const { get, modelo } = nuevoAlmacen();

  guardar(modelo, 'river plate', docGuardado({ cat: 'Categoría que ya no existe', sub: 'Fútbol' }));
  assert.deepEqual(await get('river plate', CTX), { q: RIVER.q, cat: 'Deportes', sub: 'Fútbol' }, 'un subtema válido completa su categoría');

  guardar(modelo, 'river plate', docGuardado({ cat: 'Deportes', sub: 'Subtema que ya no existe' }));
  assert.deepEqual(await get('river plate', CTX), { q: RIVER.q, cat: 'Deportes', sub: '' });

  guardar(modelo, 'river plate', docGuardado({ cat: 'Política', sub: 'Fútbol' }));
  assert.deepEqual(await get('river plate', CTX), { q: RIVER.q, cat: 'Política', sub: '' }, 'un subtema de otra categoría se descarta');

  guardar(modelo, 'river plate', docGuardado({ cat: 'Inventada', sub: 'Inventado' }));
  assert.deepEqual(await get('river plate', CTX), { q: RIVER.q, cat: '', sub: '' });

  guardar(modelo, 'river plate', docGuardado({ cat: 7, sub: ['Fútbol'] }));
  assert.deepEqual(await get('river plate', CTX), { q: RIVER.q, cat: '', sub: '' }, 'lo que no es texto no vale');
});

test('la consulta guardada se limpia como la de la IA: en una línea, sin signos, y siempre empieza con las palabras del usuario', async () => {
  const { get, modelo } = nuevoAlmacen();

  guardar(modelo, 'river plate', docGuardado({ q: 'Monumental, MILLONARIO!' }));
  assert.equal((await get('river plate', CTX)).q, 'river plate monumental millonario', 'se le anteponen las palabras del usuario');

  guardar(modelo, 'river plate', docGuardado({ q: 'river plate\nmonumental;millonario' }));
  assert.equal((await get('river plate', CTX)).q, 'river plate monumental millonario');

  guardar(modelo, 'river plate', docGuardado({ q: `river plate ${'palabra '.repeat(60)}` }));
  assert.ok((await get('river plate', CTX)).q.length <= 200, 'y no pasa del tope');
});

test('toda la taxonomía oficial sobrevive a la ida y vuelta: lo que la IA pudo decir se lee igual', async () => {
  const { get, modelo } = nuevoAlmacen();
  for (const [cat, subs] of Object.entries(CATEGORIES)) {
    for (const sub of subs) {
      guardar(modelo, 'tema', docGuardado({ q: 'tema algo', cat, sub }));
      assert.deepEqual(await get('tema', { topic: 'tema', year: 2026 }), { q: 'tema algo', cat, sub }, `${cat} / ${sub}`);
    }
  }
});

// ================================================================ Mongo falla o tarda
test('si la lectura falla (rechaza o lanza) es como no tener copia, con un aviso', async () => {
  const rechaza = nuevoAlmacen({ modelo: modeloFalso({ leer: async () => { throw new Error('Mongo caído'); } }) });
  assert.equal(await rechaza.get('river plate', CTX), null);
  assert.equal(rechaza.avisos.length, 1);
  assert.match(rechaza.avisos[0][0], /no se pudo leer "river plate", se pregunta a la IA/);
  assert.equal(rechaza.avisos[0][1], 'Mongo caído');

  const sinModelo = createExpansionStore({
    getModel: () => { throw new Error('modelo sin compilar'); },
    warn: (m, e) => rechaza.avisos.push([m, e]),
  });
  assert.equal(await sinModelo.get('river plate', CTX), null);
  assert.equal(rechaza.avisos.at(-1)[1], 'modelo sin compilar');
});

test('si Mongo no contesta a tiempo la lectura se da por perdida y el digest sigue con la IA', async () => {
  const colgado = nuevoAlmacen({ modelo: modeloFalso({ leer: () => new Promise(() => {}) }), readTimeoutMs: 25 });
  const antes = Date.now();
  assert.equal(await colgado.get('river plate', CTX), null);
  assert.ok(Date.now() - antes < 1000, 'no espera más que el límite');
  assert.equal(colgado.avisos.length, 1);
  assert.match(colgado.avisos[0][0], /no se pudo leer "river plate"/);
  assert.equal(colgado.avisos[0][1], 'sin respuesta en 25 ms');
  assert.equal(colgado.modelo.lecturas[0].maxTimeMS, 25, 'y el mismo límite se le pide al servidor de Mongo');
});

test('una lectura rápida no deja un temporizador colgado', async () => {
  const { get, modelo } = nuevoAlmacen({ readTimeoutMs: 60_000 });
  guardar(modelo, 'river plate', docGuardado());
  const antes = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  await get('river plate', CTX);
  const despues = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.equal(despues, antes);
});

// ================================================================ guardar una copia
test('escritura: un upsert por clave con la consulta, la categoría, el subtema, el modelo y la fecha de ahora', async () => {
  const { set, modelo } = nuevoAlmacen();
  await set('river plate', RIVER, CTX);

  assert.equal(modelo.escrituras.length, 1);
  const { filtro, cambio, opciones } = modelo.escrituras[0];
  assert.deepEqual(filtro, { key: storeKey('river plate', 2026) });
  assert.deepEqual(opciones, { upsert: true });
  assert.deepEqual(Object.keys(cambio), ['$set']);
  assert.deepEqual(cambio.$set, {
    topic: 'river plate', q: RIVER.q, cat: 'Deportes', sub: 'Fútbol', model: EXPANSION_MODEL, createdAt: new Date(T0),
  });
});

test('escritura: volver a guardar un tema renueva su fecha (así una copia vencida vuelve a valer)', async () => {
  const { get, set, modelo, reloj } = nuevoAlmacen();
  await set('river plate', RIVER, CTX);
  reloj.t = T0 + 8 * DIA;
  assert.equal(await get('river plate', CTX), null, 'a los 8 días la copia venció');

  await set('river plate', { ...RIVER, q: 'river plate monumental' }, CTX);
  assert.equal(modelo.docs.size, 1, 'sigue siendo un solo documento');
  assert.deepEqual(await get('river plate', CTX), { ...RIVER, q: 'river plate monumental' });
});

test('escritura: nunca rechaza ni lanza; si falla, avisa y sigue', async () => {
  const rechaza = nuevoAlmacen({ modelo: modeloFalso({ escribir: async () => { throw new Error('Mongo caído'); } }) });
  await assert.doesNotReject(() => rechaza.set('river plate', RIVER, CTX));
  assert.equal(rechaza.avisos.length, 1);
  assert.match(rechaza.avisos[0][0], /no se pudo guardar "river plate"/);
  assert.equal(rechaza.avisos[0][1], 'Mongo caído');

  const sinModelo = createExpansionStore({
    getModel: () => { throw new Error('modelo sin compilar'); },
    warn: (m, e) => rechaza.avisos.push([m, e]),
  });
  await assert.doesNotReject(() => sinModelo.set('river plate', RIVER, CTX));
  assert.equal(rechaza.avisos.at(-1)[1], 'modelo sin compilar');
});

// ================================================================ de punta a punta: un reinicio del servidor
test('un reinicio no vuelve a pagar la IA: el segundo expansor lee lo que dejó el primero', async () => {
  const modelo = modeloFalso();
  const reloj = { t: T0 };
  const llamadas = [];
  const cliente = {
    chat: { completions: { create: async (body) => { llamadas.push(body); return { choices: [{ message: { content: JSON.stringify(RIVER) } }] }; } } },
  };
  const armar = () => createTopicExpander({
    getClient: () => cliente,
    now: () => reloj.t,
    log: () => {},
    warn: () => {},
    store: createExpansionStore({ getModel: () => modelo, now: () => reloj.t, warn: () => {} }),
  });

  const primero = armar();
  assert.deepEqual(await primero.expand('River Plate'), RIVER);
  await new Promise((ok) => setImmediate(ok)); // la escritura sale sin que el expansor la espere
  assert.equal(llamadas.length, 1);
  assert.equal(modelo.docs.size, 1);

  const reiniciado = armar(); // proceso nuevo: memoria vacía, misma colección
  assert.deepEqual(await reiniciado.expand('  river   plate'), RIVER);
  assert.equal(llamadas.length, 1, 'ninguna llamada nueva a la IA');

  reloj.t = T0 + 8 * DIA; // pasada la semana, otro proceso vuelve a preguntar
  const mucho = armar();
  assert.deepEqual(await mucho.expand('river plate'), RIVER);
  assert.equal(llamadas.length, 2);
});

// ================================================================ activarlo (lo hace el servidor)
test('enablePersistentExpansionCache: carga el modelo una vez, conecta un almacén que lo usa y devuelve true', async () => {
  const modelo = modeloFalso();
  const conectados = [];
  let cargas = 0;
  const activo = enablePersistentExpansionCache({
    env: {},
    loadModel: () => { cargas++; return modelo; },
    setStore: (almacen) => conectados.push(almacen),
    now: () => T0,
    warn: () => {},
  });

  assert.equal(activo, true);
  assert.equal(cargas, 1);
  assert.equal(conectados.length, 1);
  assert.equal(typeof conectados[0].get, 'function');
  assert.equal(typeof conectados[0].set, 'function');

  await conectados[0].set('river plate', RIVER, CTX);
  assert.equal(modelo.escrituras.length, 1, 'el almacén conectado escribe en el modelo que se cargó');
  assert.deepEqual(await conectados[0].get('river plate', CTX), RIVER);
});

test('sin loadModel el servidor carga el modelo real (models/TopicExpansion.js) y ningún otro', () => {
  const cargados = () => Object.keys(require.cache).map((archivo) => path.basename(archivo));
  assert.ok(!cargados().includes('TopicExpansion.js'), 'recién se compila al activar');

  const conectados = [];
  assert.equal(enablePersistentExpansionCache({ env: {}, setStore: (a) => conectados.push(a) }), true);
  assert.equal(conectados.length, 1);
  assert.ok(cargados().includes('TopicExpansion.js'));
  assert.ok(!cargados().includes('Article.js'), 'y no arrastra los demás modelos');
});

test('TOPIC_EXPANSION_STORE=off (también 0, false, no, en cualquier escritura) lo apaga: no carga el modelo ni conecta nada', () => {
  for (const valor of ['off', 'OFF', ' Off ', '0', 'false', 'no']) {
    let cargas = 0;
    const conectados = [];
    const activo = enablePersistentExpansionCache({
      env: { TOPIC_EXPANSION_STORE: valor },
      loadModel: () => { cargas++; return modeloFalso(); },
      setStore: (a) => conectados.push(a),
    });
    assert.equal(activo, false, valor);
    assert.equal(cargas, 0, valor);
    assert.equal(conectados.length, 0, valor);
  }
});

test('prendido por defecto: sin la variable, vacía, o con cualquier otro valor, queda activo', () => {
  for (const env of [{}, { TOPIC_EXPANSION_STORE: '' }, { TOPIC_EXPANSION_STORE: 'on' }, { TOPIC_EXPANSION_STORE: 'true' }, { OTRA: 'off' }]) {
    const conectados = [];
    const activo = enablePersistentExpansionCache({ env, loadModel: () => modeloFalso(), setStore: (a) => conectados.push(a) });
    assert.equal(activo, true, JSON.stringify(env));
    assert.equal(conectados.length, 1);
  }
});

test('si no se puede activar (el modelo no compila) el servidor sigue como antes, solo con la caché en memoria', () => {
  const avisos = [];
  const conectados = [];
  const activo = enablePersistentExpansionCache({
    env: {},
    loadModel: () => { throw new Error('esquema inválido'); },
    setStore: (a) => conectados.push(a),
    warn: (m, e) => avisos.push([m, e]),
  });
  assert.equal(activo, false);
  assert.equal(conectados.length, 0);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0][0], /No se pudo activar la copia de expansiones/);
  assert.equal(avisos[0][1], 'esquema inválido');
});

// ================================================================ el modelo de Mongo (sin conectar)
test('el modelo: colección topic_expansions, clave única e índice TTL de limpieza que dura más que lo que el motor da por bueno', () => {
  const TopicExpansion = require('../../models/TopicExpansion');
  assert.equal(TopicExpansion.collection.name, 'topic_expansions');

  const indices = TopicExpansion.schema.indexes();
  const unico = indices.find(([campos]) => campos.key === 1);
  assert.ok(unico, 'índice por clave');
  assert.equal(unico[1].unique, true);

  const ttl = indices.find(([campos]) => campos.createdAt === 1);
  assert.ok(ttl, 'índice TTL por fecha de creación');
  assert.equal(ttl[1].expireAfterSeconds, TopicExpansion.RETENTION_SECONDS);
  assert.ok(TopicExpansion.RETENTION_SECONDS * 1000 >= STORE_TTL_MS, 'Mongo no borra copias que el motor todavía daría por buenas');

  for (const campo of ['key', 'topic', 'q', 'cat', 'sub', 'model', 'createdAt']) assert.ok(TopicExpansion.schema.path(campo), campo);
  assert.equal(TopicExpansion.schema.options.versionKey, false);
});

// ================================================================ solo el servidor la activa
const SRC = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function archivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) return archivosJs(ruta);
    return e.name.endsWith('.js') ? [ruta] : [];
  });
}

test('server.js la activa después de conectar a Mongo, y antes de arrancar los jobs que arman digests', () => {
  const server = leer('server.js');
  const conectar = server.indexOf('await connectDB();');
  const activar = server.indexOf('enablePersistentExpansionCache()');
  const cron = server.indexOf('startGlobalContextCron();');
  assert.ok(conectar > 0 && activar > conectar && cron > activar, 'connectDB -> activar -> jobs');
  assert.match(server, /require\('\.\/utils\/topicExpansionStore'\)/);
});

test('ninguna herramienta de prueba (estrés, comparador, mediciones) la activa ni toca su modelo: siguen de solo lectura', () => {
  const herramientas = [
    ...archivosJs(path.join(SRC, 'tests', 'estres')),
    ...archivosJs(path.join(SRC, 'tests', 'comparar')),
    ...['medirCosenos.js', 'auditarCandidatos.js'].map((f) => path.join(SRC, 'tests', f)).filter((f) => fs.existsSync(f)),
  ];
  assert.ok(herramientas.length > 10, 'se revisaron las herramientas');
  for (const archivo of herramientas) {
    const fuente = fs.readFileSync(archivo, 'utf8');
    assert.ok(!/enablePersistentExpansionCache|topicExpansionStore|models\/TopicExpansion|setExpansionStore/.test(fuente), path.relative(SRC, archivo));
  }
});

test('topicExpansion.js no conoce el almacén ni Mongo: solo recibe uno si el servidor se lo conecta', () => {
  const fuente = leer('utils/topicExpansion.js');
  const requires = [...fuente.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.ok(requires.every((r) => ['./officialTopics', './llmJudge', '../config/openai'].includes(r)), requires.join(', '));
  assert.ok(!/mongoose/.test(fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
});
