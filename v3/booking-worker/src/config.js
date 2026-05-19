import 'dotenv/config';

const browserlessToken = process.env.BROWSERLESS_TOKEN || '';
const browserlessRegion = process.env.BROWSERLESS_REGION || 'sfo';
const browserlessStealth = process.env.BROWSERLESS_STEALTH !== 'false';
const browserlessRoute = process.env.BROWSERLESS_ROUTE || (browserlessStealth ? 'stealth' : 'chrome');
const browserlessProxy = process.env.BROWSERLESS_PROXY || '';
const browserlessProxyCountry = process.env.BROWSERLESS_PROXY_COUNTRY || '';
const browserlessProxyCity = process.env.BROWSERLESS_PROXY_CITY || '';
const browserlessProxySticky = process.env.BROWSERLESS_PROXY_STICKY || '';
const browserlessProxyPreset = process.env.BROWSERLESS_PROXY_PRESET || '';
const browserlessTimeoutMs = Number(process.env.BROWSERLESS_TIMEOUT_MS || 300000);
const explicitBrowserEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT || process.env.BROWSER_WS_ENDPOINT || '';

export const config = {
  port: Number(process.env.PORT || 8787),
  workerToken: process.env.BOOKING_WORKER_TOKEN || '',
  webtracUsername: process.env.WEBTRAC_USERNAME || '',
  webtracPassword: process.env.WEBTRAC_PASSWORD || '',
  dryRun: process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  slowMo: Number(process.env.SLOW_MO_MS || 0),
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH || '',
  browserWsEndpoint: explicitBrowserEndpoint || browserlessEndpoint(),
  browserConnectMode: (process.env.PLAYWRIGHT_CONNECT_MODE || 'cdp').toLowerCase(),
  browserConnectTimeoutMs: Number(process.env.PLAYWRIGHT_CONNECT_TIMEOUT_MS || 60000),
  browserRuntimeLabel: explicitBrowserEndpoint
    ? 'remote:custom'
    : browserlessToken
      ? `remote:browserless:${browserlessStealth ? 'stealth' : 'standard'}`
      : 'local',
  artifactDir: process.env.PLAYWRIGHT_ARTIFACT_DIR || new URL('../.playwright-artifacts', import.meta.url).pathname,
  reserveJobStoreDir: process.env.RESERVE_JOB_STORE_DIR || '/tmp/courtside-reserve-jobs',
  clearCartBeforeReserve: process.env.WEBTRAC_CLEAR_CART_BEFORE_RESERVE !== 'false',
  allowWebtracFinalPayment: process.env.ALLOW_WEBTRAC_FINAL_PAYMENT === 'true',
  recaptchaWaitMs: Number(process.env.WEBTRAC_RECAPTCHA_WAIT_MS || 120000),
  payment: {
    firstName: process.env.WEBTRAC_BILL_FIRST_NAME || '',
    lastName: process.env.WEBTRAC_BILL_LAST_NAME || '',
    phone: process.env.WEBTRAC_BILL_PHONE || '',
    email: process.env.WEBTRAC_BILL_EMAIL || '',
    cardName: process.env.WEBTRAC_CARD_NAME || '',
    address1: process.env.WEBTRAC_BILL_ADDRESS1 || '',
    postalCode: process.env.WEBTRAC_BILL_POSTAL_CODE || '',
    cardNumber: process.env.WEBTRAC_CARD_NUMBER || '',
    cardExp: process.env.WEBTRAC_CARD_EXP || '',
    cardCvc: process.env.WEBTRAC_CARD_CVC || '',
  },
};

function browserlessEndpoint() {
  if (!browserlessToken) return '';
  const route = normalizeBrowserlessRoute(browserlessRoute);
  const params = new URLSearchParams({ token: browserlessToken });
  if (Number.isFinite(browserlessTimeoutMs) && browserlessTimeoutMs > 0) {
    params.set('timeout', String(browserlessTimeoutMs));
  }
  addBrowserlessParam(params, 'proxy', browserlessProxy);
  addBrowserlessParam(params, 'proxyCountry', browserlessProxyCountry);
  addBrowserlessParam(params, 'proxyCity', browserlessProxyCity);
  addBrowserlessParam(params, 'proxySticky', browserlessProxySticky);
  addBrowserlessParam(params, 'proxyPreset', browserlessProxyPreset);
  return `wss://production-${browserlessRegion}.browserless.io/${route}?${params.toString()}`;
}

function normalizeBrowserlessRoute(route) {
  return String(route || 'stealth').replace(/^\/+/, '').replace(/\/+$/, '') || 'stealth';
}

function addBrowserlessParam(params, name, value) {
  if (!value) return;
  params.set(name, value);
}

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

export function paymentEnvStatus() {
  return [
    { name: 'WEBTRAC_BILL_FIRST_NAME', ok: Boolean(config.payment.firstName) },
    { name: 'WEBTRAC_BILL_LAST_NAME', ok: Boolean(config.payment.lastName) },
    { name: 'WEBTRAC_BILL_PHONE', ok: Boolean(config.payment.phone) },
    { name: 'WEBTRAC_BILL_EMAIL', ok: Boolean(config.payment.email) },
    { name: 'WEBTRAC_CARD_NAME', ok: Boolean(config.payment.cardName) },
    { name: 'WEBTRAC_BILL_ADDRESS1', ok: Boolean(config.payment.address1) },
    { name: 'WEBTRAC_BILL_POSTAL_CODE', ok: Boolean(config.payment.postalCode) },
    { name: 'WEBTRAC_CARD_NUMBER', ok: Boolean(config.payment.cardNumber) },
    { name: 'WEBTRAC_CARD_EXP', ok: Boolean(config.payment.cardExp) },
    { name: 'WEBTRAC_CARD_CVC', ok: Boolean(config.payment.cardCvc) },
  ];
}

export function assertPaymentConfig() {
  const missing = paymentEnvStatus().filter((item) => !item.ok).map((item) => item.name);
  if (missing.length) {
    const err = new Error(`Missing WebTrac payment env vars: ${missing.join(', ')}`);
    err.code = 'MISSING_PAYMENT_ENV';
    err.missing = missing;
    throw err;
  }
}
