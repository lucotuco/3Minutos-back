'use strict';

/**
 * Tests de la taxonomía oficial y de cómo se reconoce un tópico oficial (lógica pura).
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORIES, ALL_CATEGORIES, TOPIC_TO_CATEGORY, resolveOfficialTopic, categoryOfSubtopic,
} = require('../../utils/officialTopics');

test('hay 7 categorías y 38 subtemas, sin subtemas repetidos', () => {
  assert.equal(ALL_CATEGORIES.length, 7);
  const subtemas = Object.values(CATEGORIES).flat();
  assert.equal(subtemas.length, 38);
  assert.equal(new Set(subtemas).size, 38);
  assert.equal(TOPIC_TO_CATEGORY.size, 38);
});

test('una categoría oficial se reconoce como categoría', () => {
  assert.deepEqual(resolveOfficialTopic('Deportes'), { kind: 'category', name: 'Deportes', category: 'Deportes' });
  assert.deepEqual(resolveOfficialTopic('Entretenimiento/Cultura'), {
    kind: 'category', name: 'Entretenimiento/Cultura', category: 'Entretenimiento/Cultura',
  });
});

test('un subtema oficial se reconoce con su categoría', () => {
  assert.deepEqual(resolveOfficialTopic('Fútbol'), { kind: 'subtopic', name: 'Fútbol', category: 'Deportes' });
  assert.deepEqual(resolveOfficialTopic('Dólar y Mercados'), { kind: 'subtopic', name: 'Dólar y Mercados', category: 'Economía' });
  assert.deepEqual(resolveOfficialTopic('Historias Humanas'), { kind: 'subtopic', name: 'Historias Humanas', category: 'Sociedad' });
});

test('no importan las mayúsculas, las tildes ni los espacios de los bordes', () => {
  assert.equal(resolveOfficialTopic('futbol').name, 'Fútbol');
  assert.equal(resolveOfficialTopic('  FÚTBOL ').name, 'Fútbol');
  assert.equal(resolveOfficialTopic('economia').name, 'Economía');
  assert.equal(resolveOfficialTopic('politica').kind, 'category');
  assert.equal(resolveOfficialTopic('america latina').name, 'América Latina');
  assert.equal(resolveOfficialTopic('f1').name, 'F1');
  assert.equal(resolveOfficialTopic('EEUU').category, 'Internacional');
});

test('los temas libres no son oficiales', () => {
  for (const libre of ['river plate', 'Zverev', 'tenis argentino', 'Fútbol argentino', 'Deporte', 'Entretenimiento', '']) {
    assert.equal(resolveOfficialTopic(libre), null, libre);
  }
});

test('lo que no es texto no es un tópico oficial', () => {
  for (const raro of [null, undefined, 42, {}, [], ['Fútbol'], true]) {
    assert.equal(resolveOfficialTopic(raro), null);
  }
});

test('nombres de prototipo ("constructor", "__proto__", "toString") NO se toman como oficiales', () => {
  for (const nombre of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']) {
    assert.equal(resolveOfficialTopic(nombre), null, nombre);
    assert.equal(categoryOfSubtopic(nombre), null, nombre);
  }
});

test('categoryOfSubtopic: solo subtemas oficiales exactos', () => {
  assert.equal(categoryOfSubtopic('Fútbol'), 'Deportes');
  assert.equal(categoryOfSubtopic('Música'), 'Entretenimiento/Cultura');
  assert.equal(categoryOfSubtopic('futbol'), null, 'exacto: sin normalizar');
  assert.equal(categoryOfSubtopic('Deportes'), null, 'una categoría no es un subtema');
  assert.equal(categoryOfSubtopic(undefined), null);
});

test('resolveOfficialTopic devuelve una copia: modificarla no rompe la taxonomía', () => {
  const a = resolveOfficialTopic('Fútbol');
  a.category = 'Cualquier cosa';
  assert.equal(resolveOfficialTopic('Fútbol').category, 'Deportes');
});
