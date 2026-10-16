'use strict';

/**
 * Utilidades chicas compartidas por el comparador (sin dependencias del proyecto).
 */

const BANDERAS = new Set([
  'rapido', 'sin-juez', 'forzar', 'abrir', 'ayuda', 'reusar-temas', 'sin-mongo',
]);

/**
 * Parser mínimo:  comando --clave valor --clave=valor --bandera
 * Las banderas conocidas (BANDERAS) nunca consumen el argumento siguiente.
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }

    const eq = a.indexOf('=');
    if (eq > -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }

    const clave = a.slice(2);
    const siguiente = argv[i + 1];
    if (!BANDERAS.has(clave) && siguiente !== undefined && !siguiente.startsWith('--')) {
      out[clave] = siguiente;
      i++;
    } else {
      out[clave] = true;
    }
  }
  return out;
}

function norm(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function redondear(n, decimales = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** decimales;
  return Math.round(n * f) / f;
}

module.exports = { parseArgs, norm, sleep, redondear };
