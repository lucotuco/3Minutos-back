'use strict';

/**
 * Parser de argumentos del CLI de estrés.
 *   comando --clave valor --clave=valor --bandera
 * Las banderas conocidas nunca consumen el argumento siguiente.
 */

const BANDERAS = new Set([
  'dry-run', 'si', 'ayuda', 'h', 'abrir', 'cache-openai', 'sin-usuarios', 'sin-estatico', 'seguir-tras-quiebre',
]);

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

/** "a, b ,c" -> ['a','b','c'] (sin vacíos). */
const lista = (valor) => (typeof valor === 'string' ? valor.split(',').map((x) => x.trim()).filter(Boolean) : []);

module.exports = { parseArgs, lista, BANDERAS };
