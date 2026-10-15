'use strict';

/**
 * Tests de frescura y de las fórmulas de puntaje (sin Mongo ni OpenAI).
 * Correr:  npm run test:unit
 */

// Los módulos de búsqueda cargan config/openai, que exige las claves al importarse.
process.env.OPENAI_API_KEY_EMBEDDINGS ||= 'test';
process.env.OPENAI_API_KEY_REVIEW ||= 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_ARTICLE_AGE_HOURS, IDEAL_ARTICLE_AGE_HOURS, getFreshnessScore, isPreviewOrAgenda, getHoursSince,
} = require('../../utils/freshness');
const { getRankingScore } = require('../../utils/articleRanking');
const { computeFinalScore } = require('../../embeddings/searchArticlesBySimilarityAtlas');

const hace = (horas) => new Date(Date.now() - horas * 3600 * 1000);

test('el tope de antigüedad es de 24 h y lo ideal 10 h', () => {
  assert.equal(MAX_ARTICLE_AGE_HOURS, 24);
  assert.equal(IDEAL_ARTICLE_AGE_HOURS, 10);
  assert.ok(IDEAL_ARTICLE_AGE_HOURS < MAX_ARTICLE_AGE_HOURS);
});

test('el tope de 24 h no cambia la curva de frescura del ranking del listado', () => {
  // articleRanking / getTopArticles siguen usando la curva completa (hasta una semana).
  assert.equal(getFreshnessScore(hace(30)), 50);
  assert.equal(getFreshnessScore(hace(60)), 20);
});

test('curva de frescura por tramos', () => {
  const casos = [[0, 100], [1, 100], [2, 100], [5, 90], [12, 80], [20, 65], [30, 50], [40, 35], [60, 20], [100, 10], [200, 0]];
  for (const [horas, esperado] of casos) {
    assert.equal(getFreshnessScore(hace(horas)), esperado, `a ${horas} h`);
  }
});

test('la frescura nunca sube con el tiempo', () => {
  let anterior = Infinity;
  for (let h = 0; h <= 200; h += 0.5) {
    const s = getFreshnessScore(hace(h));
    assert.ok(s <= anterior, `subió a las ${h} h`);
    anterior = s;
  }
});

test('sin fecha o con fecha inválida la frescura es 0', () => {
  assert.equal(getFreshnessScore(null), 0);
  assert.equal(getFreshnessScore(undefined), 0);
  assert.equal(getFreshnessScore('no-es-fecha'), 0);
  assert.equal(getHoursSince(null), 9999);
});

test('isPreviewOrAgenda detecta previas aunque falten tildes', () => {
  assert.equal(isPreviewOrAgenda('A qué hora juega River y dónde verlo'), true);
  assert.equal(isPreviewOrAgenda('Donde ver Boca vs Vasco'), true);
  assert.equal(isPreviewOrAgenda('Qué canal transmite el partido'), true);
  assert.equal(isPreviewOrAgenda('Tabla de posiciones del Clausura'), true);
  assert.equal(isPreviewOrAgenda('River ganó con un golazo'), false);
  assert.equal(isPreviewOrAgenda(''), false);
  assert.equal(isPreviewOrAgenda(undefined), false);
});

test('isPreviewOrAgenda detecta las marcas "(Previa)", "Previa:" y "Previa del ..." al inicio del título', () => {
  assert.equal(isPreviewOrAgenda('Previa del Valencia Basket - Olympiacos'), true);
  assert.equal(isPreviewOrAgenda('Previa LNB: Olímpico quiere conocer la victoria ante un Boca que busca recuperarse'), true);
  assert.equal(isPreviewOrAgenda('(Previa) El Sevilla quiere asentarse en Europa a costa del tocado Levante'), true);
  assert.equal(isPreviewOrAgenda('PREVIA: cómo llegan los dos al clásico'), true);
  assert.equal(isPreviewOrAgenda('  Previa de la fecha'), true);
  assert.equal(isPreviewOrAgenda('Clásico del domingo (Previa)'), true);
});

test('isPreviewOrAgenda NO marca como previa las noticias que usan la palabra suelta', () => {
  // Titulos reales de la muestra de auditoria: son noticias, no previas.
  assert.equal(isPreviewOrAgenda('Francia: crecen los incidentes en las protestas estudiantiles y hay heridos en la previa de una huelga nacional'), false);
  assert.equal(isPreviewOrAgenda('Wall Street opera de manera mixta, en la previa de resultados clave de los bancos y datos del IPC'), false);
  assert.equal(isPreviewOrAgenda('Video: los dos errores del árbitro en la acción previa al 1-0 de Temperley a Chicago'), false);
  assert.equal(isPreviewOrAgenda('Preocupación por la salud del papa: será operado, en la previa al viaje a la Argentina'), false);
  assert.equal(isPreviewOrAgenda('Revisión previa: qué cambia con la nueva ley'), false);
  assert.equal(isPreviewOrAgenda('Autorización previa: el Gobierno la eliminó para estudios de alto costo'), false);
});

test('ranking de temas oficiales: usa la misma curva y penaliza previas', () => {
  const base = { importanceScore: 60, publishedAt: hace(3), title: 'River ganó' };
  const normal = getRankingScore(base);
  const previa = getRankingScore({ ...base, title: 'Dónde ver a River' });
  assert.equal(normal.freshnessScore, getFreshnessScore(base.publishedAt));
  assert.ok(previa.rankingScore < normal.rankingScore);
  assert.ok(getRankingScore({ ...base, publishedAt: hace(30) }).rankingScore < normal.rankingScore);
});

test('puntaje final de búsqueda: a igual similitud gana la nota más fresca', () => {
  const comun = { score: 0.85, importanceScore: 50, title: 'River ganó' };
  const fresca = computeFinalScore({ ...comun, publishedAt: hace(2) });
  const vieja = computeFinalScore({ ...comun, publishedAt: hace(40) });
  assert.ok(fresca > vieja);
});

test('puntaje final de búsqueda: a igual frescura gana la más similar', () => {
  const comun = { importanceScore: 50, title: 'River ganó', publishedAt: hace(5) };
  assert.ok(computeFinalScore({ ...comun, score: 0.95 }) > computeFinalScore({ ...comun, score: 0.8 }));
});

test('puntaje final de búsqueda: previas/agenda valen menos y todo queda entre 0 y 100', () => {
  const comun = { score: 1, importanceScore: 100, publishedAt: new Date() };
  const normal = computeFinalScore({ ...comun, title: 'River ganó' });
  const previa = computeFinalScore({ ...comun, title: 'Minuto a minuto: River' });
  assert.ok(previa < normal);
  assert.ok(normal <= 100.0001 && normal > 99);
  assert.ok(computeFinalScore({}) >= 0);
});
