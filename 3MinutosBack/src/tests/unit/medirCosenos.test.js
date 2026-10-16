'use strict';

/**
 * medirCosenos.js (el script que le muestra al usuario el coseno real entre las notas de su base): la cuenta de los
 * pares, el histograma, cómo se eligen las notas a medir y que no escribe nada. La base es falsa.
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cosine, SAME_STORY_COSINE, SAME_STORY_JUDGE_MIN_COSINE } = require('../../utils/eligibility');
const {
  cargarNotas, CORTES, zonaDeCoseno, normalizar, horasEntre, medirPares, idsDeReporte, clasificarReferencias, contiene,
  leerParametros, textoDeAyuda, formatearPar, formatearHistograma,
} = require('../medirCosenos');

test.before(() => {
  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
});

/** Dos vectores unitarios en 2-D con el coseno pedido. */
const conCoseno = (c) => [[1, 0], [c, Math.sqrt(1 - c * c)]];
const nota = (id, embedding, extra = {}) => ({ _id: id, title: `Nota ${id}`, sourceName: 'Medio', embedding, ...extra });

// ================================================================ zonas
test('zonaDeCoseno: usa los mismos umbrales que el motor', () => {
  assert.equal(zonaDeCoseno(1), 'MISMA');
  assert.equal(zonaDeCoseno(SAME_STORY_COSINE), 'MISMA');
  assert.equal(zonaDeCoseno(SAME_STORY_COSINE - 0.0001), 'BANDA');
  assert.equal(zonaDeCoseno(SAME_STORY_JUDGE_MIN_COSINE), 'BANDA');
  assert.equal(zonaDeCoseno(SAME_STORY_JUDGE_MIN_COSINE - 0.0001), 'DISTINTA');
  assert.equal(zonaDeCoseno(0), 'DISTINTA');
});

// ================================================================ vectores
test('normalizar: deja el vector en largo 1 y rechaza lo que no sirve', () => {
  const v = normalizar([3, 4]);
  assert.deepEqual(Array.from(v), [0.6, 0.8]);
  for (const malo of [undefined, null, [], 'abc', {}, [0, 0, 0], [1, NaN], [1, Infinity], [1, '2']]) {
    assert.equal(normalizar(malo), null, JSON.stringify(malo));
  }
});

// ================================================================ pares
test('medirPares: el coseno de cada par es el mismo que calcula el motor, de mayor a menor', () => {
  // vectores "al azar" pero fijos
  let semilla = 12345;
  const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648 - 0.5; };
  const notas = Array.from({ length: 8 }, (_, i) => nota(`n${i}`, Array.from({ length: 24 }, azar)));

  const { pares, paresTotales } = medirPares(notas, { min: -1 });
  assert.equal(paresTotales, 28, '8 notas → 28 pares');
  assert.equal(pares.length, 28);
  for (const par of pares) {
    assert.equal(par.coseno, Math.round(cosine(par.a.embedding, par.b.embedding) * 1000) / 1000);
  }
  const cosenos = pares.map((p) => p.coseno);
  assert.deepEqual(cosenos, [...cosenos].sort((x, y) => y - x), 'ordenados de mayor a menor');
});

test('medirPares: solo devuelve los pares desde el mínimo, pero los cuenta todos', () => {
  const [a1, a2] = conCoseno(0.9);
  const [, a3] = conCoseno(0.5);
  const notas = [nota('a', a1), nota('b', a2), nota('c', a3)];
  // a-b = 0.9 · a-c = 0.5 · b-c = 0.9*0.5 + sqrt(.19)*sqrt(.75) = 0.45 + 0.37749 = 0.82749
  const { pares, paresTotales } = medirPares(notas, { min: 0.8 });
  assert.equal(paresTotales, 3);
  assert.deepEqual(pares.map((p) => [p.a._id, p.b._id, p.coseno]), [['a', 'b', 0.9], ['b', 'c', 0.827]]);
  assert.deepEqual(pares.map((p) => p.zona), ['MISMA', 'BANDA']);

  assert.equal(medirPares(notas).pares.length, 2, 'por defecto desde 0,76');
  assert.equal(medirPares(notas, { min: 0.95 }).pares.length, 0);
  // el mínimo incluye al par que lo iguala: dos vectores ortogonales tienen coseno exactamente 0
  assert.equal(medirPares([nota('x', [1, 0]), nota('y', [0, 1])], { min: 0 }).pares.length, 1);
});

test('medirPares: las notas sin embedding o de otro modelo no se miden y se cuentan aparte', () => {
  const [a, b] = conCoseno(0.9);
  const notas = [nota('a', a), nota('b', b), nota('sin', []), nota('nula', null), nota('otro', [1, 0, 0])];
  const m = medirPares(notas);
  assert.equal(m.notas, 2);
  assert.equal(m.sinVector, 2);
  assert.equal(m.otraDimension, 1);
  assert.equal(m.paresTotales, 1);
  assert.equal(m.pares.length, 1);

  assert.deepEqual(medirPares([]).pares, []);
  assert.equal(medirPares([nota('sola', a)]).paresTotales, 0);
  assert.equal(medirPares().notas, 0);
});

test('medirPares: cada par cae en el tramo del histograma que le corresponde (incluidos los dos umbrales del motor)', () => {
  assert.ok(CORTES.includes(SAME_STORY_COSINE) && CORTES.includes(SAME_STORY_JUDGE_MIN_COSINE));
  assert.deepEqual([...CORTES], [...CORTES].sort((x, y) => y - x), 'de mayor a menor');

  const casos = [
    [0.99, 0.95, 'MISMA'],
    [SAME_STORY_COSINE + 0.000001, SAME_STORY_COSINE, 'MISMA'],
    [SAME_STORY_COSINE - 0.000001, 0.84, 'BANDA'],
    [SAME_STORY_JUDGE_MIN_COSINE + 0.000001, SAME_STORY_JUDGE_MIN_COSINE, 'BANDA'],
    [SAME_STORY_JUDGE_MIN_COSINE - 0.000001, 0.76, 'DISTINTA'],
    [0.70, 0.68, 'DISTINTA'],
  ];
  for (const [coseno, desdeEsperado, zona] of casos) {
    const [a, b] = conCoseno(coseno);
    const { histograma } = medirPares([nota('a', a), nota('b', b)]);
    const llenos = histograma.filter((fila) => fila.cantidad > 0);
    assert.equal(llenos.length, 1, `coseno ${coseno}: un solo tramo`);
    assert.equal(llenos[0].cantidad, 1);
    assert.equal(llenos[0].zona, zona, `coseno ${coseno}`);
    assert.equal(llenos[0].desde, desdeEsperado, `coseno ${coseno}`);
    assert.ok(llenos[0].desde <= coseno && (llenos[0].hasta === null || coseno < llenos[0].hasta), `coseno ${coseno} en [${llenos[0].desde}, ${llenos[0].hasta})`);
  }

  // por debajo del último corte no se cuenta en el histograma (pero sí en los pares totales)
  const [a, b] = conCoseno(0.3);
  const m = medirPares([nota('a', a), nota('b', b)]);
  assert.equal(m.histograma.reduce((s, f) => s + f.cantidad, 0), 0);
  assert.equal(m.paresTotales, 1);
});

test('medirPares: informa las horas entre las dos publicaciones', () => {
  const [a, b] = conCoseno(0.9);
  const m = medirPares([
    nota('a', a, { publishedAt: '2026-10-16T10:00:00Z' }),
    nota('b', b, { publishedAt: '2026-10-16T11:30:00Z' }),
  ]);
  assert.equal(m.pares[0].horasEntre, 1.5);
  assert.equal(horasEntre({ publishedAt: '2026-10-16T10:00:00Z' }, { publishedAt: '2026-10-16T09:00:00Z' }), 1);
  assert.equal(horasEntre({}, { publishedAt: '2026-10-16T09:00:00Z' }), null);
  assert.equal(horasEntre({ publishedAt: 'no es una fecha' }, { publishedAt: '2026-10-16T09:00:00Z' }), null);
});

// ================================================================ qué notas se miden
test('idsDeReporte: las notas entregadas por una corrida del comparador, sin repetir', () => {
  const reporte = {
    meta: {},
    resultados: [
      { tema: 'a', articulo: { id: 'id1' } },
      { tema: 'b', articulo: { id: 'id2' } },
      { tema: 'c', articulo: { id: 'id1' } },
      { tema: 'd', articulo: null },
      { tema: 'e', articulo: { id: null } },
      { tema: 'f' },
    ],
  };
  assert.deepEqual(idsDeReporte(reporte), ['id1', 'id2']);
  assert.deepEqual(idsDeReporte({}), []);
  assert.deepEqual(idsDeReporte(null), []);
});

test('clasificarReferencias: separa ids de Mongo, urls y trozos de título', () => {
  assert.deepEqual(
    clasificarReferencias(['65f1a2b3c4d5e6f708192a3b', 'https://medio.test/nota', 'http://x.test/y', 'Milei viajó', '  ', '65F1A2B3C4D5E6F708192A3B']),
    { ids: ['65f1a2b3c4d5e6f708192a3b', '65F1A2B3C4D5E6F708192A3B'], urls: ['https://medio.test/nota', 'http://x.test/y'], titulos: ['Milei viajó'] },
  );
  assert.deepEqual(clasificarReferencias(), { ids: [], urls: [], titulos: [] });
  // 24 caracteres que no son hexadecimales no son un id; y un texto hexadecimal de otro largo ("cafe") tampoco
  assert.deepEqual(clasificarReferencias(['zzzzzzzzzzzzzzzzzzzzzzzz']).titulos, ['zzzzzzzzzzzzzzzzzzzzzzzz']);
  assert.deepEqual(clasificarReferencias(['cafe', '65f1a2b3c4d5e6f708192a3', '65f1a2b3c4d5e6f708192a3b4']).titulos,
    ['cafe', '65f1a2b3c4d5e6f708192a3', '65f1a2b3c4d5e6f708192a3b4']);
});

test('contiene: sin mayúsculas ni tildes, en el título o en los tags', () => {
  const n = { title: 'River goleó en el Monumental', tags: ['fútbol', 'Superclásico'] };
  assert.equal(contiene(n, 'RIVER'), true);
  assert.equal(contiene(n, 'futbol'), true);
  assert.equal(contiene(n, 'FÚTBOL'), true, 'también la búsqueda va sin tildes');
  assert.equal(contiene(n, 'superclasico'), true);
  assert.equal(contiene(n, 'boca'), false);
  assert.equal(contiene(n, ''), true);
  assert.equal(contiene({}, 'river'), false);
});

test('leerParametros: valores por defecto cuando faltan, están mal escritos o son banderas sin valor', () => {
  assert.deepEqual(leerParametros({}), { min: 0.76, maxPares: 60, horas: 24, maxNotas: 1500 });
  assert.deepEqual(leerParametros(), { min: 0.76, maxPares: 60, horas: 24, maxNotas: 1500 });
  assert.deepEqual(
    leerParametros({ min: '0.7', 'max-pares': '10', horas: '48', 'max-notas': '300' }),
    { min: 0.7, maxPares: 10, horas: 48, maxNotas: 300 },
  );
  assert.equal(leerParametros({ min: '0' }).min, 0, 'cero es un mínimo válido');
  assert.equal(leerParametros({ min: '-1' }).min, -1);
  for (const malo of [true, 'abc', '', '2', '-2']) assert.equal(leerParametros({ min: malo }).min, 0.76, String(malo));
  for (const malo of [true, 'abc', '', '0', '-5']) {
    assert.deepEqual(
      [leerParametros({ horas: malo }).horas, leerParametros({ 'max-pares': malo }).maxPares, leerParametros({ 'max-notas': malo }).maxNotas],
      [24, 60, 1500], String(malo),
    );
  }
  assert.equal(leerParametros({ 'max-pares': '7.9' }).maxPares, 7);
});

// ---- cargarNotas, con una base falsa que solo sabe leer
function baseFalsa({ find = [], findOne = null } = {}) {
  const consultas = [];
  const cadena = (resultado, registro) => {
    const q = { ...registro };
    const c = {
      select: (campos) => { q.select = campos; return c; },
      sort: (orden) => { q.sort = orden; return c; },
      limit: (n) => { q.limit = n; return c; },
      lean: async () => { consultas.push(q); return resultado; },
    };
    return c;
  };
  return {
    consultas,
    Article: {
      find: (filtro) => cadena(find, { tipo: 'find', filtro }),
      findOne: (filtro) => cadena(findOne, { tipo: 'findOne', filtro }),
    },
  };
}

test('cargarNotas: por defecto, las notas con embedding de las últimas 24 h, las más nuevas primero y con tope', async () => {
  const ahora = Date.parse('2026-10-16T12:00:00Z');
  const { Article, consultas } = baseFalsa({ find: [nota('a', [1, 0]), nota('b', [0, 1])] });
  const r = await cargarNotas({ Article, args: { _: [] }, ahora });

  assert.equal(r.notas.length, 2);
  assert.match(r.origen, /^2 notas de las últimas 24 h$/);
  assert.equal(consultas.length, 1);
  const { filtro, sort, limit, select } = consultas[0];
  assert.equal(filtro.publishedAt.$gte.toISOString(), '2026-10-15T12:00:00.000Z');
  assert.equal(filtro.embeddingStatus, 'done');
  assert.equal(filtro.category, undefined);
  assert.deepEqual(sort, { publishedAt: -1 });
  assert.equal(limit, 1500);
  assert.match(select, /embedding/);
});

test('cargarNotas: --horas, --categoria (sin importar mayúsculas), --contiene y --max-notas', async () => {
  const ahora = Date.parse('2026-10-16T12:00:00Z');
  const { Article, consultas } = baseFalsa({
    find: [nota('a', [1, 0], { title: 'River goleó' }), nota('b', [0, 1], { title: 'Boca empató' })],
  });
  const r = await cargarNotas({
    Article, ahora, args: { _: [], horas: '48', categoria: 'deportes', contiene: 'RIVER', 'max-notas': '2' },
  });

  const { filtro, limit } = consultas[0];
  assert.equal(filtro.publishedAt.$gte.toISOString(), '2026-10-14T12:00:00.000Z');
  assert.ok(filtro.category instanceof RegExp && filtro.category.test('Deportes') && !filtro.category.test('Deportes y más'));
  assert.equal(limit, 2);
  assert.deepEqual(r.notas.map((n) => n._id), ['a'], '--contiene filtra por título o tags');
  assert.match(r.origen, /1 notas de las últimas 48 h \(categoría deportes, que nombran "RIVER"\)/);
  assert.match(r.origen, /tope de 2 notas/, 'avisa que la ventana tenía más notas que el tope');
});

test('cargarNotas: la categoría se busca literal (no como expresión regular)', async () => {
  const { Article, consultas } = baseFalsa({ find: [] });
  await cargarNotas({ Article, args: { _: [], categoria: 'Ciencia (.*)' } });
  const re = consultas[0].filtro.category;
  assert.equal(re.test('Ciencia (.*)'), true);
  assert.equal(re.test('Ciencia (algo)'), false);
});

test('cargarNotas: con referencias busca esas notas por id, por url y por parte del título (sin repetir)', async () => {
  const dosVeces = nota('65f1a2b3c4d5e6f708192a3b', [1, 0], { title: 'Nota por id y por título' });
  const fake = baseFalsa({ find: [dosVeces], findOne: dosVeces });
  const r = await cargarNotas({
    Article: fake.Article,
    args: { _: ['65f1a2b3c4d5e6f708192a3b', 'https://medio.test/nota', 'por id y por título (con paréntesis)'] },
  });

  const porTipo = fake.consultas.map((q) => q.tipo);
  assert.deepEqual(porTipo, ['find', 'find', 'findOne']);
  assert.deepEqual(fake.consultas[0].filtro, { _id: { $in: ['65f1a2b3c4d5e6f708192a3b'] } });
  assert.deepEqual(fake.consultas[1].filtro, { url: { $in: ['https://medio.test/nota'] } });
  const regTitulo = fake.consultas[2].filtro.title;
  assert.ok(regTitulo.test('Nota POR ID Y POR TÍTULO (con paréntesis)') && regTitulo.flags.includes('i'));
  assert.equal(regTitulo.test('Nota por id y por título con paréntesis'), false, 'los paréntesis del texto son literales');
  assert.deepEqual(fake.consultas[2].sort, { publishedAt: -1 }, 'si hay varias con ese título, la más nueva');
  assert.equal(r.notas.length, 1, 'la misma nota por tres caminos cuenta una vez');
  assert.match(r.origen, /1 notas que indicaste/);
});

test('cargarNotas: una referencia por título que no existe se avisa y no frena', async () => {
  const avisos = [];
  const logOriginal = console.log;
  console.log = (...a) => avisos.push(a.join(' '));
  try {
    const { Article } = baseFalsa({ find: [], findOne: null });
    const r = await cargarNotas({ Article, args: { _: ['no existe esta nota'] } });
    assert.deepEqual(r.notas, []);
    assert.ok(avisos.some((l) => l.includes('no existe esta nota')), avisos.join('|'));
  } finally {
    console.log = logOriginal;
  }
});

test('cargarNotas: con un reporte del comparador mide las notas que entregó', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosenos-'));
  try {
    const archivo = path.join(dir, 'despues.json');
    fs.writeFileSync(archivo, JSON.stringify({ resultados: [{ articulo: { id: 'idA' } }, { articulo: { id: 'idB' } }, { articulo: null }] }));
    const fake = baseFalsa({ find: [nota('idA', [1, 0]), nota('idB', [0, 1])] });
    const r = await cargarNotas({ Article: fake.Article, args: { _: [], reporte: archivo } });

    assert.deepEqual(fake.consultas[0].filtro, { _id: { $in: ['idA', 'idB'] } });
    assert.equal(r.notas.length, 2);
    assert.match(r.origen, /las 2 notas del reporte/);

    fs.writeFileSync(archivo, JSON.stringify({ resultados: [] }));
    await assert.rejects(cargarNotas({ Article: fake.Article, args: { _: [], reporte: archivo } }), /no trae notas entregadas/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================ salida
test('formatearPar y formatearHistograma: muestran coseno, zona, medios, títulos y cuántos pares hay en cada tramo', () => {
  const [a, b] = conCoseno(0.9);
  const m = medirPares([
    nota('a', a, { title: 'Milei anunció medidas', sourceName: 'Infobae', publishedAt: '2026-10-16T10:00:00Z' }),
    nota('b', b, { title: 'El Gobierno lanzó un paquete', sourceName: 'Clarín', publishedAt: '2026-10-16T10:36:00Z' }),
  ]);
  const texto = formatearPar(m.pares[0], 1);
  assert.match(texto, /^ {2}1 {2}0\.900 {2}MISMA {4}separadas por 0\.6 h\n/);
  assert.match(texto, /Infobae +\| Milei anunció medidas/);
  assert.match(texto, /Clarín +\| El Gobierno lanzó un paquete/);

  const sinFecha = formatearPar({ ...m.pares[0], horasEntre: null }, 12);
  assert.match(sinFecha, /separadas por – h/);

  const histograma = formatearHistograma(m);
  const filaMisma = histograma.split('\n').find((l) => l.startsWith(`  ${SAME_STORY_COSINE.toFixed(2)} – `));
  assert.match(filaMisma, /MISMA +1 /);
  assert.match(histograma, /≥ 0\.95/);
  assert.equal(histograma.split('\n').length, CORTES.length + 1);
});

test('el modo de uso se imprime con --ayuda', () => {
  const ayuda = textoDeAyuda();
  assert.match(ayuda, /^medirCosenos\.js/);
  assert.match(ayuda, /node src\/tests\/medirCosenos\.js/);
  assert.match(ayuda, /--reporte/);
  assert.doesNotMatch(ayuda, /^ \*/m, 'sin los asteriscos del comentario');
});

// ================================================================ solo lectura
test('el script no escribe en Mongo ni usa OpenAI', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'medirCosenos.js'), 'utf8')
    .replace(/\/\*\*[\s\S]*?\*\//, '') // sin el comentario de uso
    .replace(/^\s*\/\/.*$/gm, '');
  const escrituras = fuente.match(/\.(save|create|insertOne|insertMany|updateOne|updateMany|update|deleteOne|deleteMany|remove|bulkWrite|findOneAndUpdate|findByIdAndUpdate|findOneAndDelete|findOneAndReplace|replaceOne|drop|dropDatabase|createIndex|ensureIndexes|syncIndexes)\s*\(/g);
  assert.equal(escrituras, null, `escribe en la base: ${escrituras}`);
  assert.doesNotMatch(fuente, /require\([^)]*openai/i);
  assert.match(fuente, /autoIndex', false/, 'ni siquiera crea índices');
  assert.match(fuente, /autoCreate', false/);
});
