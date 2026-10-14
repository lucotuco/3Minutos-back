'use strict';

/**
 * Auditoría ESTÁTICA: lee el código fuente actual (solo texto, no ejecuta nada) y marca
 * decisiones de diseño que influyen en cómo se comporta el sistema bajo estrés.
 * Complementa a los escenarios dinámicos: acá se ve el "por qué", allá el efecto medido.
 *
 * auditarFuentes() es pura (recibe strings); leerFuentes() solo lee archivos.
 */

const fs = require('fs');
const path = require('path');
const { hallazgo } = require('./hallazgo');

const ARCHIVOS = {
  openai: 'config/openai.js',
  server: 'server.js',
  pick: 'utils/pickBestArticlePerTopic.js',
  historial: 'utils/getAlreadyShownUrlsForUser.js',
  digest: 'utils/buildDigestForUser.js',
  busqueda: 'embeddings/searchArticlesBySimilarityAtlas.js',
  cron: 'utils/prepareUpcomingDeliveryRuns.js',
};

function leerFuentes(srcRoot) {
  const out = {};
  for (const [clave, rel] of Object.entries(ARCHIVOS)) {
    try { out[clave] = fs.readFileSync(path.join(srcRoot, rel), 'utf8'); } catch { out[clave] = ''; }
  }
  return out;
}

function auditarFuentes(f) {
  const out = [];
  const push = (cond, h) => { if (cond) out.push(hallazgo({ escenario: 'S', ...h })); };
  const tiene = (src, re) => Boolean(src) && re.test(src);

  push(f.busqueda && !tiene(f.busqueda, /embedding\s*:\s*1/), {
    id: 'S-SIN-EMBEDDING-EN-CANDIDATOS', severidad: 'ALTA',
    titulo: 'La búsqueda híbrida no trae el campo embedding de los candidatos',
    detalle: 'isUsableDigestArticle compara contra los vectores de lo ya visto solo si article.embedding existe; sin proyectarlo, ese filtro semántico nunca bloquea nada.',
    evidencia: ['embeddings/searchArticlesBySimilarityAtlas.js → projectFields sin "embedding: 1"'],
    sugerencia: 'Proyectar embedding solo para el top-N final, o comparar contra los vectores del historial en otra etapa.',
  });

  push(f.historial && f.digest && tiene(f.digest, /history\.titles/) && !tiene(f.historial, /\btitles\b/), {
    id: 'S-TITULOS-DEL-HISTORIAL-NUNCA-LLEGAN', severidad: 'BAJA',
    titulo: 'buildDigestForUser lee history.titles, pero getAlreadyShownHistoryForUser no lo devuelve',
    detalle: 'alreadyShownTitles llega siempre vacío (y pickBestArticlePerTopic igual no lo usa para filtrar).',
  });

  push(f.historial && tiene(f.historial, /\.limit\(\s*30\s*\)/), {
    id: 'S-VENTANA-HISTORIAL-30', severidad: 'INFO',
    titulo: 'El historial anti-repetidos mira solo las últimas 30 notas vistas',
    detalle: 'Con 3 tópicos por digest son ~10 digests; un usuario que refresca seguido puede volver a ver notas (las notas viven 48 h). El escenario B lo mide.',
  });

  push(f.openai && !tiene(f.openai, /timeout|maxRetries/), {
    id: 'S-OPENAI-SIN-TIMEOUT', severidad: 'MEDIA',
    titulo: 'Los clientes de OpenAI se crean sin timeout ni maxRetries',
    detalle: 'El SDK usa sus valores por defecto (timeout de 10 minutos y 2 reintentos): una llamada colgada puede frenar la generación de un digest muchos minutos.',
    evidencia: ['config/openai.js → new OpenAI({ apiKey })'],
  });

  push(f.server && tiene(f.server, /mongoose\.connect/) && !tiene(f.server, /maxPoolSize|socketTimeoutMS/), {
    id: 'S-MONGO-SIN-POOL-NI-SOCKET-TIMEOUT', severidad: 'BAJA',
    titulo: 'La conexión a Mongo no fija maxPoolSize ni socketTimeoutMS',
    detalle: 'Rigen los valores por defecto del driver (pool de 100 conexiones, sin timeout de socket): bajo carga las consultas hacen cola en silencio en vez de fallar rápido.',
  });

  push(f.pick && tiene(f.pick, /queryExpansionCache\s*=\s*new Map/) && !tiene(f.pick, /queryExpansionCache\.(delete|clear)|queryExpansionCache\.size/), {
    id: 'S-CACHE-EXPANSION-SIN-LIMITE', severidad: 'BAJA',
    titulo: 'queryExpansionCache es un Map que solo crece',
    detalle: 'Cada tópico distinto queda guardado hasta reiniciar el proceso. Con tópicos libres escritos a mano la cantidad es acotada en la práctica; el soak (F) mide la pendiente.',
  });

  push(f.pick && tiene(f.pick, /actualidad nacional/), {
    id: 'S-RESCATE-CONSULTA-FIJA', severidad: 'MEDIA',
    titulo: 'El rescate usa una consulta fija por categoría ("<categoría> Argentina actualidad nacional")',
    detalle: 'Todos los usuarios cuyo tópico falla dentro de una categoría reciben la misma nota de relleno (la primera usable), y la consulta mete "nacional" aunque el tópico no lo sea. Los escenarios A y B miden cuántos tópicos terminan en la misma nota.',
  });

  push(f.pick && tiene(f.pick, /TOPIC_TO_CATEGORY\s*=\s*Object\.fromEntries/) && tiene(f.pick, /TOPIC_TO_CATEGORY\[topic\]/) && !tiene(f.pick, /hasOwn/), {
    id: 'S-LOOKUP-EN-OBJETO-COMUN', severidad: 'BAJA',
    titulo: 'TOPIC_TO_CATEGORY[topic] busca en un objeto común',
    detalle: 'Un tópico como "constructor" o "toString" devuelve una función heredada (truthy) y se usa como categoría. El escenario E lo prueba con entradas de prototipo.',
  });

  push(f.cron && tiene(f.cron, /for\s*\(\s*const\s+user\s+of\s+usersInWindow\s*\)/) && tiene(f.cron, /await\s+buildDigestForUser/), {
    id: 'S-CRON-SECUENCIAL', severidad: 'INFO',
    titulo: 'La cron genera los digests de una ventana horaria uno tras otro',
    detalle: 'El último usuario de la ventana espera la suma de todos los anteriores. La rampa de digests (D) estima cuántos usuarios entran por minuto.',
  });

  return out;
}

module.exports = { auditarFuentes, leerFuentes, ARCHIVOS };
