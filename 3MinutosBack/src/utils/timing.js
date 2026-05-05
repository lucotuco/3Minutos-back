function formatMs(ms) {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }

  return `${ms}ms`;
}

function safeMeta(meta = {}) {
  try {
    return JSON.stringify(meta);
  } catch {
    return '{}';
  }
}

function startTimer(label, meta = {}) {
  const startedAt = Date.now();

  console.log(`⏱️ START ${label} ${safeMeta(meta)}`);

  return {
    end(extraMeta = {}) {
      const elapsedMs = Date.now() - startedAt;

      console.log(
        `✅ END ${label} -> ${formatMs(elapsedMs)} ${safeMeta(extraMeta)}`
      );

      return elapsedMs;
    },

    fail(error, extraMeta = {}) {
      const elapsedMs = Date.now() - startedAt;

      console.error(
        `❌ FAIL ${label} -> ${formatMs(elapsedMs)} ${safeMeta({
          ...extraMeta,
          error: error?.message || String(error),
        })}`
      );

      return elapsedMs;
    },
  };
}

async function timeAsync(label, fn, meta = {}) {
  const timer = startTimer(label, meta);

  try {
    const result = await fn();
    timer.end();
    return result;
  } catch (error) {
    timer.fail(error);
    throw error;
  }
}

module.exports = {
  startTimer,
  timeAsync,
};