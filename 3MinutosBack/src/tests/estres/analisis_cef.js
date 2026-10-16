'use strict';

/**
 * Analizadores PUROS de los escenarios C (digests multi-tópico), E (tópicos hostiles y variantes
 * de escritura) y F (soak). Reciben filas ya medidas y devuelven { resumen, hallazgos }.
 */

const { UMBRALES } = require('./config');
const {
  agrupar, moda, conteo, resumenLatencias, porcentaje, pendiente,
} = require('./estadisticas');
const { paresCasiDuplicados } = require('./invariantes');
const { hallazgo, hallazgosDeViolaciones } = require('./hallazgo');

const promedio = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ================================================================= C
function ordenDependiente(filas) {
  const out = [];
  for (const [tripla, grupo] of agrupar(filas, (f) => f.tripla)) {
    const ordenes = agrupar(grupo, (f) => f.orden.join('|'));
    if (ordenes.size < 2) continue;
    const temas = new Set(grupo.flatMap((f) => f.orden));
    for (const tema of temas) {
      const modalPorOrden = [];
      for (const [orden, g] of ordenes) {
        const urls = g.map((f) => f.resultados.find((r) => r.topic === tema)?.art?.url ?? null);
        const m = moda(urls);
        const fila = g[0].resultados.find((r) => r.topic === tema);
        if (m.valor) modalPorOrden.push({ posicion: g[0].orden.indexOf(tema) + 1, url: m.valor, titulo: fila?.art?.titulo || '', orden });
      }
      if (new Set(modalPorOrden.map((x) => x.url)).size > 1) out.push({ tripla, tema, modalPorOrden });
    }
  }
  return out;
}

function analizarMultitopico(filas, { vectores = null } = {}) {
  const hallazgos = [];
  const push = (cond, h) => { if (cond) hallazgos.push(hallazgo({ escenario: 'C', ...h })); };

  const conPares = [];
  for (const f of filas) {
    const pares = paresCasiDuplicados(f.resultados.map((r) => r.art).filter(Boolean), { vectores });
    if (pares.length) conPares.push({ f, pares });
  }
  const porCoseno = conPares.some((x) => x.pares.some((p) => p.medida === 'coseno'));
  push(conPares.length, {
    id: 'C-CASI-DUPLICADOS-EN-LLAMADA', severidad: porCoseno ? 'ALTA' : 'MEDIA',
    titulo: `${conPares.length} llamada(s) de 3 tópicos entregaron dos notas de la misma historia`,
    detalle: 'Tópicos solapados (p. ej. un club, "Fútbol" y "Deportes") terminan mostrando el mismo hecho dos veces en el mismo digest.',
    evidencia: conPares.slice(0, 12).map(({ f, pares }) => `[${f.orden.join(' + ')}] ${pares[0].medida} ${pares[0].valor}: "${pares[0].a.titulo.slice(0, 50)}" ≈ "${pares[0].b.titulo.slice(0, 50)}"`),
    sugerencia: 'El filtro semántico dentro de una misma llamada tampoco corre (falta el campo embedding en los candidatos).',
  });

  const dependientes = ordenDependiente(filas);
  push(dependientes.length, {
    id: 'C-DEPENDE-DEL-ORDEN', severidad: 'MEDIA',
    titulo: `${dependientes.length} tópico(s) reciben una nota distinta según su posición en la lista`,
    detalle: 'Los tópicos se resuelven en orden y cada nota entregada se descarta para los siguientes: el último recibe "las sobras".',
    evidencia: dependientes.slice(0, 12).map((d) => `"${d.tema}": ${d.modalPorOrden.map((x) => `pos ${x.posicion} → "${x.titulo.slice(0, 40)}"`).join(' | ')}`),
  });

  const porPosicion = [0, 1, 2].map((pos) => {
    const clases = filas.map((f) => f.resultados[pos]?.clase).filter(Boolean);
    return {
      posicion: pos + 1,
      n: clases.length,
      tema: porcentaje(clases.filter((c) => c === 'tema').length, clases.length),
      rescate: porcentaje(clases.filter((c) => c === 'rescate').length, clases.length),
      vacio: porcentaje(clases.filter((c) => c === 'vacio').length, clases.length),
    };
  });
  push(porPosicion[0].n && porPosicion[2].n && porPosicion[2].rescate - porPosicion[0].rescate >= 15, {
    id: 'C-POSICION-PENALIZADA', severidad: 'MEDIA',
    titulo: 'El 3.er tópico cae en rescate bastante más que el 1.º',
    evidencia: porPosicion.map((p) => `posición ${p.posicion}: tema ${Math.round(p.tema)} % · rescate ${Math.round(p.rescate)} % · vacío ${Math.round(p.vacio)} %`),
  });

  const errores = filas.filter((f) => f.error || f.timeout);
  push(errores.length, {
    id: 'C-ERRORES', severidad: 'ALTA',
    titulo: `${errores.length} llamada(s) multi-tópico fallaron o dieron timeout`,
    evidencia: errores.slice(0, 12).map((f) => `[${f.orden.join(' + ')}] ${f.error}`),
  });

  const resumen = {
    llamadas: filas.length,
    triplas: new Set(filas.map((f) => f.tripla)).size,
    porPosicion,
    rescatesPorLlamada: conteo(filas.map((f) => f.resultados.filter((r) => r.clase === 'rescate').length)),
    ms: resumenLatencias(filas.map((f) => f.ms)),
    llamadasConCasiDuplicados: conPares.length,
    topicosDependientesDelOrden: dependientes.length,
  };
  return { resumen, hallazgos: [...hallazgos, ...hallazgosDeViolaciones('C', filas)] };
}

// ================================================================= E
const SEVERIDAD_ERROR_BUSQUEDA = {
  prototipo: 'BAJA', extremos: 'BAJA', inyeccion: 'MEDIA', unicode: 'MEDIA', ruido: 'MEDIA', vacios: 'INFO', no_string: 'INFO',
};

function analizarVariantes(filas) {
  const porBase = [...agrupar(filas, (f) => f.base)].map(([base, g]) => {
    const clases = new Set(g.map((f) => f.clase));
    const urls = new Set(g.map((f) => f.url).filter(Boolean));
    return {
      base, variantes: g.length, clases: [...clases], urls: urls.size,
      clasesDistintas: clases.size > 1, notasDistintas: urls.size > 1,
      detalle: g.map((f) => `${f.varianteId}→${f.clase}`).join(', '),
    };
  });
  return porBase;
}

function analizarHostiles({ hostiles = [], variantes = [] } = {}, { timeoutS = 60 } = {}) {
  const hallazgos = [];
  const push = (cond, h) => { if (cond) hallazgos.push(hallazgo({ escenario: 'E', ...h })); };

  const lanzo = hostiles.filter((f) => f.lanzo || f.error || f.timeout);
  push(lanzo.length, {
    id: 'E-EXCEPCION', severidad: 'CRITICA',
    titulo: `${lanzo.length} entrada(s) hostil(es) hicieron fallar o colgarse a pickBestArticlePerTopic`,
    detalle: 'Un texto de usuario nunca debería tirar una excepción ni colgar la generación del digest.',
    evidencia: lanzo.slice(0, 12).map((f) => `${f.id} (${f.valorDesc}): ${f.error}`),
  });

  for (const [grupo, g] of agrupar(hostiles.filter((f) => f.motivo === 'error_busqueda'), (f) => f.grupo)) {
    push(true, {
      id: `E-ERROR-BUSQUEDA-${grupo.toUpperCase()}`, severidad: SEVERIDAD_ERROR_BUSQUEDA[grupo] || 'BAJA',
      titulo: `Grupo "${grupo}": ${new Set(g.map((f) => f.id)).size} entrada(s) rompieron la búsqueda (error_busqueda → rescate)`,
      detalle: 'El texto llegó tal cual a Atlas/OpenAI o a un lookup de objeto y la búsqueda falló; el usuario recibe una nota de relleno.',
      evidencia: [...new Set(g.map((f) => `${f.id} (${f.valorDesc})`))],
      sugerencia: grupo === 'prototipo' ? 'TOPIC_TO_CATEGORY[topic] es un objeto común: "constructor" o "toString" devuelven funciones del prototipo. Usar Map u Object.hasOwn.' : 'Sanear/validar el texto antes de buscar.',
    });
  }

  const lentos = hostiles.filter((f) => f.ms > timeoutS * 500);
  push(lentos.length, {
    id: 'E-LENTO', severidad: 'MEDIA',
    titulo: `${lentos.length} entrada(s) hostil(es) tardaron más de la mitad del timeout`,
    evidencia: lentos.slice(0, 12).map((f) => `${f.id}: ${f.ms} ms`),
  });

  const base = analizarVariantes(variantes);
  const claseDistinta = base.filter((b) => b.clasesDistintas);
  const notaDistinta = base.filter((b) => !b.clasesDistintas && b.notasDistintas);
  push(claseDistinta.length, {
    id: 'E-VARIANTES-CLASE', severidad: porcentaje(claseDistinta.length, base.length) >= 20 ? 'MEDIA' : 'BAJA',
    titulo: `${claseDistinta.length} de ${base.length} tópicos se resuelven distinto según cómo se escriba (mayúsculas/acentos)`,
    detalle: 'Un usuario que escribe "River" o "RIVER" debería recibir lo mismo que con "river".',
    evidencia: claseDistinta.slice(0, 12).map((b) => `"${b.base}": ${b.detalle}`),
  });
  push(notaDistinta.length, {
    id: 'E-VARIANTES-NOTA', severidad: 'BAJA',
    titulo: `${notaDistinta.length} tópicos dan la misma clase de resultado pero otra nota según la escritura`,
    evidencia: notaDistinta.slice(0, 12).map((b) => `"${b.base}": ${b.urls} notas distintas`),
  });

  const resumen = {
    hostiles: new Set(hostiles.map((f) => f.id)).size,
    llamadasHostiles: hostiles.length,
    clasesPorGrupo: Object.fromEntries([...agrupar(hostiles, (f) => f.grupo)].map(([g, filas]) => [g, conteo(filas.map((f) => f.clase))])),
    variantes: { topicos: base.length, conClaseDistinta: claseDistinta.length, conNotaDistinta: notaDistinta.length },
    ms: resumenLatencias(hostiles.map((f) => f.ms)),
  };
  return { resumen, hallazgos: [...hallazgos, ...hallazgosDeViolaciones('E', [...hostiles, ...variantes])] };
}

// ================================================================= F
function analizarSoak(muestras, { memoriaMBporMin = UMBRALES.memoriaMBporMin } = {}) {
  const hallazgos = [];
  const push = (cond, h) => { if (cond) hallazgos.push(hallazgo({ escenario: 'F', ...h })); };
  if (muestras.length < 4) {
    push(true, { id: 'F-CORTO', severidad: 'INFO', titulo: 'El soak fue demasiado corto para sacar conclusiones', detalle: `Solo ${muestras.length} muestra(s).` });
    return { resumen: { muestras: muestras.length }, hallazgos };
  }
  const util = muestras.slice(Math.floor(muestras.length * 0.2)); // sin el calentamiento
  const minutos = util.map((m) => m.minuto);
  const heap = pendiente(minutos, util.map((m) => m.heapMB));
  const rss = pendiente(minutos, util.map((m) => m.rssMB));
  const tercio = Math.max(1, Math.floor(muestras.length / 3));
  const ini = muestras.slice(0, tercio);
  const fin = muestras.slice(-tercio);
  const p95Ini = promedio(ini.map((m) => m.p95).filter(Number.isFinite));
  const p95Fin = promedio(fin.map((m) => m.p95).filter(Number.isFinite));
  const tasa = (g) => porcentaje(g.reduce((a, m) => a + m.errores, 0), g.reduce((a, m) => a + m.tareas, 0));

  push(heap > memoriaMBporMin, { id: 'F-MEMORIA', severidad: 'ALTA', titulo: `El heap crece ${heap.toFixed(1)} MB/min de forma sostenida`, detalle: `Umbral: ${memoriaMBporMin} MB/min.`, evidencia: [`RSS: ${rss.toFixed(1)} MB/min`], sugerencia: 'Sospechar de queryExpansionCache (Map sin límite) y de las capturas de logs.' });
  push(heap > 5 && heap <= memoriaMBporMin, { id: 'F-MEMORIA-LEVE', severidad: 'MEDIA', titulo: `El heap crece ${heap.toFixed(1)} MB/min`, detalle: 'Puede ser caché legítima llenándose; repetir con un soak más largo.' });
  push(p95Ini && p95Fin && p95Fin >= p95Ini * 1.5 && p95Fin - p95Ini > 500, { id: 'F-DEGRADACION', severidad: 'ALTA', titulo: `La latencia p95 empeora con el tiempo (${Math.round(p95Ini)} → ${Math.round(p95Fin)} ms)` });
  push(tasa(fin) > tasa(ini) + 5, { id: 'F-ERRORES-CRECEN', severidad: 'MEDIA', titulo: `La tasa de error sube con el tiempo (${tasa(ini).toFixed(1)} % → ${tasa(fin).toFixed(1)} %)` });

  const resumen = {
    muestras: muestras.length,
    minutos: Math.round(muestras[muestras.length - 1].minuto * 10) / 10,
    heapMBporMin: Math.round(heap * 10) / 10,
    rssMBporMin: Math.round(rss * 10) / 10,
    p95Inicio: p95Ini, p95Final: p95Fin,
    tasaErrorInicio: Math.round(tasa(ini) * 10) / 10, tasaErrorFinal: Math.round(tasa(fin) * 10) / 10,
  };
  return { resumen, hallazgos };
}

module.exports = { analizarMultitopico, analizarHostiles, analizarVariantes, analizarSoak, ordenDependiente };
