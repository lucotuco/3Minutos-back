'use strict';

/**
 * Invariantes: lo que SIEMPRE tiene que cumplir cada resultado de pickBestArticlePerTopic,
 * sin importar la carga, el tópico ni cuántas veces se repita. Son funciones puras
 * (no tocan Mongo ni OpenAI), así se pueden probar con datos falsos.
 *
 * Cada violación: { id, severidad, mensaje, topic, url }.
 */

const { norm } = require('../comparar/utilidades');
const { topicWords } = require('../../utils/topicMatching');
const { CONTRATO, UMBRALES } = require('./config');
const { coseno, similitudTitulos } = require('./estadisticas');

const ZONAS = new Set(['VERDE', 'AMARILLA', 'RESCATE']);
const CAUSAS_RESCATE = new Set(['sin_candidatos', 'ningun_candidato_valido', 'error_busqueda']);
// Espejo de OPINION_KEYWORDS en pickBestArticlePerTopic.js (si cambia allá, actualizar acá).
const OPINION = ['opinion', 'columna', 'columnista', 'editorial', 'analisis'];

const redondear = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

/** 'tema' | 'rescate' | 'vacio' | 'sin_resultado' */
function clasificar(r) {
  if (!r || typeof r !== 'object') return 'sin_resultado';
  if (!r.article) return 'vacio';
  return r.usedFallback ? 'rescate' : 'tema';
}

function tokensDe(a) {
  const texto = [a?.title, a?.rawSummary, a?.contentSnippet, ...(Array.isArray(a?.tags) ? a.tags : [])].join(' ');
  return new Set(norm(texto).replace(/[^a-z0-9ñ]+/g, ' ').split(' ').filter(Boolean));
}

/** ¿La nota contiene al menos una palabra "con contenido" del tópico? */
function mencionaAlguna(topic, a) {
  const palabras = topicWords(topic);
  if (!palabras.length) return null; // tópico sin palabras evaluables (p. ej. "el la los")
  const tokens = tokensDe(a);
  return palabras.some((p) => tokens.has(p));
}

function esOpinion(a) {
  if (/\/opinion(es)?\//i.test(String(a?.url || ''))) return true;
  const campos = [a?.section, a?.category, a?.title, ...(Array.isArray(a?.tags) ? a.tags : [])];
  return campos.some((c) => OPINION.some((k) => norm(c).includes(k)));
}

function edadHoras(a, ahora) {
  const t = a?.publishedAt ? new Date(a.publishedAt).getTime() : NaN;
  return Number.isNaN(t) ? null : (ahora - t) / 36e5;
}

/** Datos mínimos de la nota que se guardan en los reportes (no se guarda el documento entero). */
function resumenArticulo(a, ahora = Date.now()) {
  if (!a) return null;
  return {
    id: a._id ? String(a._id) : null,
    url: a.url || null,
    titulo: String(a.title || ''),
    categoria: a.category || null,
    subtema: a.topic || null,
    fuente: a.sourceName || null,
    edadHoras: redondear(edadHoras(a, ahora)),
    score: typeof a.score === 'number' ? redondear(a.score, 3) : null,
    finalScore: typeof a.finalScore === 'number' ? redondear(a.finalScore, 1) : null,
  };
}

// ---------------------------------------------------------------- chequeos sueltos
function chequearTraza(r, add) {
  if (typeof r.topic !== 'string') add('I5-TRAZA', 'MEDIA', 'falta el campo topic');
  if (typeof r.queryExpanded !== 'string') add('I5-TRAZA', 'MEDIA', 'queryExpanded no es texto');
  if (typeof r.matchReason !== 'string' || !r.matchReason) add('I5-TRAZA', 'MEDIA', 'matchReason vacío');
  if (!Number.isInteger(r.candidatesEvaluated) || r.candidatesEvaluated < 0) add('I5-TRAZA', 'MEDIA', 'candidatesEvaluated inválido');
  if (!('corralCategory' in r)) add('I5-TRAZA', 'MEDIA', 'falta corralCategory');
}

function chequearZona(r, a, add) {
  const zona = r.matchZone ?? null;
  if (!a) {
    if (zona !== null) add('I2-ZONA', 'ALTA', `sin nota pero matchZone=${zona}`);
    if (r.usedFallback) add('I2-ZONA', 'ALTA', 'sin nota pero usedFallback=true');
    return;
  }
  if (zona !== null && !ZONAS.has(zona)) add('I2-ZONA', 'ALTA', `zona desconocida: ${zona}`);
  if (r.usedFallback) {
    if (zona !== 'RESCATE') add('I2-ZONA', 'ALTA', `usedFallback=true con zona=${zona}`);
    if (!CAUSAS_RESCATE.has(r.matchReason)) add('I13-RESCATE-SIN-MOTIVO', 'MEDIA', `rescate con matchReason="${r.matchReason}"`);
    return;
  }
  if (zona !== 'VERDE' && zona !== 'AMARILLA') { add('I2-ZONA', 'ALTA', `nota de tema con zona=${zona}`); return; }
  const s = r.matchScore;
  if (typeof s !== 'number' || !Number.isFinite(s)) add('I2-ZONA', 'ALTA', 'nota de tema sin matchScore numérico');
  else if (zona === 'VERDE' && s < CONTRATO.verdeMin) add('I2-ZONA', 'ALTA', `VERDE con score ${s.toFixed(3)} < ${CONTRATO.verdeMin}`);
  else if (zona === 'AMARILLA' && (s < CONTRATO.amarillaMin || s >= CONTRATO.verdeMin)) {
    add('I2-ZONA', 'ALTA', `AMARILLA con score ${s.toFixed(3)} fuera de [${CONTRATO.amarillaMin}, ${CONTRATO.verdeMin})`);
  }
}

function chequearNota(a, ahora, add) {
  if (!a._id) add('I6-FORMA', 'ALTA', 'la nota no tiene _id');
  if (typeof a.url !== 'string' || !/^https?:\/\//i.test(a.url)) add('I6-FORMA', 'ALTA', `url inválida: ${String(a.url).slice(0, 80)}`);
  if (typeof a.title !== 'string' || !a.title.trim()) add('I6-FORMA', 'ALTA', 'la nota no tiene título');
  if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > 1) add('I10-SCORE', 'MEDIA', `score fuera de [0,1]: ${a.score}`);
  if (typeof a.finalScore !== 'number' || !Number.isFinite(a.finalScore)) add('I10-SCORE', 'MEDIA', 'finalScore no numérico');
  if (esOpinion(a)) add('I6b-OPINION', 'MEDIA', 'se entregó una nota de opinión/columna/análisis');

  const h = edadHoras(a, ahora);
  if (h === null) add('I1-EDAD', 'MEDIA', 'la nota no tiene publishedAt válido');
  else if (h > CONTRATO.maxEdadHoras + 1 / 60) add('I1-EDAD', 'ALTA', `la nota tiene ${h.toFixed(1)} h (máximo ${CONTRATO.maxEdadHoras} h)`);
  else if (h < -2) add('I1-FECHA-FUTURA', 'BAJA', `publishedAt está ${Math.abs(h).toFixed(1)} h en el futuro (cuenta como "recién salida")`);
}

function chequearCorral(r, a, esperado, add) {
  if (esperado.tipo === 'oficial' && esperado.categoria) {
    if (norm(a.category) !== norm(esperado.categoria)) {
      add('I3-CORRAL-OFICIAL', 'ALTA', `tópico oficial de "${esperado.categoria}" entregó una nota de "${a.category}"`);
    }
    if (r.usedFallback && r.fallbackCategory && norm(r.fallbackCategory) !== norm(esperado.categoria)) {
      add('I3-CORRAL-OFICIAL', 'ALTA', `el rescate de un tópico de "${esperado.categoria}" salió de "${r.fallbackCategory}"`);
    }
  } else if (!r.usedFallback && r.corralCategory && a.category && a.category !== r.corralCategory) {
    add('I4-CORRAL-INFERIDO', 'MEDIA', `corral inferido "${r.corralCategory}" pero la nota es de "${a.category}"`);
  }
}

// ---------------------------------------------------------------- API
/**
 * @param {object} p
 * @param {string} p.topic        lo que se mandó (crudo)
 * @param {object} p.r            un elemento de resultados
 * @param {object} [p.esperado]   { tipo: 'oficial'|'libre', categoria }
 * @param {Set<string>} [p.historial] URLs ya vistas por el usuario simulado
 * @param {number} [p.ahora]
 */
function verificarResultado({ topic, r, esperado = {}, historial = null, ahora = Date.now() }) {
  const out = [];
  const etiqueta = typeof topic === 'string' ? topic : String(topic);
  const add = (id, severidad, mensaje) => out.push({ id, severidad, mensaje, topic: etiqueta.slice(0, 80), url: r?.article?.url || null });

  if (!r || typeof r !== 'object') {
    add('I0-FORMA-RESULTADO', 'ALTA', 'falta el resultado de este tópico');
    return out;
  }
  const a = r.article || null;
  chequearTraza(r, add);
  chequearZona(r, a, add);
  if (!a) return out;

  chequearNota(a, ahora, add);
  chequearCorral(r, a, esperado, add);

  if (historial && a.url && historial.has(a.url)) add('I7-REPETIDO-HISTORIAL', 'CRITICA', 'se entregó una nota que el usuario ya había visto');

  // esperado.sinTexto: los items de un digest no traen rawSummary/contentSnippet, no se puede medir.
  if (esperado.tipo === 'libre' && !esperado.sinTexto && !r.usedFallback && r.matchZone === 'AMARILLA' && mencionaAlguna(topic, a) === false) {
    add('I11-AMARILLA-SIN-PALABRA', 'MEDIA', 'zona AMARILLA pero la nota no contiene ninguna palabra del tópico');
  }
  return out;
}

/** Chequeos de una llamada completa: alineación, duplicados y cada resultado. */
function verificarLlamada({ topics, resultados, esperados = [], historial = null, ahora = Date.now() }) {
  if (!Array.isArray(resultados)) {
    return [{ id: 'I0-FORMA-RESULTADO', severidad: 'CRITICA', mensaje: 'pickBestArticlePerTopic no devolvió un array', topic: '', url: null }];
  }
  const out = [];
  const validos = topics.map((t, i) => ({ t, esperado: esperados[i] || {} })).filter(({ t }) => String(t || '').trim());

  if (resultados.length !== validos.length) {
    out.push({ id: 'I9-ALINEACION', severidad: 'MEDIA', mensaje: `se enviaron ${validos.length} tópicos válidos y volvieron ${resultados.length} resultados`, topic: '', url: null });
  }
  const vistasUrl = new Map();
  validos.forEach(({ t, esperado }, i) => {
    const r = resultados[i];
    if (r && norm(r.topic) !== norm(String(t).trim())) {
      out.push({ id: 'I9-ALINEACION', severidad: 'MEDIA', mensaje: `el resultado #${i} es de "${r.topic}" y se esperaba "${String(t).trim()}"`, topic: String(t).slice(0, 80), url: null });
    }
    out.push(...verificarResultado({ topic: String(t).trim(), r, esperado, historial, ahora }));
    const url = r?.article?.url;
    if (url) vistasUrl.set(url, [...(vistasUrl.get(url) || []), String(t).trim()]);
  });
  for (const [url, ts] of vistasUrl) {
    if (ts.length > 1) out.push({ id: 'I8-DUPLICADO-LLAMADA', severidad: 'CRITICA', mensaje: `la misma nota se entregó a ${ts.length} tópicos de una misma llamada: ${ts.join(' | ')}`, topic: ts[0].slice(0, 80), url });
  }
  return out;
}

/**
 * Pares de notas "casi iguales" (misma historia) dentro de un grupo entregado.
 * Usa los embeddings reales si se pasan (Map id -> vector); si no, la similitud de títulos.
 */
function paresCasiDuplicados(notas, { vectores = null } = {}) {
  const pares = [];
  for (let i = 0; i < notas.length; i++) {
    for (let j = i + 1; j < notas.length; j++) {
      const A = notas[i];
      const B = notas[j];
      if (!A || !B || A.id === B.id) continue;
      const vA = vectores && vectores.get(A.id);
      const vB = vectores && vectores.get(B.id);
      if (vA && vB) {
        const c = coseno(vA, vB);
        if (c >= UMBRALES.casiDuplicadoCos) pares.push({ a: A, b: B, medida: 'coseno', valor: Math.round(c * 1000) / 1000 });
      } else {
        const s = similitudTitulos(A.titulo, B.titulo);
        if (s >= UMBRALES.casiDuplicadoTitulos) pares.push({ a: A, b: B, medida: 'titulos', valor: Math.round(s * 1000) / 1000 });
      }
    }
  }
  return pares;
}

module.exports = {
  clasificar, tokensDe, mencionaAlguna, esOpinion, edadHoras, resumenArticulo,
  verificarResultado, verificarLlamada, paresCasiDuplicados,
};
