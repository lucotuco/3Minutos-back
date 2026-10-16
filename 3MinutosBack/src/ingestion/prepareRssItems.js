'use strict';

/**
 * prepareRssItems.js
 *
 * El paso de la ingesta RSS que va entre "bajé el feed" y "se lo mando al clasificador": convierte los items del
 * feed en notas, descarta lo que no sirve y trae el cuerpo de las notas cuyo resumen es demasiado corto.
 *
 * Sale de runRssIngestion.js (que arranca solo al cargarse y por eso no se puede probar) y recibe todo lo que toca
 * la red o la base como parámetro. Qué cambia respecto del código que había adentro del ciclo:
 *
 *   1. Las notas que YA están guardadas se descartan antes del rescate. Antes se rescataban igual (una descarga
 *      de la página por nota, con 0,5 s de espera) y recién después se descubría que ya estaban.
 *   2. El largo se mide sobre texto limpio. Antes se medía sobre el HTML: una nota de 40 letras con una imagen
 *      de 400 caracteres de URL parecía tener 440 y no se rescataba nunca.
 *   3. Si el rescate falla, la nota se conserva cuando tiene al menos MIN_KEEP_CHARS caracteres legibles (antes se
 *      tiraba toda nota cuyo rescate fallaba, aunque ya tuviera un buen resumen) y se descarta cuando tiene menos.
 *   4. Devuelve contadores (rescatadas / cortas conservadas / descartadas) para el log de cada fuente.
 */

const { toPlainText } = require('../utils/plainText');

const RESCUE_BELOW_CHARS = 250; // resumen más corto que esto: se intenta traer el cuerpo de la nota
const MIN_KEEP_CHARS = 80;      // si el rescate no sirvió, se conserva la nota solo con al menos este texto
const RESCUE_PAUSE_MS = 500;    // cortesía con el sitio antes de cada descarga

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object}   p
 * @param {object[]} p.items            items del feed (ya recortados a los que se quieren mirar)
 * @param {object}   p.source           fuente de Sources.json
 * @param {(item:object, source:object)=>object} p.adapt   item del feed -> nota (rssAdapter)
 * @param {(article:object)=>object}  p.process            nota -> nota con los campos de partida (processArticle)
 * @param {(articles:object[])=>Promise<{newArticles:object[], duplicateArticles:object[]}>} p.filterExisting
 * @param {(url:string)=>Promise<string>} p.rescueBody     descarga la nota y devuelve su texto plano (puede lanzar)
 * @param {(article:object)=>boolean} [p.isDiscardedImage] true si la nota se tira por su imagen
 * @param {(ms:number)=>Promise<void>} [p.sleep]
 * @param {(msg:string)=>void} [p.log]
 * @returns {Promise<{articles:object[], duplicateArticles:object[], stats:object}>}
 */
async function prepareRssItems({
  items = [],
  source = {},
  adapt,
  process,
  filterExisting,
  rescueBody,
  isDiscardedImage = () => false,
  sleep = defaultSleep,
  log = () => {},
}) {
  const stats = {
    items: items.length, sinImagen: 0, errores: 0, duplicadas: 0, rescatadas: 0, cortasConservadas: 0, descartadas: 0,
  };

  // 1. Items del feed -> notas. Sin red: solo se mira la imagen y se dejan los campos de partida.
  const prepared = [];
  for (const item of items) {
    try {
      const adapted = adapt(item, source);
      if (isDiscardedImage(adapted)) {
        log(`Noticia descartada por no tener imagen valida: ${adapted.title}`);
        stats.sinImagen++;
        continue;
      }
      const article = process(adapted);
      // El largo se mide sobre texto plano (los adaptadores ya lo entregan así; esto lo garantiza en el borde).
      article.rawSummary = toPlainText(article.rawSummary);
      article.contentSnippet = toPlainText(article.contentSnippet);
      prepared.push(article);
    } catch (error) {
      stats.errores++;
      log(`${source.name} -> ${error.message}`);
    }
  }

  // 2. Lo que ya está guardado se va ANTES de gastar una descarga en rescatarlo.
  const { newArticles, duplicateArticles } = await filterExisting(prepared);
  stats.duplicadas = duplicateArticles.length;

  // 3. Rescate del cuerpo de las notas nuevas con resumen corto.
  const articles = [];
  for (const article of newArticles) {
    try {
      const current = article.rawSummary || article.contentSnippet || '';
      if (current.length >= RESCUE_BELOW_CHARS) {
        articles.push(article);
        continue;
      }

      log(`Rescatando nota corta de ${source.name} (${current.length} chars)...`);
      await sleep(RESCUE_PAUSE_MS);

      let rescued = '';
      try {
        rescued = toPlainText(await rescueBody(article.url));
      } catch (error) {
        log(`Fallo el rescate de Postlight: ${error.message}`);
      }

      if (rescued.length >= RESCUE_BELOW_CHARS) {
        article.rawSummary = rescued;
        article.contentSnippet = rescued;
        stats.rescatadas++;
        log(`Rescate exitoso: ${rescued.length} chars recuperados.`);
        articles.push(article);
        continue;
      }

      // No se pudo traer el cuerpo entero: se queda con el texto más largo que haya, si alcanza el piso.
      const best = rescued.length > current.length ? rescued : current;
      if (best.length >= MIN_KEEP_CHARS) {
        if (best === rescued) {
          article.rawSummary = rescued;
          article.contentSnippet = rescued;
        }
        stats.cortasConservadas++;
        log(`Se conserva la nota con ${best.length} chars (no se pudo recuperar el cuerpo completo).`);
        articles.push(article);
      } else {
        stats.descartadas++;
        log(`Descartada: solo ${best.length} chars legibles.`);
      }
    } catch (error) {
      stats.errores++;
      log(`${source.name} -> ${error.message}`);
    }
  }

  return { articles, duplicateArticles, stats };
}

module.exports = { prepareRssItems, RESCUE_BELOW_CHARS, MIN_KEEP_CHARS, RESCUE_PAUSE_MS };
