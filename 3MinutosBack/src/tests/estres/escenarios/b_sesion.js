'use strict';

/**
 * Escenario B - Sesiones de usuario simulado, con historial.
 * Reproduce lo que hace producción: cada "refresco" le pasa al motor lo que el usuario ya vio (las URLs y los
 * embeddings de hasta 150 notas de las últimas 48 h) para que no repita notas ni "la misma historia".
 *   B1: un tópico, N rondas seguidas (¿se repite alguna nota? ¿cuándo se agota el tópico?).
 *   B2: un usuario de 3 tópicos, N rondas (¿vuelven notas cuando se pasa del tope de 150? ¿se entregan notas
 *       "casi iguales"?). Si hay embeddings reales en Mongo, se leen (solo lectura) para pasárselos al motor y
 *       para medir duplicados semánticos.
 * El historial vive en memoria: no se escribe nada en user_shown_articles. Como la corrida dura minutos, la
 * ventana de 48 h nunca se vence: lo único que saca notas del historial es el tope de cantidad.
 */

const { CONTRATO } = require('../config');
const { analizarSesiones } = require('../analisis_ab');
const { muestrear } = require('../estadisticas');
const { verificarLlamada } = require('../invariantes');
const { pool, progreso, filaDeUnTopico, resultadosCompactos, clasificarTema, completar } = require('./util');

const ID = 'B';
const NOMBRE = 'Sesiones con historial (repetidos)';

/**
 * Embeddings (solo lectura) de las notas que el usuario simulado ya "vio", para pasárselos al motor como
 * lo hace producción (seenEmbeddings). Cada nota se pide una sola vez. Si no se pueden leer, el motor corre
 * solo con las URLs y se informa una vez.
 */
function crearLectorDeVistos(ctx, erroresInternos) {
  const cache = new Map(); // id -> vector | null (null = la nota no tiene embedding)
  let roto = false;
  return async function embeddingsDe(notas) {
    const faltan = [...new Set(notas.map((n) => n.id).filter((id) => id && !cache.has(id)))];
    if (faltan.length && !roto) {
      try {
        const leidos = await ctx.embeddings(faltan);
        for (const id of faltan) cache.set(id, (leidos && leidos.get(id)) || null);
      } catch (e) {
        roto = true;
        erroresInternos.push(`no se pudieron leer embeddings para pasarle al motor lo ya visto: ${e.message}`);
      }
    }
    return notas
      .map((n) => ({ title: n.titulo, vector: cache.get(n.id) }))
      .filter((x) => Array.isArray(x.vector) && x.vector.length > 0);
  };
}

const nota = (art) => ({ url: art.url, id: art.id, titulo: art.titulo });

async function rondasDeTema(ctx, tema, rondas, tick, embeddingsDe) {
  const vistas = []; // notas entregadas, en orden
  const filas = [];
  for (let ronda = 1; ronda <= rondas; ronda++) {
    if (ctx.detener()) break;
    const ventana = vistas.slice(-CONTRATO.ventanaHistorial);
    const urls = ventana.map((n) => n.url);
    const salida = await ctx.pick([tema.tema], { alreadyShownUrls: urls, seenEmbeddings: await embeddingsDe(ventana) });
    const fila = filaDeUnTopico({
      salida,
      topic: tema.tema,
      esperado: { tipo: tema.tipo, nivel: tema.nivel, categoria: tema.categoria },
      historial: new Set(urls),
      extra: { tema: tema.tema, tipo: tema.tipo, categoria: tema.categoria, ronda },
    });
    filas.push(fila);
    if (fila.art?.url) vistas.push(nota(fila.art));
    tick();
  }
  return filas;
}

async function rondasDeSesion(ctx, sesion, topics, rondas, tick, embeddingsDe) {
  const entregadas = []; // notas en orden de entrega
  const primeraRonda = new Map();
  const esperados = topics.map((t) => clasificarTema(t));
  const filas = [];
  for (let ronda = 1; ronda <= rondas; ronda++) {
    if (ctx.detener()) break;
    const ventana = entregadas.slice(-CONTRATO.ventanaHistorial);
    const urls = ventana.map((n) => n.url);
    const enVentana = new Set(urls);
    const salida = await ctx.pick(topics, { alreadyShownUrls: urls, seenEmbeddings: await embeddingsDe(ventana) });
    const resultados = resultadosCompactos(salida);

    const reaparecidas = [];
    for (const x of resultados) {
      const url = x.art?.url;
      if (!url) continue;
      // Si sigue dentro de la ventana, es una violación del invariante I7; acá solo se anotan las que ya salieron de ella.
      if (primeraRonda.has(url) && !enVentana.has(url)) reaparecidas.push({ url, titulo: x.art.titulo, rondaPrevia: primeraRonda.get(url), ronda });
      else if (!primeraRonda.has(url)) primeraRonda.set(url, ronda);
    }
    const violaciones = salida.resultados
      ? verificarLlamada({ topics, resultados: salida.resultados, esperados, historial: enVentana, ahora: salida.ahora })
      : [];
    filas.push({
      t: Date.now(), sesion, topics, ronda, ms: salida.ms, error: salida.error, timeout: salida.timeout,
      resultados, reaparecidas, violaciones, logs: salida.logs || null,
    });
    for (const x of resultados) if (x.art?.url) entregadas.push(nota(x.art));
    tick();
  }
  return filas;
}

/** Tríos de tópicos: usuarios reales primero (misma forma que producción) y, si faltan, mezclas al azar. */
function triosParaSesiones(ctx, n) {
  const reales = muestrear(ctx.usuarios, n, ctx.rng).map((u) => u.topics.slice(0, CONTRATO.topicosPorUsuario));
  const todos = [...ctx.temas.libres, ...ctx.temas.oficiales].map((t) => t.tema);
  const out = [...reales];
  while (out.length < n) out.push(completar(muestrear(todos, CONTRATO.topicosPorUsuario, ctx.rng), CONTRATO.topicosPorUsuario));
  return out;
}

async function correr(ctx) {
  const { nivel } = ctx;
  const todos = [...ctx.temas.libres, ...ctx.temas.oficiales];
  const elegidos = muestrear(todos, nivel.B.temas, ctx.rng);
  const trios = triosParaSesiones(ctx, nivel.B.sesiones);
  const total = elegidos.length * nivel.B.rondas + trios.length * nivel.B.rondasSesion;
  const tick = progreso(ctx, 'B sesiones', total);

  const rondasTema = [];
  const sesiones = [];
  const erroresInternos = [];
  const embeddingsDe = crearLectorDeVistos(ctx, erroresInternos);

  erroresInternos.push(...await pool(elegidos, nivel.concurrencia, async (tema) => {
    rondasTema.push(...await rondasDeTema(ctx, tema, nivel.B.rondas, tick, embeddingsDe));
  }, ctx.detener));
  erroresInternos.push(...await pool(trios, nivel.concurrencia, async (topics, i) => {
    sesiones.push(...await rondasDeSesion(ctx, i + 1, topics, nivel.B.rondasSesion, tick, embeddingsDe));
  }, ctx.detener));

  let vectores = null;
  try {
    const ids = sesiones.flatMap((s) => s.resultados.map((r) => r.art?.id)).filter(Boolean);
    vectores = ids.length ? await ctx.embeddings(ids) : null;
  } catch (e) {
    erroresInternos.push(`no se pudieron leer embeddings para medir duplicados semánticos: ${e.message}`);
  }

  const analisis = analizarSesiones({ rondasTema, sesiones, vectores });
  return {
    id: ID, nombre: NOMBRE, parcial: rondasTema.length + sesiones.length < total, llamadasPlaneadas: total,
    rondasTema, sesiones, erroresInternos, usoEmbeddingsReales: Boolean(vectores && vectores.size), ...analisis,
  };
}

module.exports = { ID, NOMBRE, correr, triosParaSesiones };
