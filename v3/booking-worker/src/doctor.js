import fs from 'node:fs';
import { config, paymentEnvStatus, requiredEnvStatus } from './config.js';

const envUrl = new URL('../.env', import.meta.url);
const envText = fs.existsSync(envUrl) ? fs.readFileSync(envUrl, 'utf8') : '';
const envPitfalls = [
  dotenvValueCheck('WEBTRAC_USERNAME'),
  dotenvValueCheck('WEBTRAC_PASSWORD'),
].filter(Boolean);

const checks = [
  {
    label: '.env file',
    ok: fs.existsSync(envUrl),
    help: 'Run: cp .env.example .env',
  },
  ...requiredEnvStatus().map((item) => ({
    label: item.name,
    ok: item.ok,
    help: `Set ${item.name} in .env`,
  })),
  {
    label: 'Chrome executable',
    ok: !config.chromeExecutablePath || fs.existsSync(config.chromeExecutablePath),
    help: 'Set CHROME_EXECUTABLE_PATH to an installed Chrome path, or install Playwright Chromium.',
  },
  {
    label: 'Playwright artifact directory',
    ok: Boolean(config.artifactDir),
    help: 'Set PLAYWRIGHT_ARTIFACT_DIR to a writable folder.',
  },
  {
    label: 'Visible browser mode',
    ok: !config.headless,
    help: 'Set HEADLESS=false. WebTrac may block headless browser sessions.',
  },
  ...envPitfalls,
];

const missing = checks.filter((check) => !check.ok);
const paymentMissing = paymentEnvStatus().filter((check) => !check.ok);

console.log('Courtside booking worker doctor');
console.log('');
for (const check of checks) {
  console.log(`${check.ok ? 'OK ' : 'FIX'} ${check.label}`);
  if (!check.ok) console.log(`    ${check.help}`);
}

console.log('');
console.log(`DRY_RUN=${config.dryRun}`);
console.log(`HEADLESS=${config.headless}`);
console.log(`PORT=${config.port}`);
console.log(`WEBTRAC_CLEAR_CART_BEFORE_RESERVE=${config.clearCartBeforeReserve}`);
console.log(`ALLOW_WEBTRAC_FINAL_PAYMENT=${config.allowWebtracFinalPayment}`);

if (paymentMissing.length) {
  console.log('');
  console.log(`Payment profile incomplete (${paymentMissing.map((item) => item.name).join(', ')}).`);
  console.log('Reserve/cart tests can still run; final WebTrac payment cannot run until those are set.');
}

if (missing.length) {
  console.log('');
  console.log('Fix the items above, then run: npm run start');
  process.exitCode = 1;
} else {
  console.log('');
  console.log('Ready. Run: npm run start');
}

function dotenvValueCheck(name) {
  const line = envText.split(/\r?\n/).find((row) => row.trim().startsWith(`${name}=`));
  if (!line) return null;
  const value = line.slice(line.indexOf('=') + 1).trim();
  const quoted = /^['"].*['"]$/.test(value);
  if (value.includes('#') && !quoted) {
    return {
      label: `${name} quoting`,
      ok: false,
      help: `Wrap ${name} in double quotes because # starts a comment in .env files.`,
    };
  }
  return {
    label: `${name} quoting`,
    ok: true,
    help: '',
  };
}
