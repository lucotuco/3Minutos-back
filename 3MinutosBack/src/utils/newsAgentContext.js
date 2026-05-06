const UserPreference = require('../models/UserPreference');
const UserDeliveryRun = require('../models/UserDeliveryRun');
const { getLocalDateString } = require('./dateHelpers');

function cleanText(value = '', maxLength = 1200) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function formatArticleForContext(item, index) {
  const title = cleanText(
    item.neutralTitle || item.title || item.originalTitle || 'Sin título',
    220
  );

  const lead = cleanText(item.neutralLead || item.lead || '', 350);
  const summary = cleanText(item.neutralSummary || item.summary || '', 900);
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

async function getLatestDigestForUser(userId) {
  const today = getLocalDateString(new Date());

  const todaysRun = await UserDeliveryRun.findOne({
    userId,
    deliveryDate: today,
    status: { $in: ['prepared', 'sent'] },
    digest: { $ne: null },
  })
    .sort({ preparedAt: -1, createdAt: -1 })
    .lean();

  if (todaysRun?.digest?.items?.length) {
    return {
      deliveryDate: todaysRun.deliveryDate,
      deliveryTime: todaysRun.deliveryTime,
      digest: todaysRun.digest,
      source: 'today',
    };
  }

  const latestRun = await UserDeliveryRun.findOne({
    userId,
    status: { $in: ['prepared', 'sent'] },
    digest: { $ne: null },
  })
    .sort({ preparedAt: -1, createdAt: -1 })
    .lean();

  if (latestRun?.digest?.items?.length) {
    return {
      deliveryDate: latestRun.deliveryDate,
      deliveryTime: latestRun.deliveryTime,
      digest: latestRun.digest,
      source: 'latest',
    };
  }

  return null;
}

async function buildNewsAgentContext(userId) {
  const user = await UserPreference.findById(userId).lean();

  if (!user) {
    return {
      user: null,
      digestRun: null,
      contextText: '',
    };
  }

  const digestRun = await getLatestDigestForUser(userId);
  const items = digestRun?.digest?.items || [];

  const userBlock = [
    `Usuario: ${cleanText(user.name || 'usuario', 80)}`,
    `Temas elegidos: ${(user.topics || []).map((t) => cleanText(t, 60)).join(', ')}`,
    `Horario de digest: ${user.deliveryTime || 'sin horario'}`,
  ].join('\n');

  const digestBlock = digestRun
    ? [
        `Fecha del digest usado como contexto: ${digestRun.deliveryDate}`,
        `Origen del contexto: ${digestRun.source === 'today' ? 'digest de hoy' : 'último digest disponible'}`,
        '',
        items.slice(0, 3).map(formatArticleForContext).join('\n\n'),
      ].join('\n')
    : 'No hay digest preparado para este usuario. Si el usuario pregunta por noticias, aclarale que todavía no hay noticias disponibles para discutir.';

  const contextText = [
    '=== USUARIO ===',
    userBlock,
    '',
    '=== NOTICIAS_DEL_DIGEST ===',
    digestBlock,
    '=== FIN_NOTICIAS_DEL_DIGEST ===',
  ].join('\n');

  return {
    user,
    digestRun,
    contextText,
  };
}

function buildNewsAgentInstructions(contextText) {
  return `
Sos el agente de voz de 3 Minutos.

Tu objetivo es conversar con el usuario sobre las noticias que recibió en su digest del día.
Respondé en español rioplatense, claro, natural y conversacional.

Reglas:
- Usá como contexto principal las noticias incluidas abajo.
- Podés explicar contexto, causas, consecuencias, actores involucrados y posibles impactos.
- Si el usuario pregunta algo que no está en el contexto, aclaralo y respondé con cuidado.
- No inventes datos específicos que no estén respaldados por el contexto.
- No hagas bajada partidaria ni militante.
- Si hay temas políticos, intentá separar hechos, interpretaciones y opiniones.
- Hacé respuestas breves para audio: 20 a 45 segundos salvo que el usuario pida más detalle.
- Si el usuario pide “resumime”, dale un resumen simple.
- Si el usuario pide “por qué importa”, explicá impacto práctico.
- Si el usuario pide opinión, podés dar un análisis balanceado, no una certeza absoluta.
- No leas URLs en voz alta salvo que te las pidan.
- Al comenzar, saludá breve y preguntá qué noticia quiere discutir.

${contextText}
`.trim();
}

module.exports = {
  buildNewsAgentContext,
  buildNewsAgentInstructions,
};