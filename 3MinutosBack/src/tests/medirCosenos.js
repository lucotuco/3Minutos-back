'use strict';

/**
 * medirCosenos.js  (SOLO LECTURA: no escribe nada en Mongo ni llama a OpenAI)
 *
 * Muestra el coseno REAL entre las notas de tu base. Sirve para afinar cuándo dos notas son "la misma historia"
 * (utils/eligibility.js):
 *   coseno ≥ 0,88          MISMA     se descarta sin preguntar
 *   0,80 ≤ coseno < 0,88   BANDA     decide el juez de IA (sameEventJudge.js)
 *   coseno < 0,80          DISTINTA  son hechos distintos
 * Los bordes son estimaciones. Con esta salida se ve a qué altura quedan de verdad los pares que vos reconocés como el
 * mismo hecho contado por otro medio, y cuántos pares de hechos distintos caen en la banda del juez (cada uno es una
 * llamada más a gpt-4o-mini).
 *
 * Uso (desde la carpeta 3MinutosBack, donde está tu .env):
 *   node src/tests/medirCosenos.js                                  las notas de las últimas 24 h (por defecto)
 *   node src/tests/medirCosenos.js --horas 48 --categoria Deportes --contiene river
 *   node src/tests/medirCosenos.js --reporte test-resultados/despues.json
 *                                                                   las notas que entregó esa corrida del comparador
 *   node src/tests/medirCosenos.js <id | url | parte del título> ...  esas notas (por ejemplo las de un digest repetido)
 *
 * Opciones:  --min 0.76 (se listan los pares con coseno ≥ min)   --max-pares 60 (cuántos se imprimen)
 *            --max-notas 1500 (tope de notas en la ventana)      --salida cosenos.json
 *
 * Imprime el histograma y los pares más parecidos con sus títulos, y guarda TODOS los pares ≥ min en cosenos.json
 * (subilo para que lo analice).
 */

const fs = require('fs');
const path = require('path');

const { parseArgs, norm } = require('./comparar/utilidades');
const { SAME_STORY_COSINE, SAME_STORY_JUDGE_MIN_COSINE } = require('../utils/eligibility');

const MIN_POR_DEFECTO = 0.76;
const MAX_PARES_POR_DEFECTO = 60;
const MAX_NOTAS_POR_DEFECTO = 1500;
const HORAS_POR_DEFECTO = 24;

// Cortes del histograma, de mayor a menor: incluyen los dos umbrales reales del motor.
const CORTES = [...new Set([0.95, 0.92, SAME_STORY_COSINE, 0.84, SAME_STORY_JUDGE_MIN_COSINE, 0.76, 0.72, 0.68])]
  .sort((a, b) => b - a);

// ---------------------------------------------------------------- lógica pura (se prueba sin Mongo)

/** Cómo trata el motor a un par con este coseno. */
function zonaDeCoseno(coseno) {
  if (coseno >= SAME_STORY_COSINE) return 'MISMA';
  if (coseno >= SAME_STORY_JUDGE_MIN_COSINE) return 'BANDA';
  return 'DISTINTA';
}

/** El vector, normalizado a largo 1 (así el coseno es un producto escalar). null si no sirve. */
function normalizar(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const salida = new Float64Array(vector.length);
  let suma = 0;
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    salida[i] = x;
    suma += x * x;
  }
  if (suma === 0) return null;
  const largo = Math.sqrt(suma);
  for (let i = 0; i < salida.length; i++) salida[i] /= largo;
  return salida;
}

function horasEntre(a, b) {
  const ta = a?.publishedAt ? new Date(a.publishedAt).getTime() : NaN;
  const tb = b?.publishedAt ? new Date(b.publishedAt).getTime() : NaN;
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((Math.abs(ta - tb) / 36e5) * 10) / 10;
}

/**
 * Coseno de todos los pares de notas (cada nota trae su `embedding`).
 *
 * @param {object[]} notas
 * @param {{min?:number}} [opciones]  min = coseno desde el que se devuelve el par
 * @returns {{
 *   notas:number, sinVector:number, otraDimension:number, paresTotales:number,
 *   histograma:{desde:number, hasta:number|null, zona:string, cantidad:number}[],
 *   pares:{a:object, b:object, coseno:number, zona:string, horasEntre:number|null}[]
 * }}  pares de mayor a menor coseno
 */
function medirPares(notas = [], { min = MIN_POR_DEFECTO } = {}) {
  const usables = [];
  let sinVector = 0;
  let otraDimension = 0;
  let dimension = 0;
  for (const nota of notas) {
    const vector = normalizar(nota?.embedding);
    if (!vector) { sinVector++; continue; }
    if (!dimension) dimension = vector.length;
    if (vector.length !== dimension) { otraDimension++; continue; }
    usables.push({ nota, vector });
  }

  const cantidades = new Array(CORTES.length).fill(0);
  const pares = [];
  let paresTotales = 0;
  for (let i = 0; i < usables.length; i++) {
    const va = usables[i].vector;
    for (let j = i + 1; j < usables.length; j++) {
      const vb = usables[j].vector;
      let dot = 0;
      for (let k = 0; k < dimension; k++) dot += va[k] * vb[k];
      paresTotales++;

      const cubo = CORTES.findIndex((corte) => dot >= corte);
      if (cubo !== -1) cantidades[cubo]++;
      if (dot >= min) pares.push({ i, j, coseno: dot });
    }
  }

  pares.sort((x, y) => y.coseno - x.coseno);
  return {
    notas: usables.length,
    sinVector,
    otraDimension,
    paresTotales,
    histograma: CORTES.map((desde, n) => ({
      desde,
      hasta: n === 0 ? null : CORTES[n - 1],
      zona: zonaDeCoseno(desde),
      cantidad: cantidades[n],
    })),
    pares: pares.map(({ i, j, coseno }) => ({
      a: usables[i].nota,
      b: usables[j].nota,
      coseno: Math.round(coseno * 1000) / 1000,
      zona: zonaDeCoseno(coseno),
      horasEntre: horasEntre(usables[i].nota, usables[j].nota),
    })),
  };
}

/** Los ids de las notas entregadas en una corrida del comparador (resultados[].articulo.id), sin repetir. */
function idsDeReporte(reporte) {
  const ids = (Array.isArray(reporte?.resultados) ? reporte.resultados : [])
    .map((r) => r?.articulo?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)];
}

/** Separa lo que se pasó por consola en ids de Mongo, urls y trozos de título. */
function clasificarReferencias(referencias = []) {
  const salida = { ids: [], urls: [], titulos: [] };
  for (const crudo of referencias) {
    const texto = String(crudo).trim();
    if (!texto) continue;
    if (/^[0-9a-f]{24}$/i.test(texto)) salida.ids.push(texto);
    else if (/^https?:\/\//i.test(texto)) salida.urls.push(texto);
    else salida.titulos.push(texto);
  }
  return salida;
}

/** ¿Nombra la nota (título o tags) este texto? Sin mayúsculas ni tildes. */
function contiene(nota, texto) {
  const buscado = norm(texto);
  if (!buscado) return true;
  return norm(`${nota?.title || ''} ${(nota?.tags || []).join(' ')}`).includes(buscado);
}

const escaparRegExp = (texto) => String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Un número mayor que cero; una bandera sin valor (--horas a secas) o un texto que no es un número no valen. */
function numeroPositivo(valor, porDefecto) {
  if (typeof valor === 'boolean' || valor === undefined || valor === null || valor === '') return porDefecto;
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

/** Las opciones numéricas de la consola, con su valor por defecto cuando faltan o están mal escritas. */
function leerParametros(args = {}) {
  const min = typeof args.min === 'boolean' || args.min === undefined || args.min === '' ? NaN : Number(args.min);
  return {
    min: Number.isFinite(min) && min >= -1 && min <= 1 ? min : MIN_POR_DEFECTO,
    maxPares: Math.floor(numeroPositivo(args['max-pares'], MAX_PARES_POR_DEFECTO)),
    horas: numeroPositivo(args.horas, HORAS_POR_DEFECTO),
    maxNotas: Math.floor(numeroPositivo(args['max-notas'], MAX_NOTAS_POR_DEFECTO)),
  };
}

/** El modo de uso: el comentario del principio de este archivo. */
function textoDeAyuda() {
  const bloque = fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//);
  return bloque ? bloque[1].replace(/^ \* ?/gm, '').trim() : 'Ver el comentario del principio de medirCosenos.js';
}

function formatearPar(par, posicion) {
  const horas = par.horasEntre === null ? '–' : par.horasEntre.toFixed(1);
  const cabecera = `${String(posicion).padStart(3)}  ${par.coseno.toFixed(3)}  ${par.zona.padEnd(8)} separadas por ${horas} h`;
  const linea = (nota) => `       ${String(nota.sourceName || '–').slice(0, 16).padEnd(16)} | ${String(nota.title || '').slice(0, 100)}`;
  return `${cabecera}\n${linea(par.a)}\n${linea(par.b)}`;
}

function formatearHistograma(medicion) {
  const filas = medicion.histograma.map((fila) => {
    const rango = fila.hasta === null ? `≥ ${fila.desde.toFixed(2)}` : `${fila.desde.toFixed(2)} – ${fila.hasta.toFixed(2)}`;
    return `  ${rango.padEnd(14)} ${fila.zona.padEnd(9)} ${String(fila.cantidad).padStart(7)}  ${'█'.repeat(Math.min(40, Math.ceil(Math.log2(fila.cantidad + 1) * 3)))}`;
  });
  return [`  ${'coseno'.padEnd(14)} ${'el motor lo trata como'.padEnd(9)}  pares`, ...filas].join('\n');
}

// ---------------------------------------------------------------- lectura de la base (solo find)

const CAMPOS = 'title url sourceName category topic tags publishedAt importanceScore embedding';

async function cargarNotas({ Article, args, ahora = Date.now() }) {
  const { horas, maxNotas } = leerParametros(args);
  if (args.reporte) {
    const ids = idsDeReporte(JSON.parse(fs.readFileSync(path.resolve(args.reporte), 'utf8')));
    if (!ids.length) throw new Error(`${args.reporte} no trae notas entregadas (resultados[].articulo.id).`);
    return {
      origen: `las ${ids.length} notas del reporte ${args.reporte}`,
      notas: await Article.find({ _id: { $in: ids } }).select(CAMPOS).lean(),
    };
  }

  if (args._.length) {
    const { ids, urls, titulos } = clasificarReferencias(args._);
    const encontradas = new Map();
    const agregar = (notas) => { for (const n of notas) encontradas.set(String(n._id), n); };
    if (ids.length) agregar(await Article.find({ _id: { $in: ids } }).select(CAMPOS).lean());
    if (urls.length) agregar(await Article.find({ url: { $in: urls } }).select(CAMPOS).lean());
    for (const titulo of titulos) {
      const nota = await Article.findOne({ title: new RegExp(escaparRegExp(titulo), 'i') }).sort({ publishedAt: -1 }).select(CAMPOS).lean();
      if (nota) encontradas.set(String(nota._id), nota);
      else console.log(`⚠ No encontré ninguna nota con "${titulo}" en el título.`);
    }
    return { origen: `las ${encontradas.size} notas que indicaste`, notas: [...encontradas.values()] };
  }

  const filtro = { publishedAt: { $gte: new Date(ahora - horas * 3600e3) }, embeddingStatus: 'done' };
  if (typeof args.categoria === 'string') filtro.category = new RegExp(`^${escaparRegExp(args.categoria)}$`, 'i');
  const traidas = await Article.find(filtro).select(CAMPOS).sort({ publishedAt: -1 }).limit(maxNotas).lean();
  const notas = typeof args.contiene === 'string' ? traidas.filter((n) => contiene(n, args.contiene)) : traidas;

  const filtros = [
    typeof args.categoria === 'string' ? `categoría ${args.categoria}` : null,
    typeof args.contiene === 'string' ? `que nombran "${args.contiene}"` : null,
  ].filter(Boolean);
  return {
    origen: `${notas.length} notas de las últimas ${horas} h${filtros.length ? ` (${filtros.join(', ')})` : ''}`
      + (traidas.length >= maxNotas ? ` — se llegó al tope de ${maxNotas} notas: las más viejas de la ventana quedaron afuera (--max-notas)` : ''),
    notas,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ayuda) {
    console.log(textoDeAyuda());
    return;
  }

  require('dotenv').config();
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI en el .env');
  const mongoose = require('mongoose');
  mongoose.set('autoIndex', false); // solo lectura: no crear índices
  mongoose.set('autoCreate', false);
  const Article = require('../models/Article');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, autoIndex: false });
  console.log('Conectado a:', mongoose.connection.name);

  try {
    const { min, maxPares } = leerParametros(args);

    const { origen, notas } = await cargarNotas({ Article, args });
    console.log(`\nMidiendo ${origen}`);
    if (notas.length < 2) {
      console.log('Hacen falta al menos 2 notas para medir un coseno.');
      return;
    }

    const medicion = medirPares(notas, { min });
    console.log(`Notas con embedding: ${medicion.notas} · sin embedding utilizable: ${medicion.sinVector}`
      + `${medicion.otraDimension ? ` · de otro modelo (otra dimensión): ${medicion.otraDimension}` : ''} · pares medidos: ${medicion.paresTotales}\n`);
    console.log('Cuántos pares hay en cada tramo de coseno:');
    console.log(formatearHistograma(medicion));

    console.log(`\nLos ${Math.min(maxPares, medicion.pares.length)} pares más parecidos de ${medicion.pares.length} con coseno ≥ ${min}:`);
    console.log('(¿cuáles son el MISMO hecho contado por dos medios? ¿a qué coseno dejan de serlo?)\n');
    medicion.pares.slice(0, maxPares).forEach((par, n) => console.log(formatearPar(par, n + 1)));

    const salida = path.resolve(typeof args.salida === 'string' ? args.salida : 'cosenos.json');
    const resumenNota = (n) => ({
      id: String(n._id), titulo: n.title, medio: n.sourceName || null, categoria: n.category || null, subtema: n.topic || null,
      publicadaEn: n.publishedAt ? new Date(n.publishedAt).toISOString() : null, url: n.url || null,
    });
    fs.writeFileSync(salida, JSON.stringify({
      generado: new Date().toISOString(),
      origen,
      umbrales: { mismaHistoria: SAME_STORY_COSINE, bandaDelJuez: SAME_STORY_JUDGE_MIN_COSINE },
      min,
      notas: medicion.notas,
      sinEmbedding: medicion.sinVector,
      otraDimension: medicion.otraDimension,
      paresMedidos: medicion.paresTotales,
      histograma: medicion.histograma,
      pares: medicion.pares.map((p) => ({ coseno: p.coseno, zona: p.zona, horasEntre: p.horasEntre, a: resumenNota(p.a), b: resumenNota(p.b) })),
    }, null, 2));
    console.log(`\nListo: ${salida}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

module.exports = {
  cargarNotas,
  CORTES,
  zonaDeCoseno,
  normalizar,
  horasEntre,
  medirPares,
  idsDeReporte,
  clasificarReferencias,
  contiene,
  leerParametros,
  textoDeAyuda,
  formatearPar,
  formatearHistograma,
};
