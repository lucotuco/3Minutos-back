function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

const { getHoursSince, getFreshnessScore, isPreviewOrAgenda } = require('./freshness');

function getRankingScore(article = {}) {
  let importanceScore = Number(article.importanceScore || 0);
  const freshnessScore = getFreshnessScore(article.publishedAt);
  const hoursOld = getHoursSince(article.publishedAt);

  // Regla universal de caducidad para previas/agenda (lista compartida en freshness.js)
  const isPreview = isPreviewOrAgenda(article.title);

  // Eliminamos la condición "&& hoursOld > 4": si es agenda o previa, pierde el 80% del puntaje SIEMPRE.
  if (isPreview) {
    importanceScore = importanceScore * 0.2; 
  }

  // 💥 NUEVO: PENALIZACIÓN MULTIPLICATIVA POR VEJEZ (GRAVEDAD)
  // Evita que un puntaje alto de IA compense que la nota sea vieja
  let ageMultiplier = 1.0;
  if (hoursOld > 72) {
    ageMultiplier = 0.1; // Más de 3 días: pasa a valer casi nada (ej: 63 pts -> 6 pts)
  } else if (hoursOld > 48) {
    ageMultiplier = 0.4; // Entre 2 y 3 días: pierde el 60% de su valor
  } else if (hoursOld > 24) {
    ageMultiplier = 0.8; // De ayer: pierde un 20% para priorizar lo de hoy
  }

  // Aplicamos el multiplicador al final de la fórmula
  const rankingScore = clamp(
    (importanceScore * 0.70 + freshnessScore * 0.30) * ageMultiplier,
    0,
    100
  );

  return {
    importanceScore,
    freshnessScore,
    rankingScore: Number(rankingScore.toFixed(2)),
  };
}

function enrichArticleRanking(article = {}) {
  const scores = getRankingScore(article);

  return {
    ...article,
    ...scores,
  };
}

module.exports = {
  getFreshnessScore,
  getRankingScore,
  enrichArticleRanking,
};