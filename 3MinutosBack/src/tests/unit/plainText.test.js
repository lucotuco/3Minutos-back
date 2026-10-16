'use strict';

/**
 * Tests del limpiador de texto (HTML, entidades, imágenes) que usa toda la ingesta.
 * Los ejemplos de abajo son notas REALES de los reportes del comparador (Perfil, Infobae, Clarín, Básquet Plus):
 * esas son las formas de HTML que hoy llegan al clasificador, a los embeddings y al juez.
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { toPlainText, pickReadableText, decodeEntities, MAX_INPUT_CHARS } = require('../../utils/plainText');

// ---------------------------------------------------------------- formas reales de cada medio
const PERFIL_IMG_Y_TEXTO =
  '<p><img src="https://fotos.perfil.com/2026/10/15/trim/540/304/luis-caputo-debate-sobre-la-economia-mundial-2348872.jpg" '
  + 'alt="Luis Caputo- “Debate sobre la economía mundial"" /></p>El organismo redujo al 2,1% su proyección de expansión de la '
  + 'economía argentina para este año, aunque espera una aceleración al 3,5% en 2027.';

const INFOBAE_IMG_Y_PARRAFO =
  '<img src="https://www.infobae.com/resizer/v2/PJ42V67YKFGLZF5V4KY4FWVLQM.JPG?auth=a88d0a4bfa9ededd841c0af6e98a2bb32dc89f9ba759588dd73a4df394d13ed8'
  + '&smart=true&width=4000&height=2668" alt="El dólar abrió a $ 3.166,55 frente al peso colombiano - crédito Dado Ruvic/Reuters" height="2668" width="4000"/>'
  + '<p>El dólar abrió este viernes en Colombia con compras de reservas del Banco de la República.</p>';

const INFOBAE_ENTIDADES =
  'Guerra Tebas y Real Madrid. (Composici&#xF3;n Infobae) LaLiga tiene una guerra abierta. En un bando, el madridismo ; en otro, Javier Tebas . '
  + 'Fue este &#xFA;ltimo quien, tras la vuelta a la competici&#xF3;n dom&#xE9;stica, ha disparado primero.';

const CLARIN_LISTA =
  '<ul><li>La cantante quilmeña ganó tres Martín Fierro de la Música por su disco. </li>'
  + '<li>Al recibir el premio al Mejor Álbum, recordó el problema de salud que puso su vida en riesgo.</li></ul>';

const BASQUET_PLUS_DRUPAL =
  '<div class="field field-name-field-bp-volanta field-type-text field-label-hidden"><div class="field-items">'
  + '<div class="field-item even">Liga Argentina</div></div></div>'
  + '<div class="field field-name-field-articulo-texto-imagen field-type-text-long field-label-hidden"><div class="field-items">'
  + '<div class="field-item even">River ganó en Mar del Plata.</div></div></div>';

const MUESTRAS = [PERFIL_IMG_Y_TEXTO, INFOBAE_IMG_Y_PARRAFO, INFOBAE_ENTIDADES, CLARIN_LISTA, BASQUET_PLUS_DRUPAL];

test('Perfil: la imagen con comillas rotas en el alt no se come el texto que sigue', () => {
  assert.equal(
    toPlainText(PERFIL_IMG_Y_TEXTO),
    'El organismo redujo al 2,1% su proyección de expansión de la economía argentina para este año, aunque espera una aceleración al 3,5% en 2027.',
  );
});

test('Infobae: la imagen con token ?auth=...&smart=... desaparece y queda el párrafo', () => {
  const out = toPlainText(INFOBAE_IMG_Y_PARRAFO);
  assert.equal(out, 'El dólar abrió este viernes en Colombia con compras de reservas del Banco de la República.');
  assert.ok(!out.includes('auth='));
  assert.ok(!out.includes('infobae.com/resizer'));
});

test('Infobae: las entidades numéricas hexadecimales se convierten en letras', () => {
  assert.equal(
    toPlainText(INFOBAE_ENTIDADES),
    'Guerra Tebas y Real Madrid. (Composición Infobae) LaLiga tiene una guerra abierta. En un bando, el madridismo ; en otro, Javier Tebas . '
    + 'Fue este último quien, tras la vuelta a la competición doméstica, ha disparado primero.',
  );
});

test('Clarín: los ítems de lista quedan separados por un espacio', () => {
  assert.equal(
    toPlainText(CLARIN_LISTA),
    'La cantante quilmeña ganó tres Martín Fierro de la Música por su disco. Al recibir el premio al Mejor Álbum, recordó el problema de salud que puso su vida en riesgo.',
  );
});

test('Básquet Plus: los div de Drupal se limpian y queda el texto (con su volanta)', () => {
  assert.equal(toPlainText(BASQUET_PLUS_DRUPAL), 'Liga Argentina River ganó en Mar del Plata.');
});

test('un campo que es solo una imagen queda vacío', () => {
  assert.equal(toPlainText('<img src="https://x.test/a.jpg" alt="" height="10" width="10"/>'), '');
  assert.equal(toPlainText('<p><img src="https://x.test/a.jpg" alt="Foto de algo" /></p>'), '', 'el alt no se cuenta como texto');
});

// ---------------------------------------------------------------- etiquetas
test('las etiquetas en línea no parten palabras y las de bloque separan', () => {
  assert.equal(toPlainText('<p>Hola</p><p>mundo</p>'), 'Hola mundo');
  assert.equal(toPlainText('una<br>línea<br/>nueva'), 'una línea nueva');
  assert.equal(toPlainText('la <b>diferenciación</b> ya no pasa <a href="/x">solo</a> por la velocidad'), 'la diferenciación ya no pasa solo por la velocidad');
  assert.equal(toPlainText('dólar<span>es</span>'), 'dólares', 'una etiqueta en línea no deja espacio, como en un navegador');
});

test('script, style, comentarios y svg se sacan con su contenido', () => {
  assert.equal(toPlainText('Antes<script type="text/javascript">var x = "<p>no</p>"; alert(1);</script>Después'), 'Antes Después');
  assert.equal(toPlainText('Uno <style>.a { color: red }</style> dos'), 'Uno dos');
  assert.equal(toPlainText('Uno <!-- comentario <b>oculto</b> --> dos'), 'Uno dos');
  assert.equal(toPlainText('Uno <svg viewBox="0 0 1 1"><title>logo</title><path d="M0"/></svg> dos'), 'Uno dos');
  assert.equal(toPlainText('Uno <iframe src="https://x.test"></iframe> dos'), 'Uno dos');
});

test('un elemento sin cerrar se descarta hasta el final en vez de dejar basura', () => {
  assert.equal(toPlainText('Texto bueno <script>var a = 1;'), 'Texto bueno');
  assert.equal(toPlainText('Texto bueno <!-- comentario sin cerrar'), 'Texto bueno');
});

test('una etiqueta cortada a la mitad al final (texto truncado) no deja restos', () => {
  const cortado = '<img src="https://www.infobae.com/resizer/v2/ABC.jpg?auth=9ca4af6361c339f82dae676d7eab852422578e02edd25efd2a1c05d4e63f64cf&smart=true&width=19';
  assert.equal(toPlainText(cortado), '');
  assert.equal(toPlainText(`Hay texto real antes <a href="https://x.test/muy/largo`), 'Hay texto real antes');
  assert.equal(toPlainText('cortado a la mitad &#x'), 'cortado a la mitad');
  assert.equal(toPlainText('cortado a la mitad &#12'), 'cortado a la mitad');
});

test('CDATA se desenvuelve y declaraciones (<!DOCTYPE>, <?xml?>) se sacan', () => {
  assert.equal(toPlainText('<![CDATA[<p>Hola <b>mundo</b></p>]]>'), 'Hola mundo');
  assert.equal(toPlainText('<?xml version="1.0"?><!DOCTYPE html><p>Hola</p>'), 'Hola');
});

test('los signos "<" y ">" que son texto no se tocan', () => {
  assert.equal(toPlainText('Si a < b y c > d entonces 5<6'), 'Si a < b y c > d entonces 5<6');
  assert.equal(toPlainText('Subió 3 > 2 puntos'), 'Subió 3 > 2 puntos');
});

test('las siglas con & no se rompen', () => {
  assert.equal(toPlainText('La I+D y el R&D de AT&T'), 'La I+D y el R&D de AT&T');
});

// ---------------------------------------------------------------- entidades
test('decodifica entidades numéricas (decimales y hexadecimales) y las nombradas más comunes', () => {
  assert.equal(toPlainText('Canci&#243;n &#xF1;and&#xFA; &aacute;&eacute;&iacute;&oacute;&uacute;&ntilde; &Ntilde;'), 'Canción ñandú áéíóúñ Ñ');
  assert.equal(toPlainText('Messi &amp; Di Mar&iacute;a: &laquo;campeones&raquo; &ndash; &quot;dos&quot; &mdash; &hellip;'), 'Messi & Di María: «campeones» – "dos" — …');
  assert.equal(toPlainText('-200 &#x2103; y 10&deg; &euro;5 &iexcl;Hola! &iquest;Qu&eacute;?'), '-200 ℃ y 10° €5 ¡Hola! ¿Qué?');
  assert.equal(toPlainText('&ldquo;Contame los votos&rdquo; &#x201C;listo&#x201D; &rsquo;'), '“Contame los votos” “listo” ’');
});

test('&nbsp; y los espacios raros se vuelven un espacio común', () => {
  assert.equal(toPlainText('uno&nbsp;&nbsp;dos tres cuatro　cinco'), 'uno dos tres cuatro cinco');
  assert.equal(toPlainText('con​cero‍ancho­guion﻿'), 'conceroanchoguion', 'ancho cero y guion blando se eliminan');
});

test('las referencias 128-159 se leen como Windows-1252 (&#150; es una raya, no un control)', () => {
  assert.equal(toPlainText('a&#150;b &#146;hola&#147; &#133;'), 'a–b ’hola“ …');
});

test('una imagen entre dos textos los separa; un elemento autocerrado no se traga lo que sigue', () => {
  assert.equal(toPlainText('antes<img src="x.jpg"/>después'), 'antes después');
  assert.equal(toPlainText('Antes <iframe src="https://x.test"/> después'), 'Antes después');
  assert.equal(toPlainText('Antes <svg viewBox="0 0 1 1"/> después'), 'Antes después');
});

test('referencias inválidas no rompen nada', () => {
  assert.equal(toPlainText('a&#0;b &#xD800;c &#99999999;d &#x110000;e'), 'a b c &#99999999;d e');
  assert.equal(toPlainText('entidad &desconocida; queda igual'), 'entidad &desconocida; queda igual');
  assert.equal(toPlainText('x &toString; y &valueOf; z'), 'x &toString; y &valueOf; z', 'un nombre de prototipo no es una entidad');
});

test('decodeEntities se puede usar suelta', () => {
  assert.equal(decodeEntities('a &amp; b &#x41;'), 'a & b A');
});

test('texto codificado dos veces (&lt;p&gt;...) también se limpia', () => {
  assert.equal(toPlainText('&lt;p&gt;Hola &lt;b&gt;mundo&lt;/b&gt;&lt;/p&gt;'), 'Hola mundo');
  assert.equal(toPlainText('Doble &amp;aacute; codificado'), 'Doble á codificado');
});

// ---------------------------------------------------------------- forma de la entrada y de la salida
test('acepta texto, arreglos, objetos { _ } y vacíos', () => {
  assert.equal(toPlainText(null), '');
  assert.equal(toPlainText(undefined), '');
  assert.equal(toPlainText(''), '');
  assert.equal(toPlainText(['<p>uno</p>', 'dos']), 'uno');
  assert.equal(toPlainText({ _: '<b>texto</b>', $: { lang: 'es' } }), 'texto');
  assert.equal(toPlainText({ otra: 'cosa' }), '');
  assert.equal(toPlainText(42), '42');
});

test('colapsa espacios y saltos de línea y recorta los bordes', () => {
  assert.equal(toPlainText('  uno \n\n  dos\t\ttres  '), 'uno dos tres');
});

test('es idempotente en todas las muestras reales', () => {
  for (const m of MUESTRAS) {
    const una = toPlainText(m);
    assert.equal(toPlainText(una), una);
  }
  const raro = 'x &lt;i&gt;y&lt;/i&gt; <b>z</b> &amp;amp; &#x41; <!-- c --> fin';
  assert.equal(toPlainText(toPlainText(raro)), toPlainText(raro));
});

test('el resultado nunca tiene etiquetas ni entidades numéricas en las muestras reales', () => {
  for (const m of MUESTRAS) {
    const out = toPlainText(m);
    assert.ok(!/<[a-z/!]/i.test(out), `quedó una etiqueta en: ${out.slice(0, 80)}`);
    assert.ok(!/&#x?[0-9a-f]+;/i.test(out), `quedó una entidad en: ${out.slice(0, 80)}`);
  }
});

// ---------------------------------------------------------------- recorte
test('maxChars corta en el límite de una palabra', () => {
  const t = 'Una frase larga de prueba para cortar en una palabra completa sin partirla';
  assert.equal(toPlainText(t, { maxChars: 40 }), 'Una frase larga de prueba para cortar en');
  assert.equal(toPlainText(t, { maxChars: 40, ellipsis: true }), 'Una frase larga de prueba para cortar en...');
  assert.equal(toPlainText(t, { maxChars: 1000 }), t, 'si entra, no se toca (ni se agregan puntos suspensivos)');
  assert.equal(toPlainText(t, { maxChars: 1000, ellipsis: true }), t);
});

test('maxChars: si el corte cae en medio de una palabra, retrocede hasta la anterior', () => {
  assert.equal(
    toPlainText('Una frase larga de prueba para cortar en una palabra', { maxChars: 43 }),
    'Una frase larga de prueba para cortar en',
  );
});

test('maxChars: si el corte cae justo al final de una palabra no se pierde nada', () => {
  assert.equal(toPlainText('uno dos tres', { maxChars: 7 }), 'uno dos');
});

test('maxChars: una palabra interminable se corta igual (no queda vacío)', () => {
  const out = toPlainText('x'.repeat(100), { maxChars: 30 });
  assert.equal(out.length, 30);
});

test('maxChars no parte un par sustituto (emoji)', () => {
  const out = toPlainText('ab😀cd', { maxChars: 3 });
  assert.ok(!/[\ud800-\udbff]$/.test(out), 'no puede terminar en medio de un emoji');
});

test('maxChars limpia primero y recién después corta: la imagen no gasta el presupuesto', () => {
  const out = toPlainText(INFOBAE_IMG_Y_PARRAFO, { maxChars: 30 });
  assert.equal(out, 'El dólar abrió este viernes en');
});

// ---------------------------------------------------------------- elección del campo legible
test('pickReadableText elige el primer campo con texto suficiente y salta los que son solo imagen', () => {
  const r = pickReadableText([
    '<img src="https://x.test/a.jpg" alt=""/>',
    '   ',
    'texto corto',
    'Este es un texto suficientemente largo para pasar el piso de cuarenta caracteres.',
    'Otro texto que también alcanzaría pero viene después del anterior en la lista.',
  ]);
  assert.equal(r.index, 3);
  assert.equal(r.text, 'Este es un texto suficientemente largo para pasar el piso de cuarenta caracteres.');
});

test('pickReadableText: si ninguno llega al piso devuelve el más largo, no vacío', () => {
  const r = pickReadableText(['<img src="x.jpg" />', 'corto', 'un poco más largo']);
  assert.equal(r.text, 'un poco más largo');
  assert.equal(r.index, 2);
});

test('pickReadableText: sin nada legible devuelve texto vacío', () => {
  assert.deepEqual(pickReadableText([undefined, null, '', '<br>']), { text: '', index: -1 });
  assert.deepEqual(pickReadableText([]), { text: '', index: -1 });
});

test('pickReadableText: justo 40 letras alcanzan', () => {
  assert.equal(pickReadableText(['a'.repeat(40), 'b'.repeat(50)]).index, 0);
  assert.equal(pickReadableText(['a'.repeat(39), 'b'.repeat(50)]).index, 1);
});

test('pickReadableText respeta un piso distinto', () => {
  assert.equal(pickReadableText(['abcdef', 'abcdefghij'], { minChars: 8 }).index, 1);
});

// ---------------------------------------------------------------- entradas patológicas
test('entradas patológicas no cuelgan la ingesta (tiempo lineal)', () => {
  const casos = [
    '<a '.repeat(80000),
    '<script '.repeat(30000),
    'a < b '.repeat(40000),
    '<!-- x '.repeat(30000),
    '&#x&#x&#x'.repeat(30000),
    `<img src="data:image/png;base64,${'A'.repeat(150000)}"/>texto`,
  ];
  const t0 = Date.now();
  for (const c of casos) toPlainText(c);
  assert.ok(Date.now() - t0 < 1500, `tardó ${Date.now() - t0} ms`);
});

test('una entrada gigante se acota', () => {
  const out = toPlainText('palabra '.repeat(MAX_INPUT_CHARS));
  assert.ok(out.length <= MAX_INPUT_CHARS);
});
