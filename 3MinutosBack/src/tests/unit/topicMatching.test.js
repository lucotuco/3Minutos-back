'use strict';

/**
 * Tests de la lógica pura de selección (sin Mongo ni OpenAI).
 * Correr:  npm run test:unit
 *
 * Los fixtures de "river plate" salen del volcado REAL de candidatos (auditarCandidatos.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  zoneOf, topicWords, extractAnchorWords, matchesAnchors, inferCorralCategory, selectBestCandidate,
} = require('../../utils/topicMatching');

let n = 0;
const nota = (title, score, category = 'Deportes', extra = {}) => ({
  title, score, category, url: `https://ejemplo.test/${n++}`, rawSummary: '', contentSnippet: '', tags: [], ...extra,
});

// "river plate" SIN expansión (solo títulos; el texto real también tiene resumen y tags).
const RIVER_SIN_EXPANSION = [
  nota('Tobías Andrada: "La idea de juego de River me favorece"', 0.968),
  nota('La sequía de los 9 que sufre el River de Ponzio', 0.862),
  nota('El probable 11 de River para enfrentar a Sarmiento', 0.855),
  nota('El "último deseo" de Ramón Díaz que sacude a River', 0.835),
  nota('Fausto Vera, sin vueltas sobre el presente de River', 0.861),
  nota('El jugador que River recupera para enfrentar a Sarmiento', 0.825),
  nota('Sarmiento vs. River, por el Torneo Clausura 2026: día, horario, TV', 0.803),
  nota('El problema de River con el gol: genera mucho pero falla', 0.838),
  nota('El sueño del pibe: la ansiedad de Nico Otamendi por festejar', 0.827),
  nota('River, con la mira en los playoffs y los seis puntos', 0.816),
  nota('Los dos juveniles de River que Ponzio bajó a Reserva', 0.787),
  nota('Iguazú Falls closed amid flood warnings linked to El Niño', 0.623, 'Sociedad'),
];

// "river plate" CON expansión: la nota 1 es AMARILLA y el título dice "River", no "River Plate".
const RIVER_CON_EXPANSION = [
  nota('Sarmiento vs. River, por el Torneo Clausura 2026: día, horario, TV', 0.884),
  nota('Tras la victoria de San Lorenzo sobre Riestra, así están las tablas', 0.851),
  nota('El probable 11 de River para enfrentar a Sarmiento', 0.818),
  nota('La foto matera entre dos campeones del mundo que revolucionó', 0.849),
  nota('Sarmiento-River con visitantes: ingresos al estadio', 0.792),
  nota('El problema de River con el gol: genera mucho pero falla', 0.793),
];

// ---------------------------------------------------------------- zonas

test('zoneOf respeta los umbrales 0.94 / 0.80', () => {
  assert.equal(zoneOf(0.94), 'VERDE');
  assert.equal(zoneOf(0.9399), 'AMARILLA');
  assert.equal(zoneOf(0.8), 'AMARILLA');
  assert.equal(zoneOf(0.7999), 'ROJA');
  assert.equal(zoneOf(0), 'ROJA');
});

// ---------------------------------------------------------------- palabras del tema

test('topicWords: normaliza, saca acentos, palabras cortas y funcionales, y duplicados', () => {
  assert.deepEqual(topicWords('River Plate'), ['river', 'plate']);
  assert.deepEqual(topicWords('Dólar y Mercados'), ['dolar', 'mercados']);
  assert.deepEqual(topicWords('del Real Madrid'), ['real', 'madrid']);
  assert.deepEqual(topicWords('boca boca'), ['boca']);
  assert.deepEqual(topicWords('  '), []);
});

// ---------------------------------------------------------------- anclas léxicas

test('anclas: "river plate" -> solo "river" (la prensa casi nunca escribe "plate")', () => {
  const pool = RIVER_SIN_EXPANSION.filter((a) => a.score >= 0.8);
  const r = extractAnchorWords('river plate', pool);
  assert.deepEqual(r.anchors, ['river']);
  assert.equal(r.mode, 'pool_df');
});

test('anclas: una palabra poco frecuente en el pool (2 de 10) no alcanza para ser ancla', () => {
  const pool = [];
  for (let i = 0; i < 10; i++) pool.push(nota(i < 2 ? `River Plate informe ${i}` : `River informe ${i}`, 0.9));
  assert.deepEqual(extractAnchorWords('river plate', pool).anchors, ['river']);
});

test('anclas: si las dos palabras son igual de frecuentes las dos son ancla', () => {
  const pool = [];
  for (let i = 0; i < 6; i++) pool.push(nota(`Javier Milei habló ${i}`, 0.9, 'Política'));
  assert.deepEqual(extractAnchorWords('javier milei', pool).anchors, ['javier', 'milei']);
});

test('anclas: un tema de una palabra es su propia ancla', () => {
  assert.deepEqual(extractAnchorWords('milei', []).anchors, ['milei']);
  assert.equal(extractAnchorWords('milei', []).mode, 'single');
});

test('anclas: con pocos candidatos no hay evidencia y se exigen TODAS las palabras', () => {
  const r = extractAnchorWords('river plate', [nota('River gana', 0.9), nota('River pierde', 0.85)]);
  assert.deepEqual(r.anchors, ['river', 'plate']);
  assert.equal(r.mode, 'strict_no_pool');
});

test('anclas: si ninguna palabra se repite en el pool tampoco hay evidencia (modo estricto)', () => {
  const pool = [nota('Algo distinto', 0.9), nota('Otra cosa', 0.88), nota('Nada que ver', 0.85)];
  const r = extractAnchorWords('river plate', pool);
  assert.deepEqual(r.anchors, ['river', 'plate']);
  assert.equal(r.mode, 'strict_no_support');
});

test('anclas: nombre de tema oficial, ej. "Dólar y Mercados" -> "dolar"', () => {
  const pool = [
    nota('El dólar blue sube', 0.9, 'Economía'), nota('Dólar oficial hoy', 0.88, 'Economía'),
    nota('Dólar: cómo cierra la semana', 0.86, 'Economía'), nota('Mercados: caen los bonos y el dólar', 0.84, 'Economía'),
  ];
  assert.deepEqual(extractAnchorWords('Dólar y Mercados', pool).anchors, ['dolar']);
});

test('matchesAnchors usa palabras completas y mira título, resumen, snippet y tags', () => {
  assert.equal(matchesAnchors(nota('Algo', 0.9, 'Deportes', { rawSummary: 'ganó River' }), ['river']), true);
  assert.equal(matchesAnchors(nota('Algo', 0.9, 'Deportes', { tags: ['river plate'] }), ['river']), true);
  assert.equal(matchesAnchors(nota('Rivera dijo algo', 0.9), ['river']), false); // no es "river"
  assert.equal(matchesAnchors(nota('River', 0.9), []), false);
});

// ---------------------------------------------------------------- corral de categoría

test('corral: gana la categoría dominante', () => {
  assert.equal(inferCorralCategory(RIVER_SIN_EXPANSION.filter((a) => a.score >= 0.8)), 'Deportes');
});

test('corral: si hay empate o dispersión no se inventa uno', () => {
  const pool = [
    nota('a', 0.9, 'Deportes'), nota('b', 0.9, 'Sociedad'), nota('c', 0.9, 'Política'), nota('d', 0.9, 'Economía'),
  ];
  assert.equal(inferCorralCategory(pool), null);
});

test('corral: con pocos candidatos no hay evidencia', () => {
  assert.equal(inferCorralCategory([nota('a', 0.9), nota('b', 0.9)]), null);
});

// ---------------------------------------------------------------- selección

test('selectBestCandidate: "river plate" sin expansión elige la nota 1 (VERDE)', () => {
  const r = selectBestCandidate('river plate', RIVER_SIN_EXPANSION);
  assert.equal(r.zone, 'VERDE');
  assert.match(r.article.title, /Andrada/);
  assert.equal(r.corral, 'Deportes');
  assert.equal(r.candidatesEvaluated, 1);
});

test('selectBestCandidate: con expansión acepta "Sarmiento vs. River" aunque no diga "plate"', () => {
  const r = selectBestCandidate('river plate', RIVER_CON_EXPANSION);
  assert.ok(r.article, 'antes esto terminaba en rescate');
  assert.match(r.article.title, /Sarmiento vs\. River/);
  assert.equal(r.zone, 'AMARILLA');
});

test('selectBestCandidate: salta lo ya visto y toma el siguiente válido', () => {
  const primera = RIVER_CON_EXPANSION[0];
  const r = selectBestCandidate('river plate', RIVER_CON_EXPANSION, { isUsable: (a) => a !== primera });
  assert.ok(r.article);
  assert.notEqual(r.article, primera);
  assert.ok(r.candidatesEvaluated > 1);
});

test('selectBestCandidate: una nota AMARILLA sin ancla se rechaza y se sigue buscando', () => {
  const r = selectBestCandidate('river plate', RIVER_CON_EXPANSION, { exhaustive: true });
  const sanLorenzo = r.evaluated.find((e) => /San Lorenzo/.test(e.title));
  assert.match(sanLorenzo.verdict, /sin ancla/);
});

test('selectBestCandidate: nunca acepta zona ROJA', () => {
  const todasRojas = RIVER_SIN_EXPANSION.map((a) => ({ ...a, score: 0.5 }));
  const r = selectBestCandidate('river plate', todasRojas);
  assert.equal(r.article, null);
});

test('selectBestCandidate: el corral deja afuera notas de otra categoría aunque digan "River"', () => {
  const fuera = nota('Airbag suspendió su sexto River por la visita del Papa', 0.9, 'Entretenimiento/Cultura');
  const lista = [fuera, ...RIVER_SIN_EXPANSION.slice(1, 10)]; // 9 de Deportes + 1 de otra categoría
  const r = selectBestCandidate('river plate', lista, { exhaustive: true });
  assert.match(r.evaluated[0].verdict, /fuera del corral Deportes/);
  assert.notEqual(r.article, fuera);
});

test('selectBestCandidate: strictCategory (temas oficiales) manda sobre la inferencia', () => {
  const r = selectBestCandidate('river plate', RIVER_SIN_EXPANSION, { strictCategory: 'Economía' });
  assert.equal(r.article, null);
  assert.equal(r.corral, 'Economía');
});

test('selectBestCandidate: VERDE no necesita ancla léxica', () => {
  const lista = [nota('Un título sin la palabra', 0.97), nota('river uno', 0.9), nota('river dos', 0.88), nota('river tres', 0.86)];
  const r = selectBestCandidate('river plate', lista);
  assert.equal(r.zone, 'VERDE');
});

test('selectBestCandidate: sin candidatos devuelve article null sin romper', () => {
  const r = selectBestCandidate('lo que sea', []);
  assert.equal(r.article, null);
  assert.equal(r.candidatesEvaluated, 0);
});

// ---------------------------------------------------------------- accepted (todas las aceptadas, con su posición)

test('selectBestCandidate: sin exhaustive corta en la primera y `accepted` trae solo esa', () => {
  const r = selectBestCandidate('river plate', RIVER_SIN_EXPANSION);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].article, r.article);
  assert.equal(r.accepted[0].rank, 1);
  assert.equal(r.accepted[0].zone, 'VERDE');
  assert.equal(r.accepted[0].score, 0.968);
});

test('selectBestCandidate: con exhaustive `accepted` trae todas las válidas, en el orden de la búsqueda y con su posición', () => {
  const r = selectBestCandidate('river plate', RIVER_SIN_EXPANSION, { exhaustive: true });
  // Se cae la 9.ª (AMARILLA sin "River" en el título) y las dos ROJAS del final (0.787 y la de Iguazú).
  assert.equal(r.accepted.length, 9);
  assert.deepEqual(r.accepted.map((x) => x.rank), [1, 2, 3, 4, 5, 6, 7, 8, 10], 'rank = posición original en la búsqueda');
  assert.equal(r.accepted[0].article, r.article, 'la "elegida" sigue siendo la primera de la búsqueda');
  assert.ok(r.accepted.every((x) => x.zone === 'VERDE' || x.zone === 'AMARILLA'));
});

test('selectBestCandidate: `accepted` respeta isUsable y las anclas (lo rechazado no entra)', () => {
  const primera = RIVER_CON_EXPANSION[0];
  const r = selectBestCandidate('river plate', RIVER_CON_EXPANSION, { exhaustive: true, isUsable: (a) => a !== primera });
  assert.ok(!r.accepted.some((x) => x.article === primera));
  assert.ok(!r.accepted.some((x) => /San Lorenzo/.test(x.article.title)), 'AMARILLA sin ancla');
  assert.ok(r.accepted.every((x) => x.rank > 1));
});

test('selectBestCandidate: sin candidatos o todo rojo, `accepted` queda vacío', () => {
  assert.deepEqual(selectBestCandidate('lo que sea', []).accepted, []);
  const rojas = RIVER_SIN_EXPANSION.map((a) => ({ ...a, score: 0.5 }));
  assert.deepEqual(selectBestCandidate('river plate', rojas, { exhaustive: true }).accepted, []);
});

// ---------------------------------------------------------------- corral blando (con juez de tema)

/** Una nota de otra categoría que dice "River" + 9 de Deportes: el corral infiere Deportes. */
function conNotaDeAfuera() {
  const fuera = nota('Airbag suspendió su sexto River por la visita del Papa', 0.9, 'Entretenimiento/Cultura');
  return { fuera, lista: [fuera, ...RIVER_SIN_EXPANSION.slice(1, 10)] };
}

test('corral blando: una nota de otra categoría se acepta MARCADA (outOfCorral) para que la decida el juez de tema', () => {
  const { fuera, lista } = conNotaDeAfuera();
  const r = selectBestCandidate('river plate', lista, { exhaustive: true, softCorral: true });
  const aceptada = r.accepted.find((x) => x.article === fuera);
  assert.ok(aceptada, 'entra a la lista de aceptadas');
  assert.equal(aceptada.outOfCorral, true);
  assert.equal(aceptada.rank, 1);
  assert.equal(r.evaluated[0].verdict, 'ACEPTADO (fuera del corral Deportes: lo decide el juez)');
  assert.ok(r.accepted.filter((x) => x.article !== fuera).every((x) => x.outOfCorral === false), 'las de adentro no se marcan');
  assert.equal(r.corral, 'Deportes', 'el corral se infiere igual: sirve para marcar y para el rescate');
});

test('corral blando: sin la opción el corral sigue descartando, como siempre', () => {
  const { fuera, lista } = conNotaDeAfuera();
  const r = selectBestCandidate('river plate', lista, { exhaustive: true });
  assert.ok(!r.accepted.some((x) => x.article === fuera));
  assert.ok(r.accepted.every((x) => x.outOfCorral === false));
  assert.match(r.evaluated[0].verdict, /^rechazo: fuera del corral Deportes$/);
});

test('corral blando: la zona ROJA, el ancla léxica y isUsable se siguen aplicando a las notas de afuera', () => {
  const roja = nota('River jugó contra otro club', 0.5, 'Sociedad');
  const sinAncla = nota('Un tema que no tiene relación alguna', 0.88, 'Sociedad');
  const yaVista = nota('River en otro rubro', 0.97, 'Sociedad');
  const verdeDeAfuera = nota('River y la política', 0.97, 'Política');
  const adentro = RIVER_SIN_EXPANSION.slice(1, 10);
  const r = selectBestCandidate('river plate', [roja, sinAncla, yaVista, verdeDeAfuera, ...adentro], {
    exhaustive: true, softCorral: true, isUsable: (a) => a !== yaVista,
  });
  const veredicto = (titulo) => r.evaluated.find((e) => e.title === titulo).verdict;
  assert.equal(veredicto(roja.title), 'rechazo: score bajo');
  assert.match(veredicto(sinAncla.title), /^rechazo: sin ancla léxica/);
  assert.match(veredicto(yaVista.title), /^rechazo: ya visto/);
  assert.match(veredicto(verdeDeAfuera.title), /^ACEPTADO \(fuera del corral Deportes/, 'una VERDE no necesita ancla');
  assert.deepEqual(r.accepted.filter((x) => x.outOfCorral).map((x) => x.article), [verdeDeAfuera]);
});

test('corral blando con strictCategory: lo que no es de esa categoría queda marcado en vez de descartado', () => {
  const r = selectBestCandidate('river plate', RIVER_SIN_EXPANSION, { strictCategory: 'Economía', softCorral: true, exhaustive: true });
  assert.equal(r.corral, 'Economía');
  assert.ok(r.accepted.length > 0);
  assert.ok(r.accepted.every((x) => x.outOfCorral === true));
});

test('corral blando: sin corral (no hay evidencia suficiente) nadie está afuera', () => {
  const lista = [nota('river a', 0.97, 'Deportes'), nota('river b', 0.9, 'Sociedad'), nota('river c', 0.9, 'Política')];
  const r = selectBestCandidate('river', lista, { exhaustive: true, softCorral: true });
  assert.equal(r.corral, null);
  assert.equal(r.accepted.length, 3);
  assert.ok(r.accepted.every((x) => x.outOfCorral === false));
});
