require('dotenv').config();
const mongoose = require('mongoose');
const { buildUserNewsDigest } = require('../utils/buildUserNewsDigest');

async function connectDB() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
}

// 🪤 PERFILES TRAMPA: Diseñados para forzar al sistema a cometer errores de duplicación
const TEST_PROFILES = [
  {
    name: '🏀 Perfil 1: Aislamiento Deportivo (Anti-FIFA)',
    topics: ['básquet', 'tenis', 'los pumas'],
  },

  // ============================================================================
  // 🎬 GRUPO 2: ENTRETENIMIENTO PURO (Sin relleno genérico)
  // ============================================================================
  // Desafío: "Cine y Series" antes expandía a "producciones plataformas". 
  // Ahora debería tirar cosas como "hollywood oscars taquilla rodajes guiones".
  // "Música" debería ir a "recitales shows discograficas grammys".
  {
    name: '🎬 Perfil 2: Nicho de Entretenimiento',
    topics: ['cine y series', 'música', 'streaming'],
  },

  // ============================================================================
  // 💻 GRUPO 3: TECNOLOGÍA DURA (Anti "Innovación")
  // ============================================================================
  // Desafío: Antes "Inteligencia Artificial" tiraba "avances tecnológicos". 
  // Ahora lo obligamos a ir a "algoritmos machine learning redes neuronales llm".
  // "Videojuegos" debería ir a "consolas fps rpg joysticks".
  {
    name: '💻 Perfil 3: Tech y Código Duro',
    topics: ['inteligencia artificial', 'videojuegos', 'apps y redes'],
  },

  // ============================================================================
  // 💸 GRUPO 4: ECOSISTEMA FINANCIERO (Bolsillo vs Corporativo)
  // ============================================================================
  // Desafío: Forzar a la IA a buscar la jerga de los que fundan empresas 
  // ("startups venture capital rondas semilla") vs. la timba ("merval bonos cedears").
  {
    name: '💸 Perfil 4: Finanzas y Startups',
    topics: ['emprendedores', 'inversiones', 'dólar y mercados'],
  },

  // ============================================================================
  // ⚔️ GRUPO 5: GEOPOLÍTICA Y POLÍTICA LOCAL (Sin "Historia" ni "Actualidad")
  // ============================================================================
  // Desafío: Ver cómo aísla el conflicto de "Medio Oriente" (debería tirar 
  // "franja gaza hezbola misiles") y cómo maneja las instituciones argentinas.
  {
    name: '⚔️ Perfil 5: Geopolítica y Estado',
    topics: ['medio oriente', 'justicia', 'gobierno nacional'],
  },

  // ============================================================================
  // 🔀 GRUPO 6: NOMBRES PROPIOS CORTOS (El test del Escudo Léxico)
  // ============================================================================
  // Desafío: Nombres de 1 sola palabra. La IA tiene que agregarles el contexto 
  // técnico correcto. "Boca" (xeneize riquelme bombonera) y "Milei" (lla dnu veto).
  // Y el escudo léxico de BM25 debe exigir que el texto los nombre explícitamente.
  {
    name: '🔀 Perfil 6: Nombres Cortos y Ambiguos',
    topics: ['boca', 'milei', 'ceuta'],
  }
];

async function runBattery() {
  await connectDB();
  console.log('\n⚡ INICIANDO BATERÍA ANTI-DUPLICADOS Y FALLBACKS...\n' + '='.repeat(60));

  let totalTests = 0;
  let passedTests = 0;

  for (const profile of TEST_PROFILES) {
    console.log(`\n▶️  Ejecutando: ${profile.name}`);
    
    const startTime = Date.now();
    
    // Ejecutamos el motor de curación
    const digest = await buildUserNewsDigest({
      topics: profile.topics,
      alreadyShownUrls: [],
      seenEmbeddings: [], // Arrancamos con historial limpio para la prueba
      perTopicLimit: 10,
    });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    const seenUrls = new Set();
    const seenTitles = new Set();
    let profilePassed = true;

    console.log(`⏱️  Tiempo: ${elapsed}s | Noticias entregadas: ${digest.items.length}/3`);

    digest.items.forEach((item, idx) => {
      totalTests++;
      const num = idx + 1;
      const title = item.title || 'SIN TÍTULO';
      const score = Number(item.rankingScore ?? item.finalScore ?? item.score ?? 0);
      
      console.log(`\n   📰 Noticia ${num} [Tópico pedido: "${profile.topics[idx]}" -> Entregado: "${item.topic}"]`);
      console.log(`      Título: "${title.slice(0, 75)}..."`);
      
      const errors = [];

      // 🚨 1. CHEQUEO ESTRICTO DE DUPLICADOS (URL y Título)
      if (item.url && seenUrls.has(item.url)) {
        errors.push('❌ ERROR: URL DUPLICADA en el mismo resumen.');
      }
      if (seenTitles.has(title)) {
        errors.push('❌ ERROR: TÍTULO DUPLICADO en el mismo resumen.');
      }

      // 🚨 2. CHEQUEO DE DEGRADACIÓN ELEGANTE (Fallback)
      if (profile.name.includes('Fallback') && !item.topic.includes('Sugerido')) {
         errors.push('❌ ERROR: Falló la degradación elegante. No aplicó la etiqueta "Destacado (Sugerido)".');
      }

      if (errors.length > 0) {
        profilePassed = false;
        errors.forEach(e => console.log(`      ${e}`));
      } else {
        passedTests++;
        console.log(`      ✅ ESTADO: Noticia única y validada (Score: ${score.toFixed(1)})`);
      }

      // Añadimos a los Sets para comparar con la SIGUIENTE noticia del mismo ciclo
      if (item.url) seenUrls.add(item.url);
      seenTitles.add(title);
    });

    console.log('-'.repeat(60));
  }

  console.log(`\n📊 RESULTADO FINAL DE LA AUDITORÍA:`);
  console.log(`   Noticias evaluadas: ${totalTests}`);
  console.log(`   Éxitos: ${passedTests} | Fallos: ${totalTests - passedTests}`);
  
  if (passedTests === totalTests) {
    console.log(`\n🏆 ¡TODO PERFECTO! El sistema anti-duplicados funciona al 100%.\n`);
  } else {
    console.log(`\n⚠️ SE DETECTARON FALLOS. Revisá los ítems marcados con ❌ arriba.\n`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

runBattery().catch(err => {
  console.error('❌ Error fatal en la batería de pruebas:', err);
  process.exit(1);
});