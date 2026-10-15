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
