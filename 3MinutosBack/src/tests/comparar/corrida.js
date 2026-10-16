'use strict';

/**
 * corrida.js  -  proceso hijo: corre UNA versión del código contra la base (SOLO LECTURA).
 *
 * Llama a pickBestArticlePerTopic() de la versión indicada, tema por tema, igual que lo hace
 * producción pero sin curación, sin DigestTestLog y sin historial del usuario:
 *   - no escribe en Mongo (autoIndex/autoCreate apagados),
 *   - OpenAI queda cacheado en disco para que las dos versiones vean lo mismo.
 *
 * Lo lanza cli.js; también se puede correr a mano:
 *   node src/tests/comparar/corrida.js --root <carpeta 3MinutosBack de esa versión> \
 *        --etiqueta despues --temas test-resultados/temas.json --salida test-resultados/despues.json
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const { execFileSync } = require('child_process');

const { parseArgs, norm, redondear } = require('./utilidades');
const { instalarCacheOpenAI } = require('./cache');
const { mencionaTema } = require('./metricas');

const PER_TOPIC_LIMIT = 10; // igual que buildUserNewsDigest (el motor nuevo busca perTopicLimit * 3 = 30; el anterior, * 2 = 20)
const UMBRAL_VERDE = 0.94;
const UMBRAL_AMARILLA = 0.8;

const PROMPT_JUEZ = [
  'Sos un evaluador estricto de relevancia periodística.',
  'Te doy un TEMA que eligió un usuario y una NOTICIA (título y resumen).',
  'Respondé con UNA sola palabra:',
  '- SI: la noticia trata directamente sobre ese tema (es protagonista o foco principal).',
  '- PARCIAL: el tema aparece mencionado pero no es el foco de la noticia.',
  '- NO: la noticia no tiene relación con el tema.',
  'Si el tema es una persona o un club, la noticia debe ser sobre esa persona o club (no sobre un rival que lo nombra de pasada).',
].join('\n');

const consolaOriginal = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};
const almacen = new AsyncLocalStorage();

/** Las funciones del proyecto hablan mucho por consola; se guardan por tema en vez de mezclarse. */
function capturarConsola() {
  for (const metodo of ['log', 'warn', 'error', 'info']) {
    console[metodo] = (...args) => {
      const lineas = almacen.getStore();
      if (lineas) lineas.push(util.format(...args));
      else consolaOriginal[metodo](...args);
    };
  }
}

const out = (texto) => process.stdout.write(`${texto}\n`);

function desde(root, modulo) {
  return require(require.resolve(modulo, { paths: [root] }));
}

function git(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function conTimeout(promesa, ms) {
  let timer;
  const limite = new Promise((_, rechazar) => {
    timer = setTimeout(() => rechazar(new Error(`timeout de ${ms} ms`)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(timer));
}

function zonaDeScore(score) {
  if (score >= UMBRAL_VERDE) return 'VERDE';
  if (score >= UMBRAL_AMARILLA) return 'AMARILLA';
  return null;
}

function armarRegistro(t, r, error, ms, logs) {
  const a = r?.article || null;
  const rescate = Boolean(r?.usedFallback);

  // La versión nueva informa la zona; la vieja no, así que se deriva (misma regla de umbrales).
  let zona = r?.matchZone ?? null;
  if (!zona && a) zona = rescate ? 'RESCATE' : zonaDeScore(a.score || 0);

  let articulo = null;
  if (a) {
    const cuerpo = `${a.title} ${a.rawSummary || ''} ${a.contentSnippet || ''} ${(a.tags || []).join(' ')}`;
    const publicada = a.publishedAt ? new Date(a.publishedAt) : null;
    articulo = {
      id: a._id ? String(a._id) : null,
      titulo: a.title || '',
      url: a.url || null,
      fuente: a.sourceName || null,
      categoria: a.category || null,
      subtema: a.topic || null,
      publicadaEn: publicada ? publicada.toISOString() : null,
      edadHoras: publicada ? redondear((Date.now() - publicada.getTime()) / 36e5) : null,
      score: typeof a.score === 'number' ? redondear(a.score, 3) : null,
      finalScore: typeof a.finalScore === 'number' ? redondear(a.finalScore, 1) : null,
      importancia: a.importanceScore ?? null,
      geoScope: a.geoScope || null,
      tags: (a.tags || []).slice(0, 8),
      resumen: String(a.rawSummary || a.contentSnippet || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      menciona: t.tipo === 'libre' ? mencionaTema(t.tema, cuerpo) : null,
      mencionaEnTitulo: t.tipo === 'libre' ? mencionaTema(t.tema, a.title || '') : null,
      categoriaOk: t.tipo === 'oficial' ? norm(a.category) === norm(t.categoria) : null,
      subtemaOk: t.tipo === 'oficial' ? norm(a.topic) === norm(t.tema) : null,
    };
  }

  return {
    tema: t.tema,
    tipo: t.tipo,
    nivel: t.nivel,
    categoriaEsperada: t.categoria || null,
    usuarios: t.usuarios ?? null,
    ms,
    error: error || null,
    consultaExpandida: r?.queryExpanded ?? null,
    entregada: Boolean(a),
    rescate,
    zona,
    // En un rescate el score es contra la consulta genérica del rescate, no contra el tema: no se informa.
    scoreBusqueda: rescate ? null : (r?.matchScore ?? articulo?.score ?? null),
    motivo: r ? (r.matchReason ?? null) : undefined,
    corral: r?.corralCategory ?? null,
    candidatosEvaluados: r?.candidatesEvaluated ?? null,
    categoriaRescate: r?.fallbackCategory ?? null,
    nivelNota: r?.tier ?? null, // buena | aceptable | sugerida (solo la versión nueva lo informa)
    articulo,
    juez: null,
    logs,
  };
}

async function juzgar(cfg, registro) {
  const a = registro.articulo;
  const respuesta = await cfg.openaiReview.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 4,
    messages: [
      { role: 'system', content: PROMPT_JUEZ },
      { role: 'user', content: `TEMA: ${registro.tema}\nTÍTULO: ${a.titulo}\nRESUMEN: ${a.resumen || '(sin resumen)'}` },
    ],
  });
  const texto = norm(respuesta?.choices?.[0]?.message?.content || '').replace(/[^a-z]/g, '');
  if (texto.startsWith('si')) return 'SI';
  if (texto.startsWith('parcial')) return 'PARCIAL';
  if (texto.startsWith('no')) return 'NO';
  return null;
}

async function pool(items, concurrencia, trabajo) {
  let siguiente = 0;
  const workers = Array.from({ length: Math.max(1, concurrencia) }, async () => {
    while (true) {
      const i = siguiente++;
      if (i >= items.length) return;
      await trabajo(items[i], i);
    }
  });
  await Promise.all(workers);
}

function verificarDigestTestLog(root, mongoose) {
  try {
    const DigestTestLog = require(path.join(root, 'src', 'models', 'DigestTestLog'));
    const doc = new DigestTestLog({
      idUsuario: new mongoose.Types.ObjectId(),
      noticias: [{
        topicoUsuario: 'prueba', titulo: 'prueba', usedFallback: true, fallbackCategory: 'Deportes',
        zona: 'AMARILLA', scoreBusqueda: 0.9, motivoMatch: 'prueba', corralCategoria: 'Deportes', candidatosEvaluados: 3,
      }],
    });
    const error = doc.validateSync();
    const n = doc.noticias[0] || {};
    return {
      validaOk: !error,
      guardaCamposNuevos: n.zona === 'AMARILLA' && n.scoreBusqueda === 0.9 && n.candidatosEvaluados === 3 &&
        n.corralCategoria === 'Deportes' && n.usedFallback === true,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  for (const requerido of ['root', 'etiqueta', 'temas', 'salida']) {
    if (!a[requerido]) throw new Error(`Falta --${requerido}`);
  }
  const root = path.resolve(a.root);
  if (!fs.existsSync(path.join(root, 'src', 'utils', 'pickBestArticlePerTopic.js'))) {
    throw new Error(`No encuentro src/utils/pickBestArticlePerTopic.js en ${root}`);
  }

  const conc = Number(a.concurrencia) || 4;
  const timeoutMs = (Number(a.timeout) || 90) * 1000;
  const dirCache = path.resolve(a.cache || path.join(path.dirname(path.resolve(a.salida)), 'cache'));
  const sinJuez = Boolean(a['sin-juez']);
  const temas = JSON.parse(fs.readFileSync(path.resolve(a.temas), 'utf8')).filter((t) => {
    if (a.solo === 'oficiales') return t.tipo === 'oficial';
    if (a.solo === 'libres') return t.tipo === 'libre';
    return true;
  });

  if (a.env && fs.existsSync(a.env)) desde(root, 'dotenv').config({ path: a.env, quiet: true });

  const mongoose = desde(root, 'mongoose');
  mongoose.set('autoIndex', false); // solo lectura: no crear índices
  mongoose.set('autoCreate', false);
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI (revisá tu .env)');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, autoIndex: false });

  const cfg = require(path.join(root, 'src', 'config', 'openai'));
  const caches = instalarCacheOpenAI(cfg, dirCache);
  const { pickBestArticlePerTopic } = require(path.join(root, 'src', 'utils', 'pickBestArticlePerTopic'));
  const Article = require(path.join(root, 'src', 'models', 'Article'));

  capturarConsola();

  const meta = {
    etiqueta: a.etiqueta,
    root,
    commit: git(root, 'rev-parse', '--short', 'HEAD'),
    rama: (() => { const r = git(root, 'rev-parse', '--abbrev-ref', 'HEAD'); return r === 'HEAD' ? 'commit fijo' : r; })(),
    ejecutadoEn: new Date().toISOString(),
    baseDeDatos: mongoose.connection.name || null,
    node: process.version,
    concurrencia: conc,
    perTopicLimit: PER_TOPIC_LIMIT,
    juez: !sinJuez,
    dbArticulos24h: null,
    dbArticulos48h: null,
    digestLog: null,
  };
  // La versión nueva solo mira las últimas 24 h; la anterior, 48 h: se cuentan las dos para poder medir la deriva de la base.
  for (const horas of [24, 48]) {
    try {
      meta[`dbArticulos${horas}h`] = await Article.countDocuments({ publishedAt: { $gte: new Date(Date.now() - horas * 36e5) } }).maxTimeMS(15000);
    } catch (e) {
      meta[`dbArticulos${horas}h`] = null;
    }
  }
  meta.digestLog = verificarDigestTestLog(root, mongoose);

  out(`▶ ${a.etiqueta}: ${temas.length} temas | commit ${meta.commit || '?'} (${meta.rama || '?'}) | base "${meta.baseDeDatos}" | notas 24 h: ${meta.dbArticulos24h ?? 'n/d'} (48 h: ${meta.dbArticulos48h ?? 'n/d'})`);

  const resultados = new Array(temas.length);
  let hechos = 0;
  const t0 = Date.now();

  await pool(temas, conc, async (t, i) => {
    const logs = [];
    const inicio = Date.now();
    let r = null;
    let error = null;
    await almacen.run(logs, async () => {
      try {
        const res = await conTimeout(
          pickBestArticlePerTopic([t.tema], { perTopicLimit: PER_TOPIC_LIMIT, alreadyShownUrls: [], alreadyShownTitles: [], seenEmbeddings: [] }),
          timeoutMs
        );
        r = Array.isArray(res) ? res[0] || null : null;
      } catch (e) {
        error = e.message;
      }
    });
    resultados[i] = armarRegistro(t, r, error, Date.now() - inicio, logs);
    hechos++;
    if (hechos % 10 === 0 || hechos === temas.length) {
      out(`   ${a.etiqueta}: ${hechos}/${temas.length} temas (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  });

  if (!sinJuez) {
    const aJuzgar = resultados.filter((r) => r.tipo === 'libre' && r.entregada && !r.rescate && r.articulo);
    out(`   ${a.etiqueta}: juzgando relevancia de ${aJuzgar.length} noticias de temas libres…`);
    await pool(aJuzgar, conc, async (r) => {
      try {
        r.juez = await juzgar(cfg, r);
      } catch (e) {
        r.juez = null;
        r.juezError = e.message;
      }
    });
  }

  fs.mkdirSync(path.dirname(path.resolve(a.salida)), { recursive: true });
  fs.writeFileSync(path.resolve(a.salida), JSON.stringify({ meta, resultados }, null, 2));

  out(`✔ ${a.etiqueta}: listo en ${Math.round((Date.now() - t0) / 1000)} s → ${path.resolve(a.salida)} ` +
      `(caché OpenAI: ${caches.chat.aciertos + caches.embeddings.aciertos} aciertos, ${caches.chat.fallos + caches.embeddings.fallos} llamadas nuevas)`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((error) => {
  consolaOriginal.error(`✖ ${error.stack || error.message}`);
  process.exit(1);
});
