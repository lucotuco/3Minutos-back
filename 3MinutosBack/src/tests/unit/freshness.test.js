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
  MAX_ARTICLE_AGE_HOURS, DEFAULT_FRESHNESS_WEIGHT, FRESHNESS_WEIGHT, parseWeight,
  DEFAULT_FRESHNESS_PLATEAU_HOURS, FRESHNESS_PLATEAU_HOURS, parsePlateauHours, freshnessOfAge,
  getFreshnessScore, isPreviewOrAgenda, getHoursSince,
} = require('../../utils/freshness');
const { getRankingScore } = require('../../utils/articleRanking');
const { computeFinalScore } = require('../../embeddings/searchArticlesBySimilarityAtlas');

// El reloj queda fijo: la curva tiene bordes exactos (<= 2 h, <= 12 h…) y con el reloj real un milisegundo
// de diferencia entre armar la fecha y medirla la pasaba al tramo siguiente (el test fallaba una vez cada tantas corridas).
const AHORA = Date.now();
test.before(() => { test.mock.method(Date, 'now', () => AHORA); });
test.after(() => { test.mock.restoreAll(); });

const hace = (horas) => new Date(AHORA - horas * 3600 * 1000);

test('el tope de antigüedad es de 24 h y el peso por defecto de la frescura es 0,3', () => {
  assert.equal(MAX_ARTICLE_AGE_HOURS, 24);
  assert.equal(DEFAULT_FRESHNESS_WEIGHT, 0.3);
  // El peso real puede venir de FRESHNESS_WEIGHT; en cualquier caso es un número entre 0 y 1.
  assert.ok(FRESHNESS_WEIGHT >= 0 && FRESHNESS_WEIGHT <= 1);
});

test('parseWeight: acepta de 0 a 1; vacío, texto o fuera de rango vuelve al valor por defecto', () => {
  assert.equal(parseWeight('0.4'), 0.4);
  assert.equal(parseWeight('0'), 0, 'cero es un valor válido (solo importancia)');
  assert.equal(parseWeight('1'), 1, 'uno es un valor válido (solo frescura)');
  assert.equal(parseWeight(0.25), 0.25);
  for (const malo of [undefined, null, '', '   ', 'mucho', '-0.1', '1.5', '40', NaN]) {
    assert.equal(parseWeight(malo), DEFAULT_FRESHNESS_WEIGHT, `${String(malo)} usa el valor por defecto`);
  }
  assert.equal(parseWeight('mucho', 0.5), 0.5, 'el valor de reemplazo se puede elegir');
});

test('la meseta por defecto es de 4 h y siempre queda por debajo del tope de 24 h', () => {
  assert.equal(DEFAULT_FRESHNESS_PLATEAU_HOURS, 4);
  // La meseta real puede venir de FRESHNESS_PLATEAU_HOURS; en cualquier caso es un número de 0 a menos de 24.
  assert.ok(FRESHNESS_PLATEAU_HOURS >= 0 && FRESHNESS_PLATEAU_HOURS < MAX_ARTICLE_AGE_HOURS);
});

test('parsePlateauHours: acepta de 0 a menos de 24; vacío, texto o fuera de rango vuelve al valor por defecto', () => {
  assert.equal(parsePlateauHours('6'), 6);
  assert.equal(parsePlateauHours('0'), 0, 'cero es válido: sin meseta');
  assert.equal(parsePlateauHours('2.5'), 2.5);
  assert.equal(parsePlateauHours(3), 3);
  for (const malo of [undefined, null, '', '   ', 'mucho', '-1', '24', '30', NaN]) {
    assert.equal(parsePlateauHours(malo), DEFAULT_FRESHNESS_PLATEAU_HOURS, `${String(malo)} usa el valor por defecto`);
  }
  assert.equal(parsePlateauHours('mucho', 2), 2, 'el valor de reemplazo se puede elegir');
});

test('freshnessOfAge sin meseta (0 h): lineal, 100 al publicarse y 0 a las 24 h', () => {
  const f = (h) => freshnessOfAge(h, 0);
  assert.equal(f(0), 100);
  assert.equal(f(6), 75);
  assert.equal(f(12), 50);
  assert.equal(f(18), 25);
  assert.equal(f(MAX_ARTICLE_AGE_HOURS), 0);
  assert.equal(f(30), 0, 'pasado el tope no es negativa');
  assert.equal(f(-1), 100, 'una nota "del futuro" (reloj del medio) no pasa de 100');
  assert.equal(f(NaN), 0);
  assert.equal(f(undefined), 0);
});

test('freshnessOfAge con meseta de 4 h: 100 hasta las 4 h y desde ahí en línea recta hasta 0 a las 24 h', () => {
  const f = (h) => freshnessOfAge(h, 4);
  for (const h of [-1, 0, 0.5, 2, 3.9, 4]) assert.equal(f(h), 100, `a ${h} h`);
  assert.equal(f(9), 75);
  assert.equal(f(14), 50);
  assert.equal(f(19), 25);
  assert.equal(f(MAX_ARTICLE_AGE_HOURS), 0);
  assert.equal(f(30), 0);
  assert.equal(f(NaN), 0);
  assert.ok(f(4.01) < 100 && f(4.01) > 99.9, 'recién pasada la meseta empieza a bajar, sin saltar');
});

test('freshnessOfAge: sin escalones; pasada la meseta cada hora baja lo mismo y nunca sube con la edad', () => {
  for (const meseta of [0, 2, 4, 8]) {
    const paso = 100 / (MAX_ARTICLE_AGE_HOURS - meseta);
    let anterior = Infinity;
    for (let h = 0; h <= 30; h += 0.25) {
      const f = freshnessOfAge(h, meseta);
      assert.ok(f <= anterior, `meseta ${meseta}: subió a las ${h} h`);
      anterior = f;
    }
    for (let h = meseta; h < MAX_ARTICLE_AGE_HOURS; h++) {
      const baja = freshnessOfAge(h, meseta) - freshnessOfAge(h + 1, meseta);
      assert.ok(Math.abs(baja - paso) < 1e-9, `meseta ${meseta}: la hora ${h}-${h + 1} baja ${baja} y no ${paso}`);
    }
  }
});

test('freshnessOfAge sin segundo argumento usa FRESHNESS_PLATEAU_HOURS', () => {
  for (const h of [0, 3, 10, 20, 24, 30]) assert.equal(freshnessOfAge(h), freshnessOfAge(h, FRESHNESS_PLATEAU_HOURS), `a ${h} h`);
});

test('la curva de frescura del listado (por tramos) llega hasta el tope de 24 h y pasado el tope vale 0', () => {
  // articleRanking / getTopArticles usan esta curva, no freshnessOfAge (que es la del orden de entrega).
  assert.equal(getFreshnessScore(hace(24)), 30);
  assert.equal(getFreshnessScore(hace(30)), 0);
  assert.equal(getFreshnessScore(hace(60)), 0);
});

test('curva de frescura del listado por tramos', () => {
  const casos = [
    [0, 100], [1, 100], [2, 100], [5, 90], [6, 90], [7, 80], [8, 80], [9, 70], [10, 70], [11, 60], [12, 60],
    [15, 40], [18, 40], [20, 30], [24, 30], [30, 0], [100, 0], [200, 0],
  ];
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
