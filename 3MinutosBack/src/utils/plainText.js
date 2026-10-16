'use strict';

/**
 * plainText.js
 *
 * Convierte lo que traen los feeds (HTML, entidades como &#xF3; o &nbsp;, imágenes, listas) en texto plano
 * legible. Es la única función de limpieza de todo el sistema: la ingesta la usa ANTES de guardar la nota
 * (para que el clasificador, los embeddings, el juez y las anclas vean texto y no marcas), y las capas
 * de curaduría la usan como red de seguridad con notas viejas que ya quedaron guardadas con HTML.
 *
 * Reglas:
 *   - <script>, <style>, <noscript>, <svg>, <iframe> y comentarios se sacan CON su contenido.
 *   - Etiquetas de bloque (p, div, li, br, h1-h6, tr...) y objetos (img...) se reemplazan por un espacio,
 *     las de texto en línea (a, b, span...) se sacan sin dejar espacio, como las dibuja un navegador.
 *   - Entidades numéricas (&#243; y &#xF3;) y las nombradas más comunes (&aacute;, &nbsp;, &amp;...) se decodifican.
 *   - Si el texto estaba codificado dos veces (&lt;p&gt;...), se limpia otra vez (hasta 3 pasadas).
 *   - Es idempotente: toPlainText(toPlainText(x)) === toPlainText(x).
 *
 * Las comillas dentro de los atributos NO se interpretan a propósito: los feeds reales traen HTML roto
 * (por ejemplo alt="Debate sobre la economía"" />) y un limpiador que "respeta" las comillas se tragaría
 * el texto que sigue. Una etiqueta termina en el primer ">".
 */

// Tope de entrada: acota el costo con un feed que mande megabytes.
const MAX_INPUT_CHARS = 200000;
const MAX_PASSES = 3;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  iexcl: '¡', iquest: '¿',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  Agrave: 'À', Egrave: 'È', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  atilde: 'ã', otilde: 'õ', Atilde: 'Ã', Otilde: 'Õ', ccedil: 'ç', Ccedil: 'Ç',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', szlig: 'ß',
  copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£', cent: '¢', yen: '¥',
  middot: '·', bull: '•', times: '×', divide: '÷', plusmn: '±', ordm: 'º', ordf: 'ª',
  sect: '§', para: '¶', frac12: '½', frac14: '¼', frac34: '¾',
};

// Referencias numéricas 128-159: los navegadores las leen como Windows-1252 (&#150; es una raya, no un control).
const CP1252 = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š',
  139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—',
  152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
};

// Elementos que se sacan con todo lo que tienen adentro (hasta su cierre; si no cierra, hasta el final).
const JUNK_ELEMENTS = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe']);
const JUNK_CLOSERS = Object.fromEntries([...JUNK_ELEMENTS].map((name) => [name, new RegExp(`</${name}\\s*>`, 'gi')]));
const TAG_NAME = /\/?([a-zA-Z][a-zA-Z0-9:-]*)/y;
const CDATA_OPEN = /<!\[CDATA\[/g;
const CDATA_CLOSE = /\]\]>/g;
const PARTIAL_NUMERIC_ENTITY_AT_END = /&#[xX]?[0-9a-fA-F]*$/;

// Etiquetas que separan texto (se reemplazan por un espacio). El resto (a, b, i, span...) se saca sin espacio.
const SEPARATING_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'br', 'hr', 'tr', 'td', 'th', 'table', 'thead', 'tbody', 'tfoot',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'section', 'article', 'aside', 'header', 'footer', 'nav',
  'main', 'figure', 'figcaption', 'address', 'details', 'summary', 'form', 'fieldset',
  'img', 'picture', 'source', 'video', 'audio', 'object', 'embed', 'canvas', 'button', 'input', 'select', 'textarea',
]);

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,9}));/g;

function codePointToText(n) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return ' ';
  if (n >= 0xd800 && n <= 0xdfff) return ' ';
  if (CP1252[n]) return CP1252[n];
  if (n < 32 && n !== 9 && n !== 10 && n !== 13) return ' ';
  return String.fromCodePoint(n);
}

function decodeEntities(text) {
  return text.replace(ENTITY, (whole, dec, hex, name) => {
    if (dec !== undefined) return codePointToText(parseInt(dec, 10));
    if (hex !== undefined) return codePointToText(parseInt(hex, 16));
    return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : whole;
  });
}

/**
 * Saca las etiquetas con un recorrido de una sola pasada (tiempo lineal): un texto roto, con miles de "<a" sin
 * cerrar, no puede colgar la ingesta como pasaría con una expresión regular que retrocede.
 */
function stripMarkup(input) {
  if (!input.includes('<')) return input;
  const text = input.replace(CDATA_OPEN, '').replace(CDATA_CLOSE, '');
  const n = text.length;
  let out = '';
  let i = 0;

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) { out += text.slice(i); break; }
    out += text.slice(i, lt);

    // Comentario: <!-- ... -->  (sin cerrar: se descarta hasta el final)
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      out += ' ';
      if (end === -1) break;
      i = end + 3;
      continue;
    }

    // Declaración o instrucción: <!DOCTYPE ...>, <?xml ...?>
    const next = text[lt + 1];
    if (next === '!' || next === '?') {
      const end = text.indexOf('>', lt + 2);
      out += ' ';
      if (end === -1) break;
      i = end + 1;
      continue;
    }

    // Un "<" que no abre una etiqueta ("a < b", "5<6") es texto.
    TAG_NAME.lastIndex = lt + 1;
    const m = TAG_NAME.exec(text);
    if (!m) { out += '<'; i = lt + 1; continue; }

    // Etiqueta sin ">" hasta el final (texto cortado a la mitad): se descarta el resto.
    const gt = text.indexOf('>', lt + 1 + m[0].length);
    if (gt === -1) { out += ' '; break; }

    const name = m[1].toLowerCase();
    const isClosing = m[0][0] === '/';
    const selfClosed = text[gt - 1] === '/';

    if (!isClosing && !selfClosed && JUNK_ELEMENTS.has(name)) {
      const closer = JUNK_CLOSERS[name];
      closer.lastIndex = gt + 1;
      const c = closer.exec(text);
      out += ' ';
      if (!c) break;
      i = c.index + c[0].length;
      continue;
    }

    out += SEPARATING_TAGS.has(name) || JUNK_ELEMENTS.has(name) ? ' ' : '';
    i = gt + 1;
  }

  return out;
}

function tidyWhitespace(text) {
  return text
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '') // guion blando y caracteres de ancho cero
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ') // caracteres de control
    .replace(/\s+/g, ' ') // \s ya cubre nbsp y los demas espacios Unicode
    .trim();
}

/** Lo que llega de un feed puede ser texto, un arreglo o un objeto { _: texto }. */
function coerceToString(input) {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.length ? coerceToString(input[0]) : '';
  if (typeof input === 'object') return typeof input._ === 'string' ? input._ : '';
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  return '';
}

/** Corta en el límite de una palabra (sin partir pares sustitutos). */
function truncateAtWord(text, maxChars, ellipsis) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const high = cut.charCodeAt(cut.length - 1);
  if (high >= 0xd800 && high <= 0xdbff) cut = cut.slice(0, -1);
  if (!/\s/.test(text[cut.length] || ' ')) {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace >= maxChars * 0.6) cut = cut.slice(0, lastSpace);
  }
  cut = cut.replace(/[\s,;:.\-–—(]+$/, '');
  return ellipsis ? `${cut}...` : cut;
}

/**
 * @param {*} input  texto, arreglo, objeto { _ } o vacío
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  si se pasa, corta en límite de palabra
 * @param {boolean} [opts.ellipsis] agrega "..." cuando corta
 * @returns {string} texto plano, con espacios simples y sin bordes
 */
function toPlainText(input, { maxChars = 0, ellipsis = false } = {}) {
  let text = coerceToString(input);
  if (!text) return '';
  if (text.length > MAX_INPUT_CHARS) text = text.slice(0, MAX_INPUT_CHARS);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = decodeEntities(stripMarkup(text).replace(PARTIAL_NUMERIC_ENTITY_AT_END, ' '));
    if (next === text) break;
    text = next;
  }
  return truncateAtWord(tidyWhitespace(text), maxChars, ellipsis);
}

/**
 * De una lista de campos candidatos (en orden de preferencia) devuelve el primero cuyo texto limpio tiene al
 * menos `minChars` caracteres legibles. Si ninguno llega, devuelve el más largo (puede ser '').
 * Un campo que es solo una imagen (<img .../>) queda en 0 y se salta al siguiente.
 *
 * @returns {{ text: string, index: number }} index = posición del candidato elegido (-1 si no hay ninguno)
 */
function pickReadableText(candidates, { minChars = 40 } = {}) {
  let best = { text: '', index: -1 };
  for (let i = 0; i < candidates.length; i++) {
    const text = toPlainText(candidates[i]);
    if (text.length >= minChars) return { text, index: i };
    if (text.length > best.text.length) best = { text, index: i };
  }
  return best;
}

module.exports = {
  toPlainText,
  pickReadableText,
  decodeEntities,
  MAX_INPUT_CHARS,
};
