'use strict';

/**
 * Instrumentos del test de estrés: contadores de OpenAI y de Mongo, bloqueo de escrituras,
 * captura de logs por llamada, lag del event loop y memoria.
 *
 * No hace require de mongoose ni de openai: recibe los objetos por parámetro, así se puede
 * probar con falsos. Lo que escribe en Mongo está bloqueado (ver bloquearEscrituras).
 */

const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const { mb } = require('./estadisticas');

const CAP_MUESTRAS = 50000;

function guardarMuestra(arr, valor) {
  if (arr.length < CAP_MUESTRAS) arr.push(valor);
  else arr[Math.floor(Math.random() * CAP_MUESTRAS)] = valor;
}

const contadorOpenAI = () => ({
  llamadas: 0, ok: 0, err429: 0, err5xx: 0, errTimeout: 0, errOtros: 0, bloqueadas: 0, ms: [], unicos: new Set(),
});

function crearContadores() {
  return {
    openai: { chat: contadorOpenAI(), embeddings: contadorOpenAI() },
    mongo: { comandos: 0, fallos: 0, escrituras: 0, bloqueadas: 0, checkOutFallidos: 0, porComando: {}, ms: [], ejemplosEscritura: [] },
    errores: new Map(),
  };
}

function normalizarMensaje(texto) {
  return String(texto || '').split('\n')[0].replace(/[0-9a-f]{24}/gi, '<id>').replace(/\d+/g, '#').trim().slice(0, 200);
}

function anotarError(contadores, origen, mensaje) {
  const k = `${origen}: ${normalizarMensaje(mensaje)}`;
  if (!contadores.errores.has(k) && contadores.errores.size >= 200) return;
  contadores.errores.set(k, (contadores.errores.get(k) || 0) + 1);
}

const topErrores = (contadores, n = 15) =>
  [...contadores.errores].sort((a, b) => b[1] - a[1]).slice(0, n).map(([mensaje, veces]) => ({ mensaje, veces }));

function clasificarErrorOpenAI(e) {
  const status = e?.status;
  if (status === 429) return 'err429';
  if (status >= 500 && status < 600) return 'err5xx';
  // El SDK real devuelve name='Error' y distingue los tipos por la clase (APIConnectionError, ...) y por e.cause.
  const texto = `${e?.constructor?.name || ''} ${e?.name || ''} ${e?.code || ''} ${e?.message || ''} ${e?.cause?.code || ''} ${e?.cause?.message || ''}`;
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|connection error|APIConnection/i.test(texto)) return 'errTimeout';
  return 'errOtros';
}

function crearPresupuesto(max) {
  let usado = 0;
  return { max, gastar: () => { usado++; }, usado: () => usado, restante: () => Math.max(0, max - usado), agotado: () => usado >= max };
}

/**
 * Decide cuándo parar: Ctrl+C, límite de minutos o presupuesto de OpenAI agotado.
 * Los escenarios lo consultan entre tareas (detener()) y devuelven resultados parciales.
 */
function crearControl({ maxMinutos = Infinity, presupuesto = null, ahora = Date.now } = {}) {
  const inicio = ahora();
  let motivo = null;
  return {
    detener() {
      if (motivo) return true;
      if ((ahora() - inicio) / 60000 >= maxMinutos) motivo = `límite de ${maxMinutos} min alcanzado`;
      else if (presupuesto && presupuesto.agotado()) motivo = 'presupuesto de llamadas a OpenAI agotado';
      return Boolean(motivo);
    },
    solicitar(m) { motivo = motivo || m; },
    motivo: () => motivo,
    transcurridoMs: () => ahora() - inicio,
  };
}

// ---------------------------------------------------------------- OpenAI
function envolverOpenAI(objetivo, metodo, tipo, contadores, presupuesto) {
  const original = objetivo[metodo].bind(objetivo);
  objetivo[metodo] = async (params, ...resto) => {
    const c = contadores.openai[tipo];
    if (presupuesto.agotado()) {
      c.bloqueadas++;
      const e = new Error('Presupuesto de llamadas a OpenAI del test agotado (--max-openai)');
      e.code = 'ESTRES_PRESUPUESTO';
      throw e;
    }
    presupuesto.gastar();
    c.llamadas++;
    if (tipo === 'embeddings' && c.unicos.size < 200000) c.unicos.add(String(params?.input));
    const t0 = performance.now();
    try {
      const respuesta = await original(params, ...resto);
      c.ok++;
      guardarMuestra(c.ms, performance.now() - t0);
      return respuesta;
    } catch (e) {
      c[clasificarErrorOpenAI(e)]++;
      guardarMuestra(c.ms, performance.now() - t0);
      const mensaje = String(e?.message || e);
      anotarError(contadores, `openai.${tipo}`, e?.status && !mensaje.startsWith(String(e.status)) ? `${e.status} ${mensaje}` : mensaje);
      throw e;
    }
  };
}

/** Cuenta (y limita) las llamadas reales a OpenAI. Se instala ANTES de la caché de disco, si la hay. */
function instrumentarOpenAI(cfg, contadores, presupuesto) {
  if (cfg.openaiReview?.chat?.completions) envolverOpenAI(cfg.openaiReview.chat.completions, 'create', 'chat', contadores, presupuesto);
  if (cfg.openaiEmbeddings?.embeddings) envolverOpenAI(cfg.openaiEmbeddings.embeddings, 'create', 'embeddings', contadores, presupuesto);
}

// ---------------------------------------------------------------- Mongo
const COMANDOS_DE_ESCRITURA = new Set([
  'insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'dropIndexes', 'drop', 'dropDatabase',
  'create', 'collMod', 'renameCollection',
]);

const esEscritura = (e) =>
  COMANDOS_DE_ESCRITURA.has(e.commandName) ||
  (e.commandName === 'aggregate' && Array.isArray(e.command?.pipeline) && e.command.pipeline.some((s) => s && (s.$out || s.$merge)));

/** Escucha los comandos de Mongo (la conexión debe abrirse con monitorCommands: true). */
function monitorearMongo(client, contadores) {
  const m = contadores.mongo;
  client.on('commandStarted', (e) => {
    m.comandos++;
    m.porComando[e.commandName] = (m.porComando[e.commandName] || 0) + 1;
    if (esEscritura(e)) {
      m.escrituras++;
      if (m.ejemplosEscritura.length < 10) m.ejemplosEscritura.push(`${e.commandName} en ${e.databaseName}`);
    }
  });
  client.on('commandSucceeded', (e) => guardarMuestra(m.ms, e.duration));
  client.on('commandFailed', (e) => {
    m.fallos++;
    anotarError(contadores, `mongo.${e.commandName}`, e.failure?.message || e.failure);
  });
  client.on('connectionCheckOutFailed', (e) => {
    m.checkOutFallidos++;
    anotarError(contadores, 'mongo.pool', e.reason || 'connectionCheckOutFailed');
  });
}

const ESTATICOS_DE_ESCRITURA = [
  'create', 'insertMany', 'bulkWrite', 'bulkSave', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate',
  'findOneAndReplace', 'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete',
  'syncIndexes', 'createIndexes', 'ensureIndexes', 'createCollection',
];
const QUERY_DE_ESCRITURA = ['updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete'];

/** Cinturón y tirantes: cualquier escritura de mongoose en este proceso lanza un error. */
function bloquearEscrituras(mongoose, contadores) {
  const trampa = (nombre) => function bloqueado() {
    contadores.mongo.bloqueadas++;
    const e = new Error(`ESTRES: escritura bloqueada (${nombre}). El test de estrés es de solo lectura.`);
    e.code = 'ESTRES_ESCRITURA_BLOQUEADA';
    throw e;
  };
  for (const n of ESTATICOS_DE_ESCRITURA) if (typeof mongoose.Model[n] === 'function') mongoose.Model[n] = trampa(`Model.${n}`);
  for (const n of QUERY_DE_ESCRITURA) if (mongoose.Query?.prototype?.[n]) mongoose.Query.prototype[n] = trampa(`Query.${n}`);
  mongoose.Model.prototype.save = trampa('Model#save');
}

// ---------------------------------------------------------------- logs por llamada
function mensajeDe(args) {
  const err = args.find((a) => a instanceof Error);
  if (err) return `${err.name}: ${err.message}`;
  return typeof args[0] === 'string' ? args[0] : util.format(...args);
}

/**
 * El proyecto habla mucho por consola. Acá se captura por llamada (AsyncLocalStorage):
 * no se imprime nada, solo se cuentan las líneas que importan.
 */
function crearCaptura(contadores) {
  const almacen = new AsyncLocalStorage();
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const metodo of Object.keys(original)) {
    console[metodo] = (...args) => {
      const marca = almacen.getStore();
      if (!marca) { original[metodo].apply(console, args); return; }
      const texto = typeof args[0] === 'string' ? args[0] : '';
      marca.lineas++;
      if (/Error en busqueda semantica/.test(texto)) marca.errorBusqueda++;
      else if (/Error en rescate de emergencia/.test(texto)) marca.errorRescate++;
      else if (/CADUCIDAD/.test(texto)) marca.caducidad++;
      if (metodo === 'error' || /Fallo expansion IA/.test(texto)) anotarError(contadores, 'consola', mensajeDe(args));
    };
  }
  return {
    original,
    async correr(fn) {
      const logs = { lineas: 0, errorBusqueda: 0, errorRescate: 0, caducidad: 0 };
      try {
        return { r: await almacen.run(logs, fn), logs };
      } catch (e) {
        e.logs = logs;
        throw e;
      }
    },
    restaurar() { Object.assign(console, original); },
  };
}

// ---------------------------------------------------------------- lag y memoria
function crearMonitorLag(resolucionMs = 20) {
  const h = monitorEventLoopDelay({ resolution: resolucionMs });
  h.enable();
  return {
    /** Lag del event loop desde la última lectura (la resolución del temporizador ya está descontada). */
    leerYReiniciar() {
      const p99 = Number.isFinite(h.percentile(99)) ? h.percentile(99) / 1e6 : 0;
      const max = Number.isFinite(h.max) ? h.max / 1e6 : 0;
      h.reset();
      return { p99: Math.max(0, Math.round(p99 - resolucionMs)), max: Math.max(0, Math.round(max - resolucionMs)) };
    },
    detener() { h.disable(); },
  };
}

function memoria() {
  const m = process.memoryUsage();
  return { rssMB: mb(m.rss), heapMB: mb(m.heapUsed), externalMB: mb(m.external) };
}

// ---------------------------------------------------------------- snapshots
function snapshot(c) {
  const o = (x) => ({
    llamadas: x.llamadas, ok: x.ok, err429: x.err429, err5xx: x.err5xx, errTimeout: x.errTimeout, errOtros: x.errOtros,
    bloqueadas: x.bloqueadas, unicos: x.unicos.size,
  });
  const m = c.mongo;
  return {
    openai: { chat: o(c.openai.chat), embeddings: o(c.openai.embeddings) },
    mongo: {
      comandos: m.comandos, fallos: m.fallos, escrituras: m.escrituras, bloqueadas: m.bloqueadas, checkOutFallidos: m.checkOutFallidos,
      porComando: { ...m.porComando },
      // Texto (no lista): así `diferencia` lo deja pasar tal cual. Sirve para que G-ESCRITURAS diga QUÉ escribió.
      ejemplosEscritura: m.ejemplosEscritura.join('; '),
    },
  };
}

/** b - a para todo número anidado (las claves que faltan en a cuentan como 0). */
function diferencia(a, b) {
  if (typeof b === 'number') return b - (typeof a === 'number' ? a : 0);
  if (b && typeof b === 'object') return Object.fromEntries(Object.keys(b).map((k) => [k, diferencia(a?.[k], b[k])]));
  return b;
}

module.exports = {
  crearContadores, crearPresupuesto, crearControl, anotarError, topErrores, normalizarMensaje, clasificarErrorOpenAI,
  instrumentarOpenAI, monitorearMongo, bloquearEscrituras, esEscritura,
  crearCaptura, crearMonitorLag, memoria, snapshot, diferencia,
};
