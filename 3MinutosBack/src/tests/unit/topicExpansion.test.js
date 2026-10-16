'use strict';

/**
 * Tests de la expansión con IA de los temas libres (utils/topicExpansion.js): el pedido a la IA, la lectura y
 * validación de su respuesta ({ q, cat, sub }), la caché con tope y vencimiento y las llamadas en curso compartidas.
 * La IA es FALSA: ningún test llama a OpenAI.
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CATEGORIES, ALL_CATEGORIES } = require('../../utils/officialTopics');
const { TtlCache } = require('../../utils/llmJudge');
const {
  EXPANSION_MODEL, EXPANSION_TIMEOUT_MS, EXPANSION_MAX_RETRIES, LONG_TOPIC_WORDS, MAX_QUERY_CHARS,
  CACHE_TTL_MS, CACHE_MAX_ENTRIES,
  buildSystemPrompt, validCategory, validSubtopic, cleanQuery, parseExpansion, asExpansion,
  createTopicExpander, expandTopic, expansionCache,
} = require('../../utils/topicExpansion');

// ---------------------------------------------------------------- IA falsa
const respuesta = (contenido) => ({
  choices: [{ message: { content: typeof contenido === 'string' ? contenido : JSON.stringify(contenido) } }],
});

/** Cliente con la forma de OpenAI: chat.completions.create(body, opts). */
function clienteFalso(responder = () => respuesta({ q: 'river plate monumental millonario', cat: 'Deportes', sub: 'Fútbol' })) {
  const llamadas = [];
  return {
    llamadas,
    chat: {
      completions: {
        create: async (body, opts) => {
          llamadas.push({ body, opts });
          return responder(body, opts, llamadas.length);
        },
      },
    },
  };
}

/** Un cliente cuya respuesta se libera a mano: la llamada queda "en curso" hasta que el test la suelta. */
function clienteManual(contenido) {
  const cliente = clienteFalso(() => new Promise((ok) => { cliente.liberar = () => ok(respuesta(contenido)); }));
  return cliente;
}

const T0 = Date.parse('2026-10-15T15:00:00.000Z');

function nuevoExpansor({ cliente = clienteFalso(), reloj = { t: T0 }, ...resto } = {}) {
  const logs = [];
  const avisos = [];
  const expansor = createTopicExpander({
    getClient: () => cliente,
    now: () => reloj.t,
    log: (m) => logs.push(m),
    warn: (m, e) => avisos.push([m, e]),
    ...resto,
  });
  return { ...expansor, cliente, logs, avisos, reloj };
}

const pasarTurno = () => new Promise((ok) => setImmediate(ok));

// ================================================================ el pedido a la IA
test('el pedido: gpt-4o-mini, temperatura 0, semilla fija, JSON, 8 s y un reintento; el usuario manda su tema tal cual', async () => {
  const { expand, cliente } = nuevoExpansor();
  await expand('  river plate  ');

  assert.equal(cliente.llamadas.length, 1);
  const { body, opts } = cliente.llamadas[0];
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.model, EXPANSION_MODEL);
  assert.equal(body.temperature, 0);
  assert.equal(body.seed, 7);
  assert.equal(body.max_tokens, 120);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(body.messages[1].content, 'river plate', 'el tema va recortado y sin nada más');
  assert.equal(opts.timeout, 8000);
  assert.equal(opts.timeout, EXPANSION_TIMEOUT_MS);
  assert.equal(opts.maxRetries, 1);
  assert.equal(opts.maxRetries, EXPANSION_MAX_RETRIES);
});

test('las instrucciones traen las 4 reglas de la consulta, el año del reloj y la taxonomía oficial completa', () => {
  const prompt = buildSystemPrompt(2027);
  assert.match(prompt, /\(2027\)/);
  assert.match(prompt, /REGLA 1: q DEBE EMPEZAR con las palabras exactas del usuario/);
  assert.match(prompt, /REGLA 2: .*2 a 4 palabras clave/);
  assert.match(prompt, /REGLA 3: PROHIBICIÓN ABSOLUTA de agregar nombres de rivales/);
  assert.match(prompt, /REGLA 4: NO uses palabras genéricas/);
  assert.match(prompt, /\{"q": "\.\.\.", "cat": "\.\.\.", "sub": "\.\.\."\}/);
  assert.match(prompt, /Nunca inventes categorías ni subtemas/);
  assert.match(prompt, /dejalo en ""/);
  for (const categoria of ALL_CATEGORIES) {
    assert.ok(prompt.includes(`- ${categoria}: ${CATEGORIES[categoria].join(', ')}`), `falta la línea de ${categoria}`);
  }
});

test('el año de las instrucciones sale del reloj inyectado (no de uno fijo)', async () => {
  const { expand, cliente } = nuevoExpansor({ reloj: { t: Date.parse('2031-03-01T12:00:00Z') } });
  await expand('milei');
  assert.match(cliente.llamadas[0].body.messages[0].content, /\(2031\)/);
});

// ================================================================ lectura de la respuesta
test('validCategory: acepta la escritura oficial sin importar mayúsculas, tildes ni espacios; lo demás es ""', () => {
  const esperado = {
    Deportes: 'Deportes', deportes: 'Deportes', ' DEPORTES ': 'Deportes',
    Política: 'Política', politica: 'Política', 'ECONOMIA': 'Economía',
    'entretenimiento/cultura': 'Entretenimiento/Cultura', Tecnologia: 'Tecnología',
  };
  for (const [entrada, categoria] of Object.entries(esperado)) assert.equal(validCategory(entrada), categoria, JSON.stringify(entrada));
  for (const entrada of ['', null, undefined, 'Otros', 'Cocina', 'Fútbol', 'Deportes y más', 42, {}]) {
    assert.equal(validCategory(entrada), '', JSON.stringify(entrada));
  }
});

test('validSubtopic: con categoría busca solo en ella; sin categoría busca en todas; lo desconocido es ""', () => {
  assert.equal(validSubtopic('futbol', 'Deportes'), 'Fútbol');
  assert.equal(validSubtopic('FÚTBOL', 'Deportes'), 'Fútbol');
  assert.equal(validSubtopic('dolar y mercados', 'Economía'), 'Dólar y Mercados');
  assert.equal(validSubtopic('futbol', null), 'Fútbol', 'sin categoría se busca en toda la taxonomía');
  assert.equal(validSubtopic('Justicia', undefined), 'Justicia');
  assert.equal(validSubtopic('futbol', 'Política'), '', 'un subtema de otra categoría no vale');
  for (const entrada of ['', null, undefined, 'Otros deportes', 'Ajedrez', 'Deportes']) {
    assert.equal(validSubtopic(entrada, 'Deportes'), '', JSON.stringify(entrada));
  }
});

test('cleanQuery: minúsculas, una línea, sin signos de puntuación', () => {
  assert.equal(cleanQuery('River Plate, Monumental!! millonario', 'River Plate'), 'river plate monumental millonario');
  assert.equal(cleanQuery('  river   plate\nmonumental\t"millonario"  ', 'river plate'), 'river plate monumental millonario');
  assert.equal(cleanQuery('¿river plate? (monumental); [millonario]', 'river plate'), 'river plate monumental millonario');
});

test('cleanQuery: la consulta siempre empieza con las palabras del usuario (regla 1); si la IA las cambió, se las antepone', () => {
  assert.equal(cleanQuery('club atlético monumental millonario', 'river plate'), 'river plate club atlético monumental millonario');
  assert.equal(cleanQuery('monumental', 'Boca, Juniors!'), 'boca juniors monumental', 'el tema se limpia igual que la consulta');
});

test('cleanQuery: "empieza con" es por palabra entera, sin importar mayúsculas ni tildes', () => {
  assert.equal(cleanQuery('river platense club', 'river plate'), 'river plate river platense club', '"platense" no es "plate"');
  assert.equal(cleanQuery('Fútbol argentino liga', 'futbol'), 'fútbol argentino liga', 'la tilde no cuenta: ya empieza con el tema');
  assert.equal(cleanQuery('futbol', 'FÚTBOL'), 'futbol');
  assert.equal(cleanQuery('rivera', 'river'), 'river rivera');
});

test('cleanQuery: una consulta vacía vuelve al tema tal cual, y una larga se corta en una palabra entera sin pasar el tope', () => {
  assert.equal(cleanQuery('', 'river plate'), 'river plate');
  assert.equal(cleanQuery('   ', 'River Plate'), 'River Plate', 'sin consulta se devuelve lo que escribió el usuario');
  assert.equal(cleanQuery(',;:.', 'river'), 'river', 'solo signos = vacía');

  const larga = cleanQuery(`river ${'palabra '.repeat(80)}`, 'river');
  assert.ok(larga.length <= MAX_QUERY_CHARS, `largo ${larga.length}`);
  assert.equal(MAX_QUERY_CHARS, 200);
  assert.ok(larga.startsWith('river palabra'));
  assert.ok(larga.split(' ').every((w) => w === 'river' || w === 'palabra'), 'no queda ninguna palabra cortada a la mitad');
});

test('parseExpansion: lee { q, cat, sub } y los deja con la escritura oficial', () => {
  assert.deepEqual(
    parseExpansion('{"q":"boca juniors bombonera xeneize","cat":"deportes","sub":"futbol"}', 'boca'),
    { q: 'boca juniors bombonera xeneize', cat: 'Deportes', sub: 'Fútbol' },
  );
  assert.deepEqual(
    parseExpansion(JSON.stringify({ q: 'Zverev ATP Alemania!', cat: 'DEPORTES', sub: 'Tenis' }), 'zverev'),
    { q: 'zverev atp alemania', cat: 'Deportes', sub: 'Tenis' },
  );
});

test('parseExpansion: un subtema sin categoría completa la categoría; uno que es de otra categoría se descarta', () => {
  assert.deepEqual(parseExpansion('{"q":"boca","cat":"","sub":"Fútbol"}', 'boca'), { q: 'boca', cat: 'Deportes', sub: 'Fútbol' });
  assert.deepEqual(parseExpansion('{"q":"boca","sub":"futbol"}', 'boca'), { q: 'boca', cat: 'Deportes', sub: 'Fútbol' }, 'sin el campo cat');
  assert.deepEqual(
    parseExpansion('{"q":"milei","cat":"Política","sub":"Fútbol"}', 'milei'),
    { q: 'milei', cat: 'Política', sub: '' },
    'la categoría manda: un subtema que no es suyo se descarta',
  );
});

test('parseExpansion: lo que la IA invente fuera de la taxonomía se descarta, pero la consulta se conserva', () => {
  assert.deepEqual(parseExpansion('{"q":"receta flan","cat":"Cocina","sub":"Postres"}', 'flan'), { q: 'flan receta flan', cat: '', sub: '' });
  assert.deepEqual(parseExpansion('{"q":"boca","cat":"Deportes","sub":"Otros deportes"}', 'boca'), { q: 'boca', cat: 'Deportes', sub: '' });
  assert.deepEqual(parseExpansion('{"q":"boca","cat":7,"sub":["Fútbol"]}', 'boca'), { q: 'boca', cat: '', sub: '' }, 'tipos que no son texto');
  assert.deepEqual(parseExpansion('{"q":"boca"}', 'boca'), { q: 'boca', cat: '', sub: '' }, 'cat y sub son opcionales');
  assert.deepEqual(parseExpansion('{"q":"boca","cat":["Deportes"]}', 'boca'), { q: 'boca', cat: '', sub: '' }, 'una lista de un elemento no es un texto');
  assert.deepEqual(parseExpansion('{"q":"boca","sub":["Fútbol"]}', 'boca'), { q: 'boca', cat: '', sub: '' });
});

test('parseExpansion: tolera las vallas de código; lo que no es un objeto con "q" de texto no se puede usar (null)', () => {
  const json = '{"q":"boca juniors","cat":"Deportes","sub":"Fútbol"}';
  const esperado = { q: 'boca juniors', cat: 'Deportes', sub: 'Fútbol' };
  assert.deepEqual(parseExpansion(`\`\`\`json\n${json}\n\`\`\``, 'boca'), esperado);
  assert.deepEqual(parseExpansion(`\`\`\`\n${json}\n\`\`\``, 'boca'), esperado);
  assert.deepEqual(parseExpansion(`  \n${json}\n  `, 'boca'), esperado);

  for (const texto of ['', null, undefined, 'boca juniors bombonera', '{no es json', '[]', '["q"]', 'null', '42', '"texto"', '{}', '{"q":7}', '{"q":null}', '{"cat":"Deportes"}']) {
    assert.equal(parseExpansion(texto, 'boca'), null, JSON.stringify(texto));
  }
});

test('asExpansion: acepta un objeto { q, cat, sub } o un texto (los tests viejos devuelven texto); lo vacío cae en el tema', () => {
  assert.deepEqual(asExpansion({ q: 'a b', cat: 'Deportes', sub: 'Tenis' }, 't'), { q: 'a b', cat: 'Deportes', sub: 'Tenis' });
  assert.deepEqual(asExpansion({ q: 'a b' }, 't'), { q: 'a b', cat: '', sub: '' });
  assert.deepEqual(asExpansion('boca expandido', 'boca'), { q: 'boca expandido', cat: '', sub: '' });
  for (const nada of [null, undefined, '', 0, {}, { q: '' }]) assert.deepEqual(asExpansion(nada, 'boca'), { q: 'boca', cat: '', sub: '' }, JSON.stringify(nada));
});

// ================================================================ el expansor
test('expand: devuelve { q, cat, sub } validado y deja una línea de log con la categoría y el subtema', async () => {
  const { expand, logs } = nuevoExpansor();
  assert.deepEqual(await expand('river plate'), { q: 'river plate monumental millonario', cat: 'Deportes', sub: 'Fútbol' });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[Query Expansion IA\] "river plate" -> "river plate monumental millonario" \| categoría: Deportes \| subtema: Fútbol$/);
});

test('expand: una categoría sola es una pista válida (sub vacío)', async () => {
  const cliente = clienteFalso(() => respuesta({ q: 'milei casa rosada', cat: 'Política', sub: '' }));
  const { expand, logs } = nuevoExpansor({ cliente });
  assert.deepEqual(await expand('milei'), { q: 'milei casa rosada', cat: 'Política', sub: '' });
  assert.match(logs[0], /categoría: Política \| subtema: -$/);
});

test('caché: el mismo tema (sin importar mayúsculas, tildes ni espacios) se pregunta una sola vez', async () => {
  const { expand, cliente } = nuevoExpansor();
  const a = await expand('river plate');
  const b = await expand('River Plate');
  const c = await expand('  RÍVER   plate '); // tilde, mayúsculas y espacios de más
  assert.equal(cliente.llamadas.length, 1);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test('caché: lo que devuelve es una copia (cambiarla no contamina a los demás)', async () => {
  const { expand } = nuevoExpansor();
  const a = await expand('river plate'); // de la IA
  a.q = 'cambiado';
  a.cat = 'Política';
  const b = await expand('river plate'); // de la caché
  assert.equal(b.q, 'river plate monumental millonario');
  assert.equal(b.cat, 'Deportes');
  b.q = 'otro cambio';
  b.sub = 'Tenis';
  const c = await expand('river plate'); // de la caché otra vez
  assert.deepEqual(c, { q: 'river plate monumental millonario', cat: 'Deportes', sub: 'Fútbol' });
});

test('caché: vence a las 24 h justas y entonces se vuelve a preguntar', async () => {
  assert.equal(CACHE_TTL_MS, 24 * 3600e3);
  const { expand, cliente, reloj } = nuevoExpansor();
  await expand('river plate');
  reloj.t = T0 + CACHE_TTL_MS - 1;
  await expand('river plate');
  assert.equal(cliente.llamadas.length, 1, 'un milisegundo antes todavía vale');
  reloj.t = T0 + CACHE_TTL_MS;
  await expand('river plate');
  assert.equal(cliente.llamadas.length, 2, 'a las 24 h vence');
});

test('caché: tiene tope (antes un Map que solo crecía); al llenarse se va el tema menos usado', async () => {
  assert.equal(CACHE_MAX_ENTRIES, 2000);
  const { expand, cliente, cache } = nuevoExpansor({ cacheMaxEntries: 2 });
  await expand('uno');
  await expand('dos');
  await expand('uno'); // 'uno' pasa a ser el más usado
  await expand('tres'); // se va 'dos'
  assert.equal(cache.size, 2);
  assert.equal(cliente.llamadas.length, 3);
  await expand('uno');
  assert.equal(cliente.llamadas.length, 3, '"uno" sigue guardado');
  await expand('dos');
  assert.equal(cliente.llamadas.length, 4, '"dos" se descartó y se vuelve a preguntar');
});

test('llamadas en curso compartidas: 20 usuarios que piden el mismo tema nuevo a la vez hacen UNA llamada', async () => {
  const cliente = clienteManual({ q: 'river plate monumental', cat: 'Deportes', sub: 'Fútbol' });
  const { expand, inflight } = nuevoExpansor({ cliente });
  const pedidos = Array.from({ length: 20 }, (_, i) => expand(i % 2 ? 'river plate' : 'River Plate'));
  await pasarTurno();
  assert.equal(cliente.llamadas.length, 1);
  assert.equal(inflight.size, 1);

  cliente.liberar();
  const resultados = await Promise.all(pedidos);
  assert.equal(cliente.llamadas.length, 1);
  assert.equal(inflight.size, 0, 'terminada la llamada no queda nada colgado');
  for (const r of resultados) assert.deepEqual(r, { q: 'river plate monumental', cat: 'Deportes', sub: 'Fútbol' });
  assert.equal(new Set(resultados).size, 20, 'cada pedido recibe su propia copia');
});

test('si la IA falla se busca el tema tal cual (sin pista) y el fallo NO se guarda: el próximo pedido vuelve a intentar', async () => {
  let fallar = true;
  const cliente = clienteFalso(() => {
    if (fallar) throw new Error('timeout de OpenAI');
    return respuesta({ q: 'river plate monumental', cat: 'Deportes', sub: 'Fútbol' });
  });
  const { expand, avisos, inflight, cache } = nuevoExpansor({ cliente });

  assert.deepEqual(await expand('river plate'), { q: 'river plate', cat: '', sub: '' });
  assert.equal(avisos.length, 1);
  assert.match(avisos[0][0], /Fallo expansion IA para "river plate", usando original:/);
  assert.equal(avisos[0][1], 'timeout de OpenAI');
  assert.equal(cache.size, 0, 'el fallo no se guarda');
  assert.equal(inflight.size, 0);

  fallar = false;
  assert.deepEqual(await expand('river plate'), { q: 'river plate monumental', cat: 'Deportes', sub: 'Fútbol' });
  assert.equal(cliente.llamadas.length, 2);
});

test('si la IA contesta cualquier cosa (no JSON, sin "q", sin choices) es lo mismo que si fallara', async () => {
  for (const mala of ['claro, acá va: river plate monumental', '{"cat":"Deportes"}', '[]', '', { choices: [] }, {}, null]) {
    const cliente = clienteFalso(() => (typeof mala === 'string' ? respuesta(mala) : mala));
    const { expand, avisos, cache } = nuevoExpansor({ cliente });
    assert.deepEqual(await expand('river plate'), { q: 'river plate', cat: '', sub: '' }, JSON.stringify(mala));
    assert.equal(avisos.length, 1);
    assert.equal(cache.size, 0);
  }
});

test('un tema de 5 palabras o más ya es una consulta: no se expande ni se llama a la IA', async () => {
  assert.equal(LONG_TOPIC_WORDS, 5);
  const { expand, cliente } = nuevoExpansor();
  assert.deepEqual(await expand('cotizacion del dolar blue hoy'), { q: 'cotizacion del dolar blue hoy', cat: '', sub: '' });
  assert.equal(cliente.llamadas.length, 0);
  await expand('dolar blue de hoy'); // 4 palabras: sí
  assert.equal(cliente.llamadas.length, 1);
});

test('un tema vacío o de espacios no llama a la IA', async () => {
  const { expand, cliente } = nuevoExpansor();
  for (const vacio of ['', '   ', null, undefined]) assert.deepEqual(await expand(vacio), { q: '', cat: '', sub: '' });
  assert.equal(cliente.llamadas.length, 0);
});

test('la IA se carga recién al usarla (importar el módulo no exige claves de OpenAI)', () => {
  assert.equal(typeof expandTopic, 'function');
  assert.ok(expansionCache instanceof TtlCache);
  assert.equal(expansionCache.maxEntries, 2000);
  assert.equal(expansionCache.ttlMs, 24 * 3600e3);
});
