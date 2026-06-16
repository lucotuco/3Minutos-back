const { normalizeText } = require('../../utils/normalizeText');

const FALLBACK_IMAGE_URL = 'https://st2.depositphotos.com/1036149/5381/i/950/depositphotos_53811511-stock-illustration-duck-with-sunglasses.jpg'; 

function extractImage(item = {}) {
  let url = null;

  if (item.reformaEnclosure) {
    let url = typeof item.reformaEnclosure === 'string' ? item.reformaEnclosure.trim() : null;
    if (url && url.startsWith('http')) return url;
  }
  // Función auxiliar para extraer URLs de diferentes estructuras de objetos XML
  const getUrlFromObj = (obj) => {
    if (!obj) return null;
    
    // Si el parser lo devuelve como un string directo (ej. Reforma)
    if (typeof obj === 'string') {
      const trimmed = obj.trim(); // Limpiamos espacios y saltos de línea
      if (trimmed.startsWith('http')) return trimmed;
    }
    
    // Si viene parseado de forma estándar
    if (obj.url) return obj.url;
    
    // Si viene parseado por xml2js (los atributos caen dentro de un objeto $)
    if (obj.$ && obj.$.url) return obj.$.url;
    
    // Si el valor está en el texto interior del nodo
    if (obj._ && typeof obj._ === 'string') {
      const trimmed = obj._.trim(); // Limpiamos espacios
      if (trimmed.startsWith('http')) return trimmed;
    }
    
    return null;
  };

  // 1. Etiqueta <enclosure> (Ámbito, El País Uruguay, La Política Online, Reforma)
  if (item.enclosure) {
    url = Array.isArray(item.enclosure) ? getUrlFromObj(item.enclosure[0]) : getUrlFromObj(item.enclosure);
    if (url) return url;
  }

  // 2. Etiqueta <media:content> (La Nación, FayerWayer, The Guardian, SDP Noticias, Clarín)
  const mediaContent = item['media:content'] || item.mediaContent;
  if (mediaContent) {
    url = Array.isArray(mediaContent) ? getUrlFromObj(mediaContent[0]) : getUrlFromObj(mediaContent);
    if (url) return url;
  }

  // 3. Etiqueta <media:thumbnail> (BBC News Brasil)
  const mediaThumb = item['media:thumbnail'] || item.mediaThumbnail;
  if (mediaThumb) {
    url = Array.isArray(mediaThumb) ? getUrlFromObj(mediaThumb[0]) : getUrlFromObj(mediaThumb);
    if (url) return url;
  }

  // 4. Etiqueta <image:image> -> <image:loc> (La República)
  const imageImage = item['image:image'] || item.imageImage;
  if (imageImage) {
    let imgObj = Array.isArray(imageImage) ? imageImage[0] : imageImage;
    let loc = imgObj['image:loc'] || imgObj.loc;
    if (loc) {
      if (Array.isArray(loc)) loc = loc[0];
      if (typeof loc === 'string' && loc.startsWith('http')) return loc;
      if (typeof loc === 'object' && loc._ && loc._.startsWith('http')) return loc._;
    }
  }

  // 5. Buscar etiqueta <img> dentro de cualquier campo de texto/HTML (G1 Globo, El Economista, Infobae, Montevideo Portal)
  const contentFields = [
    item.content,
    item['content:encoded'],
    item.contentSnippet,
    item.summary,
    item.description
  ];

  for (let field of contentFields) {
    let text = field;
    if (Array.isArray(text)) text = text[0];
    if (typeof text === 'object' && text !== null && text._) text = text._;
    
    if (typeof text === 'string' && text.trim().length > 0) {
      // Regex súper tolerante a espacios, saltos de línea y distintos tipos de comillas
      const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["']/i;
      const match = text.match(imgRegex);
      if (match && match[1]) {
        return match[1];
      }
    }
  }

  return FALLBACK_IMAGE_URL;
}

function extractSummary(item = {}) {
  return (
    item.content ||
    item['content:encoded'] ||
    item.contentSnippet ||
    item.summary ||
    item.description ||
    ''
  );
}

function adaptRssArticle(item = {}, source = {}) {
  const title = item.title || 'Sin título';
  const url = item.link || '';
  const rawSummary = extractSummary(item);

  return {
    sourceName: source.name || 'Fuente RSS',
    sourceType: 'rss',
    sourceUrl: source.url || '',
    title,
    url,
    publishedAt: item.pubDate ? new Date(item.pubDate) : null,
    category: source.category || 'general',
    country: source.country || 'ar',
    language: source.language || 'es',
    author: item.creator || item.author || '',
    rawSummary,
    imageUrl: extractImage(item),
    contentSnippet: item.contentSnippet || item.summary || item.description || '',
    normalizedTitle: normalizeText(title),
    _sourceMeta: {
      type: 'rss',
      source,
      rawItem: item,
    },
  };
}

module.exports = {
  adaptRssArticle,
};