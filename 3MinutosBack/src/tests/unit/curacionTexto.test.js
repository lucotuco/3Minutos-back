'use strict';

/**
 * Los textos que el usuario lee salen, cuando la IA falla (o de lo que devuelve), de las bajadas de los feeds, que
 * traen HTML y entidades. La curación y el resumen limpian con el mismo toPlainText que la ingesta; antes cada módulo
 * tenía su propia copia, que dejaba "&oacute;" y "&#8220;" en el texto final y no sacaba las imágenes.
 * La IA y Mongo son falsos. Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test.before(() => {
  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
});

// ---------------------------------------------------------------- falsos (antes de cargar los módulos)
function instalarFalso(rel, exportaciones) {
  const archivo = require.resolve(path.join(__dirname, '..', '..', rel));
  require.cache[archivo] = { id: archivo, filename: archivo, loaded: true, exports: exportaciones };
}

let respuestaIA = async () => { throw new Error('IA caída'); };
const pedidosIA = [];
instalarFalso('config/openai.js', {
  OPENAI_MODEL: 'modelo-de-prueba',
  openaiReview: {
    responses: {
      parse: async (args) => { pedidosIA.push(args); return respuestaIA(args); },
      create: async (args) => { pedidosIA.push(args); return respuestaIA(args); },
    },
  },
});

let articulo = null;
instalarFalso('models/Article.js', { findById: async () => articulo });

const { generateNeutralCuration } = require('../../curation/generateNeutralCuration');
const { generateArticleSummary } = require('../../summaries/generateArticleSummary');

test.beforeEach(() => {
  pedidosIA.length = 0;
  respuestaIA = async () => { throw new Error('IA caída'); };
  articulo = null;
});

/** Una nota de la base con lo justo para curarla; guarda en `guardados` cada vez que se la graba. */
function nota(extra = {}) {
  const guardados = [];
  return {
    _id: 'a1', title: 'Título', sourceName: 'Medio', rawSummary: '', contentSnippet: '', summary: '', tags: [],
    curationStatus: 'pending', guardados,
    async save() { guardados.push({ neutralTitle: this.neutralTitle, summary: this.summary }); return this; },
    ...extra,
  };
}

// Una bajada de feed como las reales: imagen sola en el primer párrafo, tildes y comillas como entidades.
const BAJADA_SUCIA = '<p><img src="https://www.infobae.com/resizer/v2/ABC.JPG?auth=a88d&smart=true&width=4000" alt="" height="2668" width="4000"/></p>'
  + '<p>El Gobierno anunci&oacute; este martes medidas &#8220;urgentes&#8221; para &quot;ordenar&quot; las cuentas p&uacute;blicas.</p>';
const BAJADA_LIMPIA = 'El Gobierno anunció este martes medidas “urgentes” para "ordenar" las cuentas públicas.';
const TITULO_SUCIO = '<b>Milei</b> anunci&oacute; un plan &amp; nuevas medidas para la econom&iacute;a';

// ================================================================ curación: texto de respaldo (la IA falló)
test('curación sin IA: título, copete y resumen de respaldo salen en texto plano, con las entidades decodificadas', async () => {
  articulo = nota({ title: TITULO_SUCIO, rawSummary: BAJADA_SUCIA });
  const r = await generateNeutralCuration('a1');

  assert.equal(r.fallback, true);
  assert.equal(r.neutralTitle, 'Milei anunció un plan & nuevas medidas para la', 'las 9 primeras palabras, ya limpias');
  assert.equal(r.neutralLead, BAJADA_LIMPIA);
  assert.equal(r.neutralSummary, BAJADA_LIMPIA);
  for (const texto of [r.neutralTitle, r.neutralLead, r.neutralSummary]) {
    assert.doesNotMatch(texto, /[<>]|&[a-z#0-9]+;/i, `quedó marcado: ${texto}`);
  }
  assert.equal(articulo.curationStatus, 'error');
  assert.equal(articulo.guardados.length, 1, 'se graba el respaldo');
});

test('curación sin IA: una bajada que era solo una imagen no deja la etiqueta como texto (cae al título)', async () => {
  articulo = nota({ title: 'Mundial 2026: Argentina debuta ante Argelia', rawSummary: '<img src="https://x.test/1.jpg" alt="" width="10"/>' });
  const r = await generateNeutralCuration('a1');
  assert.equal(r.neutralLead, 'Mundial 2026: Argentina debuta ante Argelia');
  assert.equal(r.neutralSummary, 'Mundial 2026: Argentina debuta ante Argelia');
});

test('curación sin IA: sin título ni bajada queda el título genérico (también si el título era solo una etiqueta)', async () => {
  articulo = nota({ title: '', rawSummary: '' });
  assert.equal((await generateNeutralCuration('a1')).neutralTitle, 'Noticia relevante del día');

  articulo = nota({ title: '<img src="https://x.test/1.jpg" alt=""/>', rawSummary: '' });
  assert.equal((await generateNeutralCuration('a1')).neutralTitle, 'Noticia relevante del día');
});

test('curación sin IA: si la bajada era solo una imagen se usa el snippet, no se queda vacío', async () => {
  articulo = nota({ title: 'Título', rawSummary: '<p><img src="https://x.test/1.jpg" alt=""/></p>', contentSnippet: 'El snippet con la noticia.' });
  const r = await generateNeutralCuration('a1');
  assert.equal(r.neutralLead, 'El snippet con la noticia.');
  assert.equal(r.neutralSummary, 'El snippet con la noticia.');

  // Con un snippet largo el copete (16 palabras) y el resumen (hasta 60) se distinguen: el resumen sale del snippet, no del copete.
  const largo = Array.from({ length: 30 }, (_, i) => `w${i + 1}`).join(' ');
  articulo = nota({ title: 'Título', rawSummary: '<img src="https://x.test/1.jpg" alt=""/>', contentSnippet: largo });
  const l = await generateNeutralCuration('a1');
  assert.equal(l.neutralLead.split(' ').length, 16);
  assert.equal(l.neutralSummary, largo);
});

test('curación: a la IA se le manda el texto limpio y lo que devuelve se limpia (y se le sacan las frases de la fuente)', async () => {
  articulo = nota({ title: TITULO_SUCIO, rawSummary: BAJADA_SUCIA });
  respuestaIA = async () => ({
    output_parsed: {
      politicalBiasRisk: 'low', biasAnalysis: '', neutralityScore: 90,
      neutralTitle: 'Según Ámbito, el Gobierno anunci&oacute; medidas',
      neutralLead: '<p>El plan incluye cambios &amp; ajustes</p>',
      neutralSummary: 'El Gobierno anunci&oacute; medidas &#8220;urgentes&#8221; para las cuentas p&uacute;blicas.',
    },
  });
  const r = await generateNeutralCuration('a1');

  assert.equal(r.fallback, false);
  assert.equal(r.neutralTitle, 'el Gobierno anunció medidas');
  assert.equal(r.neutralLead, 'El plan incluye cambios & ajustes');
  assert.equal(r.neutralSummary, 'El Gobierno anunció medidas “urgentes” para las cuentas públicas.');
  assert.equal(articulo.curationStatus, 'done');
});

// ================================================================ resumen
test('resumen sin IA: el respaldo es la bajada en texto plano', async () => {
  articulo = nota({ title: TITULO_SUCIO, rawSummary: BAJADA_SUCIA });
  const r = await generateArticleSummary('a1');
  assert.equal(r.fallback, true);
  assert.equal(r.summary, BAJADA_LIMPIA);
  assert.equal(articulo.summary, BAJADA_LIMPIA);
});

test('resumen sin IA: si la bajada era solo una imagen se usa el snippet (también en lo que se le pide a la IA)', async () => {
  articulo = nota({ title: 'Título', rawSummary: '<p><img src="https://x.test/1.jpg" alt=""/></p>', contentSnippet: 'El snippet con la noticia.' });
  assert.equal((await generateArticleSummary('a1')).summary, 'El snippet con la noticia.');
  assert.match(pedidosIA[0].input, /Texto fuente: El snippet con la noticia\./);
});

test('resumen sin IA y sin bajada: el respaldo es el título limpio; sin nada, el aviso de siempre', async () => {
  articulo = nota({ title: TITULO_SUCIO, rawSummary: '<img src="https://x.test/1.jpg" alt=""/>' });
  assert.equal((await generateArticleSummary('a1')).summary, 'Milei anunció un plan & nuevas medidas para la economía');

  articulo = nota({ title: '', rawSummary: '' });
  assert.equal((await generateArticleSummary('a1')).summary, 'Resumen no disponible por el momento.');
});

test('resumen: a la IA se le pide con el título y el texto fuente ya limpios', async () => {
  articulo = nota({ title: TITULO_SUCIO, rawSummary: BAJADA_SUCIA });
  respuestaIA = async () => ({ output_text: 'El Gobierno anunció medidas.' });
  await generateArticleSummary('a1');

  const pedido = pedidosIA[0].input;
  assert.match(pedido, /Título: Milei anunció un plan & nuevas medidas para la economía/);
  assert.ok(pedido.includes(`Texto fuente: ${BAJADA_LIMPIA}`), pedido);
  assert.doesNotMatch(pedido, /<img|<p>|&oacute;|&#8220;/);
});

test('resumen: lo que contesta la IA se limpia, venga como texto directo o en las partes de la salida', async () => {
  articulo = nota({ title: 'Título', rawSummary: 'Bajada de la nota.' });
  respuestaIA = async () => ({ output_text: '<p>El Gobierno anunci&oacute; medidas &amp; cambios.</p>' });
  assert.equal((await generateArticleSummary('a1')).summary, 'El Gobierno anunció medidas & cambios.');

  articulo = nota({ title: 'Título', rawSummary: 'Bajada de la nota.' });
  respuestaIA = async () => ({ output: [{ content: [{ type: 'output_text', text: 'Primera&nbsp;parte' }, { type: 'text', text: '<i>segunda</i> parte' }] }] });
  assert.equal((await generateArticleSummary('a1')).summary, 'Primera parte segunda parte');
});

test('resumen ya guardado: se devuelve limpio y sin llamar a la IA', async () => {
  articulo = nota({ summary: '<b>Ya&nbsp;hecho</b> &amp; listo' });
  const r = await generateArticleSummary('a1');
  assert.deepEqual([r.cached, r.summary], [true, 'Ya hecho & listo']);
  assert.equal(pedidosIA.length, 0);
});
