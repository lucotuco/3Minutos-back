'use strict';

/**
 * Tests de cómo el texto de las notas entra al sistema: adaptadores de los feeds, el paso que rescata las notas
 * cortas (prepareRssItems), el texto que se manda a embeddings y las palabras que ven las anclas.
 * Los items de ejemplo tienen la forma real de Infobae, Perfil y Clarín (sacados de los reportes del comparador).
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { adaptRssArticle } = require('../../ingestion/adapter/rssAdapter');
const { adaptNewsApiArticle } = require('../../ingestion/adapter/newsApiAdapter');
const {
  prepareRssItems, RESCUE_BELOW_CHARS, MIN_KEEP_CHARS, RESCUE_PAUSE_MS,
} = require('../../ingestion/prepareRssItems');
const { buildEmbeddingText, EMBEDDING_SUMMARY_MAX_CHARS } = require('../../embeddings/buildEmbeddingsText');
const { matchesAnchors } = require('../../utils/topicMatching');

const FUENTE = { name: 'Infobae', url: 'https://www.infobae.com/feeds/rss/', category: 'Economía', country: 'ar', language: 'es' };

const IMG_INFOBAE = '<img src="https://www.infobae.com/resizer/v2/PJ42V67YKFGLZF5V4KY4FWVLQM.JPG?auth=a88d0a4bfa9ededd841c0af6e98a2bb32dc89f9ba759588dd73a4df394d13ed8&smart=true&width=4000&height=2668" alt="El dólar abrió" height="2668" width="4000"/>';
const PARRAFO = 'El dólar abrió este viernes en Colombia con compras de reservas del Banco de la República y una jornada de mucha volatilidad.';

// ================================================================= adaptador RSS
test('RSS: el resumen sale en texto plano (la imagen del principio no cuenta)', () => {
  const nota = adaptRssArticle({
    title: 'Dólar hoy', link: 'https://www.infobae.com/colombia/2026/10/16/dolar/', pubDate: 'Fri, 16 Oct 2026 12:00:00 GMT',
    content: `${IMG_INFOBAE}<p>${PARRAFO}</p>`,
    contentSnippet: PARRAFO,
  }, FUENTE);
  assert.equal(nota.rawSummary, PARRAFO);
  assert.equal(nota.contentSnippet, PARRAFO);
});

test('RSS: las entidades numéricas del resumen se convierten en letras', () => {
  const nota = adaptRssArticle({
    title: 'Sarampión', link: 'https://x.test/1',
    content: 'Estados Unidos registr&#xF3; m&#xE1;s de 4.000 contagios de sarampi&#xF3;n en 2026, la cifra m&#xE1;s alta desde 1990.',
  }, FUENTE);
  assert.equal(nota.rawSummary, 'Estados Unidos registró más de 4.000 contagios de sarampión en 2026, la cifra más alta desde 1990.');
});

test('RSS: si el campo principal es solo una imagen, se usa el siguiente con texto', () => {
  const nota = adaptRssArticle({
    title: 'Nota', link: 'https://x.test/2',
    content: '<p><img src="https://fotos.perfil.com/a.jpg" alt="Foto" /></p>',
    'content:encoded': `<p>${PARRAFO}</p>`,
    description: 'Texto corto.',
  }, FUENTE);
  assert.equal(nota.rawSummary, PARRAFO);
});

test('RSS: sin ningún campo con 40 letras se queda con el más largo, no con la imagen', () => {
  const nota = adaptRssArticle({
    title: 'Nota', link: 'https://x.test/3',
    content: '<img src="https://x.test/a.jpg" alt=""/>',
    description: 'Liga Argentina: River ganó.',
  }, FUENTE);
  assert.equal(nota.rawSummary, 'Liga Argentina: River ganó.');
});

test('RSS: el snippet también sale limpio cuando viene de summary o description con HTML', () => {
  const conSummary = adaptRssArticle({
    title: 'Nota', link: 'https://x.test/7',
    summary: '<p>El d&#xF3;lar abri&#xF3; este viernes con compras de reservas del Banco Central.</p>',
  }, FUENTE);
  assert.equal(conSummary.contentSnippet, 'El dólar abrió este viernes con compras de reservas del Banco Central.');

  const conDescription = adaptRssArticle({
    title: 'Nota', link: 'https://x.test/8',
    description: `${IMG_INFOBAE}<p>${PARRAFO}</p>`,
  }, FUENTE);
  assert.equal(conDescription.contentSnippet, PARRAFO);
});

test('RSS: un item sin texto da resumen vacío', () => {
  const nota = adaptRssArticle({ title: 'Nota', link: 'https://x.test/4', content: '<img src="https://x.test/a.jpg"/>' }, FUENTE);
  assert.equal(nota.rawSummary, '');
  assert.equal(nota.contentSnippet, '');
});

test('RSS: la imagen de la nota se sigue sacando del HTML original', () => {
  const nota = adaptRssArticle({ title: 'Nota', link: 'https://x.test/5', content: `${IMG_INFOBAE}<p>${PARRAFO}</p>` }, FUENTE);
  assert.ok(nota.imageUrl.startsWith('https://www.infobae.com/resizer/v2/PJ42V67YKFGLZF5V4KY4FWVLQM.JPG'), nota.imageUrl);
  assert.ok(!nota.rawSummary.includes('<'), 'el resumen no lleva etiquetas aunque la imagen salió de ahí');
});

test('RSS: el contenido de una lista (Clarín) queda como oraciones separadas', () => {
  const nota = adaptRssArticle({
    title: 'Martín Fierro', link: 'https://x.test/6',
    content: '<ul><li>La cantante quilmeña ganó tres Martín Fierro de la Música por su disco.</li><li>Al recibir el premio recordó el problema de salud.</li></ul>',
  }, FUENTE);
  assert.equal(nota.rawSummary, 'La cantante quilmeña ganó tres Martín Fierro de la Música por su disco. Al recibir el premio recordó el problema de salud.');
});

// ================================================================= adaptador NewsAPI
test('NewsAPI: saca la marca "[+1234 chars]" del final y el HTML', () => {
  const nota = adaptNewsApiArticle({
    title: 'Nota', url: 'https://x.test/n1', description: '<p>Descripción de la nota con suficiente texto para contar como resumen.</p>',
    content: 'Texto de la nota con bastante contenido para superar el piso de cuarenta letras… [+3456 chars]',
  }, { name: 'NewsAPI' });
  assert.equal(nota.rawSummary, 'Descripción de la nota con suficiente texto para contar como resumen.');
  assert.equal(nota.contentSnippet, 'Texto de la nota con bastante contenido para superar el piso de cuarenta letras…');
});

test('NewsAPI: sin description usa content', () => {
  const nota = adaptNewsApiArticle({ title: 'Nota', url: 'https://x.test/n2', content: 'Contenido suficientemente largo para pasar el piso de legibilidad. [+120 chars]' }, {});
  assert.equal(nota.rawSummary, 'Contenido suficientemente largo para pasar el piso de legibilidad.');
});

// ================================================================= prepareRssItems
const FEED_LARGO = `${PARRAFO} `.repeat(4).trim(); // > 250 caracteres limpios

/** Arma los parámetros de prepareRssItems con todo falso: devuelve también lo que se llamó. */
function armar({ items, guardadas = [], rescate = async () => '', imagenDescartada = () => false } = {}) {
  const llamadas = { rescate: [], sleep: [], filtro: [], log: [] };
  const params = {
    items,
    source: FUENTE,
    adapt: adaptRssArticle,
    process: (a) => ({ ...a, tags: [], processed: true }),
    filterExisting: async (articulos) => {
      llamadas.filtro.push(articulos.map((a) => a.url));
      const yaEstan = new Set(guardadas);
      return {
        newArticles: articulos.filter((a) => !yaEstan.has(a.url)),
        duplicateArticles: articulos.filter((a) => yaEstan.has(a.url)),
      };
    },
    rescueBody: async (url) => { llamadas.rescate.push(url); return rescate(url); },
    isDiscardedImage: imagenDescartada,
    sleep: async (ms) => { llamadas.sleep.push(ms); },
    log: (m) => llamadas.log.push(m),
  };
  return { params, llamadas };
}

const item = (n, contenido, extra = {}) => ({ title: `Nota ${n}`, link: `https://x.test/${n}`, content: contenido, ...extra });

test('las constantes del rescate son las acordadas', () => {
  assert.equal(RESCUE_BELOW_CHARS, 250);
  assert.equal(MIN_KEEP_CHARS, 80);
  assert.equal(RESCUE_PAUSE_MS, 500);
});

test('una nota con texto suficiente no se rescata', async () => {
  const { params, llamadas } = armar({ items: [item(1, `<p>${FEED_LARGO}</p>`)] });
  const r = await prepareRssItems(params);
  assert.equal(r.articles.length, 1);
  assert.equal(llamadas.rescate.length, 0);
  assert.equal(llamadas.sleep.length, 0);
  assert.equal(r.stats.rescatadas, 0);
});

test('las notas YA guardadas se descartan antes del rescate (no se gasta una descarga en ellas)', async () => {
  const { params, llamadas } = armar({
    items: [item(1, '<p>corto</p>'), item(2, '<p>corto</p>'), item(3, '<p>corto</p>')],
    guardadas: ['https://x.test/1', 'https://x.test/3'],
    rescate: async () => FEED_LARGO,
  });
  const r = await prepareRssItems(params);
  assert.deepEqual(llamadas.rescate, ['https://x.test/2'], 'solo la nota nueva se rescata');
  assert.equal(r.duplicateArticles.length, 2);
  assert.equal(r.stats.duplicadas, 2);
  assert.equal(r.articles.length, 1);
});

test('el largo se mide sobre texto limpio: una imagen de 400 caracteres no hace "larga" a una nota corta', async () => {
  // Con el alt completo que trae Infobae en la vida real (la imagen sola pasa de 300 caracteres).
  const conAltReal = IMG_INFOBAE.replace('alt="El dólar abrió"', 'alt="El dólar abrió a $ 3.166,55 frente al peso colombiano en una jornada marcada por las compras de reservas del Banco de la República - crédito Dado Ruvic/Reuters"');
  const html = `${conAltReal}<p>Texto de apenas unas letras.</p>`;
  const { params, llamadas } = armar({ items: [item(1, html)], rescate: async () => FEED_LARGO });
  assert.ok(html.length >= RESCUE_BELOW_CHARS, `el HTML (${html.length}) ya pasaba el umbral que antes se medía`);
  const r = await prepareRssItems(params);
  assert.deepEqual(llamadas.rescate, ['https://x.test/1']);
  assert.equal(r.stats.rescatadas, 1);
  assert.equal(r.articles[0].rawSummary, FEED_LARGO);
  assert.equal(r.articles[0].contentSnippet, FEED_LARGO);
});

test('antes de cada rescate espera 500 ms', async () => {
  const { params, llamadas } = armar({ items: [item(1, 'a'.repeat(10)), item(2, 'b'.repeat(10))], rescate: async () => FEED_LARGO });
  await prepareRssItems(params);
  assert.deepEqual(llamadas.sleep, [500, 500]);
});

test('rescate fallido: la nota con al menos 80 letras se conserva tal cual', async () => {
  const texto = 'Una nota corta pero con texto de verdad: el Gobierno anunció medidas para el sector agropecuario este viernes.';
  assert.ok(texto.length >= MIN_KEEP_CHARS && texto.length < RESCUE_BELOW_CHARS);
  const { params } = armar({
    items: [item(1, `<p>${texto}</p>`)],
    rescate: async () => { throw new Error('timeout'); },
  });
  const r = await prepareRssItems(params);
  assert.equal(r.articles.length, 1);
  assert.equal(r.articles[0].rawSummary, texto);
  assert.equal(r.stats.cortasConservadas, 1);
  assert.equal(r.stats.descartadas, 0);
});

test('rescate fallido: la nota con menos de 80 letras se descarta', async () => {
  const { params } = armar({
    items: [item(1, '<p>Liga Argentina</p>')],
    rescate: async () => { throw new Error('403'); },
  });
  const r = await prepareRssItems(params);
  assert.equal(r.articles.length, 0);
  assert.equal(r.stats.descartadas, 1);
});

test('un resumen que era solo una imagen (0 letras) con rescate fallido se descarta', async () => {
  const { params } = armar({ items: [item(1, IMG_INFOBAE)], rescate: async () => '' });
  const r = await prepareRssItems(params);
  assert.equal(r.articles.length, 0);
  assert.equal(r.stats.descartadas, 1);
});

test('rescate que trae algo más largo que el resumen pero menos de 250: se usa lo más largo si llega a 80', async () => {
  const intermedio = 'x'.repeat(30) + ' ' + 'y'.repeat(120);
  const { params } = armar({ items: [item(1, '<p>Texto corto de 30 letras ok</p>')], rescate: async () => intermedio });
  const r = await prepareRssItems(params);
  assert.equal(r.articles.length, 1);
  assert.equal(r.articles[0].rawSummary, intermedio);
  assert.equal(r.stats.cortasConservadas, 1);
});

test('rescate que trae algo más corto que el resumen actual: queda el resumen actual', async () => {
  const actual = 'Texto original de la nota con varias palabras para llegar cómodo al piso de ochenta letras de verdad.';
  const { params } = armar({ items: [item(1, `<p>${actual}</p>`)], rescate: async () => 'muy corto' });
  const r = await prepareRssItems(params);
  assert.equal(r.articles[0].rawSummary, actual);
});

test('lo que sale es texto plano aunque el adaptador no lo haya limpiado', async () => {
  const { params } = armar({ items: [item(1, 'x')] });
  params.adapt = (it) => ({ title: it.title, url: it.link, imageUrl: 'https://x.test/i.jpg', rawSummary: `<p>${FEED_LARGO}&#xF3;</p>`, contentSnippet: '<b>otro</b>' });
  const r = await prepareRssItems(params);
  assert.ok(!/[<>]|&#/.test(r.articles[0].rawSummary));
  assert.equal(r.articles[0].contentSnippet, 'otro');
});

test('las notas con imagen descartada no llegan al rescate ni a la base', async () => {
  const { params, llamadas } = armar({
    items: [item(1, `<p>${FEED_LARGO}</p>`), item(2, `<p>${FEED_LARGO}</p>`)],
    imagenDescartada: (a) => a.url.endsWith('/2'),
  });
  const r = await prepareRssItems(params);
  assert.deepEqual(r.articles.map((a) => a.url), ['https://x.test/1']);
  assert.equal(r.stats.sinImagen, 1);
  assert.deepEqual(llamadas.filtro, [['https://x.test/1']]);
});

test('un item que falla al adaptarse se cuenta como error y no frena a los demás', async () => {
  const { params } = armar({ items: [item(1, `<p>${FEED_LARGO}</p>`), item(2, `<p>${FEED_LARGO}</p>`)] });
  const adaptar = params.adapt;
  params.adapt = (it, src) => { if (it.link.endsWith('/1')) throw new Error('feed roto'); return adaptar(it, src); };
  const r = await prepareRssItems(params);
  assert.equal(r.stats.errores, 1);
  assert.deepEqual(r.articles.map((a) => a.url), ['https://x.test/2']);
});

test('un fallo del rescate de una nota no afecta a la siguiente', async () => {
  const { params } = armar({
    items: [item(1, '<p>corto uno</p>'), item(2, '<p>corto dos</p>')],
    rescate: async (url) => { if (url.endsWith('/1')) throw new Error('timeout'); return FEED_LARGO; },
  });
  const r = await prepareRssItems(params);
  assert.deepEqual(r.articles.map((a) => a.url), ['https://x.test/2']);
  assert.equal(r.stats.descartadas, 1);
  assert.equal(r.stats.rescatadas, 1);
});

test('los contadores cuentan lo que pasó con cada nota', async () => {
  const bueno = 'Texto de una nota con bastante contenido, suficiente como para conservarla aunque no se pueda rescatar el cuerpo.';
  const { params } = armar({
    items: [
      item(1, `<p>${FEED_LARGO}</p>`), // alcanza
      item(2, '<p>muy corto</p>'),      // se rescata
      item(3, `<p>${bueno}</p>`),       // el rescate falla pero se conserva
      item(4, '<p>corto</p>'),          // el rescate falla y se descarta
      item(5, '<p>ya guardada</p>'),    // duplicada
    ],
    guardadas: ['https://x.test/5'],
    rescate: async (url) => { if (url.endsWith('/2')) return FEED_LARGO; throw new Error('x'); },
  });
  const r = await prepareRssItems(params);
  assert.deepEqual(r.stats, {
    items: 5, sinImagen: 0, errores: 0, duplicadas: 1, rescatadas: 1, cortasConservadas: 1, descartadas: 1,
  });
  assert.equal(r.articles.length, 3);
});

// ================================================================= texto para embeddings
test('el texto de embeddings lleva el resumen en texto plano, sin HTML ni entidades', () => {
  const t = buildEmbeddingText({
    title: 'Dólar hoy', tags: ['dólar', 'colombia'],
    rawSummary: `${IMG_INFOBAE}<p>El d&#xF3;lar abri&#xF3; este viernes en Colombia.</p>`,
  });
  assert.equal(t, 'Tags: dólar, colombia\nTítulo: Dólar hoy\nResumen: El dólar abrió este viernes en Colombia.');
});

test('el texto de embeddings corta el resumen a 1500 caracteres en un límite de palabra', () => {
  const largo = 'palabra '.repeat(1000);
  const t = buildEmbeddingText({ title: 'Nota', rawSummary: largo });
  const resumen = t.split('Resumen: ')[1];
  assert.ok(resumen.length <= EMBEDDING_SUMMARY_MAX_CHARS, `largo ${resumen.length}`);
  assert.ok(resumen.length > EMBEDDING_SUMMARY_MAX_CHARS - 10);
  assert.ok(resumen.endsWith('palabra'), 'no corta una palabra al medio');
});

test('el texto de embeddings usa contentSnippet si no hay rawSummary, y omite lo vacío', () => {
  assert.equal(buildEmbeddingText({ title: 'Nota', contentSnippet: 'Solo el snippet.' }), 'Título: Nota\nResumen: Solo el snippet.');
  assert.equal(buildEmbeddingText({ title: 'Solo título', rawSummary: '<img src="x.jpg"/>' }), 'Título: Solo título');
  assert.equal(buildEmbeddingText({}), '');
});

// ================================================================= anclas
test('las anclas ven solo palabras de la nota, no las del HTML ni los pedazos de entidades', () => {
  const conHtml = {
    title: 'Dólar hoy',
    rawSummary: `${IMG_INFOBAE}<p>Composici&#xF3;n del mercado cambiario.</p>`,
    contentSnippet: '',
  };
  for (const basura of ['auth', 'smart', 'width', 'height', 'resizer', 'xf3', 'img', 'src']) {
    assert.equal(matchesAnchors(conHtml, [basura]), false, `"${basura}" no es una palabra de la nota`);
  }
  assert.equal(matchesAnchors(conHtml, ['composicion']), true, 'la palabra con tilde decodificada sí cuenta');
  assert.equal(matchesAnchors(conHtml, ['mercado', 'cambiario']), true);
});
