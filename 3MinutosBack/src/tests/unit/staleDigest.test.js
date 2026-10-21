'use strict';

/**
 * Tests de la revisión del digest guardado al abrirlo (staleDigest.js): nada se entrega con más de 24 h.
 * Sin Mongo ni motor: `rebuild` y `persist` son falsos.
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  digestItemsOf, staleReason, splitByFreshness, mergeReplacements, refreshStaleItems, ensureFreshDigest,
} = require('../../utils/staleDigest');

const NOW = Date.parse('2026-10-15T15:00:00.000Z');
const hace = (horas) => new Date(NOW - horas * 3600e3);

let seq = 0;
const item = (topic, horas, extra = {}) => ({
  topic,
  articleId: `art${seq}`,
  url: `https://medio.test/${seq++}`,
  title: `Nota de ${topic}`,
  publishedAt: horas === null ? null : hace(horas),
  category: 'Deportes',
  ...extra,
});

const nested = (items, extra = {}) => ({
  user: { id: 'u1', name: 'Lucas', topics: ['Fútbol', 'Economía', 'river plate'] },
  digest: { items, audioUrl: null, audioStorageKey: null, audioGeneratedAt: null, ...extra },
});

const silencio = { log() {}, error() {} };

// ---------------------------------------------------------------- formas del digest guardado

test('digestItemsOf: reconoce la forma actual, la vieja y la vacía', () => {
  const a = item('Fútbol', 1);
  assert.deepEqual(digestItemsOf({ digest: { items: [a] } }), { items: [a], shape: 'nested' });
  assert.deepEqual(digestItemsOf({ items: [a] }), { items: [a], shape: 'root' });
  assert.deepEqual(digestItemsOf({ digest: { items: [a] }, items: [] }), { items: [a], shape: 'nested' }, 'la forma actual manda');
  for (const raro of [null, undefined, {}, { digest: null }, { digest: { items: 'x' } }, 7]) {
    assert.deepEqual(digestItemsOf(raro), { items: [], shape: null });
  }
});

// ---------------------------------------------------------------- cuándo una nota está vencida

test('staleReason: 24 h justas sirven, un poco más no', () => {
  assert.equal(staleReason(item('Fútbol', 0), NOW), null);
  assert.equal(staleReason(item('Fútbol', 23.99), NOW), null);
  assert.equal(staleReason(item('Fútbol', 24), NOW), null);
  assert.equal(staleReason(item('Fútbol', 24.01), NOW), 'vencida');
  assert.equal(staleReason(item('Fútbol', 72), NOW), 'vencida');
});

test('staleReason: sin fecha, con fecha inválida o con fecha futura no creíble está vencida', () => {
  assert.equal(staleReason(item('Fútbol', null), NOW), 'sin_fecha');
  assert.equal(staleReason({ topic: 'x' }, NOW), 'sin_fecha');
  assert.equal(staleReason({ publishedAt: 'ayer' }, NOW), 'sin_fecha');
  assert.equal(staleReason(null, NOW), 'sin_fecha');
  assert.equal(staleReason(item('Fútbol', -2), NOW), null, '2 h en el futuro: desfase de relojes, tolerable');
  assert.equal(staleReason(item('Fútbol', -4), NOW), 'fecha_futura');
});

test('splitByFreshness: separa y conserva la posición de cada nota', () => {
  const items = [item('A', 30), item('B', 2), item('C', 25), item('D', 23)];
  const { fresh, stale } = splitByFreshness(items, NOW);
  assert.deepEqual(fresh.map((f) => f.index), [1, 3]);
  assert.deepEqual(stale.map((s) => s.index), [0, 2]);
  assert.deepEqual(stale.map((s) => s.reason), ['vencida', 'vencida']);
  assert.deepEqual(splitByFreshness(undefined, NOW), { fresh: [], stale: [] });
});

// ---------------------------------------------------------------- reemplazos

test('mergeReplacements: cada vencida se cambia en su lugar por una del mismo tema (sin importar tildes ni mayúsculas)', () => {
  const items = [item('Fútbol', 30), item('Economía', 2), item('river plate', 40)];
  const repFutbol = item('futbol', 1);
  const repRiver = item('River Plate', 3);
  const r = mergeReplacements(items, [0, 2], [repRiver, repFutbol]);
  assert.deepEqual(r.items, [repFutbol, items[1], repRiver]);
  assert.equal(r.replaced, 2);
  assert.equal(r.dropped, 0);
});

test('mergeReplacements: sin reposición para ese tema, la nota se saca', () => {
  const items = [item('Fútbol', 30), item('Economía', 30), item('Salud', 1)];
  const r = mergeReplacements(items, [0, 1], [item('Economía', 2)]);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].topic, 'Economía');
  assert.equal(r.items[1], items[2]);
  assert.equal(r.replaced, 1);
  assert.equal(r.dropped, 1);
});

test('mergeReplacements: una reposición se usa una sola vez', () => {
  const items = [item('Fútbol', 30), item('Fútbol', 31)];
  const unica = item('Fútbol', 1);
  const r = mergeReplacements(items, [0, 1], [unica]);
  assert.deepEqual(r.items, [unica]);
  assert.equal(r.dropped, 1);

  const dos = mergeReplacements(items, [0, 1], [unica, item('Fútbol', 2)]);
  assert.equal(dos.items.length, 2);
  assert.notEqual(dos.items[0].url, dos.items[1].url);
});

test('mergeReplacements: una vencida sin tema no se puede reponer; las reposiciones de más se ignoran', () => {
  const items = [{ publishedAt: hace(40) }, item('Salud', 1)];
  const r = mergeReplacements(items, [0], [item('Salud', 2), item('Otro', 2)]);
  assert.deepEqual(r.items, [items[1]]);
  assert.equal(r.replaced, 0);
  assert.equal(r.dropped, 1);
});

// ---------------------------------------------------------------- refreshStaleItems

test('todo vigente: no toca nada y no llama al motor', async () => {
  const stored = nested([item('Fútbol', 3), item('Economía', 20), item('river plate', 23.5)]);
  let llamadas = 0;
  const r = await refreshStaleItems(stored, { now: NOW, rebuild: async () => { llamadas++; return nested([]); } });
  assert.equal(r.changed, false);
  assert.equal(r.digest, stored, 'devuelve el mismo objeto');
  assert.equal(llamadas, 0);
});

test('una vencida se repone, en su lugar, y el motor recibe los temas vencidos y las notas que se quedan', async () => {
  const a = item('Fútbol', 3);
  const b = item('Economía', 30); // vencida
  const c = item('river plate', 20);
  const stored = nested([a, b, c]);
  const nueva = item('Economía', 2, { title: 'Reposición' });

  let recibido = null;
  const r = await refreshStaleItems(stored, {
    now: NOW,
    rebuild: async (opts) => { recibido = opts; return nested([nueva]); },
  });

  assert.deepEqual(recibido.onlyTopics, ['Economía']);
  assert.deepEqual(recibido.keepItems, [a, c]);
  assert.equal(r.changed, true);
  assert.equal(r.replaced, 1);
  assert.equal(r.dropped, 0);
  assert.deepEqual(r.digest.digest.items, [a, nueva, c], 'misma posición y mismo orden');
  assert.deepEqual(r.digest.user, stored.user, 'el resto del digest se conserva');
});

test('no modifica el digest que recibe', async () => {
  const stored = nested([item('Fútbol', 3), item('Economía', 30)], { audioUrl: 'https://audio.test/x.mp3' });
  const copia = JSON.parse(JSON.stringify(stored));
  await refreshStaleItems(stored, { now: NOW, rebuild: async () => nested([item('Economía', 1)]) });
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), copia);
});

test('el audio del digest entero se borra cuando cambian las notas (ya no corresponde)', async () => {
  const stored = nested([item('Fútbol', 30)], { audioUrl: 'https://audio.test/x.mp3', audioStorageKey: 'k', audioGeneratedAt: hace(5) });
  const r = await refreshStaleItems(stored, { now: NOW, rebuild: async () => nested([item('Fútbol', 1)]) });
  assert.equal(r.digest.digest.audioUrl, null);
  assert.equal(r.digest.digest.audioStorageKey, null);
  assert.equal(r.digest.digest.audioGeneratedAt, null);
});

test('la forma vieja ({ items }) se conserva', async () => {
  const stored = { items: [item('Fútbol', 30), item('Salud', 1)], audioUrl: null };
  const nueva = item('Fútbol', 2);
  const r = await refreshStaleItems(stored, { now: NOW, rebuild: async () => ({ items: [nueva] }) });
  assert.equal(r.digest.digest, undefined);
  assert.deepEqual(r.digest.items.map((i) => i.url), [nueva.url, stored.items[1].url]);
});

test('sin reposición disponible: se saca la nota vencida (mejor un hueco)', async () => {
  const a = item('Fútbol', 3);
  const stored = nested([a, item('Economía', 30), item('river plate', 31)]);
  const r = await refreshStaleItems(stored, { now: NOW, rebuild: async () => nested([]) });
  assert.deepEqual(r.digest.digest.items, [a]);
  assert.equal(r.dropped, 2);
  assert.equal(r.failed, null);
});

test('si el motor falla: se sirven solo las vigentes y queda registrado el error', async () => {
  const a = item('Fútbol', 3);
  const stored = nested([a, item('Economía', 30)]);
  const r = await refreshStaleItems(stored, { now: NOW, rebuild: async () => { throw new Error('OpenAI caído'); } });
  assert.deepEqual(r.digest.digest.items, [a]);
  assert.equal(r.failed.message, 'OpenAI caído');
  assert.equal(r.changed, true);
});

test('una reposición que tampoco está vigente se descarta', async () => {
  const stored = nested([item('Fútbol', 3), item('Economía', 30)]);
  const r = await refreshStaleItems(stored, {
    now: NOW,
    rebuild: async () => nested([item('Economía', 50), item('Economía', null)]),
  });
  assert.equal(r.digest.digest.items.length, 1);
  assert.equal(r.dropped, 1);
});

test('dos vencidas del mismo tema piden dos reposiciones', async () => {
  const stored = nested([item('Fútbol', 30), item('Fútbol', 31), item('Salud', 1)]);
  let recibido = null;
  await refreshStaleItems(stored, { now: NOW, rebuild: async (o) => { recibido = o; return nested([]); } });
  assert.deepEqual(recibido.onlyTopics, ['Fútbol', 'Fútbol']);
});

test('una vencida sin tema se saca sin molestar al motor', async () => {
  const stored = nested([{ publishedAt: hace(40), url: 'https://medio.test/x' }, item('Salud', 2)]);
  let llamadas = 0;
  const r = await refreshStaleItems(stored, { now: NOW, rebuild: async () => { llamadas++; return nested([]); } });
  assert.equal(llamadas, 0);
  assert.equal(r.digest.digest.items.length, 1);
});

test('un digest sin notas o con otra forma queda igual', async () => {
  for (const stored of [nested([]), {}, null, { digest: null }]) {
    const r = await refreshStaleItems(stored, { now: NOW, rebuild: async () => { throw new Error('no debería llamarse'); } });
    assert.equal(r.changed, false);
    assert.equal(r.digest, stored);
  }
});

test('caso real: digest preparado a las 07:45 y abierto una hora después', async () => {
  const preparado = Date.parse('2026-10-15T10:45:00.000Z'); // 07:45 (UTC-3)
  const abierto = preparado + 3600e3 * 1.0;
  const edadAlPreparar = (h) => new Date(preparado - h * 3600e3);
  const a = item('Fútbol', 0, { publishedAt: edadAlPreparar(5) });      // 6 h al abrir
  const b = item('Economía', 0, { publishedAt: edadAlPreparar(20) });   // 21 h
  const c = item('river plate', 0, { publishedAt: edadAlPreparar(23.5) }); // 24,5 h: se venció esperando
  const stored = nested([a, b, c]);
  const repo = item('river plate', 0, { publishedAt: new Date(abierto - 2 * 3600e3) });

  const r = await refreshStaleItems(stored, { now: abierto, rebuild: async () => nested([repo]) });
  assert.deepEqual(r.digest.digest.items, [a, b, repo]);
  assert.equal(r.staleCount, 1);
});

test('propiedad: lo que sale nunca tiene una nota vencida, pase lo que pase con el motor', async () => {
  let semilla = 12345;
  const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
  const temas = ['Fútbol', 'Economía', 'river plate', 'Salud'];

  for (let corrida = 0; corrida < 300; corrida++) {
    const items = temas.slice(0, 1 + Math.floor(azar() * 4)).map((t) => item(t, azar() < 0.2 ? null : azar() * 60 - 3));
    const stored = nested(items);
    const modo = Math.floor(azar() * 4);
    const rebuild = async ({ onlyTopics }) => {
      if (modo === 0) throw new Error('falla');
      if (modo === 1) return nested([]);
      return nested(onlyTopics.map((t) => item(t, azar() * 60 - 3))); // reposiciones con edades al azar (algunas vencidas)
    };
    const r = await refreshStaleItems(stored, { now: NOW, rebuild });
    for (const it of digestItemsOf(r.digest).items) {
      assert.equal(staleReason(it, NOW), null, `corrida ${corrida}: salió una nota vencida`);
    }
    // y las vigentes de origen siguen estando, en el mismo orden relativo
    const vigentes = digestItemsOf(stored).items.filter((it) => staleReason(it, NOW) === null);
    const salida = digestItemsOf(r.digest).items.filter((it) => vigentes.includes(it));
    assert.deepEqual(salida, vigentes, `corrida ${corrida}: se perdió o se movió una vigente`);
  }
});

// ---------------------------------------------------------------- ensureFreshDigest (lo que usan las rutas)

test('ensureFreshDigest: si no hay nada vencido no guarda nada', async () => {
  const run = { _id: 'r1', digest: nested([item('Fútbol', 3)]) };
  let guardado = 0;
  const r = await ensureFreshDigest(run, { now: NOW, rebuild: async () => nested([]), persist: async () => { guardado++; }, logger: silencio });
  assert.equal(r.changed, false);
  assert.equal(r.digest, run.digest);
  assert.equal(guardado, 0);
});

test('ensureFreshDigest: guarda el digest revisado en el mismo run', async () => {
  const run = { _id: 'r1', preparedAt: hace(2), digest: nested([item('Fútbol', 3), item('Economía', 30)]) };
  const repo = item('Economía', 1);
  let guardado = null;
  const r = await ensureFreshDigest(run, {
    now: NOW,
    rebuild: async () => nested([repo]),
    persist: async (runRecibido, digest) => { guardado = { runRecibido, digest }; },
    logger: silencio,
  });
  assert.equal(r.changed, true);
  assert.equal(guardado.runRecibido, run);
  assert.deepEqual(guardado.digest, r.digest);
  assert.equal(digestItemsOf(r.digest).items[1], repo);
});

test('ensureFreshDigest: si el reemplazo falló sirve el digest sin las vencidas y NO lo guarda', async () => {
  const run = { _id: 'r1', digest: nested([item('Fútbol', 3), item('Economía', 30)]) };
  let guardado = 0;
  const r = await ensureFreshDigest(run, {
    now: NOW,
    rebuild: async () => { throw new Error('Atlas caído'); },
    persist: async () => { guardado++; },
    logger: silencio,
  });
  assert.equal(digestItemsOf(r.digest).items.length, 1);
  assert.equal(guardado, 0, 'la próxima apertura vuelve a intentar');
  assert.ok(r.failed);
});

test('ensureFreshDigest: si no se puede guardar igual se entrega el digest revisado', async () => {
  const run = { _id: 'r1', digest: nested([item('Fútbol', 30)]) };
  const repo = item('Fútbol', 1);
  const r = await ensureFreshDigest(run, {
    now: NOW,
    rebuild: async () => nested([repo]),
    persist: async () => { throw new Error('Mongo no responde'); },
    logger: silencio,
  });
  assert.equal(digestItemsOf(r.digest).items[0], repo);
});

test('ensureFreshDigest: ante un error inesperado sirve el digest como estaba (nunca rompe la apertura)', async () => {
  const run = { _id: 'r1', digest: nested([item('Fútbol', 30)]) };
  const r = await ensureFreshDigest(run, {
    now: NOW,
    rebuild: async () => nested([item('Fútbol', 1)]),
    logger: { log() { throw new Error('el log explotó'); }, error() {} },
  });
  assert.equal(r.digest, run.digest);
  assert.equal(r.changed, false);
  assert.ok(r.error);
});

test('ensureFreshDigest: un run sin digest no rompe', async () => {
  for (const run of [null, undefined, {}, { digest: null }]) {
    const r = await ensureFreshDigest(run, { now: NOW, logger: silencio });
    assert.equal(r.changed, false);
  }
});
