const cron = require('node-cron');
const path = require('path');
const { spawn } = require('child_process');

const APP_TIME_ZONE = 'America/Argentina/Buenos_Aires';

let isIngestionRunning = false;

function envFlag(name, defaultValue = false) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return String(value).toLowerCase() === 'true';
}

function formatArgentinaDateTime(date = new Date()) {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: APP_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

function runScript(scriptRelativePath, label) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, scriptRelativePath);

    console.log(`▶️ Ejecutando ${label}: ${scriptPath}`);

    const child = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        INGESTION_CHILD_PROCESS: 'true',
      },
    });

    child.on('error', (error) => {
      reject(new Error(`${label}: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} terminó con código ${code}`));
    });
  });
}

async function runHourlyIngestion() {
  if (isIngestionRunning) {
    console.log(
      `⏭️ Ingesta salteada: ya hay una ingesta corriendo. Hora AR: ${formatArgentinaDateTime(new Date())}`
    );
    return;
  }

  const enableRss = envFlag('INGEST_RSS', true);
  const enableNewsApi = envFlag('INGEST_NEWSAPI', false);

  if (!enableRss && !enableNewsApi) {
    console.log('⏸️ Ingesta omitida: INGEST_RSS=false e INGEST_NEWSAPI=false');
    return;
  }

  isIngestionRunning = true;

  try {
    console.log(
      `\n📰 Iniciando ingesta horaria AR: ${formatArgentinaDateTime(new Date())}`
    );

    if (enableRss) {
      await runScript('ingestion/runRssIngestion.js', 'RSS ingestion');
    } else {
      console.log('⏸️ RSS ingestion deshabilitada');
    }

    if (enableNewsApi) {
      if (!process.env.NEWS_API_KEY) {
        console.log('⏸️ NewsAPI omitida: falta NEWS_API_KEY');
      } else {
        await runScript('ingestion/runNewsApiIngestion.js', 'NewsAPI ingestion');
      }
    } else {
      console.log('⏸️ NewsAPI ingestion deshabilitada');
    }

    console.log('✅ Ingesta horaria completada');
  } catch (error) {
    console.error('❌ Error en ingesta horaria:', error.message);
  } finally {
    isIngestionRunning = false;
  }
}

function startHourlyIngestionJob() {
  cron.schedule(
    '0 * * * *',
    async () => {
      await runHourlyIngestion();
    },
    {
      timezone: APP_TIME_ZONE,
    }
  );

  console.log('✅ Cron de ingesta programado cada hora');
}

module.exports = {
  startHourlyIngestionJob,
  runHourlyIngestion,
};