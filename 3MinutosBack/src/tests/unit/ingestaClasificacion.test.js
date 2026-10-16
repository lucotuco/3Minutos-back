'use strict';

/**
 * Tests de cómo la ingesta traduce lo que devuelve la IA (categoría, subtema, país) a lo que se guarda.
 * La IA es falsa: el test decide qué "responde" para cada nota. Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..');

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
async function payloadEnviado(notas) {
  let llamada = null;
  instalarStub('config/openai.js', {
    OPENAI_MODEL: 'test',
    openaiReview: {
      responses: {
        parse: async (args) => {
          llamada = args;
          return { output_parsed: { reviews: notas.map((_, i) => review(i)) } };
        },
      },
    },
  });
  instalarStub('models/GlobalContext.js', { findOne: () => ({ sort: async () => null }) });

  const archivo = require.resolve(path.join(SRC, 'ingestion', 'reviewArticlesWithAIBatch.js'));
  delete require.cache[archivo];
  const { reviewArticlesWithAIBatch, CLASSIFIER_SUMMARY_CHARS } = require(archivo);
  await reviewArticlesWithAIBatch(notas);

  const usuario = llamada.input.find((m) => m.role === 'user').content;
  const json = usuario.slice(usuario.indexOf('Artículos a evaluar:') + 'Artículos a evaluar:'.length);
  return { payload: JSON.parse(json), limite: CLASSIFIER_SUMMARY_CHARS };
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
