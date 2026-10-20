'use strict';

/**
 * entorno.js - ÚNICO archivo del test de estrés que se conecta de verdad a Mongo y a OpenAI.
 * Arma el "ctx" que usan los escenarios. Garantías:
 *   - solo lectura: las escrituras de mongoose lanzan error y además se cuentan los comandos;
 *   - la curación de OpenAI y el DigestTestLog se SIMULAN (esos dos son los únicos puntos que
 *     escriben en buildDigestForUser); el resto del código es el real;
 *   - cada llamada real a OpenAI se cuenta y está limitada por --max-openai.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const { CONTRATO } = require('./config');
const { mulberry32 } = require('./estadisticas');
const { lista } = require('./args');
const inst = require('./instrumentos');
const { construirTemas } = require('../comparar/temas');
const { instalarCacheOpenAI } = require('../comparar/cache');

const SRC = path.resolve(__dirname, '..', '..');
const RAIZ = path.resolve(SRC, '..');

function conTimeout(promesa, ms) {
  let timer;
  const limite = new Promise((_, rechazar) => { timer = setTimeout(() => rechazar(new Error(`timeout de ${ms} ms`)), ms); });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(timer));
}

/** Host y base de la URI, SIN usuario ni contraseña. */
function describirUri(uri) {
  try {
    const u = new URL(String(uri));
    return { esquema: u.protocol.replace(':', ''), host: u.hostname, base: u.pathname.replace(/^\//, '') || null };
  } catch {
    return { esquema: null, host: '(no se pudo leer la URI)', base: null };
  }
}

const git = (...a) => {
  try { return execFileSync('git', ['-C', RAIZ, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};

/** Reemplaza generateNeutralCuration por una versión que no llama a OpenAI ni escribe en Article. */
function simularCuracion() {
  const ruta = require.resolve(path.join(SRC, 'curation', 'generateNeutralCuration'));
  const falso = new Module(ruta);
  falso.filename = ruta;
  falso.loaded = true;
  falso.exports = {
    generateNeutralCuration: async () => ({
      cached: true, fallback: false, neutralTitle: null, neutralLead: null, neutralSummary: null,
      neutralityScore: null, politicalBiasRisk: 'unknown',
    }),
  };
  require.cache[ruta] = falso;
}

async function crearEntorno({ nivel, args = {}, log = () => {}, presupuesto, control }) {
  const envPath = args.env ? path.resolve(args.env) : path.join(RAIZ, '.env');
  if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath, quiet: true });
  if (!process.env.MONGODB_URI) throw new Error(`Falta MONGODB_URI (busqué un .env en ${envPath})`);
  for (const k of ['OPENAI_API_KEY_EMBEDDINGS', 'OPENAI_API_KEY_REVIEW']) {
    if (!process.env[k]) throw new Error(`Falta ${k} en el .env`);
  }

  const mongoose = require('mongoose');
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  // Mismas opciones que server.js (serverSelectionTimeoutMS) + las que exige el solo-lectura.
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, autoIndex: false, monitorCommands: true });

  const contadores = inst.crearContadores();
  inst.monitorearMongo(mongoose.connection.getClient(), contadores);
  inst.bloquearEscrituras(mongoose, contadores);

  const cfg = require(path.join(SRC, 'config', 'openai'));
  inst.instrumentarOpenAI(cfg, contadores, presupuesto);
  if (args['cache-openai']) instalarCacheOpenAI(cfg, path.join(RAIZ, 'test-resultados', 'cache-estres'));

  const captura = inst.crearCaptura(contadores);
  const lag = inst.crearMonitorLag();
  const timeoutMs = nivel.timeoutS * 1000;

  const { pickBestArticlePerTopic } = require(path.join(SRC, 'utils', 'pickBestArticlePerTopic'));
  const Article = require(path.join(SRC, 'models', 'Article'));
  const UserPreference = require(path.join(SRC, 'models', 'UserPreference'));

  // ---- digest completo (buildDigestForUser real, con curación y log simulados)
  let digestFn = null;
  let motivoSinDigest = null;
  let lecturasUsuario = 0;
  if (args['sin-usuarios']) {
    motivoSinDigest = 'se pidió --sin-usuarios';
  } else {
    try {
      simularCuracion();
      const DigestTestLog = require(path.join(SRC, 'models', 'DigestTestLog'));
      DigestTestLog.create = async () => ({ simulado: true });
      const original = UserPreference.findById.bind(UserPreference);
      UserPreference.findById = (...a) => { lecturasUsuario++; return original(...a); };
      digestFn = require(path.join(SRC, 'utils', 'buildDigestForUser')).buildDigestForUser;
    } catch (e) {
      motivoSinDigest = `no se pudo preparar buildDigestForUser: ${e.message}`;
    }
  }

  async function pick(topics, opts = {}) {
    const t0 = Date.now();
    const base = { perTopicLimit: CONTRATO.perTopicLimit, alreadyShownUrls: [], seenEmbeddings: [] };
    try {
      const { r, logs } = await captura.correr(() => conTimeout(pickBestArticlePerTopic(topics, { ...base, ...opts }), timeoutMs));
      return { resultados: r, ms: Date.now() - t0, error: null, timeout: false, logs, ahora: Date.now() };
    } catch (e) {
      const error = e.message || String(e);
      return { resultados: null, ms: Date.now() - t0, error, timeout: /^timeout de/.test(error), logs: e.logs || null, ahora: Date.now() };
    }
  }

  async function digest(userId) {
    const t0 = Date.now();
    try {
      const { r, logs } = await captura.correr(() => conTimeout(digestFn(userId), timeoutMs));
      return { ok: true, items: r?.digest?.items || [], resultado: r, ms: Date.now() - t0, error: null, timeout: false, logs };
    } catch (e) {
      const error = e.message || String(e);
      return { ok: false, items: [], resultado: null, ms: Date.now() - t0, error, timeout: /^timeout de/.test(error), logs: e.logs || null };
    }
  }

  /** Embeddings reales de notas ya entregadas (lectura). Sirve para medir duplicados semánticos. */
  async function embeddings(ids) {
    const unicos = [...new Set((ids || []).filter(Boolean))].slice(0, 3000);
    const out = new Map();
    for (let i = 0; i < unicos.length; i += 100) {
      const docs = await Article.find({ _id: { $in: unicos.slice(i, i + 100) } }).select('embedding').lean().maxTimeMS(30000);
      for (const d of docs) if (Array.isArray(d.embedding) && d.embedding.length) out.set(String(d._id), d.embedding);
    }
    return out;
  }

  // ---- temas y usuarios (lectura)
  const t = await construirTemas({
    libresManual: lista(args['temas-libres']), archivoTemas: args['archivo-temas'], top: nivel.libres, rapido: false, UserPreference,
  });
  const oficiales = nivel.oficiales === 'categorias' ? t.oficiales.filter((x) => x.nivel === 'categoria') : t.oficiales;
  const libres = t.libres.slice(0, nivel.libres);

  let usuarios = [];
  if (!args['sin-usuarios']) {
    const filas = await UserPreference.find({ isActive: true }).select('_id topics').limit(300).lean().maxTimeMS(20000);
    usuarios = filas
      .filter((u) => Array.isArray(u.topics) && u.topics.length === CONTRATO.topicosPorUsuario)
      .map((u) => ({ id: String(u._id), topics: u.topics }));
  }

  // Cuántas notas hay para elegir: el motor solo mira las últimas 24 h (las de 48 h quedan como referencia).
  let articulos24h = null;
  let articulos48h = null;
  try { articulos24h = await Article.countDocuments({ publishedAt: { $gte: new Date(Date.now() - 24 * 36e5) } }).maxTimeMS(15000); } catch { /* informativo */ }
  try { articulos48h = await Article.countDocuments({ publishedAt: { $gte: new Date(Date.now() - 48 * 36e5) } }).maxTimeMS(15000); } catch { /* informativo */ }

  const meta = {
    ...describirUri(process.env.MONGODB_URI),
    baseConectada: mongoose.connection.name || null,
    commit: git('rev-parse', '--short', 'HEAD'),
    rama: git('rev-parse', '--abbrev-ref', 'HEAD'),
    node: process.version,
    articulos24h,
    articulos48h,
    usuariosActivosLeidos: usuarios.length,
    origenLibres: t.origenLibres,
    cacheOpenAI: Boolean(args['cache-openai']),
  };

  const ctx = {
    nivel, args, meta, log, control, presupuesto, contadores, lag,
    rng: mulberry32(Number(args.semilla) || 20260101),
    temas: { oficiales, libres, origenLibres: t.origenLibres },
    usuarios,
    tieneDigest: Boolean(digestFn),
    motivoSinDigest,
    pick, digest, embeddings,
    lecturasUsuario: () => lecturasUsuario,
    idUsuarioInexistente: () => String(new mongoose.Types.ObjectId()),
    contar: () => inst.snapshot(contadores),
    memoria: inst.memoria,
    detener: () => control.detener(),
  };

  async function cerrar() {
    lag.detener();
    captura.restaurar();
    await mongoose.disconnect().catch(() => {});
  }
  return { ctx, cerrar };
}

module.exports = { crearEntorno, describirUri, conTimeout };
