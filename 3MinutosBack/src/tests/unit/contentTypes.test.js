'use strict';

/**
 * Tipos de nota (utils/contentTypes.js) y su campo en el modelo Article.
 * Correr:  npm run test:unit
 */

process.env.OPENAI_API_KEY_EMBEDDINGS ||= 'test';
process.env.OPENAI_API_KEY_REVIEW ||= 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTENT_TYPES, CONTENT_TYPE_VALUES, EXCLUDED_CONTENT_TYPES, sanitizeContentType, exclusionReasonOf,
} = require('../../utils/contentTypes');
const Article = require('../../models/Article');

test('son 8 tipos, con estos nombres', () => {
  assert.deepEqual([...CONTENT_TYPE_VALUES], [
    'noticia', 'analisis', 'opinion', 'entrevista', 'color', 'servicio', 'previa_agenda', 'publicidad',
  ]);
  assert.equal(Object.keys(CONTENT_TYPES).length, 8);
});

test('no se entregan opinión, servicio, previa/agenda ni publicidad; sí noticia, análisis, entrevista y color', () => {
  assert.deepEqual(Object.keys(EXCLUDED_CONTENT_TYPES).sort(), ['opinion', 'previa_agenda', 'publicidad', 'servicio']);
  assert.equal(exclusionReasonOf('opinion'), 'opinion');
  assert.equal(exclusionReasonOf('servicio'), 'servicio');
  assert.equal(exclusionReasonOf('previa_agenda'), 'previa_o_agenda', 'comparte el motivo con las previas detectadas por el título');
  assert.equal(exclusionReasonOf('publicidad'), 'publicidad');
  for (const ok of ['noticia', 'analisis', 'entrevista', 'color', '', undefined, null, 'otra cosa']) {
    assert.equal(exclusionReasonOf(ok), null, String(ok));
  }
});

test('exclusionReasonOf ignora mayúsculas y espacios y no se confunde con nombres de prototipo', () => {
  assert.equal(exclusionReasonOf(' OPINION '), 'opinion');
  for (const raro of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(exclusionReasonOf(raro), null, raro);
  }
});

test('sanitizeContentType deja pasar solo los tipos conocidos', () => {
  for (const tipo of CONTENT_TYPE_VALUES) assert.equal(sanitizeContentType(tipo), tipo);
  assert.equal(sanitizeContentType(' Opinion '), 'opinion');
  for (const malo of ['inventado', '', null, undefined, 42, {}, [], 'constructor', '__proto__']) {
    assert.equal(sanitizeContentType(malo), '', String(malo));
  }
});

test('el modelo Article tiene contentType: por defecto vacío y solo acepta los tipos conocidos', () => {
  const base = { sourceName: 'M', sourceUrl: 'https://m.test', title: 'T', url: 'https://m.test/1' };
  const sinTipo = new Article(base);
  assert.equal(sinTipo.contentType, '');
  assert.equal(sinTipo.validateSync(), undefined);

  for (const tipo of ['', ...CONTENT_TYPE_VALUES]) {
    assert.equal(new Article({ ...base, contentType: tipo }).validateSync(), undefined, `"${tipo}" debería ser válido`);
  }
  const malo = new Article({ ...base, contentType: 'inventado' }).validateSync();
  assert.ok(malo?.errors?.contentType, 'un tipo fuera de la lista no se guarda');
});
