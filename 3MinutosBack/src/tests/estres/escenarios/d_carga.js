'use strict';

/**
 * Escenario D - Carga y concurrencia.
 *   D1  rampa de llamadas a pickBestArticlePerTopic con 1, 2, 4, … N en paralelo.
 *   D2  rampa de digests completos (buildDigestForUser real, con curación y log simulados) con
 *       usuarios reales: latencia, errores y cuántos digests por minuto salen.
 *   D3  candado de buildDigestForUser: K pedidos simultáneos del MISMO usuario deben ser 1
 *       ejecución, y el candado debe liberarse después de un error.
 *   D4  ráfaga de K pedidos simultáneos con el mismo tópico nuevo (¿cuántas expansiones paga?).
 *   D5  una sola llamada con muchísimos tópicos (ráfaga de expansiones, tiempo secuencial).
 * Mide latencias, errores por clase (429, 5xx, timeouts, pool de Mongo), lag del event loop y
 * memoria por escalón, y corta la rampa en el primer escalón que se quiebra.
 */

const { CONTRATO, CALENTAMIENTO_TOPICOS, tareasEscalon } = require('../config');
const { muestrear, resumenLatencias } = require('../estadisticas');
const { diferencia } = require('../instrumentos');
const { analizarCarga, evaluarPaso } = require('../analisis_d');
const { verificarLlamada } = require('../invariantes');
const { pool, filaDeUnTopico, violacionesDeDigest, clasificarTema, completar } = require('./util');

const ID = 'D';
const NOMBRE = 'Carga y concurrencia';

const suma = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);

const hacerPick = (ctx) => async (tema) => {
  const salida = await ctx.pick([tema.tema]);
  const f = filaDeUnTopico({ salida, topic: tema.tema, esperado: { tipo: tema.tipo, nivel: tema.nivel, categoria: tema.categoria } });
  return {
    ms: f.ms, error: f.error, timeout: f.timeout,
    rescates: f.clase === 'rescate' ? 1 : 0,
    vacios: f.clase === 'vacio' ? 1 : 0,
    erroresBusqueda: f.motivo === 'error_busqueda' ? 1 : 0,
    violaciones: f.violaciones,
  };
};

const hacerDigest = (ctx) => async (usuario) => {
  const s = await ctx.digest(usuario.id);
  const items = s.items || [];
  return {
    ms: s.ms, error: s.error, timeout: s.timeout,
    rescates: items.filter((i) => i.usedFallback).length,
    vacios: s.ok ? Math.max(0, CONTRATO.topicosPorUsuario - items.length) : 0,
    erroresBusqueda: items.filter((i) => i.matchReason === 'error_busqueda').length,
    violaciones: s.ok ? violacionesDeDigest(items) : [],
  };
};

async function ejecutarPaso(ctx, c, items, hacer) {
  const antes = ctx.contar();
  ctx.lag.leerYReiniciar();
  const t0 = Date.now();
  const filas = [];
  const erroresInternos = await pool(items, c, async (item) => { filas.push(await hacer(item)); }, ctx.detener);
  const duracionMs = Date.now() - t0;
  const lag = ctx.lag.leerYReiniciar();
  const mem = ctx.memoria();
  return {
    c,
    tareas: filas.length,
    duracionMs,
    errores: filas.filter((f) => f.error && !f.timeout).length,
    timeouts: filas.filter((f) => f.timeout).length,
    erroresBusqueda: suma(filas, (f) => f.erroresBusqueda),
    rescates: suma(filas, (f) => f.rescates),
    vacios: suma(filas, (f) => f.vacios),
    ms: filas.map((f) => f.ms),
    violaciones: filas.flatMap((f) => f.violaciones || []),
    lagP99: lag.p99,
    rssMB: mem.rssMB,
    heapMB: mem.heapMB,
    delta: diferencia(antes, ctx.contar()),
    erroresInternos,
  };
}

async function rampa(ctx, { etiqueta, items, hacer, maxConcurrencia = Infinity }) {
  const { nivel } = ctx;
  const pasos = [];
  let baseP95 = null;
  for (const c of nivel.D.rampa) {
    if (ctx.detener()) break;
    if (c > maxConcurrencia) {
      ctx.log(`   D ${etiqueta}: se omite ${c} en paralelo (solo hay ${maxConcurrencia} usuarios distintos para que no se pisen)`);
      break;
    }
    const lista = Array.from({ length: tareasEscalon(nivel, c) }, (_, i) => items[i % items.length]);
    const paso = await ejecutarPaso(ctx, c, lista, hacer);
    pasos.push(paso);
    if (baseP95 === null) baseP95 = resumenLatencias(paso.ms).p95;
    const ev = evaluarPaso(paso, baseP95, nivel.timeoutS);
    ctx.log(`   D ${etiqueta}: ${c} en paralelo → ${ev.throughput ?? '–'} req/s · p95 ${ev.p95 ?? '–'} ms · errores ${Math.round(ev.tasaError * 100)} %` +
      `${ev.quiebra ? ` ⚠ ${ev.motivos.join(', ')}` : ''}`);
    if (ev.quiebra && !ctx.args['seguir-tras-quiebre']) {
      ctx.log(`   D ${etiqueta}: la rampa se detiene acá (usar --seguir-tras-quiebre para seguir subiendo)`);
      break;
    }
  }
  return pasos;
}

async function probarLock(ctx) {
  if (!ctx.tieneDigest) return { motivoOmitido: ctx.motivoSinDigest || 'buildDigestForUser no disponible' };
  if (!ctx.usuarios.length) return { motivoOmitido: 'no hay usuarios activos con 3 tópicos' };
  const K = ctx.nivel.D.lock;
  const llamar = (id) => Promise.all(Array.from({ length: K }, () => ctx.digest(id)));

  const l0 = ctx.lecturasUsuario();
  const mismas = await llamar(ctx.usuarios[0].id);
  const l1 = ctx.lecturasUsuario();
  const ok = mismas.filter((s) => s.ok);

  const fantasma = ctx.idUsuarioInexistente();
  const fallidas = await llamar(fantasma);
  const l2 = ctx.lecturasUsuario();
  await ctx.digest(fantasma); // ¿el candado se liberó? => tiene que volver a leer el usuario
  const l3 = ctx.lecturasUsuario();

  return {
    mismoUsuario: {
      llamadas: K, resueltas: ok.length, rechazadas: K - ok.length,
      mismosItems: ok.length > 0 && ok.every((s) => s.resultado === ok[0].resultado),
      lecturasUsuario: l1 - l0,
    },
    usuarioInexistente: {
      llamadas: K, resueltas: fallidas.filter((s) => s.ok).length, rechazadas: fallidas.filter((s) => !s.ok).length,
      lecturasUsuario: l2 - l1, reintento: { lecturasAntes: l2, lecturasDespues: l3 },
    },
  };
}

async function probarStampede(ctx) {
  const K = ctx.nivel.D.stampede;
  const nonce = Math.floor(ctx.rng() * 36 ** 5).toString(36).padStart(5, '0');
  const tema = `tema frio ${nonce}`; // 3 palabras: pasa por la expansión y nadie lo tiene en caché
  const antes = ctx.contar();
  const t0 = Date.now();
  const salidas = await Promise.all(Array.from({ length: K }, () => ctx.pick([tema])));
  const d = diferencia(antes, ctx.contar());
  return {
    concurrentes: K, tema, ms: Date.now() - t0,
    llamadasChat: d.openai.chat.llamadas, llamadasEmbedding: d.openai.embeddings.llamadas,
    errores: salidas.filter((s) => s.error).length,
  };
}

async function probarMega(ctx) {
  const n = ctx.nivel.D.mega;
  const reales = muestrear([...ctx.temas.libres, ...ctx.temas.oficiales].map((t) => t.tema), n, ctx.rng);
  const topics = completar(reales, n);
  const antes = ctx.contar();
  const salida = await ctx.pick(topics);
  const d = diferencia(antes, ctx.contar());
  const rs = salida.resultados || [];
  return {
    topics: n, ms: salida.ms, error: salida.error, timeout: salida.timeout,
    resultados: rs.length,
    rescates: rs.filter((r) => r.usedFallback).length,
    erroresBusqueda: rs.filter((r) => r.matchReason === 'error_busqueda').length,
    llamadasChat: d.openai.chat.llamadas,
    violaciones: salida.resultados
      ? verificarLlamada({ topics, resultados: salida.resultados, esperados: topics.map((t) => clasificarTema(t)), ahora: salida.ahora })
      : [],
  };
}

async function correr(ctx) {
  const { nivel } = ctx;
  const erroresInternos = [];
  const todos = [...ctx.temas.libres, ...ctx.temas.oficiales];
  const base = muestrear(todos, Math.min(CALENTAMIENTO_TOPICOS, todos.length), ctx.rng);

  ctx.log('   D1 rampa de tópicos: precalentando expansiones…');
  erroresInternos.push(...await pool(base, 4, (t) => ctx.pick([t.tema]), ctx.detener));
  const pasosPick = await rampa(ctx, { etiqueta: 'pick', items: base, hacer: hacerPick(ctx) });

  let pasosDigest = null;
  if (ctx.tieneDigest && ctx.usuarios.length && !ctx.detener()) {
    ctx.log('   D2 rampa de digests completos: precalentando…');
    erroresInternos.push(...await pool(ctx.usuarios.slice(0, nivel.D.tareasMin), 4, (u) => ctx.digest(u.id), ctx.detener));
    pasosDigest = await rampa(ctx, { etiqueta: 'digest', items: ctx.usuarios, hacer: hacerDigest(ctx), maxConcurrencia: ctx.usuarios.length });
  } else {
    ctx.log(`   D2 se omite: ${ctx.motivoSinDigest || 'no hay usuarios activos con 3 tópicos'}`);
  }

  let lock = null;
  let stampede = null;
  let mega = null;
  if (!ctx.detener()) { ctx.log('   D3 candado de buildDigestForUser…'); lock = await probarLock(ctx); }
  if (!ctx.detener()) { ctx.log('   D4 ráfaga sobre un tópico nuevo…'); stampede = await probarStampede(ctx); }
  if (!ctx.detener()) { ctx.log(`   D5 una llamada con ${nivel.D.mega} tópicos…`); mega = await probarMega(ctx); }

  const analisis = analizarCarga({ rampaPick: pasosPick, rampaDigest: pasosDigest, lock, stampede, mega }, { timeoutS: nivel.timeoutS });
  const todosPasos = [...pasosPick, ...(pasosDigest || [])];
  erroresInternos.push(...todosPasos.flatMap((p) => p.erroresInternos || []));
  return {
    id: ID, nombre: NOMBRE, parcial: ctx.detener(), erroresInternos,
    datos: { pasosPick: pasosPick.map(({ erroresInternos: _e, ...p }) => p), pasosDigest: pasosDigest && pasosDigest.map(({ erroresInternos: _e, ...p }) => p) },
    ...analisis,
  };
}

module.exports = { ID, NOMBRE, correr };
