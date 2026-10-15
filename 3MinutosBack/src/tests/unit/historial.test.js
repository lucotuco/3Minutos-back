'use strict';

/**
 * Tests del historial de lo que el usuario ya vio (ventana de 48 h, tope de 150 notas, embeddings).
 * Usa modelos de Mongo FALSOS que aplican en memoria el filtro, el orden y el límite que recibe cada consulta.
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HISTORY_WINDOW_HOURS, HISTORY_MAX_NOTES, getAlreadyShownHistoryForUser,
} = require('../../utils/getAlreadyShownUrlsForUser');

const NOW = Date.parse('2026-10-15T15:00:00.000Z');
const hace = (horas) => new Date(NOW - horas * 3600e3);

/** Modelo falso: find(filtro).sort().limit().select().lean() sobre un arreglo en memoria. */
function modeloFalso(filas) {
  const llamadas = [];
  return {
    llamadas,
    find(filtro) {
      const call = { filtro, sort: null, limit: null, select: null };
      llamadas.push(call);
      const corre = () => {
        let out = filas.filter((f) => {
          if (filtro.userId !== undefined && String(f.userId) !== String(filtro.userId)) return false;
          if (filtro.shownAt?.$gte && !(f.shownAt >= filtro.shownAt.$gte)) return false;
          if (filtro._id?.$in && !filtro._id.$in.map(String).includes(String(f._id))) return false;
          return true;
        });
        if (call.sort) {
          const [[campo, dir]] = Object.entries(call.sort);
          out = [...out].sort((a, b) => dir * (a[campo] - b[campo]));
        }
        if (call.limit) out = out.slice(0, call.limit);
        return out;
      };
      const q = {
        sort(s) { call.sort = s; return q; },
        limit(n) { call.limit = n; return q; },
        select(s) { call.select = s; return q; },
        lean() { return q; },
        then(res, rej) { return Promise.resolve().then(corre).then(res, rej); },
      };
      return q;
    },
  };
}

const vista = (i, horas, extra = {}) => ({
  userId: 'u1', articleId: `a${i}`, articleUrl: `https://medio.test/${i}`, title: `Titulo ${i}`, shownAt: hace(horas), ...extra,
});
const articulo = (i, embedding = [i, 1]) => ({ _id: `a${i}`, title: `Original ${i}`, embedding });

test('los valores por defecto son 48 h y 150 notas', () => {
  assert.equal(HISTORY_WINDOW_HOURS, 48);
  assert.equal(HISTORY_MAX_NOTES, 150);
});

test('solo cuenta lo visto en las últimas 48 h', async () => {
  const Shown = modeloFalso([vista(1, 1), vista(2, 47.9), vista(3, 48.1), vista(4, 100)]);
  const Art = modeloFalso([1, 2, 3, 4].map((i) => articulo(i)));
  const h = await getAlreadyShownHistoryForUser('u1', { now: NOW, models: { UserShownArticle: Shown, Article: Art } });

  assert.deepEqual(h.urls.sort(), ['https://medio.test/1', 'https://medio.test/2']);
  assert.equal(h.seenEmbeddings.length, 2);
  const filtro = Shown.llamadas[0].filtro;
  assert.equal(filtro.userId, 'u1');
  assert.equal(filtro.shownAt.$gte.getTime(), NOW - 48 * 3600e3);
});

test('48 h justas todavía cuentan', async () => {
  const Shown = modeloFalso([vista(1, 48)]);
  const h = await getAlreadyShownHistoryForUser('u1', { now: NOW, models: { UserShownArticle: Shown, Article: modeloFalso([articulo(1)]) } });
  assert.deepEqual(h.urls, ['https://medio.test/1']);
});

test('con más de 150 notas se queda con las 150 más recientes', async () => {
  const filas = Array.from({ length: 200 }, (_, i) => vista(i, 1 + i * 0.2)); // la 0 es la más nueva (1 h) y la 199 la más vieja (~40 h)
  const Shown = modeloFalso(filas);
  const Art = modeloFalso(filas.map((_, i) => articulo(i)));
  const h = await getAlreadyShownHistoryForUser('u1', { now: NOW, models: { UserShownArticle: Shown, Article: Art } });

  assert.equal(h.urls.length, 150);
  assert.ok(h.urls.includes('https://medio.test/0'));
  assert.ok(h.urls.includes('https://medio.test/149'));
  assert.ok(!h.urls.includes('https://medio.test/150'), 'la 151.ª más reciente queda afuera');
  assert.equal(Shown.llamadas[0].limit, 150);
  assert.deepEqual(Shown.llamadas[0].sort, { shownAt: -1 });
  assert.equal(h.seenEmbeddings.length, 150);
});

test('se puede cambiar la ventana y el tope', async () => {
  const Shown = modeloFalso([vista(1, 1), vista(2, 3), vista(3, 5)]);
  const Art = modeloFalso([1, 2, 3].map((i) => articulo(i)));
  const h = await getAlreadyShownHistoryForUser('u1', { now: NOW, hours: 4, cap: 1, models: { UserShownArticle: Shown, Article: Art } });
  assert.deepEqual(h.urls, ['https://medio.test/1']);
});

test('no mezcla notas de otros usuarios', async () => {
  const Shown = modeloFalso([vista(1, 1), vista(2, 1, { userId: 'otro' })]);
  const Art = modeloFalso([articulo(1), articulo(2)]);
  const h = await getAlreadyShownHistoryForUser('u1', { now: NOW, models: { UserShownArticle: Shown, Article: Art } });
  assert.deepEqual(h.urls, ['https://medio.test/1']);
  assert.equal(h.seenEmbeddings.length, 1);
});

test('devuelve urls y títulos sin repetir, y los embeddings con su título', async () => {
  const Shown = modeloFalso([vista(1, 1), vista(1, 2, { shownAt: hace(2) }), vista(2, 3)]);
  const Art = modeloFalso([articulo(1, [1, 0]), articulo(2, [0, 1])]);
  const h = await getAlreadyShownHistoryForUser('u1', { now: NOW, models: { UserShownArticle: Shown, Article: Art } });

  assert.equal(h.urls.length, 2, 'la misma URL vista dos veces cuenta una');
  assert.deepEqual(h.titles.sort(), ['Titulo 1', 'Titulo 2']);
  assert.deepEqual(h.seenEmbeddings.map((e) => e.vector), [[1, 0], [0, 1]]);
  assert.ok(h.seenEmbeddings.every((e) => typeof e.title === 'string' && e.title.length > 0));
  assert.deepEqual(Art.llamadas[0].filtro._id.$in.sort(), ['a1', 'a2'], 'cada id se pide una sola vez');
});

test('las notas sin embedding o sin articleId cuentan por URL pero no por significado', async () => {
  const Shown = modeloFalso([vista(1, 1), vista(2, 2, { articleId: null }), vista(3, 3)]);
  const Art = modeloFalso([articulo(1), { _id: 'a3', title: 'Sin vector', embedding: [] }]);
  const h = await getAlreadyShownHistoryForUser('u1', { now: NOW, models: { UserShownArticle: Shown, Article: Art } });

  assert.equal(h.urls.length, 3);
  assert.equal(h.seenEmbeddings.length, 1);
  assert.equal(h.seenEmbeddings[0].title, 'Original 1');
});

test('sin historial devuelve todo vacío y no consulta los artículos', async () => {
  const Shown = modeloFalso([]);
  const Art = modeloFalso([articulo(1)]);
  const h = await getAlreadyShownHistoryForUser('u1', { now: NOW, models: { UserShownArticle: Shown, Article: Art } });
  assert.deepEqual(h, { urls: [], titles: [], seenEmbeddings: [] });
  assert.equal(Art.llamadas.length, 0);
});
