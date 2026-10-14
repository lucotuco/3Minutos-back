'use strict';

/**
 * Qué temas se prueban.
 *  - Oficiales: la taxonomía de pickBestArticlePerTopic.js (7 categorías + sus subtemas).
 *  - Libres: los más pedidos según user_preferences (usuarios activos). Si no hay datos,
 *    se usa una lista de ejemplo (SOLO para poder probar en una base vacía).
 */

const fs = require('fs');
const path = require('path');
const { norm } = require('./utilidades');

// Espejo de CATEGORIES en src/utils/pickBestArticlePerTopic.js.
// verificarOficialesContraCodigo() avisa si el código cambió y esto quedó desactualizado.
const CATEGORIAS = {
  'Política': ['Gobierno Nacional', 'Justicia', 'Elecciones', 'Educación', 'Seguridad'],
  'Economía': ['Dólar y Mercados', 'Inflación y Consumo', 'Empresas y Negocios', 'Inversiones', 'Emprendedores'],
  'Internacional': ['EEUU', 'Medio Oriente', 'Europa', 'América Latina', 'Conflictos', 'Geopolítica'],
  'Deportes': ['Fútbol', 'F1', 'Básquet', 'Tenis', 'Rugby'],
  'Sociedad': ['Salud', 'Bienestar', 'Clima y Ambiente', 'Historias Humanas', 'Tendencias y Vida'],
  'Tecnología': ['Inteligencia Artificial', 'Ciencia y Espacio', 'Apps y Redes', 'Innovación', 'Videojuegos'],
  'Entretenimiento/Cultura': ['Cine y Series', 'Música', 'Turismo y Viajes', 'Streaming', 'Autos', 'Viral y Trending', 'Teatro y Literatura'],
};

// Solo para probar sin datos reales. La lista de verdad sale de la base.
const TEMAS_LIBRES_EJEMPLO = [
  'river plate', 'boca juniors', 'racing club', 'independiente', 'san lorenzo', 'selección argentina',
  'messi', 'mundial 2026', 'colapinto', 'milei', 'cristina kirchner', 'kicillof', 'bullrich',
  'dólar blue', 'inflación', 'jubilaciones', 'aguinaldo', 'paro de colectivos', 'bitcoin', 'nvidia',
  'tesla', 'apple', 'openai', 'trump', 'israel', 'ucrania', 'china', 'venezuela', 'brasil',
  'netflix', 'taylor swift', 'nba', 'champions league', 'copa libertadores', 'clima buenos aires',
  'universidad pública', 'reforma laboral', 'rosario', 'córdoba', 'mendoza',
];

function temasOficiales() {
  const lista = [];
  for (const [categoria, subtemas] of Object.entries(CATEGORIAS)) {
    lista.push({ tema: categoria, tipo: 'oficial', nivel: 'categoria', categoria });
    for (const sub of subtemas) lista.push({ tema: sub, tipo: 'oficial', nivel: 'subtema', categoria });
  }
  return lista;
}

/** Devuelve los nombres oficiales que NO aparecen escritos en el código de la versión probada. */
function verificarOficialesContraCodigo(root) {
  const archivo = path.join(root, 'src', 'utils', 'pickBestArticlePerTopic.js');
  if (!fs.existsSync(archivo)) return { archivo, faltantes: null };
  const fuente = fs.readFileSync(archivo, 'utf8');
  const faltantes = temasOficiales()
    .map((t) => t.tema)
    .filter((t) => !fuente.includes(`'${t}'`) && !fuente.includes(`"${t}"`));
  return { archivo, faltantes };
}

async function leerTemasLibresDesdeMongo(UserPreference, setOficiales, top) {
  const filas = await UserPreference.aggregate([
    { $match: { isActive: { $ne: false } } },
    { $unwind: '$topics' },
    { $group: { _id: '$topics', usuarios: { $sum: 1 } } },
  ]);

  const agrupado = new Map();
  for (const fila of filas) {
    const original = String(fila._id || '').trim();
    const clave = norm(original).replace(/\s+/g, ' ');
    if (!clave || setOficiales.has(clave)) continue;

    const previo = agrupado.get(clave) || { tema: original, usuarios: 0, mayorVariante: 0 };
    previo.usuarios += fila.usuarios;
    if (fila.usuarios > previo.mayorVariante) {
      previo.tema = original; // se conserva la grafía más usada
      previo.mayorVariante = fila.usuarios;
    }
    agrupado.set(clave, previo);
  }

  const ordenados = [...agrupado.values()].sort(
    (a, b) => b.usuarios - a.usuarios || a.tema.localeCompare(b.tema, 'es')
  );
  const total = ordenados.reduce((acc, t) => acc + t.usuarios, 0);
  const elegidos = ordenados.slice(0, top);
  const cubierto = elegidos.reduce((acc, t) => acc + t.usuarios, 0);

  return {
    lista: elegidos.map(({ tema, usuarios }) => ({ tema, usuarios })),
    distintosEnBase: ordenados.length,
    cobertura: total ? cubierto / total : null,
  };
}

/**
 * @param {object}   o
 * @param {string[]} [o.libresManual]   --temas-libres "a,b,c"
 * @param {string}   [o.archivoTemas]   un tema por línea
 * @param {number}   [o.top]
 * @param {boolean}  [o.rapido]
 * @param {object}   [o.UserPreference] modelo de mongoose (si hay conexión)
 */
async function construirTemas({ libresManual, archivoTemas, top = 150, rapido = false, UserPreference = null }) {
  let oficiales = temasOficiales();
  const setOficiales = new Set(oficiales.map((t) => norm(t.tema).replace(/\s+/g, ' ')));

  let libres = [];
  let origenLibres = 'ninguno';
  let detalle = {};

  if (libresManual && libresManual.length) {
    libres = libresManual.map((tema) => ({ tema: tema.trim(), usuarios: null }));
    origenLibres = 'manual (--temas-libres)';
  } else if (archivoTemas) {
    libres = fs.readFileSync(archivoTemas, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .map((tema) => ({ tema, usuarios: null }));
    origenLibres = `archivo (${path.basename(archivoTemas)})`;
  } else if (UserPreference) {
    const r = await leerTemasLibresDesdeMongo(UserPreference, setOficiales, top);
    libres = r.lista;
    origenLibres = 'user_preferences (usuarios activos)';
    detalle = { distintosEnBase: r.distintosEnBase, cobertura: r.cobertura };
  }

  if (!libres.length) {
    libres = TEMAS_LIBRES_EJEMPLO.map((tema) => ({ tema, usuarios: null }));
    origenLibres = 'lista de ejemplo (no había datos en user_preferences)';
  }

  // Sin oficiales, sin vacíos y sin duplicados.
  const vistos = new Set();
  libres = libres.filter(({ tema }) => {
    const k = norm(tema).replace(/\s+/g, ' ');
    if (!k || setOficiales.has(k) || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  }).slice(0, top);

  if (rapido) {
    const categorias = oficiales.filter((t) => t.nivel === 'categoria');
    const primerSub = Object.keys(CATEGORIAS).map((c) => oficiales.find((t) => t.categoria === c && t.nivel === 'subtema'));
    oficiales = [...categorias, ...primerSub];
    libres = libres.slice(0, 15);
  }

  return {
    generadoEn: new Date().toISOString(),
    origenLibres,
    ...detalle,
    oficiales,
    libres: libres.map((l) => ({ tipo: 'libre', nivel: 'libre', categoria: null, ...l })),
  };
}

module.exports = {
  CATEGORIAS,
  TEMAS_LIBRES_EJEMPLO,
  temasOficiales,
  verificarOficialesContraCodigo,
  construirTemas,
};
