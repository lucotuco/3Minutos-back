#!/usr/bin/env node
'use strict';

/**
 * verificarFuentes.js  (SOLO LECTURA: no toca Mongo ni Sources.json)
 *
 * Prueba una lista de feeds RSS candidatos con LA MISMA lectura que la ingesta (rss-parser con los mismos campos) y la
 * MISMA extracción de imagen (adapter/rssAdapter.js), y arma las entradas listas para pegar en src/Sources.json
 * solo con los que andan.
 *
 * Un feed pasa si:
 *   - responde y es RSS/Atom válido (sin User-Agent especial: la ingesta tampoco lo manda)
 *   - trae al menos MIN_ITEMS ítems
 *   - al menos MIN_CON_IMAGEN de los ítems tiene imagen (las notas sin imagen la ingesta las descarta)
 *   - el ítem más nuevo tiene menos de MAX_HORAS_ULTIMO horas (si no, el feed está muerto)
 * Para cada medio se prueban sus URLs alternativas en orden y se queda la primera que pasa.
 * Los feeds que ya están en Sources.json se saltean.
 *
 * Uso (desde la carpeta 3MinutosBack):
 *   node src/tests/verificarFuentes.js
 *   node src/tests/verificarFuentes.js --salida fuentes_nuevas.json
 *   node src/tests/verificarFuentes.js --ronda2 --salida fuentes_ronda2.json
 *
 * Genera fuentes_nuevas.json (o el archivo que digas): un array listo para copiar dentro de Sources.json.
 */

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const { adaptRssArticle } = require('../ingestion/adapter/rssAdapter');

// Igual que runRssIngestion.js
const parser = new Parser({
  timeout: 30000,
  customFields: {
    item: [
      ['media:content', 'media:content'],
      ['media:thumbnail', 'media:thumbnail'],
      ['image:image', 'image:image'],
      ['content:encoded', 'content:encoded'],
      ['enclosure', 'reformaEnclosure'],
    ],
  },
});

// La imagen "de relleno" del adaptador = sin imagen (la ingesta descarta esas notas).
const FALLBACK_IMAGE_URL = 'https://st2.depositphotos.com/1036149/5381/i/950/depositphotos_53811511-stock-illustration-duck-with-sunglasses.jpg';

const MIN_ITEMS = 5;
const MIN_CON_IMAGEN = 0.7;
const MAX_HORAS_ULTIMO = 72;
const CONCURRENCIA = 6;

/**
 * Candidatos. `urls` en orden de preferencia: se queda la primera que pasa.
 * `category` usa el mismo vocabulario que Sources.json (es solo informativo: la categoría real la pone la IA).
 * Las URLs son las que publican los medios o las de sus plataformas (Arc, WordPress); el script dice cuáles andan.
 */
const CANDIDATOS = [
  // ---------------------------------------------------------------- huecos en medios que ya están
  { name: 'Infobae Economía', category: 'economy', priority: 2, urls: ['https://www.infobae.com/arc/outboundfeeds/rss/category/economia/?outputType=xml'] },
  { name: 'Infobae Sociedad', category: 'society', priority: 3, urls: ['https://www.infobae.com/arc/outboundfeeds/rss/category/sociedad/?outputType=xml'] },
  { name: 'Infobae Teleshow', category: 'entertainment', priority: 4, urls: ['https://www.infobae.com/arc/outboundfeeds/rss/category/teleshow/?outputType=xml'] },
  { name: 'Infobae Turismo', category: 'lifestyle', priority: 5, urls: ['https://www.infobae.com/arc/outboundfeeds/rss/category/turismo/?outputType=xml'] },
  { name: 'Infobae Cultura', category: 'entertainment', priority: 5, urls: ['https://www.infobae.com/arc/outboundfeeds/rss/category/cultura/?outputType=xml'] },
  { name: 'Infobae Salud', category: 'society', priority: 5, urls: ['https://www.infobae.com/arc/outboundfeeds/rss/category/salud/?outputType=xml'] },
  { name: 'La Nación Deportes', category: 'sports', priority: 3, urls: ['https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/deportes/?outputType=xml'] },
  { name: 'La Nación Cultura', category: 'entertainment', priority: 5, urls: ['https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/cultura/?outputType=xml'] },
  { name: 'La Nación Turismo', category: 'lifestyle', priority: 5, urls: [
    'https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/turismo/?outputType=xml',
    'https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/revista-lugares/?outputType=xml',
  ] },
  { name: 'La Nación Ciencia', category: 'tech', priority: 5, urls: ['https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/ciencia/?outputType=xml'] },
  { name: 'La Nación Campo', category: 'economy', priority: 5, urls: ['https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/economia/campo/?outputType=xml'] },
  { name: 'Clarin Tenis', category: 'deportes', priority: 5, urls: ['https://www.clarin.com/rss/deportes/tenis/'] },
  { name: 'Clarin Rugby', category: 'deportes', priority: 5, urls: ['https://www.clarin.com/rss/deportes/rugby/'] },
  { name: 'Clarin Automovilismo', category: 'deportes', priority: 5, urls: ['https://www.clarin.com/rss/deportes/automovilismo/'] },
  { name: 'Ole Automovilismo', category: 'deportes', priority: 5, urls: ['http://www.ole.com.ar/rss/automovilismo/', 'http://www.ole.com.ar/rss/formula-1/'] },
  { name: 'Perfil Deportes', category: 'sports', priority: 5, urls: ['https://www.perfil.com/feed/deportes'] },
  { name: 'Perfil Cultura', category: 'entertainment', priority: 5, urls: ['https://www.perfil.com/feed/cultura'] },
  { name: 'Perfil Ciencia', category: 'tech', priority: 5, urls: ['https://www.perfil.com/feed/ciencia'] },
  { name: 'Perfil Tecnología', category: 'tech', priority: 5, urls: ['https://www.perfil.com/feed/tecnologia'] },
  { name: 'Parabrisas', category: 'autos', priority: 6, urls: ['https://parabrisas.perfil.com/feed'] },

  // ---------------------------------------------------------------- diversidad editorial
  { name: 'Página/12 Portada', category: 'general', priority: 3, urls: ['https://www.pagina12.com.ar/rss/portada'] },
  { name: 'Página/12 El País', category: 'politics', priority: 3, urls: ['https://www.pagina12.com.ar/rss/secciones/el-pais/notas'] },
  { name: 'Página/12 Economía', category: 'economy', priority: 3, urls: ['https://www.pagina12.com.ar/rss/secciones/economia/notas'] },
  { name: 'Página/12 Sociedad', category: 'society', priority: 4, urls: ['https://www.pagina12.com.ar/rss/secciones/sociedad/notas'] },
  { name: 'Página/12 Cultura', category: 'entertainment', priority: 5, urls: ['https://www.pagina12.com.ar/rss/secciones/cultura/notas'] },
  { name: 'Página/12 Deportes', category: 'sports', priority: 5, urls: ['https://www.pagina12.com.ar/rss/secciones/deportes/notas'] },
  { name: 'elDiarioAR', category: 'general', priority: 3, urls: ['https://www.eldiarioar.com/rss/', 'https://www.eldiarioar.com/rss'] },
  { name: 'Tiempo Argentino', category: 'general', priority: 4, urls: ['https://www.tiempoar.com.ar/feed/'] },
  { name: 'El Destape', category: 'general', priority: 4, urls: ['https://www.eldestapeweb.com/rss/', 'https://www.eldestapeweb.com/arc/outboundfeeds/rss/?outputType=xml'] },
  { name: 'Chequeado', category: 'politics', priority: 4, urls: ['https://chequeado.com/feed/'] },
  { name: 'Noticias Argentinas', category: 'general', priority: 4, urls: ['https://noticiasargentinas.com/rss', 'https://noticiasargentinas.com/feed'] },

  // ---------------------------------------------------------------- interior
  { name: 'La Voz', category: 'general', priority: 3, urls: ['https://www.lavoz.com.ar/arc/outboundfeeds/rss/?outputType=xml', 'https://www.lavoz.com.ar/rss'] },
  { name: 'Los Andes', category: 'general', priority: 4, urls: ['https://www.losandes.com.ar/arc/outboundfeeds/rss/?outputType=xml', 'https://www.losandes.com.ar/rss'] },
  { name: 'La Capital Rosario', category: 'general', priority: 4, urls: ['https://www.lacapital.com.ar/rss/home.xml', 'https://www.lacapital.com.ar/rss/'] },
  { name: 'Río Negro', category: 'general', priority: 5, urls: ['https://www.rionegro.com.ar/feed/'] },
  { name: 'El Litoral', category: 'general', priority: 5, urls: ['https://www.ellitoral.com/rss/um.xml', 'https://www.ellitoral.com/rss'] },
  { name: 'La Gaceta Tucumán', category: 'general', priority: 5, urls: ['https://www.lagaceta.com.ar/rss/ultimo-momento.xml', 'https://www.lagaceta.com.ar/rss'] },

  // ---------------------------------------------------------------- deportes de nicho
  { name: 'La Legión Argentina (tenis)', category: 'deportes', priority: 5, urls: ['https://lalegionargentina.com.ar/feed/'] },
  { name: 'TyC Sports', category: 'deportes', priority: 4, urls: ['https://www.tycsports.com/rss/', 'https://www.tycsports.com/rss.xml'] },
  { name: 'Carburando', category: 'deportes', priority: 5, urls: ['https://www.carburando.com/rss', 'https://www.carburando.com/rss.xml', 'https://www.carburando.com/feed/'] },
  { name: 'Campeones', category: 'deportes', priority: 5, urls: ['https://campeones.com.ar/feed/'] },
  { name: 'Motorsport F1 (latam)', category: 'deportes', priority: 5, urls: ['https://lat.motorsport.com/rss/f1/news/'] },
  { name: 'Rugby Champagne', category: 'deportes', priority: 6, urls: ['https://www.rugbychampagneweb.com/feed/'] },
  { name: 'DeporTV', category: 'deportes', priority: 6, urls: ['https://deportv.gob.ar/rss', 'https://deportv.gob.ar/feed'] },

  // ---------------------------------------------------------------- negocios, emprendedores, campo
  { name: 'iProfesional', category: 'economy', priority: 4, urls: ['https://www.iprofesional.com/rss', 'https://www.iprofesional.com/rss/home'] },
  { name: 'iProfesional Tecnología', category: 'tech', priority: 5, urls: ['https://www.iprofesional.com/rss/tecnologia'] },
  { name: 'iProfesional Negocios', category: 'business', priority: 5, urls: ['https://www.iprofesional.com/rss/negocios'] },
  { name: 'Forbes Argentina', category: 'business', priority: 5, urls: ['https://www.forbesargentina.com/rss', 'https://www.forbesargentina.com/feed'] },
  { name: 'Infocampo', category: 'economy', priority: 6, urls: ['https://www.infocampo.com.ar/feed/'] },
  { name: 'InfoNegocios', category: 'business', priority: 6, urls: ['https://infonegocios.info/rss', 'https://infonegocios.info/feed'] },

  // ---------------------------------------------------------------- ciencia, tecnología, cultura
  { name: 'Agencia CyTA (Leloir)', category: 'tech', priority: 5, urls: ['https://agenciacyta.org.ar/feed/'] },
  { name: 'CONICET', category: 'tech', priority: 6, urls: ['https://www.conicet.gov.ar/feed/'] },
  { name: 'RedUSERS', category: 'tech', priority: 6, urls: ['https://www.redusers.com/noticias/feed/'] },
  { name: 'Hipertextual', category: 'tech', priority: 6, urls: ['https://hipertextual.com/feed'] },
  { name: 'Xataka', category: 'tech', priority: 6, urls: ['https://www.xataka.com/feedburner.xml', 'https://feeds.weblogssl.com/xataka2'] },
  { name: 'Rolling Stone Argentina', category: 'entretenimiento', priority: 5, urls: ['https://www.rollingstone.com.ar/feed/', 'https://www.rollingstone.com.ar/arc/outboundfeeds/rss/?outputType=xml'] },
  { name: 'Otros Cines', category: 'entretenimiento', priority: 6, urls: ['https://www.otroscines.com/feed/'] },
];

/**
 * Ronda 2 (node src/tests/verificarFuentes.js --ronda2): solo medios de alta confianza, apuntando a los huecos que
 * quedaron después de la ronda 1 (tenis, rugby, automovilismo, Página/12, internacional en español, negocios).
 */
const CANDIDATOS_RONDA2 = [
  { name: 'Infobae Tenis', category: 'sports', priority: 2, urls: ['https://www.infobae.com/arc/outboundfeeds/rss/category/deportes/tenis/?outputType=xml'] },
  { name: 'Infobae Rugby', category: 'sports', priority: 2, urls: ['https://www.infobae.com/arc/outboundfeeds/rss/category/deportes/rugby/?outputType=xml'] },
  { name: 'Infobae Automovilismo', category: 'sports', priority: 2, urls: [
    'https://www.infobae.com/arc/outboundfeeds/rss/category/deportes/automovilismo/?outputType=xml',
    'https://www.infobae.com/arc/outboundfeeds/rss/category/deportes/formula-1/?outputType=xml',
  ] },
  { name: 'La Nación Tenis', category: 'sports', priority: 2, urls: ['https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/deportes/tenis/?outputType=xml'] },
  { name: 'La Nación Rugby', category: 'sports', priority: 2, urls: ['https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/deportes/rugby/?outputType=xml'] },
  { name: 'La Nación Automovilismo', category: 'sports', priority: 2, urls: ['https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/deportes/automovilismo/?outputType=xml'] },
  { name: 'Página/12', category: 'general', priority: 2, urls: [
    'https://www.pagina12.com.ar/arc/outboundfeeds/rss/?outputType=xml',
    'https://www.pagina12.com.ar/rss/ultimas-noticias',
    'https://www.pagina12.com.ar/rss/portada/',
  ] },
  { name: 'Bloomberg Línea', category: 'economy', priority: 2, urls: [
    'https://www.bloomberglinea.com/arc/outboundfeeds/rss/category/latinoamerica/argentina/?outputType=xml',
    'https://www.bloomberglinea.com/arc/outboundfeeds/rss/?outputType=xml',
  ] },
  { name: 'BBC Mundo', category: 'world', priority: 2, urls: ['https://feeds.bbci.co.uk/mundo/rss.xml'] },
  { name: 'DW Español', category: 'world', priority: 2, urls: ['https://rss.dw.com/xml/rss-sp-all'] },
  { name: 'France 24 Español', category: 'world', priority: 2, urls: ['https://www.france24.com/es/rss'] },
];

// ---------------------------------------------------------------- verificación

function horasDesde(fecha) {
  const t = new Date(fecha).getTime();
  return Number.isFinite(t) ? (Date.now() - t) / 3600e3 : null;
}

async function probarUrl(url, candidato) {
  const t0 = Date.now();
  let feed;
  try {
    feed = await parser.parseURL(url);
  } catch (error) {
    return { url, ok: false, motivo: `no responde o no es RSS: ${String(error.message).slice(0, 90)}` };
  }

  const items = feed.items || [];
  const adaptados = items.map((item) => adaptRssArticle(item, { name: candidato.name, url, category: candidato.category }));
  const conImagen = adaptados.filter((a) => a.imageUrl && a.imageUrl !== FALLBACK_IMAGE_URL).length;
  const fechas = adaptados.map((a) => horasDesde(a.publishedAt)).filter((h) => h !== null);
  const ultimoHoras = fechas.length ? Math.min(...fechas) : null;

  const r = {
    url,
    items: items.length,
    conImagen,
    pctImagen: items.length ? conImagen / items.length : 0,
    conFecha: fechas.length,
    ultimoHoras,
    ejemploTitulo: adaptados[0]?.title || '',
    ejemploImagen: adaptados.find((a) => a.imageUrl !== FALLBACK_IMAGE_URL)?.imageUrl || null,
    ms: Date.now() - t0,
  };

  if (items.length < MIN_ITEMS) return { ...r, ok: false, motivo: `solo ${items.length} ítems` };
  if (r.pctImagen < MIN_CON_IMAGEN) return { ...r, ok: false, motivo: `solo ${Math.round(r.pctImagen * 100)}% con imagen` };
  if (ultimoHoras === null) return { ...r, ok: false, motivo: 'sin fechas de publicación' };
  if (ultimoHoras > MAX_HORAS_ULTIMO) return { ...r, ok: false, motivo: `el último ítem tiene ${Math.round(ultimoHoras)} h` };
  return { ...r, ok: true, motivo: null };
}

async function probarCandidato(candidato) {
  const intentos = [];
  for (const url of candidato.urls) {
    const r = await probarUrl(url, candidato);
    intentos.push(r);
    if (r.ok) return { candidato, elegido: r, intentos };
  }
  return { candidato, elegido: null, intentos };
}

async function enLotes(lista, n, fn) {
  const out = new Array(lista.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < lista.length) {
      const k = i++;
      out[k] = await fn(lista[k]);
    }
  }));
  return out;
}

// ---------------------------------------------------------------- principal

async function main() {
  const argv = process.argv.slice(2);
  const iSalida = argv.indexOf('--salida');
  const salida = iSalida >= 0 ? argv[iSalida + 1] : 'fuentes_nuevas.json';

  const sourcesPath = path.join(__dirname, '..', 'Sources.json');
  const existentes = new Set(JSON.parse(fs.readFileSync(sourcesPath, 'utf8')).map((s) => String(s.url).trim()));

  const lista = argv.includes('--ronda2') ? CANDIDATOS_RONDA2 : CANDIDATOS;
  const aProbar = lista
    .map((c) => ({ ...c, urls: c.urls.filter((u) => !existentes.has(u)) }))
    .filter((c) => c.urls.length);

  console.log(`Probando ${aProbar.length} medios (${aProbar.reduce((n, c) => n + c.urls.length, 0)} URLs), ${CONCURRENCIA} a la vez...`);
  console.log(`Pasa si: >= ${MIN_ITEMS} ítems, >= ${MIN_CON_IMAGEN * 100}% con imagen (misma extracción que la ingesta), último ítem < ${MAX_HORAS_ULTIMO} h\n`);

  const resultados = await enLotes(aProbar, CONCURRENCIA, probarCandidato);

  const pasan = resultados.filter((r) => r.elegido);
  const fallan = resultados.filter((r) => !r.elegido);

  console.log(`PASAN (${pasan.length})`);
  for (const { candidato, elegido } of pasan) {
    console.log(`  ✔ ${candidato.name.padEnd(30)} ${String(elegido.items).padStart(3)} ítems  ` +
      `${String(Math.round(elegido.pctImagen * 100)).padStart(3)}% img  último ${elegido.ultimoHoras.toFixed(1)} h  ${elegido.url}`);
  }
  console.log(`\nNO PASAN (${fallan.length})`);
  for (const { candidato, intentos } of fallan) {
    console.log(`  ✘ ${candidato.name.padEnd(30)} ${intentos.map((i) => i.motivo).join(' | ')}`);
  }

  const entradas = pasan.map(({ candidato, elegido }) => ({
    name: candidato.name,
    type: 'rss',
    url: elegido.url,
    category: candidato.category,
    country: 'ar',
    priority: candidato.priority,
    active: true,
  }));

  fs.writeFileSync(salida, `${JSON.stringify(entradas, null, 2)}\n`);
  fs.writeFileSync(salida.replace(/\.json$/, '') + '_detalle.json', JSON.stringify(resultados, null, 2));
  console.log(`\nListo: ${entradas.length} entradas en ${salida} (para pegar dentro del array de src/Sources.json).`);
  console.log(`El detalle de cada intento quedó en ${salida.replace(/\.json$/, '')}_detalle.json`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { probarUrl, CANDIDATOS, CANDIDATOS_RONDA2 };
