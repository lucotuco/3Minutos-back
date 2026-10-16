'use strict';

/**
 * Tests de cómo la ingesta traduce lo que devuelve la IA (categoría, subtema, país) a lo que se guarda.
 * La IA es falsa: el test decide qué "responde" para cada nota. Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..');
const { CATEGORIES, ALL_CATEGORIES, TOPIC_TO_CATEGORY } = require('../../utils/officialTopics');

function instalarStub(relPath, exports) {
  const abs = require.resolve(path.join(SRC, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

/** Clasifica `reviews` (lo que "respondió" la IA) y devuelve las notas enriquecidas. */
async function clasificar(reviews) {
  instalarStub('config/openai.js', {
    OPENAI_MODEL: 'test',
    openaiReview: { responses: { parse: async () => ({ output_parsed: { reviews } }) } },
  });
  instalarStub('models/GlobalContext.js', { findOne: () => ({ sort: async () => null }) });

  const archivo = require.resolve(path.join(SRC, 'ingestion', 'reviewArticlesWithAIBatch.js'));
  delete require.cache[archivo];
  const { reviewArticlesWithAIBatch } = require(archivo);

  const notas = reviews.map((_, i) => ({ title: `Nota ${i}`, rawSummary: 'resumen', sourceName: 'Medio' }));
  return reviewArticlesWithAIBatch(notas);
}

const review = (id, extra = {}) => ({
  id, category: 'Deportes', topic: 'Fútbol', geoScope: 'Argentina', tags: [], importanceScore: 60, aiConfidence: 0.9, ...extra,
});

test('un subtema oficial queda con su categoría', async () => {
  const [n] = await clasificar([review(0)]);
  assert.equal(n.category, 'Deportes');
  assert.equal(n.topic, 'Fútbol');
});

test('si el subtema es de otra categoría, manda el subtema', async () => {
  const [n] = await clasificar([review(0, { category: 'Deportes', topic: 'Justicia' })]);
  assert.equal(n.category, 'Política');
  assert.equal(n.topic, 'Justicia');
});

test('un subtema libre se normaliza y se queda en la categoría que eligió la IA', async () => {
  const [n] = await clasificar([review(0, { category: 'Deportes', topic: 'ciclismo de RUTA' })]);
  assert.equal(n.category, 'Deportes');
  assert.equal(n.topic, 'Ciclismo de Ruta');
});

test('nombres de prototipo como subtema ("constructor", "__proto__") son etiquetas libres, no categorías', async () => {
  const notas = await clasificar([
    review(0, { topic: 'constructor' }),
    review(1, { topic: '__proto__' }),
    review(2, { topic: 'toString' }),
    review(3, { topic: 'hasOwnProperty' }),
  ]);
  for (const n of notas) {
    assert.equal(n.category, 'Deportes', `la categoría debe seguir siendo un texto oficial (topic ${n.topic})`);
    assert.equal(typeof n.category, 'string');
  }
  assert.deepEqual(notas.map((n) => n.topic), ['Constructor', '__proto__', 'Tostring', 'Hasownproperty']);
});

test('Política o Economía de otro país pasa a Internacional', async () => {
  const [brasil, eeuu, desconocido, argentina] = await clasificar([
    review(0, { category: 'Política', topic: 'Gobierno Nacional', geoScope: 'Brasil' }),
    review(1, { category: 'Economía', topic: 'Dólar y Mercados', geoScope: 'Estados Unidos' }),
    review(2, { category: 'Política', topic: 'Elecciones', geoScope: 'Japón' }),
    review(3, { category: 'Política', topic: 'Elecciones', geoScope: 'Argentina' }),
  ]);
  assert.deepEqual([brasil.category, brasil.topic], ['Internacional', 'América Latina']);
  assert.deepEqual([eeuu.category, eeuu.topic], ['Internacional', 'EEUU']);
  assert.deepEqual([desconocido.category, desconocido.topic], ['Internacional', 'Geopolítica']);
  assert.deepEqual([argentina.category, argentina.topic], ['Política', 'Elecciones']);
});

test('una categoría que no existe cae en Sociedad', async () => {
  const [n] = await clasificar([review(0, { category: 'Inventada', topic: 'Cosas' })]);
  assert.equal(n.category, 'Sociedad');
});

// ---------------------------------------------------------------- lo que ve la IA
/** Clasifica `notas` y devuelve el arreglo de artículos que se le mandó a la IA (leído del prompt). */
async function payloadEnviado(notas, reviews = null) {
  let llamada = null;
  instalarStub('config/openai.js', {
    OPENAI_MODEL: 'test',
    openaiReview: {
      responses: {
        parse: async (args) => {
          llamada = args;
          return { output_parsed: { reviews: reviews || notas.map((_, i) => review(i)) } };
        },
      },
    },
  });
  instalarStub('models/GlobalContext.js', { findOne: () => ({ sort: async () => null }) });

  const archivo = require.resolve(path.join(SRC, 'ingestion', 'reviewArticlesWithAIBatch.js'));
  delete require.cache[archivo];
  const { reviewArticlesWithAIBatch, CLASSIFIER_SUMMARY_CHARS } = require(archivo);
  const enriquecidas = await reviewArticlesWithAIBatch(notas);

  const usuario = llamada.input.find((m) => m.role === 'user').content;
  const json = usuario.slice(usuario.indexOf('Artículos a evaluar:') + 'Artículos a evaluar:'.length);
  return { payload: JSON.parse(json), limite: CLASSIFIER_SUMMARY_CHARS, llamada, enriquecidas };
}

const IMG = '<img src="https://www.infobae.com/resizer/v2/ABC.JPG?auth=a88d0a4bfa9ededd841c0af6e98a2bb32dc89f9ba759588dd73a4df394d13ed8&smart=true&width=4000&height=2668" alt="" height="2668" width="4000"/>';

test('la IA recibe 600 caracteres de resumen en texto plano (antes eran 150 de HTML crudo)', async () => {
  const cuerpo = 'El dólar abrió este viernes con compras de reservas del Banco Central y una jornada de mucha volatilidad. '.repeat(12);
  const { payload, limite } = await payloadEnviado([
    { title: 'Dólar hoy', sourceName: 'Infobae', rawSummary: `${IMG}<p>${cuerpo}</p>` },
  ]);
  assert.equal(limite, 600);
  const resumen = payload[0].summary;
  assert.ok(resumen.startsWith('El dólar abrió este viernes'), `empieza por el texto de la nota, no por la imagen: ${resumen.slice(0, 60)}`);
  assert.ok(resumen.endsWith('...'), 'avisa que está cortado');
  assert.ok(resumen.length <= 600 + 3, `largo ${resumen.length}`);
  assert.ok(resumen.length > 500);
  assert.ok(!/[<>]|&#|auth=/.test(resumen), 'sin etiquetas, entidades ni tokens de imagen');
});

test('un resumen corto llega entero y sin puntos suspensivos', async () => {
  const { payload } = await payloadEnviado([
    { title: 'Nota', sourceName: 'Medio', rawSummary: '<p>Texto corto con acentos: canci&#xF3;n.</p>' },
  ]);
  assert.equal(payload[0].summary, 'Texto corto con acentos: canción.');
});

test('una nota cuyo resumen era solo una imagen llega con resumen vacío (no con la etiqueta)', async () => {
  const { payload } = await payloadEnviado([{ title: 'Nota', sourceName: 'Medio', rawSummary: IMG }]);
  assert.equal(payload[0].summary, '');
});

test('si no hay rawSummary se usa contentSnippet', async () => {
  const { payload } = await payloadEnviado([{ title: 'Nota', sourceName: 'Medio', rawSummary: '', contentSnippet: 'Del snippet.' }]);
  assert.equal(payload[0].summary, 'Del snippet.');
});

// ---------------------------------------------------------------- tipo de nota (contentType)
const { CONTENT_TYPE_VALUES } = require('../../utils/contentTypes');

test('el tipo de nota que devuelve la IA se guarda en cada nota', async () => {
  const notas = CONTENT_TYPE_VALUES.map((_, i) => ({ title: `Nota ${i}`, rawSummary: 'resumen', sourceName: 'Medio' }));
  const { enriquecidas } = await payloadEnviado(notas, CONTENT_TYPE_VALUES.map((contentType, i) => review(i, { contentType })));
  assert.deepEqual(enriquecidas.map((n) => n.contentType), CONTENT_TYPE_VALUES);
});

test('un tipo fuera de la lista (o ausente) queda vacío en vez de guardarse tal cual', async () => {
  const notas = [0, 1, 2, 3, 4, 5].map((i) => ({ title: `Nota ${i}`, rawSummary: 'resumen', sourceName: 'Medio' }));
  const { enriquecidas } = await payloadEnviado(notas, [
    review(0, { contentType: 'inventado' }),
    review(1, {}),
    review(2, { contentType: 'constructor' }),
    review(3, { contentType: '__proto__' }),
    review(4, { contentType: 42 }),
    review(5, { contentType: ' OPINION ' }),
  ]);
  assert.deepEqual(enriquecidas.map((n) => n.contentType), ['', '', '', '', '', 'opinion']);
});

test('una nota para la que la IA no devolvió nada queda sin tipo (se trata como noticia)', async () => {
  const notas = [{ title: 'A', rawSummary: 'x', sourceName: 'M' }, { title: 'B', rawSummary: 'y', sourceName: 'M' }];
  const { enriquecidas } = await payloadEnviado(notas, [review(0, { contentType: 'opinion' })]);
  assert.equal(enriquecidas[0].contentType, 'opinion');
  assert.equal(enriquecidas[1].contentType, undefined);
});

test('la IA recibe la URL de cada nota (pista del género y del país)', async () => {
  const { payload } = await payloadEnviado([
    { title: 'Dólar hoy', sourceName: 'Infobae', url: 'https://www.infobae.com/colombia/2026/10/16/dolar/', rawSummary: 'x' },
    { title: 'Sin url', sourceName: 'Medio', rawSummary: 'y' },
  ]);
  assert.equal(payload[0].url, 'https://www.infobae.com/colombia/2026/10/16/dolar/');
  assert.equal(payload[1].url, '');
});

test('el esquema que se le pide a la IA obliga a elegir uno de los 8 tipos', async () => {
  const { llamada } = await payloadEnviado([{ title: 'A', rawSummary: 'x', sourceName: 'M' }]);
  const propiedades = llamada.text.format.schema.properties.reviews.items.properties;
  assert.deepEqual(propiedades.contentType.enum, CONTENT_TYPE_VALUES);
  assert.ok(llamada.text.format.schema.properties.reviews.items.required.includes('contentType'));
});

test('el prompt define los 8 tipos, da la pista de la URL y la regla del país', async () => {
  const { llamada } = await payloadEnviado([{ title: 'A', rawSummary: 'x', sourceName: 'M' }]);
  const sistema = llamada.input.find((m) => m.role === 'system').content;
  for (const tipo of CONTENT_TYPE_VALUES) assert.ok(sistema.includes(`"${tipo}"`), `el prompt no define "${tipo}"`);
  assert.match(sistema, /"url"/);
  assert.match(sistema, /\/inhouse\//);
  assert.match(sistema, /\/colombia\//, 'si la URL dice otro país, ese es el geoScope');
  assert.match(sistema, /cotizaciones y datos del día/, 'las cotizaciones del día siguen siendo noticia');
  assert.match(sistema, /dónde ver/, 'dónde ver es servicio');
});

test('una nota extranjera de Economía con geoScope por la URL pasa a Internacional', async () => {
  const [n] = await clasificar([review(0, { category: 'Economía', topic: 'Dólar y Mercados', geoScope: 'Colombia', contentType: 'noticia' })]);
  assert.deepEqual([n.category, n.topic, n.geoScope], ['Internacional', 'América Latina', 'Colombia']);
});

// ---------------------------------------------------------------- una sola taxonomía
/** La lista de categorías y subtemas tal como la lee la IA en el prompt: { categoría: [subtemas] }. */
function listaDelPrompt(sistema) {
  const bloque = sistema.slice(sistema.indexOf('LISTA DE CATEGORÍAS'), sistema.indexOf('REGLAS DE CLASIFICACIÓN'));
  const lista = {};
  let actual = null;
  for (const linea of bloque.split('\n')) {
    const cat = linea.match(/^\s*Categoría: "(.+)"$/);
    if (cat) { actual = cat[1]; lista[actual] = []; continue; }
    const sub = linea.match(/^\s*\d+\. "(.+)"$/);
    if (sub && actual) lista[actual].push(sub[1]);
  }
  return lista;
}

test('el prompt ofrece EXACTAMENTE la taxonomía oficial del motor (7 categorías y todos sus subtemas, en orden)', async () => {
  const { llamada } = await payloadEnviado([{ title: 'A', rawSummary: 'x', sourceName: 'M' }]);
  const sistema = llamada.input.find((m) => m.role === 'system').content;
  const enElPrompt = listaDelPrompt(sistema);
  assert.deepEqual(enElPrompt, CATEGORIES, 'si el clasificador y el motor se desparejan, las notas quedan con etiquetas que el motor no lee');
  assert.equal(Object.keys(enElPrompt).length, 7);
  assert.equal(Object.values(enElPrompt).flat().length, 38);
});

test('todo subtema oficial, dicho por la IA, deja a la nota en SU categoría (sin importar la categoría que haya dicho)', async () => {
  const subtemas = [...TOPIC_TO_CATEGORY.keys()];
  const reviews = subtemas.map((topic, i) => review(i, { category: 'Sociedad', topic, geoScope: 'Argentina' }));
  const notas = await clasificar(reviews);
  notas.forEach((n, i) => {
    assert.equal(n.topic, subtemas[i], 'un subtema oficial se guarda tal cual, sin pasar por la normalización de etiquetas libres');
    assert.ok(ALL_CATEGORIES.includes(n.category), `${n.topic}: ${n.category}`);
    // (Política y Economía de otro país pasan a Internacional: acá todo es de Argentina, así que la categoría es la del subtema)
    assert.equal(n.category, TOPIC_TO_CATEGORY.get(subtemas[i]));
  });
});
