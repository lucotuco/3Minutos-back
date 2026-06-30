require('dotenv').config();

const mongoose = require('mongoose');
const app = require('./app');

const { startPrepareDeliveryRunsJob } = require('./prepareDeliveryRunsJob');
const { startNotificationJob } = require('./sendNotificationCronJob');
const { startHourlyIngestionJob, runHourlyIngestion } = require('./ingestionJob');
const { startCleanupAudiosJob } = require('./cleanupAudiosJob');

const PORT = Number(process.env.PORT || 3000);

function envFlag(name, defaultValue = false) {
  const value = process.env[name];

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return String(value).toLowerCase() === 'true';
}

function assertRequiredEnv() {
  const required = ['MONGODB_URI', 'JWT_SECRET'];

  for (const name of required) {
    if (!process.env[name]) {
      throw new Error(`Missing required env var: ${name}`);
    }
  }

  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must have at least 32 characters');
  }
}

async function connectDB() {
  assertRequiredEnv();

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
  });

  console.log('✅ Mongo conectado');
  console.log('✅ Base actual:', mongoose.connection.name);
}

async function start() {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`✅ Servidor escuchando en puerto ${PORT}`);
    });

    const enableIngestionJob = envFlag('ENABLE_INGESTION_JOB', false);
    const enablePrepareDigestJob = envFlag('ENABLE_PREPARE_DIGEST_JOB', false);
    const enableNotificationJob = envFlag('ENABLE_NOTIFICATION_JOB', false);
    const runIngestionOnBoot = envFlag('RUN_INGESTION_ON_BOOT', false);

    console.log('⚙️ Jobs habilitados:');
    console.log(` ENABLE_INGESTION_JOB=${enableIngestionJob}`);
    console.log(` ENABLE_PREPARE_DIGEST_JOB=${enablePrepareDigestJob}`);
    console.log(` ENABLE_NOTIFICATION_JOB=${enableNotificationJob}`);
    console.log(` RUN_INGESTION_ON_BOOT=${runIngestionOnBoot}`);

    if (enablePrepareDigestJob) {
      startPrepareDeliveryRunsJob();
      console.log('✅ Job de preparación de digest programado');
    } else {
      console.log('⏸️ Job de preparación de digest deshabilitado');
    }

    if (enableNotificationJob) {
      startNotificationJob();
      console.log('✅ Job de notificaciones programado');
    } else {
      console.log('⏸️ Job de notificaciones deshabilitado');
    }

    startCleanupAudiosJob();
    console.log('✅ Job de limpieza de audios programado (03:00 AM)');

    if (enableIngestionJob) {
      startHourlyIngestionJob();
      console.log('✅ Job de ingesta programado cada hora');
    } else {
      console.log('⏸️ Job de ingesta deshabilitado');
    }

    if (runIngestionOnBoot) {
      console.log('⚡ Ejecutando ingesta inicial al arrancar...');
      runHourlyIngestion().catch((error) => {
        console.error('❌ Error en ingesta inicial:', error);
      });
    }
  } catch (error) {
    console.error('❌ Error al iniciar servidor:', error);
    process.exit(1);
  }
}

start();