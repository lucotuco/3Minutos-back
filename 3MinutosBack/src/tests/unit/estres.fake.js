'use strict';

/**
 * Entorno 100 % falso para probar el test de estrés SIN tocar Mongo ni OpenAI.
 * Imita lo justo de pickBestArticlePerTopic / buildDigestForUser (incluido el candado por usuario)
 * y deja inyectar fallas para comprobar que los escenarios las detectan:
 *
 *   ignorarHistorial        no excluye las URLs ya vistas                   → I7 / B-REAPARICION
 *   sinDedupe               no evita la misma nota dentro de una llamada    → I8
 *   mismaNotaParaTodos      todos los tópicos comparten el mismo pozo       → A-NOTA-REPETIDA, C-DEPENDE-DEL-ORDEN
 *   inestable               la nota alterna entre dos llamadas iguales      → A-FLAPPING
 *   errorBusquedaCada: n    cada n-ésima llamada de un tópico "falla" y cae al rescate
 *   errorBusquedaPara: [t]  esos tópicos siempre fallan la búsqueda
 *   lanzarPara: [t]         pick devuelve error si el tópico está en la lista (admite null)
 *   casiDuplicados          del 2.º resultado en adelante, copias casi iguales del 1.º
 *   candadoRoto / candadoNoLibera   el candado de digest no agrupa / no se libera
 *   msPorConcurrente(c)     latencia simulada según cuántas llamadas hay a la vez
 *   vectores(ids)           embeddings "reales" (Map id → vector) o lanza para simular un fallo
 *   memoria()               lectura de memoria simulada (para el soak)
 *   alBuscar(contadores)    se llama por cada tópico buscado; sirve para tocar contadores
 *   lagP99                  lag del event loop simulado
 *
 * La latencia que informa es SINTÉTICA (5 ms + lo que pida msPorConcurrente): así los tests no
 * dependen del reloj ni de qué tan cargada esté la máquina.
 */

const { norm } = require('../comparar/utilidades');
const { temasOficiales } = require('../comparar/temas');
const { NIVELES } = require('../estres/config');
const { mulberry32 } = require('../estres/estadisticas');
const { crearContadores, snapshot } = require('../estres/instrumentos');

const OFICIALES = new Map(temasOficiales().map((t) => [norm(t.tema), t]));
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
const HORA = 3600e3;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nivel diminuto pero con la misma forma que los reales. */
function nivelChico(sobre = {}) {
  const base = JSON.parse(JSON.stringify(NIVELES.suave));
  Object.assign(base, {
    libres: 6, concurrencia: 3, timeoutS: 5, maxMinutos: 5, maxOpenAI: 100000,
    A: { repeticiones: 3 },
    B: { temas: 4, rondas: 3, sesiones: 2, rondasSesion: 3 },
    C: { triplas: 4, repeticiones: 2, permutar: true },
    D: { rampa: [1, 2, 4], tareasMin: 4, tareasPorWorker: 1, mega: 8, lock: 4, stampede: 5 },
    E: { hostiles: 'todos', variantes: 2, repeticiones: 1 },
    F: { minutos: 0 },
  });
  return { ...base, ...sobre };
}

function crearFalso({ nivel = nivelChico(), fallas = {}, usuarios = 6, articulosPorTema = 8, control = null } = {}) {
  const llamadas = { pick: 0, digest: 0, digestEjecutados: 0, topicosBuscados: 0 };
  const ahora0 = Date.now();
  const contadores = crearContadores();
  const activas = new Map(); // candado falso de digest, por usuario
  const nLlamadaPorTema = new Map();
  let lecturasUsuario = 0;
  let enCurso = 0;

  const libres = ['river plate', 'boca juniors', 'milei', 'dólar blue', 'nvidia', 'colapinto'].slice(0, nivel.libres)
    .map((tema, i) => ({ tema, tipo: 'libre', nivel: 'libre', categoria: null, usuarios: 10 - i }));
  const todosOficiales = [...OFICIALES.values()];
  const oficiales = nivel.oficiales === 'categorias' ? todosOficiales.filter((t) => t.nivel === 'categoria') : todosOficiales;

  // Cada título lleva palabras únicas por (tópico, posición): así dos notas distintas nunca parecen "la misma historia".
  const articulosDe = (clave, categoria) => {
    const compacto = slug(clave).replace(/-/g, '');
    return Array.from({ length: articulosPorTema }, (_, i) => ({
      _id: `${slug(clave)}-${i}`, url: `https://ejemplo.test/${slug(clave)}/${i}`,
      title: `${clave} suceso${i}${compacto} detalle${i}${compacto}`,
      rawSummary: `resumen sobre ${clave}`, tags: [clave], category: categoria, topic: null, sourceName: 'Fuente',
      publishedAt: new Date(ahora0 - Math.min(i + 1, 40) * HORA), score: 0.97 - i * 0.001, finalScore: 80 - i,
    }));
  };
  const categoriaDe = (t) => (OFICIALES.get(norm(t))?.categoria) || 'Deportes';

  async function resolver(topics, opts = {}) {
    enCurso++;
    try {
      await espera(fallas.esperaMs ?? 1); // cede el control: las llamadas "paralelas" de verdad se solapan
      const concurrentes = enCurso;
      const ms = 5 + (fallas.msPorConcurrente ? fallas.msPorConcurrente(concurrentes) : 0);
      if ((fallas.lanzarPara || []).some((x) => (topics || []).includes(x))) {
        return { resultados: null, ms: 1, error: 'explotó el pick', timeout: false, logs: null, ahora: Date.now() };
      }
      const historial = new Set(fallas.ignorarHistorial ? [] : opts.alreadyShownUrls || []);
      const enLlamada = new Set();
      const bloqueada = (a) => historial.has(a.url) || (!fallas.sinDedupe && enLlamada.has(a.url));
      const resultados = [];
      for (const raw of topics || []) {
        const t = String(raw ?? '').trim();
        if (!t) continue;
        llamadas.topicosBuscados++;
        if (fallas.alBuscar) fallas.alBuscar(contadores);
        const oficial = OFICIALES.get(norm(t));
        const categoria = categoriaDe(t);
        const n = (nLlamadaPorTema.get(t) || 0) + 1;
        nLlamadaPorTema.set(t, n);

        const falloBusqueda = (fallas.errorBusquedaCada && n % fallas.errorBusquedaCada === 0) || (fallas.errorBusquedaPara || []).includes(t);
        let art = null;
        if (!falloBusqueda) {
          let lista = articulosDe(fallas.mismaNotaParaTodos ? 'comun' : t, categoria).filter((a) => !bloqueada(a));
          if (fallas.inestable) lista = lista.slice(n % 2);
          art = lista[0] || null;
          const primero = resultados[0]?.article;
          if (fallas.casiDuplicados && primero) {
            art = { ...primero, _id: `${primero._id}-bis${resultados.length}`, url: `${primero.url}?bis${resultados.length}`, title: `${primero.title} (bis)` };
          }
        }
        let usedFallback = false;
        let motivo = null;
        if (!art) {
          motivo = falloBusqueda ? 'error_busqueda' : 'ningun_candidato_valido';
          art = articulosDe(`rescate ${categoria}`, categoria).filter((a) => !bloqueada(a))[0] || null;
          usedFallback = Boolean(art);
        }
        if (art) enLlamada.add(art.url);
        resultados.push({
          topic: oficial ? oficial.tema : t, queryExpanded: t, article: art, usedFallback, fallbackCategory: usedFallback ? categoria : null,
          matchZone: art ? (usedFallback ? 'RESCATE' : 'VERDE') : null, matchScore: art && !usedFallback ? art.score : null,
          matchReason: motivo || `VERDE score=${art ? art.score.toFixed(3) : ''} (candidato #1)`,
          corralCategory: oficial ? categoria : null, candidatesEvaluated: art ? 1 : 0,
        });
      }
      return { resultados, ms, error: null, timeout: false, logs: { lineas: 0, errorBusqueda: 0, errorRescate: 0, caducidad: 0 }, ahora: Date.now() };
    } finally {
      enCurso--;
    }
  }

  const pick = (topics, opts) => { llamadas.pick++; return resolver(topics, opts); };

  const usuariosFalsos = Array.from({ length: usuarios }, (_, i) => ({
    id: `u${i}`, topics: [libres[i % libres.length].tema, 'Fútbol', 'Deportes'],
  }));

  async function digest(userId) {
    llamadas.digest++;
    const clave = String(userId);
    const existente = fallas.candadoRoto ? null : activas.get(clave);
    if (existente) return existente;
    const trabajo = (async () => {
      lecturasUsuario++;
      llamadas.digestEjecutados++;
      await espera(3);
      const u = usuariosFalsos.find((x) => x.id === clave);
      if (!u) return { ok: false, items: [], resultado: null, ms: 8, error: 'User not found or inactive', timeout: false, logs: null };
      const s = await resolver(u.topics);
      const items = s.resultados.filter((r) => r.article).map((r) => ({
        topic: r.topic, queryExpanded: r.queryExpanded, articleId: String(r.article._id), originalTitle: r.article.title, title: r.article.title,
        url: r.article.url, category: r.article.category, section: null, tags: r.article.tags, publishedAt: r.article.publishedAt,
        score: r.article.score, finalScore: r.article.finalScore, usedFallback: r.usedFallback, fallbackCategory: r.fallbackCategory,
        matchZone: r.matchZone, matchScore: r.matchScore, matchReason: r.matchReason, corralCategory: r.corralCategory, candidatesEvaluated: r.candidatesEvaluated,
      }));
      return { ok: true, items, resultado: { user: { id: clave }, digest: { items } }, ms: s.ms + 3, error: null, timeout: false, logs: null };
    })();
    if (!fallas.candadoRoto) {
      activas.set(clave, trabajo);
      if (!fallas.candadoNoLibera) trabajo.finally(() => activas.delete(clave)).catch(() => {});
    }
    return trabajo;
  }

  const ctx = {
    nivel, args: {}, rng: mulberry32(7), contadores, log: () => {},
    meta: {
      baseConectada: 'falsa', host: 'host.falso', commit: 'abc1234', rama: 'rama-falsa', node: process.version,
      articulos48h: 123, usuariosActivosLeidos: usuarios, origenLibres: 'falso', cacheOpenAI: false,
    },
    temas: { oficiales, libres, origenLibres: 'falso' },
    usuarios: usuariosFalsos, tieneDigest: true, motivoSinDigest: null,
    pick, digest,
    embeddings: async (ids) => (fallas.vectores ? fallas.vectores(ids) : new Map()),
    lecturasUsuario: () => lecturasUsuario,
    idUsuarioInexistente: () => `fantasma-${Math.random().toString(36).slice(2)}`,
    contar: () => snapshot(contadores),
    memoria: fallas.memoria || (() => ({ rssMB: 100, heapMB: 50, externalMB: 1 })),
    lag: { leerYReiniciar: () => ({ p99: fallas.lagP99 ?? 1, max: 2 }), detener: () => {} },
    detener: () => (control ? control.detener() : false),
    control, presupuesto: { usado: () => 0, max: nivel.maxOpenAI },
  };
  return { ctx, llamadas, articulosDe, cerrar: async () => {} };
}

module.exports = { crearFalso, nivelChico, OFICIALES };
