'use strict';

/**
 * Tests de la elegibilidad y el orden de las notas (lógica pura, sin Mongo ni OpenAI).
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IMPORTANCE_GOOD_MIN, IMPORTANCE_ACCEPTABLE_MIN, SAME_STORY_COSINE, TIER,
  cosine, ageHoursOf, tierOf, ageBandOf, isOpinionArticle, isAdvertisingArticle, isForeignInLocalCategory,
  OPINION_URL_SEGMENTS, ADVERTISING_URL_SEGMENTS, findSameStory, mostSimilarSeen, checkEligibility, compareCandidates, rankEligible,
} = require('../../utils/eligibility');

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const hace = (horas) => new Date(NOW - horas * 3600e3);

let n = 0;
const nota = (extra = {}) => ({
  _id: `id${String(n++).padStart(4, '0')}`,
  url: `https://ejemplo.test/${n}`,
  title: 'El Gobierno anunció una medida económica',
  publishedAt: hace(3),
  importanceScore: 60,
  category: 'Deportes',
  geoScope: 'Argentina',
  section: 'general',
  tags: [],
  ...extra,
});
const ctx = (extra = {}) => ({ now: NOW, usedUrls: new Set(), ...extra });

// ---------------------------------------------------------------- umbrales

test('umbrales acordados: importancia 50/40, misma historia 0,88', () => {
  assert.equal(IMPORTANCE_GOOD_MIN, 50);
  assert.equal(IMPORTANCE_ACCEPTABLE_MIN, 40);
  assert.equal(SAME_STORY_COSINE, 0.88);
});

test('tierOf: 50 o más es buena, 40-49 aceptable, menos de 40 queda afuera', () => {
  assert.equal(tierOf(100), TIER.GOOD);
  assert.equal(tierOf(50), TIER.GOOD);
  assert.equal(tierOf(49), TIER.ACCEPTABLE);
  assert.equal(tierOf(40), TIER.ACCEPTABLE);
  assert.equal(tierOf(39.9), null);
  assert.equal(tierOf(0), null);
});

test('ageBandOf: hasta 10 h es ideal, hasta 24 h válida, más es null', () => {
  assert.equal(ageBandOf(0), 'ideal');
  assert.equal(ageBandOf(10), 'ideal');
  assert.equal(ageBandOf(10.01), 'valida');
  assert.equal(ageBandOf(24), 'valida');
  assert.equal(ageBandOf(24.01), null);
  assert.equal(ageBandOf(null), null);
});

test('ageHoursOf acepta Date, ISO y número; null si no hay fecha válida', () => {
  assert.equal(ageHoursOf({ publishedAt: hace(5) }, NOW), 5);
  assert.equal(ageHoursOf({ publishedAt: hace(5).toISOString() }, NOW), 5);
  assert.equal(ageHoursOf({ publishedAt: NOW - 2 * 3600e3 }, NOW), 2);
  assert.equal(ageHoursOf({ publishedAt: null }, NOW), null);
  assert.equal(ageHoursOf({}, NOW), null);
  assert.equal(ageHoursOf({ publishedAt: 'no-es-fecha' }, NOW), null);
});

// ---------------------------------------------------------------- vigente (24 h)

test('una nota de 3 h es elegible, buena y de banda ideal', () => {
  const ev = checkEligibility(nota(), ctx());
  assert.equal(ev.ok, true);
  assert.equal(ev.tier, TIER.GOOD);
  assert.equal(ev.band, 'ideal');
  assert.equal(ev.ageHours, 3);
  assert.deepEqual(ev.reasons, []);
});

test('24 h exactas valen; 24 h y un minuto no', () => {
  assert.equal(checkEligibility(nota({ publishedAt: hace(24) }), ctx()).ok, true);
  const vieja = checkEligibility(nota({ publishedAt: hace(24 + 1 / 60) }), ctx());
  assert.equal(vieja.ok, false);
  assert.deepEqual(vieja.reasons, ['vencida']);
});

test('una nota de 30 h (que antes valía hasta 48 h) hoy se descarta', () => {
  assert.deepEqual(checkEligibility(nota({ publishedAt: hace(30) }), ctx()).reasons, ['vencida']);
});

test('de 10 a 24 h sigue siendo buena, pero en banda "valida"', () => {
  const ev = checkEligibility(nota({ publishedAt: hace(18) }), ctx());
  assert.equal(ev.ok, true);
  assert.equal(ev.tier, TIER.GOOD);
  assert.equal(ev.band, 'valida');
});

test('sin fecha no se puede probar que sea reciente: se descarta', () => {
  assert.deepEqual(checkEligibility(nota({ publishedAt: null }), ctx()).reasons, ['sin_fecha']);
  assert.deepEqual(checkEligibility(nota({ publishedAt: 'basura' }), ctx()).reasons, ['sin_fecha']);
});

test('fecha en el futuro: hasta 3 h se tolera (reloj/zona del medio); más, no es creíble', () => {
  assert.equal(checkEligibility(nota({ publishedAt: hace(-1) }), ctx()).ok, true);
  assert.equal(checkEligibility(nota({ publishedAt: hace(-1) }), ctx()).band, 'ideal');
  assert.deepEqual(checkEligibility(nota({ publishedAt: hace(-5) }), ctx()).reasons, ['fecha_futura']);
  assert.deepEqual(checkEligibility(nota({ publishedAt: hace(-48) }), ctx()).reasons, ['fecha_futura']);
});

// ---------------------------------------------------------------- sustancia (importancia)

test('importancia 49 es aceptable, 40 es aceptable, 39 se descarta', () => {
  const a49 = checkEligibility(nota({ importanceScore: 49 }), ctx());
  assert.equal(a49.ok, true);
  assert.equal(a49.tier, TIER.ACCEPTABLE);
  assert.equal(checkEligibility(nota({ importanceScore: 40 }), ctx()).tier, TIER.ACCEPTABLE);
  assert.deepEqual(checkEligibility(nota({ importanceScore: 39 }), ctx()).reasons, ['importancia_baja']);
});

test('importancia ausente, no numérica o NaN cuenta como 0 y se descarta', () => {
  for (const importanceScore of [undefined, null, 'x', NaN]) {
    assert.deepEqual(checkEligibility(nota({ importanceScore }), ctx()).reasons, ['importancia_baja'], String(importanceScore));
  }
  assert.equal(checkEligibility(nota({ importanceScore: '65' }), ctx()).tier, TIER.GOOD);
});

// ---------------------------------------------------------------- país (solo Sociedad)

test('Sociedad: solo Argentina o Global (sin importar mayúsculas, tildes ni espacios)', () => {
  for (const geoScope of ['Argentina', 'Global', 'argentina', ' GLOBAL ']) {
    assert.equal(checkEligibility(nota({ category: 'Sociedad', geoScope }), ctx()).ok, true, geoScope);
  }
  for (const geoScope of ['México', 'Colombia', 'Perú', 'España', 'Estados Unidos', 'República Dominicana', 'Mercosur']) {
    assert.deepEqual(checkEligibility(nota({ category: 'Sociedad', geoScope }), ctx()).reasons, ['otro_pais'], geoScope);
  }
});

test('Sociedad sin geoScope (documentos viejos o proyección sin el campo) no se bloquea', () => {
  assert.equal(checkEligibility(nota({ category: 'Sociedad', geoScope: undefined }), ctx()).ok, true);
  assert.equal(checkEligibility(nota({ category: 'Sociedad', geoScope: '' }), ctx()).ok, true);
});

test('la regla de país NO se aplica a las otras categorías (el país del hecho no decide si sirve)', () => {
  for (const category of ['Deportes', 'Internacional', 'Tecnología', 'Entretenimiento/Cultura']) {
    assert.equal(checkEligibility(nota({ category, geoScope: 'España' }), ctx()).ok, true, category);
  }
});

test('Política y Economía tampoco: la ingesta ya manda a Internacional lo que tiene país extranjero', () => {
  assert.equal(isForeignInLocalCategory(nota({ category: 'Política', geoScope: 'México' })), false);
  assert.equal(isForeignInLocalCategory(nota({ category: 'Economía', geoScope: 'Colombia' })), false);
  assert.equal(isForeignInLocalCategory(nota({ category: 'Sociedad', geoScope: 'Colombia' })), true);
});

// ---------------------------------------------------------------- opinión y previas

test('opinión: se reconoce por el segmento de la URL (las secciones reales de los medios)', () => {
  const urls = [
    'https://medio.test/opinion/columna-1',
    'https://medio.test/opiniones/x',
    'https://www.perfil.com/noticias/columnistas/es-la-democracia-estupido.phtml',     // se coló en Política (Perfil)
    'https://www.cronista.com/columnistas/inflacion-y-dolar/',
    'https://www.ambito.com/ambito-debate/el-modelo-de-pais-n5900000',
    'https://www.clarin.com/cartas-al-pais/cartas-de-lectores_0_abc.html',
    'https://www.lanacion.com.ar/editoriales/titulo-nid15102026/',
    'https://www.clarin.com/OPINION/Titulo_0_abc.html',                                 // mayúsculas
    'https://www.lanacion.com.ar/opini%C3%B3n/titulo-nid1/',                            // acento codificado
  ];
  for (const url of urls) assert.equal(isOpinionArticle(nota({ url })), true, url);
  assert.deepEqual(checkEligibility(nota({ url: 'https://medio.test/columnistas/x/nota' }), ctx()).reasons, ['opinion']);
});

test('opinión: el segmento tiene que ser la palabra entera, y no cuenta la última parte (el título de la nota)', () => {
  const urls = [
    'https://www.clarin.com/politica/columnistas-de-la-semana_0_abc.html',   // el título contiene la palabra
    'https://medio.test/politica/editorial-planeta-lanzo-su-catalogo',
    'https://medio.test/politica/editorial-de-la-semana/nota-1',             // carpeta que contiene la palabra, no es la palabra
    'https://medio.test/sociedad/analisis-de-sangre',
    'https://www.perfil.com/noticias/empresas-y-protagonistas/aysa.phtml',   // sección mixta: no se bloquea por URL
    'https://medio.test/politica/nota?ref=/opinion/',                        // la palabra en el query no es una sección
    'https://medio.test/politica/nota#opinion',
    'https://medio.test/opinion',                                            // una sola parte: es la portada de la sección
    'https://medio.test/sociedad/editorial',                                 // la última parte es el título de la nota, aunque sea la palabra
  ];
  const esperado = [false, false, false, false, false, false, false, true, false];
  urls.forEach((url, i) => assert.equal(isOpinionArticle(nota({ url })), esperado[i], url));
});

test('opinión: también funciona con rutas relativas, URLs raras y acentos mal codificados', () => {
  assert.equal(isOpinionArticle(nota({ url: '/opinion/algo/nota' })), true);
  assert.equal(isOpinionArticle(nota({ url: 'medio.test/columnistas/fulano/nota' })), true);
  assert.equal(isOpinionArticle(nota({ url: 'https://medio.test/opini%ZZn/nota' })), false, 'un % mal formado no rompe nada');
  assert.equal(isOpinionArticle(nota({ url: 'https://medio.test/opini%C3%B3n/nota' })), true);
  assert.equal(isOpinionArticle(nota({ url: 'no es una url' })), false);
  assert.equal(isOpinionArticle(nota({ url: undefined })), false);
});

test('opinión: etiquetas, sección y subtema solo cuentan si SON la palabra', () => {
  assert.equal(isOpinionArticle(nota({ section: 'Opinión' })), true);
  assert.equal(isOpinionArticle(nota({ topic: 'Columna de opinión' })), true);
  assert.equal(isOpinionArticle(nota({ tags: ['política', 'Columnista'] })), true);
  assert.equal(isOpinionArticle(nota({ tags: ['editorial'] })), true);
  assert.deepEqual(checkEligibility(nota({ section: 'opinion' }), ctx()).reasons, ['opinion']);
  // Contienen la palabra pero hablan de otra cosa.
  assert.equal(isOpinionArticle(nota({ tags: ['opinión pública', 'editorial planeta', 'columnas de humo'] })), false);
  assert.equal(isOpinionArticle(nota({ topic: 'Opinión pública' })), false);
  assert.equal(isOpinionArticle(nota({ section: 'Análisis de datos' })), false);
});

test('opinión: la categoría no se mira (es una lista fija: nunca es "Opinión")', () => {
  assert.equal(isOpinionArticle(nota({ category: 'Opinion' })), false);
});

test('opinión: una marca de género al principio del título alcanza', () => {
  for (const title of [
    'Análisis: qué viene después del dólar',
    'Opinión: por qué sube la inflación',
    'OPINIÓN | El país que viene',
    'Columna - Lo que dejó la marcha',
    'Editorial: la deuda y el futuro',
    'Análisis – el mapa del Congreso',
  ]) {
    assert.equal(isOpinionArticle(nota({ title })), true, title);
  }
});

test('opinión: una nota que solo CONTIENE la palabra no es opinión (falsos positivos del criterio anterior)', () => {
  for (const title of [
    'Análisis de sangre: qué mide cada valor',
    'La opinión pública y la inflación',
    'Editorial Planeta lanzó su catálogo de otoño',
    'Columnas de humo sobre la Casa Rosada',
    'Según un análisis del INDEC, la inflación bajó',
    'El editorial de The Economist sobre Milei',
    'Opinión pública: la imagen del Gobierno cae',
    'Nuevo análisis: Boca y River',
  ]) {
    assert.equal(isOpinionArticle(nota({ title })), false, title);
  }
  assert.equal(isOpinionArticle(nota()), false);
  assert.equal(isOpinionArticle({}), false);
  assert.equal(isOpinionArticle(nota({ url: '' })), false);
});

test('publicidad: el contenido patrocinado de Infobae (/inhouse/) se descarta con su propio motivo', () => {
  const url = 'https://www.infobae.com/inhouse/2026/10/13/la-experiencia-que-transforma-a-las-empresas/';
  assert.equal(isAdvertisingArticle(nota({ url })), true);
  assert.equal(isOpinionArticle(nota({ url })), false);
  assert.deepEqual(checkEligibility(nota({ url }), ctx()).reasons, ['publicidad']);
  assert.equal(isAdvertisingArticle(nota({ url: 'https://www.infobae.com/politica/2026/10/13/nota/' })), false);
  assert.equal(isAdvertisingArticle(nota({ url: 'https://medio.test/politica/inhouse-lo-que-sea' })), false);
  assert.equal(isAdvertisingArticle({}), false);
});

test('tipo de nota: opinión, servicio, previa/agenda y publicidad (según la IA) no son elegibles, con su motivo', () => {
  assert.deepEqual(checkEligibility(nota({ contentType: 'opinion' }), ctx()).reasons, ['opinion']);
  assert.deepEqual(checkEligibility(nota({ contentType: 'servicio' }), ctx()).reasons, ['servicio']);
  assert.deepEqual(checkEligibility(nota({ contentType: 'previa_agenda' }), ctx()).reasons, ['previa_o_agenda']);
  assert.deepEqual(checkEligibility(nota({ contentType: 'publicidad' }), ctx()).reasons, ['publicidad']);
});

test('tipo de nota: noticia, análisis, entrevista, color y las notas sin tipo (anteriores al campo) sí pasan', () => {
  for (const contentType of ['noticia', 'analisis', 'entrevista', 'color', '', undefined, null]) {
    assert.equal(checkEligibility(nota({ contentType }), ctx()).ok, true, String(contentType));
  }
  assert.equal(checkEligibility(nota({ contentType: 'constructor' }), ctx()).ok, true, 'un valor raro no rompe ni excluye');
});

test('tipo de nota: si la URL, el título y el tipo dan el mismo motivo, aparece una sola vez', () => {
  const columna = nota({ url: 'https://medio.test/opinion/x/nota', contentType: 'opinion' });
  assert.deepEqual(checkEligibility(columna, ctx()).reasons, ['opinion']);
  const previa = nota({ title: 'EN VIVO | Boca - River', contentType: 'previa_agenda' });
  assert.deepEqual(checkEligibility(previa, ctx()).reasons, ['previa_o_agenda']);
  const patrocinada = nota({ url: 'https://www.infobae.com/inhouse/2026/10/13/x/', contentType: 'publicidad' });
  assert.deepEqual(checkEligibility(patrocinada, ctx()).reasons, ['publicidad']);
});

test('tipo de nota: rankEligible las deja en las rechazadas con su motivo y no cambia el orden de las demás', () => {
  const noticia = nota({ importanceScore: 60, contentType: 'noticia' });
  const analisis = nota({ importanceScore: 70, contentType: 'analisis' });
  const opinion = nota({ importanceScore: 99, contentType: 'opinion' });
  const servicio = nota({ importanceScore: 95, contentType: 'servicio' });
  const { eligible, rejected } = rankEligible([opinion, noticia, servicio, analisis], ctx());
  assert.deepEqual(eligible.map((e) => e.article), [analisis, noticia], 'el tipo no ordena: manda la importancia');
  assert.deepEqual(rejected.map((r) => [r.article, r.reasons]), [[opinion, ['opinion']], [servicio, ['servicio']]]);
});

test('las listas de segmentos son las acordadas', () => {
  assert.deepEqual([...OPINION_URL_SEGMENTS].sort(), [
    'ambito-debate', 'cartas-al-pais', 'columna', 'columnas', 'columnista', 'columnistas',
    'editorial', 'editoriales', 'opinion', 'opiniones',
  ]);
  assert.deepEqual([...ADVERTISING_URL_SEGMENTS], ['inhouse']);
});

test('previas, agenda y "en vivo" se descartan', () => {
  assert.deepEqual(checkEligibility(nota({ title: 'Previa del Valencia Basket - Olympiacos' }), ctx()).reasons, ['previa_o_agenda']);
  assert.deepEqual(checkEligibility(nota({ title: 'EN VIVO | La Mañanera de hoy' }), ctx()).reasons, ['previa_o_agenda']);
  assert.deepEqual(checkEligibility(nota({ title: 'Dónde ver a Boca esta noche' }), ctx()).reasons, ['previa_o_agenda']);
  assert.equal(checkEligibility(nota({ title: 'Wall Street opera mixto, en la previa de resultados de los bancos' }), ctx()).ok, true);
});

// ---------------------------------------------------------------- repetida

test('una URL ya vista o ya elegida no es elegible; una sin URL tampoco', () => {
  const a = nota();
  assert.deepEqual(checkEligibility(a, ctx({ usedUrls: new Set([a.url]) })).reasons, ['url_repetida']);
  assert.deepEqual(checkEligibility(nota({ url: '' }), ctx()).reasons, ['sin_url']);
  assert.deepEqual(checkEligibility(nota({ url: undefined }), ctx()).reasons, ['sin_url']);
});

test('los motivos se acumulan (para poder leer por qué se descartó)', () => {
  const ev = checkEligibility(nota({ publishedAt: hace(40), importanceScore: 10, title: 'EN VIVO: todo' }), ctx());
  assert.equal(ev.ok, false);
  assert.deepEqual(ev.reasons.sort(), ['importancia_baja', 'previa_o_agenda', 'vencida']);
});

// ---------------------------------------------------------------- misma historia (nota contra nota)

/** Vector unitario en 2D cuyo coseno con [1, 0] es exactamente c. */
const conCoseno = (c) => [c, Math.sqrt(1 - c * c)];

test('cosine: bordes (vacíos, largos distintos, vectores nulos)', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12);
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([1, 2], [1, 2, 3]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.equal(cosine(null, [1]), 0);
});

test('misma historia: 0,88 exacto cuenta como repetida; 0,879 no', () => {
  const visto = [{ title: 'Visto', vector: [1, 0] }];
  assert.ok(findSameStory(conCoseno(0.88), visto));
  assert.ok(findSameStory(conCoseno(0.95), visto));
  assert.equal(findSameStory(conCoseno(0.879), visto), null);
  assert.equal(findSameStory(conCoseno(0.5), visto), null);
});

test('misma historia: devuelve la nota vista más parecida; sin embedding no se puede probar y pasa', () => {
  const vistos = [
    { title: 'Otra cosa', vector: conCoseno(0.2) },
    { title: 'La misma', vector: conCoseno(0.93) },
    { title: 'Parecida', vector: conCoseno(0.7) },
  ];
  const r = findSameStory([1, 0], vistos);
  assert.equal(r.title, 'La misma');
  assert.ok(Math.abs(r.similarity - 0.93) < 1e-9);
  assert.equal(findSameStory(null, vistos), null);
  assert.equal(findSameStory([], vistos), null);
  assert.equal(findSameStory([1, 0], []), null);
  assert.deepEqual(mostSimilarSeen(undefined, vistos), { similarity: 0, title: null });
});

test('misma historia: vectores de largo distinto no se comparan (no hay falsos positivos)', () => {
  assert.equal(findSameStory([1, 0, 0], [{ title: 'x', vector: [1, 0] }]), null);
});

// ---------------------------------------------------------------- orden

const cand = (extra = {}) => {
  const article = nota(extra.article || {});
  return { article, tier: TIER.GOOD, zone: null, ageHours: 5, importance: 60, ...extra, article };
};
const ordenar = (lista) => [...lista].sort(compareCandidates);

test('orden 1: una buena de 20 h le gana a una aceptable de 1 h', () => {
  const buena = cand({ tier: TIER.GOOD, ageHours: 20, importance: 50 });
  const aceptable = cand({ tier: TIER.ACCEPTABLE, ageHours: 1, importance: 49 });
  assert.equal(ordenar([aceptable, buena])[0], buena);
});

test('orden 2: VERDE antes que AMARILLA aunque la AMARILLA sea más nueva e importante', () => {
  const verde = cand({ zone: 'VERDE', ageHours: 20, importance: 50 });
  const amarilla = cand({ zone: 'AMARILLA', ageHours: 1, importance: 95 });
  assert.equal(ordenar([amarilla, verde])[0], verde);
});

test('orden 3: la banda de hasta 10 h va antes que la de 10-24 h, aunque la segunda sea más importante', () => {
  const ideal = cand({ ageHours: 9.9, importance: 50 });
  const valida = cand({ ageHours: 10.1, importance: 95 });
  assert.equal(ordenar([valida, ideal])[0], ideal);
});

test('orden 4: dentro de la misma banda, la más importante primero', () => {
  const alta = cand({ ageHours: 8, importance: 80 });
  const baja = cand({ ageHours: 2, importance: 60 });
  assert.equal(ordenar([baja, alta])[0], alta);
});

test('orden 5: con igual importancia, la más nueva primero', () => {
  const nueva = cand({ ageHours: 2, importance: 70 });
  const vieja = cand({ ageHours: 6, importance: 70 });
  assert.equal(ordenar([vieja, nueva])[0], nueva);
});

test('orden 6: el empate total se resuelve por _id, sin depender del orden de entrada', () => {
  const a = cand({ ageHours: 4, importance: 70, article: { _id: 'aaa' } });
  const b = cand({ ageHours: 4, importance: 70, article: { _id: 'bbb' } });
  const c = cand({ ageHours: 4, importance: 70, article: { _id: 'ccc' } });
  const esperado = ['aaa', 'bbb', 'ccc'];
  for (const perm of [[a, b, c], [c, b, a], [b, c, a], [c, a, b]]) {
    assert.deepEqual(ordenar(perm).map((x) => x.article._id), esperado);
  }
});

test('rankEligible: separa elegibles ordenadas y descartadas con su motivo', () => {
  const buenaVieja = nota({ _id: 'b', publishedAt: hace(15), importanceScore: 55 });
  const aceptable = nota({ _id: 'a', publishedAt: hace(1), importanceScore: 45 });
  const ideal = nota({ _id: 'i', publishedAt: hace(4), importanceScore: 52 });
  const vencida = nota({ _id: 'v', publishedAt: hace(26) });
  const floja = nota({ _id: 'f', importanceScore: 20 });

  const { eligible, rejected } = rankEligible([buenaVieja, aceptable, vencida, ideal, floja], ctx());
  assert.deepEqual(eligible.map((e) => e.article._id), ['i', 'b', 'a']);
  assert.deepEqual(rejected.map((r) => [r.article._id, r.reasons[0]]).sort(), [['f', 'importancia_baja'], ['v', 'vencida']]);
  assert.deepEqual(eligible.map((e) => e.tier), [TIER.GOOD, TIER.GOOD, TIER.ACCEPTABLE]);
});

test('rankEligible con goodOnly (rescate) deja afuera las aceptables', () => {
  const a = nota({ _id: 'a', importanceScore: 45 });
  const b = nota({ _id: 'b', importanceScore: 50 });
  const { eligible, rejected } = rankEligible([a, b], ctx(), { goodOnly: true });
  assert.deepEqual(eligible.map((e) => e.article._id), ['b']);
  assert.deepEqual(rejected[0].reasons, ['no_es_buena']);
});

test('rankEligible con zoneOf: la zona desempata antes que la edad', () => {
  const amarillaFresca = nota({ _id: 'y', publishedAt: hace(1), importanceScore: 90 });
  const verdeVieja = nota({ _id: 'g', publishedAt: hace(20), importanceScore: 50 });
  const zonas = new Map([[amarillaFresca, 'AMARILLA'], [verdeVieja, 'VERDE']]);
  const { eligible } = rankEligible([amarillaFresca, verdeVieja], ctx(), { zoneOf: (a) => zonas.get(a) });
  assert.deepEqual(eligible.map((e) => e.article._id), ['g', 'y']);
});

test('rankEligible: edad negativa (fecha apenas en el futuro) se trata como 0 h', () => {
  const futura = nota({ _id: 'f', publishedAt: hace(-1) });
  const { eligible } = rankEligible([futura], ctx());
  assert.equal(eligible[0].ageHours, 0);
});
