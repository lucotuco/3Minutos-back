'use strict';

/**
 * Analizadores PUROS de los escenarios A (repetición por tópico) y B (sesiones con historial).
 * Reciben filas ya medidas y devuelven { resumen, hallazgos }. No tocan Mongo ni OpenAI.
 */

const { UMBRALES, CONTRATO } = require('./config');
const {
  agrupar, moda, transiciones, conteo, resumenLatencias, porcentaje, percentil,
} = require('./estadisticas');
const { paresCasiDuplicados } = require('./invariantes');
const { hallazgo, hallazgosDeViolaciones } = require('./hallazgo');

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ================================================================= A
function resumenTemaA(tema, filas) {
  const g = [...filas].sort((a, b) => a.t - b.t);
  const entregadas = g.filter((f) => f.art);
  const modalUrl = moda(g.map((f) => f.art?.url ?? null));
  return {
    tema,
    tipo: g[0].tipo,
    nivel: g[0].nivel,
    categoria: g[0].categoria,
    n: g.length,
    entregas: entregadas.length,
    distintos: new Set(entregadas.map((f) => f.art.id)).size,
    modalUrl: modalUrl.valor,
    modalTitulo: entregadas.find((f) => f.art.url === modalUrl.valor)?.art.titulo ?? null,
    pctModal: porcentaje(modalUrl.cuenta, g.length),
    claseModal: moda(g.map((f) => f.clase)).valor,
    rescates: g.filter((f) => f.clase === 'rescate').length,
    vacios: g.filter((f) => f.clase === 'vacio').length,
    errores: g.filter((f) => f.error || f.timeout).length,
    erroresBusqueda: g.filter((f) => f.motivo === 'error_busqueda').length,
    transiciones: transiciones(g.map((f) => f.art?.id ?? null)),
    zonas: conteo(g.map((f) => f.zona)),
    ms: resumenLatencias(g.map((f) => f.ms)),
    violaciones: sum(g.map((f) => f.violaciones?.length || 0)),
    verdeSinMencion: g.filter((f) => f.zona === 'VERDE' && f.menciona === false).length,
  };
}

function hallazgosA(porTema, filas, timeoutS) {
  const out = [];
  const ev = (lista, fmt) => lista.slice(0, 12).map(fmt);
  const push = (cond, h) => { if (cond) out.push(hallazgo({ escenario: 'A', ...h })); };

  const conError = porTema.filter((t) => t.errores > 0);
  push(conError.length, {
    id: 'A-ERRORES', severidad: 'ALTA',
    titulo: `${conError.length} tópico(s) con llamadas que fallaron o dieron timeout`,
    detalle: 'pickBestArticlePerTopic no debería lanzar ni colgarse con un tópico válido.',
    evidencia: ev(conError, (t) => `"${t.tema}": ${t.errores}/${t.n} llamadas con error`),
    sugerencia: 'Ver "top errores" del reporte para el mensaje exacto.',
  });

  const tragados = porTema.filter((t) => t.erroresBusqueda > 0);
  push(tragados.length, {
    id: 'A-ERROR-BUSQUEDA-TRAGADO', severidad: 'ALTA',
    titulo: `${tragados.length} tópico(s) tuvieron un error de búsqueda que se disfrazó de "noticia sugerida"`,
    detalle: 'Si la búsqueda falla (Atlas/OpenAI), el código cae al rescate y el usuario recibe una nota de relleno sin que nadie se entere.',
    evidencia: ev(tragados, (t) => `"${t.tema}": ${t.erroresBusqueda}/${t.n} llamadas con matchReason=error_busqueda`),
    sugerencia: 'Distinguir "no hay notas" de "falló la búsqueda": reintentar o no mostrar rescate cuando es un error de infraestructura.',
  });

  const intermitentes = porTema.filter((t) => t.rescates > 0 && t.rescates < t.n);
  push(intermitentes.length, {
    id: 'A-RESCATE-INTERMITENTE', severidad: 'ALTA',
    titulo: `${intermitentes.length} tópico(s) a veces dan nota del tema y a veces rescate, con la misma entrada`,
    detalle: 'La misma consulta, sin historial, debería resolverse siempre igual (salvo que entren notas nuevas).',
    evidencia: ev(intermitentes, (t) => `"${t.tema}": rescate en ${t.rescates}/${t.n}; zonas ${JSON.stringify(t.zonas)}`),
    sugerencia: 'Mirar si coincide con error_busqueda o con candidatos que oscilan alrededor de 0.80/0.94.',
  });

  const flapping = porTema.filter((t) => t.distintos >= 2 && t.transiciones >= 2);
  push(flapping.length, {
    id: 'A-FLAPPING', severidad: 'ALTA',
    titulo: `${flapping.length} tópico(s) cambian de nota de ida y vuelta entre llamadas idénticas`,
    detalle: 'Un cambio único puede ser una nota nueva; ir y volver (A, B, A) indica no determinismo.',
    evidencia: ev(flapping, (t) => `"${t.tema}": ${t.distintos} notas distintas, ${t.transiciones} cambios en ${t.n} llamadas`),
    sugerencia: 'Sospechar de la búsqueda aproximada (numCandidates) o de empates de finalScore.',
  });

  const cambio = porTema.filter((t) => t.distintos >= 2 && t.transiciones === 1);
  push(cambio.length, {
    id: 'A-CAMBIO-UNICO', severidad: 'BAJA',
    titulo: `${cambio.length} tópico(s) cambiaron de nota una vez durante la corrida`,
    detalle: 'Normal si entró una nota nueva o si la frescura reordenó candidatos.',
    evidencia: ev(cambio, (t) => `"${t.tema}": ${t.distintos} notas distintas`),
  });

  const hubs = new Map();
  for (const f of filas) {
    if (!f.art?.url) continue;
    if (!hubs.has(f.art.url)) hubs.set(f.art.url, { titulo: f.art.titulo, clase: f.clase, temas: new Set() });
    hubs.get(f.art.url).temas.add(f.tema);
  }
  const concentradas = [...hubs.values()].filter((h) => h.temas.size >= 3).sort((a, b) => b.temas.size - a.temas.size);
  push(concentradas.length, {
    id: 'A-NOTA-REPETIDA-ENTRE-TEMAS', severidad: 'MEDIA',
    titulo: `${concentradas.length} nota(s) se entregan a 3 o más tópicos distintos`,
    detalle: 'Si es un rescate, todos los usuarios cuyo tópico falla en esa categoría ven la misma nota de relleno.',
    evidencia: ev(concentradas, (h) => `${h.temas.size} tópicos (${h.clase}) ← "${h.titulo.slice(0, 70)}"`),
    sugerencia: 'Rotar o diversificar el rescate (hoy es siempre la primera nota usable de la misma consulta fija).',
  });

  const libres = porTema.filter((t) => t.tipo === 'libre');
  const libresRescate = libres.filter((t) => t.claseModal === 'rescate' || t.claseModal === 'vacio');
  push(libres.length && libresRescate.length / libres.length > UMBRALES.rescateMaxLibres, {
    id: 'A-RESCATE-ALTO-LIBRES', severidad: 'MEDIA',
    titulo: `${libresRescate.length} de ${libres.length} tópicos libres (${Math.round(porcentaje(libresRescate.length, libres.length))} %) terminan en rescate`,
    detalle: `Umbral tolerable: ${Math.round(UMBRALES.rescateMaxLibres * 100)} %.`,
    evidencia: ev(libresRescate, (t) => `"${t.tema}" → ${t.claseModal}`),
  });

  const catsMal = porTema.filter((t) => t.tipo === 'oficial' && t.nivel === 'categoria' && t.claseModal !== 'tema');
  push(catsMal.length, {
    id: 'A-CATEGORIA-SIN-NOTA', severidad: 'ALTA',
    titulo: `${catsMal.length} categoría(s) oficial(es) no resuelven con una nota propia`,
    detalle: 'Con 48 h de ingesta, cada una de las 7 categorías debería tener notas.',
    evidencia: ev(catsMal, (t) => `"${t.tema}" → ${t.claseModal}`),
  });
  const subMal = porTema.filter((t) => t.tipo === 'oficial' && t.nivel === 'subtema' && t.claseModal !== 'tema');
  push(subMal.length, {
    id: 'A-SUBTEMA-SIN-NOTA', severidad: 'MEDIA',
    titulo: `${subMal.length} subtema(s) oficial(es) terminan en rescate o vacío`,
    detalle: 'Puede ser falta de notas reales, o que el nombre del subtema casi nunca aparece en el texto (zona amarilla).',
    evidencia: ev(subMal, (t) => `"${t.tema}" (${t.categoria}) → ${t.claseModal}`),
  });

  const vacios = porTema.filter((t) => t.vacios > 0);
  push(vacios.length, {
    id: 'A-SIN-NOTICIA', severidad: 'MEDIA',
    titulo: `${vacios.length} tópico(s) no devolvieron ninguna nota, ni siquiera de rescate`,
    evidencia: ev(vacios, (t) => `"${t.tema}": ${t.vacios}/${t.n}`),
  });

  const verde = porTema.filter((t) => t.verdeSinMencion > 0);
  push(verde.length, {
    id: 'A-VERDE-SIN-MENCION', severidad: 'BAJA',
    titulo: `${verde.length} tópico(s) entregaron en zona VERDE una nota que no nombra el tema`,
    detalle: 'La zona VERDE no pasa por el chequeo léxico.',
    evidencia: ev(verde, (t) => `"${t.tema}": ${t.verdeSinMencion} vez/veces`),
  });

  const lentos = porTema.filter((t) => (t.ms.p95 || 0) > timeoutS * 500);
  push(lentos.length, {
    id: 'A-LENTO', severidad: 'MEDIA',
    titulo: `${lentos.length} tópico(s) con p95 mayor a la mitad del timeout`,
    evidencia: ev(lentos, (t) => `"${t.tema}": p95 ${t.ms.p95} ms`),
  });

  return [...out, ...hallazgosDeViolaciones('A', filas)];
}

function analizarRepeticiones(filas, { timeoutS = 60 } = {}) {
  const porTema = [...agrupar(filas, (f) => f.tema)].map(([tema, g]) => resumenTemaA(tema, g));
  const estables = porTema.filter((t) => t.distintos <= 1 && t.transiciones === 0 && t.errores === 0).length;
  const resumen = {
    llamadas: filas.length,
    topicos: porTema.length,
    clases: conteo(filas.map((f) => f.clase)),
    zonas: conteo(filas.map((f) => f.zona)),
    causasNoTema: conteo(filas.filter((f) => f.clase !== 'tema').map((f) => f.motivo)),
    ms: resumenLatencias(filas.map((f) => f.ms)),
    estables,
    pctEstables: porcentaje(estables, porTema.length),
    porTipo: Object.fromEntries(['oficial', 'libre'].map((tipo) => {
      const g = porTema.filter((t) => t.tipo === tipo);
      return [tipo, { topicos: g.length, conNota: g.filter((t) => t.claseModal === 'tema').length, rescate: g.filter((t) => t.claseModal === 'rescate').length }];
    })),
  };
  return { resumen, porTema, hallazgos: hallazgosA(porTema, filas, timeoutS) };
}

// ================================================================= B
function resumenTemaB(tema, filas) {
  const s = [...filas].sort((a, b) => a.ronda - b.ronda);
  const primera = (clase) => s.find((f) => f.clase === clase)?.ronda ?? null;
  return {
    tema,
    tipo: s[0].tipo,
    rondas: s.length,
    conTema: s.filter((f) => f.clase === 'tema').length,
    rescates: s.filter((f) => f.clase === 'rescate').length,
    primeraRescate: primera('rescate'),
    primeraVacia: primera('vacio'),
    errores: s.filter((f) => f.error || f.timeout).length,
    repetidas: s.filter((f) => (f.violaciones || []).some((v) => v.id === 'I7-REPETIDO-HISTORIAL')).length,
  };
}

/** Notas entregadas en una sesión, en orden, como objetos { id, url, titulo }. */
const notasDeSesion = (filas) => filas.flatMap((f) => (f.resultados || []).map((r) => r.art).filter(Boolean));

function analizarSesiones({ rondasTema = [], sesiones = [], vectores = null } = {}) {
  const porTema = [...agrupar(rondasTema, (f) => f.tema)].map(([tema, g]) => resumenTemaB(tema, g));
  const hallazgos = [];
  const push = (cond, h) => { if (cond) hallazgos.push(hallazgo({ escenario: 'B', ...h })); };

  const sinNota = porTema.filter((t) => t.primeraVacia !== null);
  push(sinNota.length, {
    id: 'B-SIN-NOTICIA', severidad: 'MEDIA',
    titulo: `${sinNota.length} tópico(s) llegaron a no devolver nada tras refrescos repetidos`,
    detalle: 'Se agotó también el rescate de la categoría (todo lo de las últimas 48 h ya fue visto).',
    evidencia: sinNota.slice(0, 12).map((t) => `"${t.tema}": vacío desde la ronda ${t.primeraVacia}`),
  });
  const agotados = porTema.filter((t) => t.tipo === 'libre' && t.conTema <= 1 && t.rondas >= 3);
  push(agotados.length, {
    id: 'B-AGOTAMIENTO-RAPIDO', severidad: 'INFO',
    titulo: `${agotados.length} tópico(s) libres se quedan sin notas propias en la 2.ª ronda`,
    detalle: 'Con refrescos repetidos pasan a "noticia sugerida" enseguida. Para un digest diario no es crítico.',
    evidencia: agotados.slice(0, 12).map((t) => `"${t.tema}": ${t.conTema} nota(s) propia(s) en ${t.rondas} rondas`),
  });

  const reaparecidas = sesiones.flatMap((s) => (s.reaparecidas || []).map((r) => ({ ...r, sesion: s.sesion })));
  push(reaparecidas.length, {
    id: 'B-REAPARICION', severidad: 'ALTA',
    titulo: `${reaparecidas.length} nota(s) volvieron a entregarse a un mismo usuario tras salir de la ventana de ${CONTRATO.ventanaHistorial}`,
    detalle: `El historial anti-repetidos mira solo las últimas ${CONTRATO.ventanaHistorial} notas vistas y las notas viven ${CONTRATO.maxEdadHoras} h: un usuario que refresca mucho vuelve a ver notas viejas.`,
    evidencia: reaparecidas.slice(0, 12).map((r) => `sesión ${r.sesion}: "${String(r.titulo).slice(0, 70)}" (la primera vez, ronda ${r.rondaPrevia})`),
    sugerencia: 'Subir la ventana o excluir por (usuario, URL) dentro de las últimas 48 h en vez de por cantidad.',
  });

  const pares = [];
  for (const s of agrupar(sesiones, (x) => x.sesion).values()) {
    for (const p of paresCasiDuplicados(notasDeSesion(s), { vectores })) pares.push(p);
  }
  const porCoseno = pares.filter((p) => p.medida === 'coseno');
  push(pares.length, {
    id: 'B-CASI-DUPLICADOS', severidad: porCoseno.length ? 'ALTA' : 'MEDIA',
    titulo: `${pares.length} par(es) de notas "casi iguales" entregadas al mismo usuario simulado`,
    detalle: `Medido con ${porCoseno.length ? 'embeddings reales (coseno ≥ ' + UMBRALES.casiDuplicadoCos + ')' : 'similitud de títulos'}. ` +
      'El filtro semántico de producción no corre (la búsqueda híbrida no trae el campo embedding), así que nada impide estos pares.',
    evidencia: pares.slice(0, 12).map((p) => `${p.medida} ${p.valor}: "${p.a.titulo.slice(0, 55)}" ≈ "${p.b.titulo.slice(0, 55)}"`),
    sugerencia: 'Proyectar embedding en la búsqueda (o compararlo aparte) para que isUsableDigestArticle pueda bloquear duplicados.',
  });

  const resumen = {
    temas: porTema.length,
    rondasPorTema: porTema.length ? porTema[0].rondas : 0,
    medianaNotasPropias: percentil(porTema.map((t) => t.conTema), 50),
    temasQueLlegaronAVacio: sinNota.length,
    sesiones: new Set(sesiones.map((s) => s.sesion)).size,
    rondasSesion: sesiones.length,
    reaparecidas: reaparecidas.length,
    paresCasiDuplicados: pares.length,
    paresPorCoseno: porCoseno.length,
    ms: resumenLatencias([...rondasTema, ...sesiones].map((f) => f.ms)),
  };
  const filas = [...rondasTema, ...sesiones];
  return { resumen, porTema, hallazgos: [...hallazgos, ...hallazgosDeViolaciones('B', filas)] };
}

module.exports = { analizarRepeticiones, analizarSesiones, notasDeSesion };
