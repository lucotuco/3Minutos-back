'use strict';

/**
 * Escenario B - Sesiones de usuario simulado, con historial.
 * Reproduce lo que hace producción: cada "refresco" excluye las últimas 30 notas vistas.
 *   B1: un tópico, N rondas seguidas (¿se repite alguna nota? ¿cuándo se agota el tópico?).
 *   B2: un usuario de 3 tópicos, N rondas (¿vuelven notas cuando se pasa de la ventana de 30?
 *       ¿se entregan notas "casi iguales"?). Si hay embeddings reales en Mongo, se leen (solo
 *       lectura) para medir duplicados semánticos aunque el filtro de producción no corra.
 * El historial vive en memoria: no se escribe nada en user_shown_articles.
 */

const { CONTRATO } = require('../config');
const { analizarSesiones } = require('../analisis_ab');
const { muestrear } = require('../estadisticas');
const { verificarLlamada } = require('../invariantes');
const { pool, progreso, filaDeUnTopico, resultadosCompactos, clasificarTema, completar } = require('./util');

const ID = 'B';
const NOMBRE = 'Sesiones con historial (repetidos)';

async function rondasDeTema(ctx, tema, rondas, tick) {
  const vistas = [];
  const filas = [];
  for (let ronda = 1; ronda <= rondas; ronda++) {
    if (ctx.detener()) break;
    const ventana = vistas.slice(-CONTRATO.ventanaHistorial);
    const salida = await ctx.pick([tema.tema], { alreadyShownUrls: ventana });
    const fila = filaDeUnTopico({
      salida,
      topic: tema.tema,
      esperado: { tipo: tema.tipo, categoria: tema.categoria },
      historial: new Set(ventana),
      extra: { tema: tema.tema, tipo: tema.tipo, categoria: tema.categoria, ronda },
    });
    filas.push(fila);
    if (fila.art?.url) vistas.push(fila.art.url);
    tick();
  }
  return filas;
}

async function rondasDeSesion(ctx, sesion, topics, rondas, tick) {
  const entregadas = []; // URLs en orden de entrega
  const primeraRonda = new Map();
  const esperados = topics.map((t) => clasificarTema(t));
  const filas = [];
  for (let ronda = 1; ronda <= rondas; ronda++) {
    if (ctx.detener()) break;
    const ventana = entregadas.slice(-CONTRATO.ventanaHistorial);
    const enVentana = new Set(ventana);
    const salida = await ctx.pick(topics, { alreadyShownUrls: ventana });
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
    for (const x of resultados) if (x.art?.url) entregadas.push(x.art.url);
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

  erroresInternos.push(...await pool(elegidos, nivel.concurrencia, async (tema) => {
    rondasTema.push(...await rondasDeTema(ctx, tema, nivel.B.rondas, tick));
  }, ctx.detener));
  erroresInternos.push(...await pool(trios, nivel.concurrencia, async (topics, i) => {
    sesiones.push(...await rondasDeSesion(ctx, i + 1, topics, nivel.B.rondasSesion, tick));
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
