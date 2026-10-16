'use strict';

/**
 * Tests de la infraestructura del test de estrés: contadores, límites, bloqueo de escrituras,
 * captura de logs, reporte (JSON/CSV/HTML/consola), plan y manejo de la URI.
 * Todo con objetos falsos: no se conecta a Mongo ni a OpenAI.
 *   npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const inst = require('../estres/instrumentos');
const R = require('../estres/reporte');
const { htmlReporte, esc } = require('../estres/reporte_html');
const { planificar, textoPlan } = require('../estres/plan');
const { describirUri, conTimeout } = require('../estres/entorno');
const { nivelChico } = require('./estres.fake');

// ================================================================= contadores
test('diferencia y snapshot: restan contadores anidados sin compartir estado', () => {
  assert.deepEqual(inst.diferencia({ a: 1, b: { c: 2 } }, { a: 3, b: { c: 5 }, d: 4 }), { a: 2, b: { c: 3 }, d: 4 });
  assert.deepEqual(inst.diferencia(undefined, { x: { y: 2 } }), { x: { y: 2 } });
  assert.equal(inst.diferencia(null, 7), 7);

  const c = inst.crearContadores();
  c.openai.chat.llamadas = 3;
  c.openai.embeddings.unicos.add('a');
  c.openai.embeddings.unicos.add('b');
  c.mongo.comandos = 5;
  c.mongo.porComando.find = 2;
  const antes = inst.snapshot(c);
  assert.equal(antes.openai.chat.llamadas, 3);
  assert.equal(antes.openai.embeddings.unicos, 2, 'el Set se convierte en cantidad');
  assert.ok(!('ms' in antes.openai.chat), 'las muestras de latencia no van en el snapshot');
  assert.doesNotThrow(() => JSON.stringify(antes));

  antes.mongo.porComando.find = 99;
  assert.equal(c.mongo.porComando.find, 2, 'el snapshot es una copia');
  c.mongo.comandos = 9;
  assert.equal(inst.diferencia(inst.snapshot(c).mongo, { comandos: 9 }).comandos, 0);

  // Los ejemplos de escritura viajan como texto: así G-ESCRITURAS puede decir QUÉ comando escribió.
  const sinEscrituras = inst.snapshot(c);
  assert.equal(sinEscrituras.mongo.ejemplosEscritura, '');
  c.mongo.ejemplosEscritura.push('insert en db', 'update en db');
  const conEscrituras = inst.snapshot(c);
  assert.equal(conEscrituras.mongo.ejemplosEscritura, 'insert en db; update en db');
  assert.equal(inst.diferencia(sinEscrituras.mongo, conEscrituras.mongo).ejemplosEscritura, 'insert en db; update en db', 'diferencia deja pasar el texto');
  assert.doesNotThrow(() => JSON.stringify(conEscrituras));
});

test('normalizarMensaje, anotarError y topErrores agrupan errores parecidos y acotan la memoria', () => {
  assert.equal(inst.normalizarMensaje('Error 429 en 507f1f77bcf86cd799439011\nstack...'), 'Error # en <id>');
  assert.equal(inst.normalizarMensaje(null), '');
  assert.equal(inst.normalizarMensaje('x'.repeat(500)).length, 200);

  const c = inst.crearContadores();
  inst.anotarError(c, 'openai.chat', '429 Too many requests (req 1)');
  inst.anotarError(c, 'openai.chat', '429 Too many requests (req 2)');
  inst.anotarError(c, 'mongo.find', 'boom');
  assert.deepEqual(inst.topErrores(c)[0], { mensaje: 'openai.chat: # Too many requests (req #)', veces: 2 });
  assert.equal(inst.topErrores(c).length, 2);

  const lleno = inst.crearContadores();
  for (let i = 0; i < 250; i++) inst.anotarError(lleno, 'x', `e${'a'.repeat(i + 1)}`);
  assert.equal(lleno.errores.size, 200, 'no guarda más de 200 mensajes distintos');
  inst.anotarError(lleno, 'x', `e${'a'}`);
  inst.anotarError(lleno, 'x', 'nuevo');
  assert.equal(lleno.errores.get('x: ea'), 2, 'los ya conocidos siguen contando');
  assert.ok(!lleno.errores.has('x: nuevo'));
  assert.equal(inst.topErrores(lleno, 3).length, 3);
});

test('clasificarErrorOpenAI: 429, 5xx, timeouts/red y el resto', () => {
  const k = inst.clasificarErrorOpenAI;
  assert.equal(k({ status: 429 }), 'err429');
  assert.equal(k({ status: 500 }), 'err5xx');
  assert.equal(k({ status: 503 }), 'err5xx');
  assert.equal(k({ name: 'APIConnectionTimeoutError', message: 'Request timed out.' }), 'errTimeout');
  assert.equal(k({ code: 'ECONNRESET' }), 'errTimeout');
  assert.equal(k({ message: 'socket hang up' }), 'errTimeout');
  assert.equal(k({ status: 400, message: 'bad request' }), 'errOtros');
  assert.equal(k(new Error('boom')), 'errOtros');

  // El SDK real de OpenAI deja name='Error': el tipo está en la clase y la causa en e.cause.
  class APIConnectionError extends Error {}
  assert.equal(k(new APIConnectionError('Connection error.')), 'errTimeout');
  assert.equal(k(Object.assign(new Error('Something odd'), { cause: { code: 'ECONNRESET' } })), 'errTimeout');
  assert.equal(k(Object.assign(new Error('Connection error.'), { cause: new TypeError('fetch failed') })), 'errTimeout');
  assert.equal(k(null), 'errOtros');
  assert.equal(k(undefined), 'errOtros');
});

// ================================================================= límites
test('crearPresupuesto y crearControl: tiempo, presupuesto y Ctrl+C', () => {
  const p = inst.crearPresupuesto(2);
  assert.equal(p.agotado(), false);
  p.gastar();
  p.gastar();
  assert.deepEqual([p.usado(), p.restante(), p.agotado()], [2, 0, true]);

  let t = 1_000_000;
  const ahora = () => t;
  const porTiempo = inst.crearControl({ maxMinutos: 1, ahora });
  assert.equal(porTiempo.detener(), false);
  t += 59_000;
  assert.equal(porTiempo.detener(), false);
  t += 2_000;
  assert.equal(porTiempo.detener(), true);
  assert.match(porTiempo.motivo(), /límite de 1 min/);
  assert.equal(porTiempo.transcurridoMs(), 61_000);

  const manual = inst.crearControl({ ahora });
  assert.equal(manual.motivo(), null);
  manual.solicitar('interrumpida con Ctrl+C');
  manual.solicitar('otro motivo');
  assert.equal(manual.detener(), true);
  assert.equal(manual.motivo(), 'interrumpida con Ctrl+C', 'gana el primer motivo');

  const presupuesto = inst.crearPresupuesto(1);
  const porPresupuesto = inst.crearControl({ presupuesto, ahora });
  assert.equal(porPresupuesto.detener(), false);
  presupuesto.gastar();
  assert.equal(porPresupuesto.detener(), true);
  assert.match(porPresupuesto.motivo(), /presupuesto/);

  assert.equal(inst.crearControl().detener(), false, 'sin límites no se detiene solo');
});

// ================================================================= OpenAI
const cfgFalso = ({ chat, emb } = {}) => ({
  openaiReview: { chat: { completions: { create: chat || (async () => ({ choices: [] })) } } },
  openaiEmbeddings: { embeddings: { create: emb || (async () => ({ data: [{ embedding: [1] }] })) } },
});

test('instrumentarOpenAI: cuenta llamadas, textos únicos y latencias, sin alterar la respuesta', async () => {
  const recibidos = [];
  const cfg = cfgFalso({ chat: async (params) => { recibidos.push(params); return { choices: ['ok'] }; } });
  const c = inst.crearContadores();
  inst.instrumentarOpenAI(cfg, c, inst.crearPresupuesto(100));

  assert.deepEqual(await cfg.openaiReview.chat.completions.create({ model: 'm' }), { choices: ['ok'] });
  assert.deepEqual(recibidos, [{ model: 'm' }]);
  for (const input of ['a', 'b', 'a']) await cfg.openaiEmbeddings.embeddings.create({ input });

  assert.equal(c.openai.chat.llamadas, 1);
  assert.equal(c.openai.embeddings.llamadas, 3);
  assert.equal(c.openai.embeddings.ok, 3);
  assert.equal(c.openai.embeddings.unicos.size, 2);
  assert.equal(c.openai.embeddings.ms.length, 3);
});

test('instrumentarOpenAI: clasifica los errores, los vuelve a lanzar y respeta el presupuesto', async () => {
  const e429 = Object.assign(new Error('rate limit'), { status: 429 });
  const cfg = cfgFalso({ emb: async () => { throw e429; } });
  const c = inst.crearContadores();
  inst.instrumentarOpenAI(cfg, c, inst.crearPresupuesto(100));
  await assert.rejects(cfg.openaiEmbeddings.embeddings.create({ input: 'x' }), (e) => e === e429);
  assert.equal(c.openai.embeddings.err429, 1);
  assert.equal(c.openai.embeddings.llamadas, 1);
  assert.equal(inst.topErrores(c)[0].mensaje, 'openai.embeddings: # rate limit');

  // El SDK real ya antepone el status al mensaje ("429 Rate limit reached"): no se duplica.
  const c3 = inst.crearContadores();
  const cfg3 = cfgFalso({ chat: async () => { throw Object.assign(new Error('429 Rate limit reached'), { status: 429 }); } });
  inst.instrumentarOpenAI(cfg3, c3, inst.crearPresupuesto(10));
  await assert.rejects(cfg3.openaiReview.chat.completions.create({}));
  assert.equal(inst.topErrores(c3)[0].mensaje, 'openai.chat: # Rate limit reached');

  let reales = 0;
  const cfg2 = cfgFalso({ chat: async () => { reales++; return {}; } });
  const c2 = inst.crearContadores();
  inst.instrumentarOpenAI(cfg2, c2, inst.crearPresupuesto(1));
  await cfg2.openaiReview.chat.completions.create({});
  await assert.rejects(cfg2.openaiReview.chat.completions.create({}), (e) => e.code === 'ESTRES_PRESUPUESTO');
  assert.equal(reales, 1, 'agotado el presupuesto NO se llama a OpenAI');
  assert.equal(c2.openai.chat.bloqueadas, 1);
  assert.equal(c2.openai.chat.llamadas, 1);

  assert.doesNotThrow(() => inst.instrumentarOpenAI({}, inst.crearContadores(), inst.crearPresupuesto(1)));
});

// ================================================================= Mongo
test('esEscritura: comandos de escritura y pipelines con $out/$merge', () => {
  for (const commandName of ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'drop', 'dropDatabase', 'create']) {
    assert.equal(inst.esEscritura({ commandName }), true, commandName);
  }
  for (const commandName of ['find', 'count', 'getMore', 'hello', 'ping', 'endSessions']) {
    assert.equal(inst.esEscritura({ commandName }), false, commandName);
  }
  assert.equal(inst.esEscritura({ commandName: 'aggregate', command: { pipeline: [{ $match: {} }, { $out: 'x' }] } }), true);
  assert.equal(inst.esEscritura({ commandName: 'aggregate', command: { pipeline: [{ $merge: { into: 'x' } }] } }), true);
  assert.equal(inst.esEscritura({ commandName: 'aggregate', command: { pipeline: [{ $vectorSearch: {} }, { $limit: 5 }] } }), false);
  assert.equal(inst.esEscritura({ commandName: 'aggregate' }), false);
  assert.equal(inst.esEscritura({ commandName: 'aggregate', command: { pipeline: [null] } }), false);
});

test('monitorearMongo: cuenta comandos, escrituras, fallos y rechazos del pool', () => {
  const client = new EventEmitter();
  const c = inst.crearContadores();
  inst.monitorearMongo(client, c);
  client.emit('commandStarted', { commandName: 'find', databaseName: 'db' });
  client.emit('commandStarted', { commandName: 'aggregate', databaseName: 'db', command: { pipeline: [{ $vectorSearch: {} }] } });
  client.emit('commandStarted', { commandName: 'insert', databaseName: 'db' });
  client.emit('commandStarted', { commandName: 'aggregate', databaseName: 'db', command: { pipeline: [{ $match: {} }, { $merge: { into: 'x' } }] } });
  client.emit('commandSucceeded', { duration: 12 });
  client.emit('commandFailed', { commandName: 'find', failure: new Error('boom 7') });
  client.emit('connectionCheckOutFailed', { reason: 'timeout' });

  assert.equal(c.mongo.comandos, 4);
  assert.deepEqual(c.mongo.porComando, { find: 1, aggregate: 2, insert: 1 });
  assert.equal(c.mongo.escrituras, 2);
  assert.deepEqual(c.mongo.ejemplosEscritura, ['insert en db', 'aggregate en db']);
  assert.deepEqual(c.mongo.ms, [12]);
  assert.equal(c.mongo.fallos, 1);
  assert.equal(c.mongo.checkOutFallidos, 1);
  const mensajes = inst.topErrores(c).map((e) => e.mensaje);
  assert.ok(mensajes.includes('mongo.find: boom #'));
  assert.ok(mensajes.includes('mongo.pool: timeout'));

  for (let i = 0; i < 15; i++) client.emit('commandStarted', { commandName: 'delete', databaseName: 'db' });
  assert.equal(c.mongo.escrituras, 17);
  assert.equal(c.mongo.ejemplosEscritura.length, 10, 'los ejemplos están acotados');
});

test('bloquearEscrituras: las escrituras de mongoose lanzan y las lecturas siguen andando', () => {
  class Model {
    static async create() { return 'real'; }
    static async insertMany() { return 'real'; }
    static find() { return 'leer'; }
    save() { return 'real'; }
  }
  class Query {
    updateOne() { return 'real'; }
    deleteMany() { return 'real'; }
    find() { return 'leer'; }
  }
  const c = inst.crearContadores();
  inst.bloquearEscrituras({ Model, Query }, c);

  assert.throws(() => Model.create({}), { code: 'ESTRES_ESCRITURA_BLOQUEADA' });
  assert.throws(() => Model.insertMany([]), /escritura bloqueada \(Model\.insertMany\)/);
  assert.throws(() => new Model().save(), /escritura bloqueada \(Model#save\)/);
  assert.throws(() => new Query().updateOne(), { code: 'ESTRES_ESCRITURA_BLOQUEADA' });
  assert.throws(() => new Query().deleteMany(), /Query\.deleteMany/);
  assert.equal(Model.find(), 'leer');
  assert.equal(new Query().find(), 'leer');
  assert.equal(c.mongo.bloqueadas, 5);
});

// ================================================================= captura de logs
test('crearCaptura: cuenta los logs de cada llamada, no los imprime y deja la consola como estaba', async () => {
  const guardado = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const impresos = [];
  console.log = (...a) => impresos.push(a.join(' '));
  console.error = (...a) => impresos.push(a.join(' '));
  try {
    const contadores = inst.crearContadores();
    const cap = inst.crearCaptura(contadores);
    const { r, logs } = await cap.correr(async () => {
      console.log('Error en busqueda semantica: boom');
      console.log('Error en rescate de emergencia: x');
      console.log('CADUCIDAD nota vieja');
      console.log('otra línea');
      console.error(new Error('algo 42'));
      console.warn('aviso');
      return 7;
    });
    console.log('fuera de la captura');
    assert.equal(r, 7);
    assert.deepEqual(logs, { lineas: 6, errorBusqueda: 1, errorRescate: 1, caducidad: 1 });
    assert.deepEqual(impresos, ['fuera de la captura'], 'lo capturado no se imprime; lo de afuera sí');
    assert.equal(inst.topErrores(contadores)[0].mensaje, 'consola: Error: algo #');

    await assert.rejects(cap.correr(async () => { console.log('x'); throw new Error('fallo'); }), (e) => e.message === 'fallo' && e.logs.lineas === 1);

    const [a, b] = await Promise.all([
      cap.correr(async () => { console.log('a1'); await new Promise((res) => setTimeout(res, 8)); console.log('a2'); }),
      cap.correr(async () => { await new Promise((res) => setTimeout(res, 2)); console.log('b1'); }),
    ]);
    assert.equal(a.logs.lineas, 2, 'cada llamada cuenta solo lo suyo aunque corran a la vez');
    assert.equal(b.logs.lineas, 1);

    cap.restaurar();
    console.log('después de restaurar');
    assert.deepEqual(impresos, ['fuera de la captura', 'después de restaurar']);
  } finally {
    Object.assign(console, guardado);
  }
});

test('crearMonitorLag y memoria devuelven números sanos', async () => {
  const m = inst.crearMonitorLag(10);
  await new Promise((res) => setTimeout(res, 50));
  const l = m.leerYReiniciar();
  assert.ok(Number.isFinite(l.p99) && l.p99 >= 0);
  assert.ok(Number.isFinite(l.max) && l.max >= 0);
  m.detener();
  const mem = inst.memoria();
  assert.ok(mem.rssMB > 0 && mem.heapMB > 0 && mem.externalMB >= 0);
});

// ================================================================= reporte
const META = {
  nivel: 'suave', duracionMin: 1.5, parcial: false, motivoParada: null, host: 'cluster0.secreto.mongodb.net',
  baseConectada: 'db', commit: 'abc1234', rama: 'rama', iniciadoEn: '2026-10-14T12:00:00Z', articulos24h: 5, articulos48h: 10,
};
const hz = (id, severidad, escenario = 'A', extra = {}) => ({ id, severidad, escenario, titulo: `titulo ${id}`, detalle: '', evidencia: [], sugerencia: '', ...extra });
const CONTADORES = { openai: { chat: { llamadas: 3, err429: 1 }, embeddings: { llamadas: 4, err429: 0 } }, mongo: { comandos: 9, fallos: 0, escrituras: 0 } };

test('veredicto: la peor severidad manda', () => {
  assert.equal(R.veredicto({ CRITICA: 1, ALTA: 5 }).nivel, 'ROJO');
  assert.equal(R.veredicto({ ALTA: 2 }).nivel, 'NARANJA');
  assert.equal(R.veredicto({ MEDIA: 1 }).nivel, 'AMARILLO');
  assert.equal(R.veredicto({ BAJA: 9, INFO: 9 }).nivel, 'VERDE');
  assert.equal(R.veredicto({}).nivel, 'VERDE');
});

test('construirReporte: ordena, suma errores internos del test y NO incluye el host', () => {
  const rep = R.construirReporte({
    meta: META, plan: {}, contadores: null, topErrores: [],
    escenarios: [{ id: 'A', nombre: 'x', hallazgos: [hz('A-1', 'BAJA'), hz('A-2', 'ALTA')] }],
    estatico: [hz('S-1', 'INFO', 'S')], globales: [hz('G-ESCRITURAS', 'CRITICA', 'G')],
    erroresInternos: [{ escenario: 'B', mensaje: 'TypeError: x' }],
  });
  assert.deepEqual(rep.hallazgos.map((h) => h.id), ['G-ESCRITURAS', 'A-2', 'X-ERROR-DEL-TEST', 'A-1', 'S-1']);
  assert.deepEqual(rep.porSeveridad, { CRITICA: 1, ALTA: 2, BAJA: 1, INFO: 1 });
  assert.equal(rep.veredicto.nivel, 'ROJO');
  assert.equal(rep.version, 1);
  assert.match(rep.hallazgos.find((h) => h.id === 'X-ERROR-DEL-TEST').titulo, /escenario B: TypeError: x/);
  assert.ok(!('host' in rep.meta));
  assert.ok(!JSON.stringify(rep).includes('secreto'), 'el host no debe filtrarse a los archivos');

  const vacio = R.construirReporte({ meta: undefined, plan: null, escenarios: [] });
  assert.equal(vacio.veredicto.nivel, 'VERDE');
  assert.deepEqual(vacio.hallazgos, []);
});

test('celdaCsv neutraliza fórmulas de Excel y escapa comillas, comas y saltos de línea', () => {
  assert.equal(R.celdaCsv('=1+1'), "'=1+1");
  assert.equal(R.celdaCsv('+54911'), "'+54911");
  assert.equal(R.celdaCsv('-5'), "'-5");
  assert.equal(R.celdaCsv('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(R.celdaCsv('\tcmd'), "'\tcmd");
  assert.equal(R.celdaCsv('hola, mundo'), '"hola, mundo"');
  assert.equal(R.celdaCsv('dijo "hola"'), '"dijo ""hola"""');
  assert.equal(R.celdaCsv('=HYPERLINK("x","y")'), '"\'=HYPERLINK(""x"",""y"")"');
  assert.equal(R.celdaCsv('linea1\nlinea2'), '"linea1\nlinea2"');
  assert.equal(R.celdaCsv(null), '');
  assert.equal(R.celdaCsv(undefined), '');
  assert.equal(R.celdaCsv(0), '0');
});

test('csvHallazgos y csvTopicosA: con BOM, encabezado, una fila por ítem y celdas neutralizadas', () => {
  const rep = R.construirReporte({
    meta: META, plan: {}, estatico: [], globales: [],
    escenarios: [{ id: 'A', nombre: 'A', hallazgos: [hz('A-1', 'ALTA', 'A', { titulo: '=cmd|calc', detalle: 'con; punto y coma', evidencia: ['e1', 'e2'] })],
      porTema: [{ tema: '=SUM(1)', tipo: 'libre', nivel: 'libre', categoria: null, n: 3, entregas: 3, distintos: 1, pctModal: 100, claseModal: 'tema',
        rescates: 0, vacios: 0, errores: 0, erroresBusqueda: 0, transiciones: 0, ms: { p50: 10, p95: 20 }, violaciones: 0, modalTitulo: 'Nota, con coma' }] }],
  });
  const csv = R.csvHallazgos(rep);
  assert.ok(csv.startsWith('﻿severidad,escenario,id,titulo'));
  assert.equal(csv.trim().split('\n').length, 2);
  assert.ok(csv.includes("'=cmd|calc"));
  assert.ok(csv.includes('"con; punto y coma"'));
  assert.ok(csv.includes('e1 | e2'));

  const topicos = R.csvTopicosA(rep);
  assert.ok(topicos.startsWith('﻿tema,tipo,nivel'));
  assert.ok(topicos.includes("'=SUM(1)"));
  assert.ok(topicos.includes('"Nota, con coma"'));
  assert.equal(R.csvTopicosA({ escenarios: [] }).trim().split('\n').length, 1, 'sin escenario A solo queda el encabezado');
});

test('textoConsola: veredicto, parcial, contadores, evidencia acotada y recorte de la lista', () => {
  const rep = R.construirReporte({
    meta: { ...META, parcial: true, motivoParada: 'límite de 1 min alcanzado' }, plan: {}, contadores: CONTADORES,
    escenarios: [{ id: 'A', hallazgos: [hz('A-2', 'ALTA', 'A', { evidencia: ['e1', 'e2', 'e3'] })] }],
  });
  const txt = R.textoConsola(rep, ['/tmp/x/estres.json']);
  for (const frag of ['Veredicto: NARANJA', 'PARCIAL', 'límite de 1 min alcanzado', 'OpenAI: 3 chat + 4 embeddings (errores 429: 1)', '[A] titulo A-2', '· e1', '· e2', 'Archivos:', '/tmp/x/estres.json']) {
    assert.ok(txt.includes(frag), `falta "${frag}"`);
  }
  assert.ok(!txt.includes('· e3'), 'solo las 2 primeras evidencias en consola');

  const tranquilo = R.construirReporte({ meta: META, plan: {}, escenarios: [{ id: 'A', hallazgos: [hz('A-9', 'INFO')] }] });
  assert.ok(R.textoConsola(tranquilo).includes('(nada de severidad media o mayor)'));
  assert.ok(R.textoConsola(tranquilo).includes('Veredicto: VERDE'));

  const muchos = R.construirReporte({ meta: META, plan: {}, escenarios: [{ id: 'A', hallazgos: Array.from({ length: 20 }, (_, i) => hz(`A-${i}`, 'ALTA')) }] });
  assert.ok(R.textoConsola(muchos).includes('… y 5 más en el reporte.'));
});

test('guardarReporte escribe los 4 archivos (creando la carpeta) y el JSON se puede releer', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'estres-test-'));
  try {
    const rep = R.construirReporte({ meta: META, plan: {}, escenarios: [{ id: 'A', nombre: 'A', hallazgos: [hz('A-1', 'MEDIA')] }] });
    const dir = path.join(base, 'a', 'b');
    const archivos = R.guardarReporte(rep, dir, () => '<!doctype html><p>ok</p>');
    assert.deepEqual(Object.keys(archivos).sort(), ['hallazgos', 'html', 'json', 'topicos']);
    for (const f of Object.values(archivos)) assert.ok(fs.existsSync(f), f);
    assert.equal(JSON.parse(fs.readFileSync(archivos.json, 'utf8')).veredicto.nivel, 'AMARILLO');
    assert.ok(fs.readFileSync(archivos.hallazgos, 'utf8').startsWith('﻿'));
    assert.equal(fs.readFileSync(archivos.html, 'utf8'), '<!doctype html><p>ok</p>');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ================================================================= HTML
test('esc escapa lo peligroso', () => {
  assert.equal(esc('<script>alert("x")</script> & \'y\''), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});

test('htmlReporte: ningún texto dinámico (tópicos, títulos, errores, metadatos) puede inyectar HTML', () => {
  const MALO = '<script>alert(1)</script>';
  const IMG = '<img src=x onerror=alert(1)>';
  const rep = R.construirReporte({
    meta: { ...META, nivel: MALO, commit: IMG, motivoParada: MALO, parcial: true }, plan: {},
    topErrores: [{ mensaje: MALO, veces: 1 }],
    escenarios: [{
      id: 'A', nombre: MALO, parcial: true,
      hallazgos: [hz('A-1', 'ALTA', 'A', { titulo: MALO, detalle: IMG, evidencia: [MALO], sugerencia: IMG })],
      resumen: { llamadas: 1, topicos: 1, pctEstables: 0, ms: { p95: 1 }, clases: {} },
      porTema: [{ tema: IMG, tipo: 'libre', n: 1, distintos: 2, transiciones: 2, claseModal: 'tema', rescates: 0, vacios: 0, errores: 1, violaciones: 0, ms: { p95: 5 }, modalTitulo: MALO }],
    }],
  });
  const html = htmlReporte(rep);
  assert.match(html, /^<!doctype html>/);
  assert.ok(!html.includes('<script'), 'no debe haber ninguna etiqueta <script>');
  assert.ok(!html.includes('<img'), 'ni <img>');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

// ================================================================= plan
test('planificar: totales = suma de escenarios; el soak solo cuenta si hay minutos', () => {
  const nivel = nivelChico();
  const plan = planificar(nivel, { oficiales: 7, libres: 6, usuarios: 1, hostiles: 10 });
  assert.deepEqual(Object.keys(plan.porEscenario), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(plan.porEscenario.A.picks, 39);
  const suma = (campo) => Object.values(plan.porEscenario).reduce((a, e) => a + (e[campo] || 0), 0);
  assert.equal(plan.totales.picks, suma('picks'));
  assert.equal(plan.totales.digests, suma('digests'));
  assert.equal(plan.totales.busquedas, suma('busquedas'));
  assert.ok(plan.totales.embeddingsEst >= plan.totales.busquedas);
  assert.ok(plan.totales.agregacionesAtlasEst >= 2 * plan.totales.busquedas);
  assert.deepEqual(plan.limites, { maxOpenAI: nivel.maxOpenAI, maxMinutos: nivel.maxMinutos });

  const conSoak = planificar(nivelChico({ F: { minutos: 2 } }), { oficiales: 7, libres: 6, usuarios: 1, hostiles: 10 });
  assert.equal(conSoak.porEscenario.F.picks, 240, '2 min · 60 / 1,5 s · 3 en paralelo');
  assert.ok(conSoak.totales.picks > plan.totales.picks);

  assert.deepEqual(Object.keys(planificar(nivel, { oficiales: 7, libres: 6, usuarios: 1, hostiles: 10, escenarios: ['A', 'C'] }).porEscenario), ['A', 'C']);
  assert.equal(planificar(nivel, { oficiales: 7, libres: 6, usuarios: 0, hostiles: 10 }).porEscenario.D.digests, 0);
});

test('textoPlan menciona el nivel, el tope de OpenAI y una línea por escenario', () => {
  const nivel = nivelChico();
  const txt = textoPlan(nivel, planificar(nivel, { oficiales: 7, libres: 6, usuarios: 1, hostiles: 10 }));
  assert.ok(txt.includes(`Plan · nivel ${nivel.nombre}`));
  assert.ok(txt.includes(`Tope de llamadas a OpenAI: ${nivel.maxOpenAI}`));
  for (const id of ['A', 'B', 'C', 'D', 'E']) assert.match(txt, new RegExp(`^  ${id}  `, 'm'));
  assert.ok(!/^  F  /m.test(txt));
  // Es lo primero que ve la persona con --dry-run: ninguna celda puede salir vacía ("undefined" en digests de A/B/C/E).
  assert.doesNotMatch(txt, /undefined|NaN|null|\[object/);
  assert.match(txt, /^  A +\d+ +0 +\d+ +\d+ min$/m, 'los escenarios sin digests muestran 0');
  const conSoak = textoPlan(nivelChico({ F: { minutos: 1 } }), planificar(nivelChico({ F: { minutos: 1 } }), { oficiales: 7, libres: 6, usuarios: 1, hostiles: 10 }));
  assert.match(conSoak, /^  F +\d+ +0 +\d+ +\d+ min$/m);
  assert.doesNotMatch(conSoak, /undefined|NaN|null|\[object/);
});

// ================================================================= URI y timeouts
test('describirUri: devuelve host y base y NUNCA usuario ni contraseña', () => {
  const d = describirUri('mongodb+srv://miusuario:clavesecreta@cluster0.abcde.mongodb.net/3minutos?retryWrites=true&w=majority');
  assert.deepEqual(d, { esquema: 'mongodb+srv', host: 'cluster0.abcde.mongodb.net', base: '3minutos' });
  assert.ok(!JSON.stringify(d).includes('miusuario') && !JSON.stringify(d).includes('clavesecreta'));

  assert.deepEqual(describirUri('mongodb://localhost:27017'), { esquema: 'mongodb', host: 'localhost', base: null });
  const roto = describirUri('esto no es una uri con clave=secreta');
  assert.deepEqual(roto, { esquema: null, host: '(no se pudo leer la URI)', base: null });
  assert.equal(describirUri(undefined).host, '(no se pudo leer la URI)');

  const multi = describirUri('mongodb://usr:clave2@h1:27017,h2:27017/db?replicaSet=rs');
  assert.ok(!JSON.stringify(multi).includes('clave2'), 'una URI con varios hosts tampoco filtra la clave');
});

test('conTimeout: resuelve, propaga errores y corta lo que tarda de más', async () => {
  assert.equal(await conTimeout(Promise.resolve(5), 1000), 5);
  await assert.rejects(conTimeout(Promise.reject(new Error('x')), 1000), /^Error: x$/);
  await assert.rejects(conTimeout(new Promise(() => {}), 20), /timeout de 20 ms/);
});
