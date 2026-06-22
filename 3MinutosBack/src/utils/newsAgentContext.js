const UserPreference = require('../models/UserPreference');
const UserDeliveryRun = require('../models/UserDeliveryRun');
const { getLocalDateString } = require('./dateHelpers');

function cleanText(value = '', maxLength = 1200) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function getDigestItemsFromRun(run) {
  if (Array.isArray(run?.digest?.digest?.items)) {
    return run.digest.digest.items;
  }

  if (Array.isArray(run?.digest?.items)) {
    return run.digest.items;
  }

  return [];
}

function getDigestAudioUrlFromRun(run) {
  if (run?.digest?.digest?.audioUrl) {
    return run.digest.digest.audioUrl;
  }

  if (run?.digest?.audioUrl) {
    return run.digest.audioUrl;
  }

  return null;
}

function getDigestUserFromRun(run) {
  if (run?.digest?.user) {
    return run.digest.user;
  }

  return null;
}

function formatArticleForContext(item, index) {
  const title = cleanText(
    item.neutralTitle || item.title || item.originalTitle || 'Sin título',
    260
  );

  const lead = cleanText(item.neutralLead || item.lead || '', 450);

  const summary = cleanText(
    item.neutralSummary || item.summary || item.rawSummary || '',
    1100
  );

  const topic = cleanText(item.topic || '', 80);
  const section = cleanText(item.section || '', 80);
  const region = cleanText(item.region || '', 80);
  const url = cleanText(item.url || '', 500);

  return [
    `NOTICIA ${index + 1}`,
    `Título: ${title}`,
    lead ? `Copete: ${lead}` : '',
    summary ? `Resumen: ${summary}` : '',
    topic ? `Tema del usuario: ${topic}` : '',
    section ? `Sección: ${section}` : '',
    region ? `Región: ${region}` : '',
    url ? `URL: ${url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function getTodaysDigestForUser(userId) {
  const today = getLocalDateString(new Date());

  const run = await UserDeliveryRun.findOne({
    userId,
    deliveryDate: today,
    status: { $in: ['prepared', 'sent'] },
    digest: { $ne: null },
  })
    .sort({
      preparedAt: -1,
      createdAt: -1,
    })
    .lean();

  if (!run) {
    return null;
  }

  const items = getDigestItemsFromRun(run);

  if (!items.length) {
    return null;
  }

  return run;
}

async function buildNewsAgentContext(userId) {
  const user = await UserPreference.findById(userId).lean();

  if (!user) {
    return {
      user: null,
      digestRun: null,
      items: [],
      hasTodaysDigest: false,
      contextText: '',
    };
  }

  const digestRun = await getTodaysDigestForUser(userId);
  const items = getDigestItemsFromRun(digestRun);
  const digestUser = getDigestUserFromRun(digestRun);

  const userBlock = [
    `Usuario: ${cleanText(user.name || digestUser?.name || 'usuario', 80)}`,
    `Temas elegidos: ${(user.topics || [])
      .map((topic) => cleanText(topic, 60))
      .filter(Boolean)
      .join(', ')}`,
    `Horario de resumen: ${user.deliveryTime || 'sin horario'}`,
  ].join('\n');

  const digestBlock =
    digestRun && items.length > 0
      ? [
          `Fecha del resumen usado como contexto: ${digestRun.deliveryDate}`,
          digestRun.preparedAt
            ? `Preparado en: ${new Date(digestRun.preparedAt).toISOString()}`
            : '',
          getDigestAudioUrlFromRun(digestRun)
            ? 'El resumen también tiene audio generado.'
            : '',
          '',
          items.slice(0, 3).map(formatArticleForContext).join('\n\n'),
        ]
          .filter(Boolean)
          .join('\n')
      : 'No hay resumen de hoy con noticias para este usuario. No hables de noticias específicas.';

  const contextText = [
    '=== USUARIO ===',
    userBlock,
    '',
    '=== NOTICIAS_DEL_DIGEST_DE_HOY ===',
    digestBlock,
    '=== FIN_NOTICIAS_DEL_DIGEST_DE_HOY ===',
  ].join('\n');

  return {
    user,
    digestRun,
    items,
    hasTodaysDigest: Boolean(digestRun && items.length > 0),
    contextText,
  };
}

function buildNewsAgentInstructions(contextText) {
  return `
Sos el agente de voz de 3 Minutos.

Respondé en español rioplatense, claro, natural y breve.
Soná comoun hombre de mediana edad : tono cálido, cercano, seguro y natural.
Tu único contexto confiable son las noticias del digest de hoy incluidas abajo.
No uses noticias viejas, memoria previa, ejemplos genéricos ni información externa como si fuera parte del digest.

Reglas obligatorias:
- No inventes nombres de noticias.
- No inventes ejemplos como "Boca", "Trump", "River" u otros salvo que aparezcan explícitamente en el contexto.
- Si el usuario pregunta por algo que no aparece en el contexto, decí: "Eso no aparece en las noticias que recibiste hoy".
- Si el usuario dice "la primera", "la segunda" o "la tercera", usá el orden listado.
- Si el usuario pide contexto, explicá causas, actores relevantes y posibles consecuencias.
- Separá hechos de interpretación.
- No hagas bajada partidaria ni militante.
- Respondé en español rioplatense, claro, natural y breve.
- Para audio, respondé en frases cortas. Máximo 20 a 45 segundos salvo que el usuario pida más detalle.
- No leas URLs en voz alta salvo que te las pidan.

Al comenzar, cuando el usuario hable, saludalo brevemente y preguntale cuál de las noticias del digest quiere discutir. Mencioná títulos reales disponibles, no ejemplos inventados.

${contextText}
`.trim();
}

module.exports = {
  buildNewsAgentContext,
  buildNewsAgentInstructions,
  getDigestItemsFromRun,
};