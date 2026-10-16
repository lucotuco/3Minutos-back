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
 * Imita el contrato del motor nuevo:
 *   - temas OFICIALES: se leen por etiqueta (zona ETIQUETA, sin score); la categoría nunca rescata y un
 *     error de lectura deja el lugar vacío; el subtema rescata con una nota "sugerida" de su categoría;
 *   - temas LIBRES: búsqueda por significado (VERDE con score) y, si no hay nada, rescate "sugerido";
 *   - todas las notas tienen menos de 24 h y importancia >= 50 ("buena").
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

  // Edades repartidas entre 0,5 h y 22,5 h: todas vigentes (< 24 h) aunque el pozo tenga muchas notas.
  const edadDe = (i, total) => 0.5 + (22 * i) / Math.max(1, total - 1);
  const redondear = (n) => Math.round(n * 10) / 10;

  // Cada título lleva palabras únicas por (tópico, posición): así dos notas distintas nunca parecen "la misma historia".
  // Los temas oficiales se leen por etiqueta: sus notas no traen score de búsqueda (las de los temas libres sí).
  const articulosDe = (clave, categoria, { oficial = null, topic = null } = {}) => {
    const compacto = slug(clave).replace(/-/g, '');
    return Array.from({ length: articulosPorTema }, (_, i) => {
      const nota = {
        _id: `${slug(clave)}-${i}`, url: `https://ejemplo.test/${slug(clave)}/${i}`,
        title: `${clave} suceso${i}${compacto} detalle${i}${compacto}`,
        rawSummary: `resumen sobre ${clave}`, tags: [clave], category: categoria, topic, geoScope: 'Argentina', sourceName: 'Fuente',
        publishedAt: new Date(ahora0 - edadDe(i, articulosPorTema) * HORA), importanceScore: 55 + (i % 40),
      };
      if (!oficial) { nota.score = 0.97 - i * 0.001; nota.finalScore = 80 - i; }
      return nota;
    });
  };
  // Le da a una nota copiada la forma de su tipo de tópico (los oficiales no traen score; los libres sí).
  const conForma = (nota, oficial) => {
    const copia = { ...nota };
    if (oficial) { delete copia.score; delete copia.finalScore; } else { copia.score ??= 0.95; copia.finalScore ??= 70; }
    return copia;
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
        const subtema = Boolean(oficial) && oficial.nivel === 'subtema';
        const categoria = categoriaDe(t);
        const n = (nLlamadaPorTema.get(t) || 0) + 1;
        nLlamadaPorTema.set(t, n);

        const falloBusqueda = (fallas.errorBusquedaCada && n % fallas.errorBusquedaCada === 0) || (fallas.errorBusquedaPara || []).includes(t);
        let art = null;
        if (!falloBusqueda) {
          let lista = articulosDe(fallas.mismaNotaParaTodos ? 'comun' : t, categoria, { oficial, topic: subtema ? oficial.tema : null })
            .filter((a) => !bloqueada(a));
          if (fallas.inestable) lista = lista.slice(n % 2);
          art = lista[0] || null;
          const primero = resultados[0]?.article;
          if (fallas.casiDuplicados && primero) {
            art = conForma({ ...primero, _id: `${primero._id}-bis${resultados.length}`, url: `${primero.url}?bis${resultados.length}`, title: `${primero.title} (bis)` }, oficial);
          }
        }
        let usedFallback = false;
        let motivo = null;
        if (!art) {
          motivo = falloBusqueda ? 'error_busqueda' : 'ningun_candidato_valido';
          // Como el motor: la categoría oficial nunca rescata (cualquier nota suya ya vale) y un error de lectura de un
          // tema oficial deja el lugar vacío. El subtema y el tema libre rescatan con una nota "buena" de su categoría.
          const puedeRescatar = !oficial || (subtema && !falloBusqueda);
          if (puedeRescatar) {
            art = articulosDe(`rescate ${categoria}`, categoria, { oficial, topic: `Otro tema de ${categoria}` }).filter((a) => !bloqueada(a))[0] || null;
            usedFallback = Boolean(art);
          }
        }
        if (art) enLlamada.add(art.url);
        const edad = art ? redondear((ahora0 - art.publishedAt.getTime()) / HORA) : null;
        resultados.push({
          topic: oficial ? oficial.tema : t, queryExpanded: t, article: art, usedFallback, fallbackCategory: usedFallback ? categoria : null,
          matchZone: art ? (usedFallback ? 'RESCATE' : (oficial ? 'ETIQUETA' : 'VERDE')) : null,
          matchScore: art && !usedFallback && !oficial ? art.score : null,
          matchReason: motivo || (oficial
            ? `ETIQUETA buena ${edad}h imp=${art.importanceScore} (candidato #1 de 1 elegibles)`
            : `VERDE score=${art.score.toFixed(3)} (candidato #1)`),
          corralCategory: oficial ? categoria : null, candidatesEvaluated: art ? 1 : 0,
          tier: art ? (usedFallback ? 'sugerida' : 'buena') : null, ageHours: edad,
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
        tier: r.tier, ageHoursAtPick: r.ageHours,
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
      articulos24h: 61, articulos48h: 123, usuariosActivosLeidos: usuarios, origenLibres: 'falso', cacheOpenAI: false,
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
