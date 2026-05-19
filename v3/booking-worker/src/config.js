import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 8787),
  workerToken: process.env.BOOKING_WORKER_TOKEN || '',
  webtracUsername: process.env.WEBTRAC_USERNAME || '',
  webtracPassword: process.env.WEBTRAC_PASSWORD || '',
  dryRun: process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  slowMo: Number(process.env.SLOW_MO_MS || 0),
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH || '',
  artifactDir: process.env.PLAYWRIGHT_ARTIFACT_DIR || new URL('../.playwright-artifacts', import.meta.url).pathname,
};

export function assertRuntimeConfig() {
  const missing = requiredEnvStatus().filter((item) => !item.ok).map((item) => item.name);
  if (missing.length) {
    const err = new Error(`Missing required env vars: ${missing.join(', ')}`);
    err.code = 'MISSING_ENV';
    err.missing = missing;
    throw err;
  }
}

export function requiredEnvStatus() {
  return [
    { name: 'BOOKING_WORKER_TOKEN', ok: Boolean(config.workerToken) },
    { name: 'WEBTRAC_USERNAME', ok: Boolean(config.webtracUsername) },
    { name: 'WEBTRAC_PASSWORD', ok: Boolean(config.webtracPassword) },
  ];
}
