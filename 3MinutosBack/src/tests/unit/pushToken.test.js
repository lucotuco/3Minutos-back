'use strict';

/**
 * Un token de notificaciones pertenece a UNA cuenta: al guardarlo en una, se saca de las demás (utils/releasePushToken.js).
 * Caso real: Naty F tenía dos cuentas con el mismo token y le llegaban los avisos de las dos.
 * Se levanta el router real con autenticación real y el modelo de Mongo falso (guarda en memoria).
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

process.env.JWT_SECRET = 'x'.repeat(48);
// El router carga módulos que piden las claves de OpenAI al importarse (ningún test las usa).
process.env.OPENAI_API_KEY_EMBEDDINGS ||= 'test';
process.env.OPENAI_API_KEY_REVIEW ||= 'test';

const SRC = path.join(__dirname, '..', '..');
const { releasePushTokenFromOtherUsers } = require('../../utils/releasePushToken');

const VIEJA = '6a5e344751a0b1eb89521f62';
const ACTUAL = '6a621d21903a120db4315984';
const OTRA = '65f1a2b3c4d5e6f708192a3b';
const TOKEN = 'ExponentPushToken[W5wUhjINrP8bpfb-EJXswf]';
const OTRO_TOKEN = 'ExponentPushToken[otroCelular123]';

test.before(() => {
  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
});

/** Modelo UserPreference falso: una "colección" en memoria con lo que usan las rutas. */
function modeloFalso(usuarios) {
  const docs = new Map(usuarios.map((u) => [u._id, { isActive: true, topics: ['a', 'b', 'c'], deliveryTime: '08:00', ...u }]));
  const coincide = (d, filtro) => (filtro.expoPushToken === undefined || d.expoPushToken === filtro.expoPushToken)
    && (!filtro._id?.$ne || String(d._id) !== String(filtro._id.$ne));
  return {
    docs,
    async updateMany(filtro, { $set }) {
      let modifiedCount = 0;
      for (const d of docs.values()) if (coincide(d, filtro)) { Object.assign(d, $set); modifiedCount++; }
      return { modifiedCount };
    },
    findByIdAndUpdate(id, { $set }) {
      const d = docs.get(String(id));
      if (d) Object.assign(d, $set);
      return { lean: async () => (d ? { ...d } : null) };
    },
    async create(datos) {
      const _id = '6b0000000000000000000001';
      const d = { _id, ...datos };
      docs.set(_id, d);
      return { ...d };
    },
    findById(id) {
      const d = docs.get(String(id));
      return { lean: async () => (d ? { ...d } : null), then: (ok, mal) => Promise.resolve(d ? { ...d } : null).then(ok, mal) };
    },
  };
}

async function montar(modelo, userId) {
  const instalar = (rel, exports) => {
    const abs = require.resolve(path.join(SRC, rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
  };
  instalar('models/UserPreference.js', modelo);
  const rutas = path.join(SRC, 'routes', 'userRoutes.js');
  delete require.cache[require.resolve(rutas)];
  const router = require(rutas);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/users', router);
  const { signUserToken } = require(path.join(SRC, 'middleware', 'auth.js'));

  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = { Authorization: `Bearer ${signUserToken(userId)}`, 'Content-Type': 'application/json' };
      const pedir = async (method, ruta, body) => {
        const r = await fetch(base + ruta, { method, headers, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
      };
      resolve({ pedir, cerrar: () => new Promise((ok) => server.close(ok)) });
    });
  });
}

// ================================================================ la función
test('saca el token de las otras cuentas y no toca la que lo guardó ni las de otro celular', async () => {
  const modelo = modeloFalso([
    { _id: VIEJA, expoPushToken: TOKEN },
    { _id: ACTUAL, expoPushToken: TOKEN },
    { _id: OTRA, expoPushToken: OTRO_TOKEN },
  ]);
  assert.equal(await releasePushTokenFromOtherUsers(modelo, TOKEN, ACTUAL), 1);
  assert.equal(modelo.docs.get(VIEJA).expoPushToken, null);
  assert.equal(modelo.docs.get(VIEJA).isActive, true, 'la cuenta vieja no se desactiva: solo pierde el token');
  assert.equal(modelo.docs.get(ACTUAL).expoPushToken, TOKEN);
  assert.equal(modelo.docs.get(OTRA).expoPushToken, OTRO_TOKEN);
});

test('sin token o sin dueño no hace nada, y si Mongo falla no rompe el guardado', async () => {
  let llamadas = 0;
  const contador = { updateMany: async () => { llamadas++; return { modifiedCount: 0 }; } };
  assert.equal(await releasePushTokenFromOtherUsers(contador, '', ACTUAL), 0);
  assert.equal(await releasePushTokenFromOtherUsers(contador, TOKEN, null), 0);
  assert.equal(llamadas, 0);

  const roto = { updateMany: async () => { throw new Error('Mongo caído'); } };
  assert.equal(await releasePushTokenFromOtherUsers(roto, TOKEN, ACTUAL), 0);
});

// ================================================================ las rutas
test('PATCH /preferences/:id/push-token: la cuenta que guarda el token se queda con él', async () => {
  const modelo = modeloFalso([{ _id: VIEJA, expoPushToken: TOKEN }, { _id: ACTUAL, expoPushToken: null }]);
  const app = await montar(modelo, ACTUAL);
  try {
    const r = await app.pedir('PATCH', `/users/preferences/${ACTUAL}/push-token`, { expoPushToken: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(modelo.docs.get(ACTUAL).expoPushToken, TOKEN);
    assert.equal(modelo.docs.get(VIEJA).expoPushToken, null);
  } finally {
    await app.cerrar();
  }
});

test('PATCH /preferences/:id con token: también se lo saca a las otras cuentas', async () => {
  const modelo = modeloFalso([{ _id: VIEJA, expoPushToken: TOKEN }, { _id: ACTUAL, expoPushToken: null }]);
  const app = await montar(modelo, ACTUAL);
  try {
    const r = await app.pedir('PATCH', `/users/preferences/${ACTUAL}`, { deliveryTime: '10:50', expoPushToken: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(modelo.docs.get(VIEJA).expoPushToken, null);
  } finally {
    await app.cerrar();
  }
});

test('PATCH /preferences/:id SIN token no toca el token de nadie', async () => {
  const modelo = modeloFalso([{ _id: VIEJA, expoPushToken: TOKEN }, { _id: ACTUAL, expoPushToken: TOKEN }]);
  const app = await montar(modelo, ACTUAL);
  try {
    await app.pedir('PATCH', `/users/preferences/${ACTUAL}`, { deliveryTime: '10:50' });
    assert.equal(modelo.docs.get(VIEJA).expoPushToken, TOKEN);
  } finally {
    await app.cerrar();
  }
});

test('POST /preferences (cuenta nueva) con el token de otra cuenta: la nueva se lo queda', async () => {
  const modelo = modeloFalso([{ _id: VIEJA, expoPushToken: TOKEN }]);
  const app = await montar(modelo, VIEJA);
  try {
    const r = await app.pedir('POST', '/users/preferences', {
      name: 'Naty F', topics: ['Messi', 'River Plate', 'Milei'], deliveryTime: '10:50', expoPushToken: TOKEN,
    });
    assert.equal(r.status, 201);
    assert.equal(modelo.docs.get(VIEJA).expoPushToken, null);
    assert.equal(modelo.docs.get('6b0000000000000000000001').expoPushToken, TOKEN);
  } finally {
    await app.cerrar();
  }
});
