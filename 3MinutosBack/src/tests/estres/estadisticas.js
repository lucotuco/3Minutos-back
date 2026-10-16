'use strict';

/**
 * Estadística y utilidades puras del test de estrés (sin Mongo, sin OpenAI, sin reloj).
 * Todo lo que está acá se prueba en src/tests/unit/estres.test.js.
 */

const { norm } = require('../comparar/utilidades');

const finitos = (valores) => (valores || []).filter((x) => typeof x === 'number' && Number.isFinite(x));

/** Percentil por "rango más cercano" (p entre 0 y 100). null si no hay datos. */
function percentil(valores, p) {
  const v = finitos(valores).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}

function resumenLatencias(valores) {
  const v = finitos(valores);
  if (!v.length) return { n: 0, min: null, p50: null, p95: null, p99: null, max: null, media: null };
  let min = Infinity;
  let max = -Infinity;
  let suma = 0;
  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
    suma += x;
  }
  return { n: v.length, min, p50: percentil(v, 50), p95: percentil(v, 95), p99: percentil(v, 99), max, media: Math.round(suma / v.length) };
}

const porcentaje = (parte, total) => (total ? (100 * parte) / total : 0);

/** Valor más frecuente (ignora null/undefined). En empate gana el que apareció primero. */
function moda(valores) {
  const cuenta = new Map();
  let total = 0;
  for (const v of valores || []) {
    if (v === null || v === undefined) continue;
    total++;
    cuenta.set(v, (cuenta.get(v) || 0) + 1);
  }
  let mejor = { valor: null, cuenta: 0, total };
  for (const [valor, n] of cuenta) if (n > mejor.cuenta) mejor = { valor, cuenta: n, total };
  return mejor;
}

/** Cuántas veces cambia el valor entre elementos consecutivos (null cuenta como un valor más). */
function transiciones(valores) {
  let cambios = 0;
  for (let i = 1; i < valores.length; i++) {
    if ((valores[i] ?? '∅') !== (valores[i - 1] ?? '∅')) cambios++;
  }
  return cambios;
}

function conteo(valores) {
  const m = new Map();
  for (const v of valores || []) {
    const k = v === null || v === undefined ? '(ninguno)' : String(v);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries(m);
}

function agrupar(items, claveDe) {
  const m = new Map();
  for (const it of items || []) {
    const k = claveDe(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

/** Pendiente de la recta de mínimos cuadrados y = a + b·x. Devuelve b (0 si hay menos de 2 puntos). */
function pendiente(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** PRNG determinístico (mulberry32): misma semilla, misma muestra. */
function mulberry32(semilla) {
  let a = (Number(semilla) || 1) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function barajar(arr, rng = Math.random) {
  const copia = [...arr];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

const muestrear = (arr, n, rng = Math.random) => barajar(arr, rng).slice(0, Math.max(0, n));

/** Todas las permutaciones (para 3 tópicos son 6). */
function permutaciones(arr) {
  if (arr.length <= 1) return [[...arr]];
  const salida = [];
  arr.forEach((x, i) => {
    const resto = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutaciones(resto)) salida.push([x, ...p]);
  });
  return salida;
}

function coseno(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const PALABRAS_VACIAS = new Set(['del', 'los', 'las', 'una', 'uno', 'con', 'sin', 'por', 'para', 'que', 'como', 'sus', 'este', 'esta', 'ese', 'esa']);

function tokensTitulo(titulo) {
  const set = new Set();
  for (const t of norm(titulo).replace(/[^a-z0-9ñ]+/g, ' ').split(' ')) {
    if (t.length >= 3 && !PALABRAS_VACIAS.has(t)) set.add(t);
  }
  return set;
}

/** Jaccard de palabras del título (0-1). Aproxima "misma historia" cuando no hay embeddings. */
function similitudTitulos(a, b) {
  const A = tokensTitulo(a);
  const B = tokensTitulo(b);
  if (!A.size || !B.size) return 0;
  let comunes = 0;
  for (const t of A) if (B.has(t)) comunes++;
  return comunes / (A.size + B.size - comunes);
}

const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

module.exports = {
  percentil, resumenLatencias, porcentaje, moda, transiciones, conteo, agrupar, pendiente,
  mulberry32, barajar, muestrear, permutaciones, coseno, tokensTitulo, similitudTitulos, mb,
};
