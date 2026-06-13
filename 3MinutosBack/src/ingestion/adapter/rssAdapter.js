const Parser = require('rss-parser');

// Configuramos el parser para que detecte etiquetas multimedia especiales en el XML
const parser = new Parser({
    customFields: {
        item: [
            ['media:content', 'mediaContent'],
            ['enclosure', 'enclosure']
        ]
    }
});

// Definimos la imagen por defecto en caso de que el RSS no traiga ninguna
const FALLBACK_IMAGE_URL = "https://st2.depositphotos.com/1036149/5381/i/950/depositphotos_53811511-stock-illustration-duck-with-sunglasses.jpg";

/**
 * Función auxiliar para buscar y extraer la URL de la imagen de un item del RSS
 */
function extractImage(item) {
    // 1. Prioridad: buscar en la etiqueta estándar <enclosure>
    if (item.enclosure && item.enclosure.url) {
        return item.enclosure.url;
    }
    
    // 2. Prioridad: buscar en la etiqueta <media:content> (muy común en portales grandes)
    if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) {
        return item.mediaContent.$.url;
    }
    
    // 3. Prioridad: buscar un tag <img> renderizado dentro del HTML del contenido/descripción
    const content = item.content || item.contentSnippet || item.description || "";
    const imgRegex = /<img[^>]+src="([^">]+)"/i;
    const match = content.match(imgRegex);
    if (match && match[1]) {
        return match[1];
    }
    
    // Si se agotan las opciones y no hay imagen, retorna el Fallback
    return FALLBACK_IMAGE_URL;
}

/**
 * Función principal que descarga el RSS y formatea los artículos
 */
async function fetchRssFeed(source) {
    try {
        const feed = await parser.parseURL(source.url);
        
        return feed.items.map(item => ({
            title: item.title,
            link: item.link,
            description: item.contentSnippet || item.description,
            content: item.content || item.description,
            source: source.name,
            category: source.category || 'general',
            country: source.country || 'ar',
            pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
            // Llamamos a la función para extraer o asignar la imagen de fallback
            imageUrl: extractImage(item)
        }));
    } catch (error) {
        console.error(`Error procesando RSS ${source.url}:`, error.message);
        // Retornamos un array vacío para que el proceso no se caiga si un feed falla
        return [];
    }
}

module.exports = {
    fetchRssFeed
};