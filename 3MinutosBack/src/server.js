require('dotenv').config();

const app = require('./app');
const mongoose = require('mongoose');

const { startPrepareDeliveryRunsJob } = require('./prepareDeliveryRunsJob');
const { startNotificationJob } = require('./sendNotificationCronJob');
const { startHourlyIngestionJob, runHourlyIngestion } = require('./ingestionJob');

const PORT = process.env.PORT || 3000;

function envFlag(name, defaultValue = false) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return String(value).toLowerCase() === 'true';
}

async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Mongo conectado');
  console.log('✅ Base actual:', mongoose.connection.name);
}

async function start() {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    });

    const enableIngestionJob = envFlag('ENABLE_INGESTION_JOB', false);
    const enablePrepareDigestJob = envFlag('ENABLE_PREPARE_DIGEST_JOB', true);
    const enableNotificationJob = envFlag('ENABLE_NOTIFICATION_JOB', true);
    const runIngestionOnBoot = envFlag('RUN_INGESTION_ON_BOOT', false);

    console.log('⚙️ Jobs habilitados:');
    console.log(`   ENABLE_INGESTION_JOB=${enableIngestionJob}`);
    console.log(`   ENABLE_PREPARE_DIGEST_JOB=${enablePrepareDigestJob}`);
    console.log(`   ENABLE_NOTIFICATION_JOB=${enableNotificationJob}`);
    console.log(`   RUN_INGESTION_ON_BOOT=${runIngestionOnBoot}`);

    if (enablePrepareDigestJob) {
      startPrepareDeliveryRunsJob();
      console.log('🕒 Job de preparación de digest programado');
    } else {
      console.log('⏸️ Job de preparación de digest deshabilitado');
    }

    if (enableNotificationJob) {
      startNotificationJob();
      console.log('🔔 Job de notificaciones programado cada minuto');
    } else {
      console.log('⏸️ Job de notificaciones deshabilitado');
    }

    if (enableIngestionJob) {
      startHourlyIngestionJob();
      console.log('📰 Job de ingesta programado cada hora');
    } else {
      console.log('⏸️ Job de ingesta deshabilitado');
    }

    if (runIngestionOnBoot) {
      console.log('⚡ Ejecutando ingesta inicial al arrancar...');
      runHourlyIngestion().catch((error) => {
        console.error('❌ Error en ingesta inicial:', error.message);
      });
    }
  } catch (error) {
    console.error('❌ Error al iniciar servidor:', error.message);
    process.exit(1);
  }
}

start();