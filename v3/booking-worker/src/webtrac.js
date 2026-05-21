import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { assertPaymentConfig, config } from './config.js';

const WEBTRAC_ORIGIN = 'https://vaarlingtonweb.myvscloud.com';
const SEARCH_PATH = '/webtrac/web/search.html';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BROWSER_VIEWPORT = { width: 1280, height: 900 };
const LOGIN_CANDIDATES = [
  '/webtrac/web/login.html',
  '/webtrac/web/householdlogin.html',
  '/webtrac/web/splash.html?ccode=login',
];

export async function reserveWithWebtrac(payload) {
  const { browser, context, page } = await createBrowserSession();

  try {
    await login(page);
    const cartReset = !config.dryRun && config.clearCartBeforeReserve
      ? await clearWebtracCart(page)
      : { skipped: true, reason: config.dryRun ? 'dry_run' : 'disabled' };
    if (cartReset.blocked) {
      return {
        status: 'cart_reset_failed',
        code: 'WEBTRAC_STALE_CART_NOT_CLEARED',
        message: 'WebTrac already had a cart item and the worker could not clear it. Empty the WebTrac cart before trying this court again.',
        dryRun: false,
        cartReset,
      };
    }

    const searchUrl = normalizeSearchUrl(payload.webtracSearchUrl, payload);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const pageState = await inspectSearchPage(page, payload);
    const pageSelectionUrls = await extractSelectionUrlsFromPage(page, payload);
    let selectionUrls = pageSelectionUrls;
    let selectionSource = 'webtrac_page';
    if (!selectionUrls.length) {
      selectionUrls = normalizeSelectionUrls(payload);
      selectionSource = selectionUrls.length ? 'payload' : 'none';
    }

    if (!selectionUrls.length) {
      return {
        status: 'needs_live_selection_urls',
        code: 'MISSING_UPDATE_SELECTION_URLS',
        message: 'The slot is visible, but WebTrac did not expose selectable booking links for the requested time.',
        dryRun: config.dryRun,
        pageState,
      };
    }

    if (config.dryRun) {
      return {
        status: 'dry_run_ready',
        code: 'DRY_RUN_READY',
        message: 'Logged in, reached WebTrac search, and found selection URLs. No WebTrac slot was selected because DRY_RUN=true.',
        dryRun: true,
        requestedBlocks: selectionUrls.length,
        selectionSource,
        pageState,
      };
    }

    const addResults = [];
    for (const selectionUrl of selectionUrls) {
      addResults.push(await callUpdateSelection(page, selectionUrl));
    }
    const selectionReady = addResults.every(r => r.ok);
    return {
      status: selectionReady ? 'slot_selected' : 'slot_selection_uncertain',
      code: selectionReady ? 'WEBTRAC_SLOT_SELECTED' : 'WEBTRAC_SLOT_SELECTION_UNCERTAIN',
      message: selectionReady
        ? 'Selected the requested WebTrac time block(s). Continue in WebTrac to add the selection to cart.'
        : 'WebTrac did not clearly confirm every selected block. Continue in WebTrac and verify the selected time before adding to cart.',
      dryRun: false,
      cartReset,
      requestedBlocks: selectionUrls.length,
      selectionSource,
      pageState,
      selectionResults: addResults,
      webtracSearchUrl: searchUrl,
    };

  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await resetArtifactDir().catch(() => {});
  }
}

export async function scrapeAvailabilityWithWebtrac(payload) {
  const { browser, context, page } = await createBrowserSession();

  try {
    const searchUrl = buildSearchUrl({
      courtCode: payload.courtCode,
      sportType: payload.sportType || 'TENNIS',
      dateWebtrac: payload.dateWebtrac,
      headcount: payload.headcount || 2,
    });
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (isCloudflareBlocked(bodyText, title)) {
      throw codedError(
        'WEBTRAC_ACCESS_BLOCKED',
        'WebTrac blocked the availability worker before the court results loaded.'
      );
    }

    const html = await page.content();
    const availability = parseAvailabilityHtml(html);
    return {
      status: 'availability_ready',
      code: 'WEBTRAC_AVAILABILITY_READY',
      ...availability,
      fetchedAt: Date.now(),
      webtracSearchUrl: searchUrl,
      page: {
        title,
        url: page.url(),
      },
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await resetArtifactDir().catch(() => {});
  }
}

export async function inspectCheckoutFlow(options = {}) {
  const { browser, context, page } = await createBrowserSession();

  try {
    await login(page);
    await page.goto(WEBTRAC_ORIGIN + '/webtrac/web/cart.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const steps = [];
    const maxSteps = Math.min(Math.max(Number(options.maxSteps || 6), 1), 10);

    for (let step = 1; step <= maxSteps; step += 1) {
      const snapshot = await inspectCheckoutStep(page, step);
      steps.push(snapshot);

      if (snapshot.stopReason) {
        if (snapshot.stopReason === 'payment_page') {
          snapshot.paymentMethodProbe = await inspectPaymentMethodSelector(page);
          snapshot.paymentEntryProbe = await inspectCreditCardEntryStep(page);
        }
        return {
          status: 'checkout_inspected',
          code: 'CHECKOUT_INSPECTION_STOPPED',
          message: checkoutStopMessage(snapshot.stopReason),
          stopReason: snapshot.stopReason,
          steps,
        };
      }

      const clickResult = await clickCheckoutInspectionNext(page);
      snapshot.nextAction = clickResult;
      if (!clickResult.clicked) {
        return {
          status: 'checkout_inspected',
          code: 'CHECKOUT_INSPECTION_NO_SAFE_NEXT_STEP',
          message: 'Checkout inspection stopped because no safe non-payment next step was found.',
          stopReason: 'no_safe_next_step',
          steps,
        };
      }
    }

    return {
      status: 'checkout_inspected',
      code: 'CHECKOUT_INSPECTION_STEP_LIMIT',
      message: 'Checkout inspection reached the configured step limit before payment or final confirmation.',
      stopReason: 'step_limit',
      steps,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await resetArtifactDir().catch(() => {});
  }
}

export async function finalizeWebtracCheckout(options = {}) {
  const { browser, context, page } = await createBrowserSession();

  try {
    await login(page);
    await page.goto(WEBTRAC_ORIGIN + '/webtrac/web/cart.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const expectedBooking = options.booking && typeof options.booking === 'object' ? options.booking : null;
    const cart = await inspectCartPage(page, expectedBooking);
    if (!cart.confirmed) {
      return {
        status: 'webtrac_finalize_failed',
        code: 'WEBTRAC_CART_EMPTY',
        message: 'WebTrac cart is empty, so final checkout cannot continue.',
        cart,
      };
    }
    if (expectedBooking && !cart.expectedMatch?.ok) {
      return {
        status: 'webtrac_finalize_failed',
        code: 'WEBTRAC_CART_MISMATCH',
        message: 'WebTrac cart does not match the requested court/time, so final checkout was stopped before payment.',
        cart,
      };
    }

    const checkoutClick = await clickCheckoutInspectionNext(page);
    if (!checkoutClick.clicked) {
      return {
        status: 'webtrac_finalize_failed',
        code: 'WEBTRAC_CHECKOUT_BUTTON_NOT_FOUND',
        message: 'Could not find the WebTrac Proceed To Checkout button.',
        cart,
        checkoutClick,
      };
    }

    const checkoutState = await inspectCheckoutPaymentState(page);
    let selected = { selected: false, skipped: true, reason: 'payment_method_not_needed' };
    let entryContinue = { clicked: false, skipped: true, reason: 'payment_method_not_needed', url: page.url() };
    let paymentPage = page;
    let fillResult = { skipped: true, reason: 'no_card_entry_detected' };
    let paymentEntry = await inspectPaymentEntryPage(paymentPage);

    const shouldPreparePaymentEntry = config.allowWebtracFinalPayment
      || (options.stopBeforeSubmit === true && options.verifyPaymentFields === true);

    if (checkoutState.needsPaymentMethod && !shouldPreparePaymentEntry) {
      selected = { selected: false, skipped: true, reason: 'final_payment_guard_disabled' };
      entryContinue = { clicked: false, skipped: true, reason: 'final_payment_guard_disabled', url: page.url() };
    } else if (checkoutState.needsPaymentMethod) {
      assertPaymentConfig();
      selected = await selectPaymentMethodOption(page, /Credit Card - Web/i);
      if (!selected.selected) {
        return {
          status: 'webtrac_finalize_failed',
          code: 'WEBTRAC_CREDIT_CARD_METHOD_NOT_FOUND',
          message: 'Could not select WebTrac Credit Card - Web payment method.',
          cart,
          checkoutClick: withoutPageHandle(checkoutClick),
          checkoutState,
          selected,
        };
      }

      entryContinue = await clickCheckoutContinueButton(page);
      if (!entryContinue.clicked) {
        return {
          status: 'webtrac_finalize_failed',
          code: 'WEBTRAC_PAYMENT_ENTRY_NOT_REACHED',
          message: 'Could not continue from WebTrac payment-method selection to card entry.',
          cart,
          checkoutClick: withoutPageHandle(checkoutClick),
          checkoutState,
          selected,
          entryContinue,
        };
      }

      paymentPage = entryContinue.page || page;
      paymentEntry = await inspectPaymentEntryPage(paymentPage);
    }

    if (!shouldPreparePaymentEntry && (paymentEntry.markers.hasCardField || paymentEntry.markers.hasExpirationField || paymentEntry.markers.hasSecurityCodeField)) {
      fillResult = { skipped: true, reason: 'final_payment_guard_disabled' };
    } else if (paymentEntry.markers.hasCardField || paymentEntry.markers.hasExpirationField || paymentEntry.markers.hasSecurityCodeField) {
      assertPaymentConfig();
      fillResult = await fillWebtracPaymentProfile(paymentPage);
      paymentEntry = await inspectPaymentEntryPage(paymentPage);
    }

    if (!config.allowWebtracFinalPayment || options.stopBeforeSubmit) {
      return {
        status: 'webtrac_payment_ready',
        code: 'WEBTRAC_PAYMENT_READY_NOT_SUBMITTED',
        message: 'WebTrac checkout is ready, but final payment is disabled by the safety guard.',
        requiresFinalPaymentGuard: true,
        allowWebtracFinalPayment: config.allowWebtracFinalPayment,
        cart,
        checkoutClick: withoutPageHandle(checkoutClick),
        checkoutState,
        selected,
        entryContinue: withoutPageHandle(entryContinue),
        fillResult,
        paymentEntry,
      };
    }

    const recaptcha = await waitForRecaptchaIfPresent(paymentPage);
    if (recaptcha.present && !recaptcha.solved) {
      return {
        status: 'webtrac_finalize_failed',
        code: 'WEBTRAC_RECAPTCHA_REQUIRED',
        message: 'WebTrac showed reCAPTCHA. Solve it in the visible browser before the worker timeout, then retry.',
        cart,
        checkoutClick: withoutPageHandle(checkoutClick),
        checkoutState,
        selected,
        entryContinue: withoutPageHandle(entryContinue),
        fillResult,
        recaptcha,
        paymentEntry,
      };
    }

    const finalSubmit = await clickFinalWebtracContinue(paymentPage);
    await paymentPage.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    const confirmation = await inspectFinalWebtracConfirmation(paymentPage);

    return {
      status: confirmation.confirmed ? 'webtrac_confirmed' : 'webtrac_finalize_uncertain',
      code: confirmation.confirmed ? 'WEBTRAC_BOOKING_CONFIRMED' : 'WEBTRAC_FINALIZE_UNCERTAIN',
      message: confirmation.confirmed
        ? 'WebTrac appears to have confirmed the court booking.'
        : 'WebTrac payment was submitted, but the worker could not confirm the final booking.',
      cart,
      checkoutClick: withoutPageHandle(checkoutClick),
      checkoutState,
      selected,
      entryContinue: withoutPageHandle(entryContinue),
      fillResult,
      recaptcha,
      finalSubmit,
      confirmation,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await resetArtifactDir().catch(() => {});
  }
}

async function resetArtifactDir() {
  await fs.rm(config.artifactDir, { recursive: true, force: true });
  await fs.mkdir(config.artifactDir, { recursive: true });
}

async function createBrowserSession() {
  await resetArtifactDir();
  const browser = await createBrowser();
  const context = await createBrowserContext(browser);

  await context.addInitScript(() => {
    const defineGetter = (target, property, getter) => {
      try {
        Object.defineProperty(target, property, { get: getter, configurable: true });
      } catch (e) {}
    };

    defineGetter(navigator, 'webdriver', () => undefined);
    defineGetter(navigator, 'languages', () => ['en-US', 'en']);
    defineGetter(navigator, 'plugins', () => [1, 2, 3, 4, 5]);

    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};

    const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters?.name === 'notifications'
          ? Promise.resolve({ state: window.Notification?.permission || 'default' })
          : originalQuery(parameters)
      );
    }
  });

  const page = await context.newPage();
  return { browser, context, page };
}

async function createBrowser() {
  if (config.browserWsEndpoint) {
    const connectOptions = {
      slowMo: config.slowMo,
      timeout: config.browserConnectTimeoutMs,
    };
    const attempts = Math.max(1, Math.min(Number(config.browserConnectAttempts) || 1, 5));
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (config.browserConnectMode === 'playwright') {
          return await chromium.connect(config.browserWsEndpoint, connectOptions);
        }
        return await chromium.connectOverCDP(config.browserWsEndpoint, connectOptions);
      } catch (error) {
        lastError = error;
        console.warn('[browser:remote_connect_failed]', {
          attempt,
          attempts,
          mode: config.browserConnectMode,
          message: error.message || String(error),
        });
        if (attempt < attempts) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    throw lastError;
  }

  return chromium.launch({
    headless: config.headless,
    slowMo: config.slowMo,
    executablePath: config.chromeExecutablePath || undefined,
    artifactsPath: config.artifactDir,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-sandbox',
      `--window-size=${BROWSER_VIEWPORT.width},${BROWSER_VIEWPORT.height}`,
    ],
  });
}

async function createBrowserContext(browser) {
  const contextOptions = {
    viewport: BROWSER_VIEWPORT,
    screen: BROWSER_VIEWPORT,
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: BROWSER_USER_AGENT,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };
  const storageState = await readWebtracStorageState();
  if (storageState) contextOptions.storageState = storageState;

  try {
    return await browser.newContext(contextOptions);
  } catch (error) {
    if (!config.browserWsEndpoint) throw error;
    const context = browser.contexts()[0];
    if (context) return context;
    throw error;
  }
}

async function login(page) {
  let lastUrl = null;
  const attempts = [];
  for (const path of LOGIN_CANDIDATES) {
    lastUrl = WEBTRAC_ORIGIN + path;
    await page.goto(lastUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const title = await page.title().catch(() => '');
    const loginAttempt = {
      requestedUrl: lastUrl,
      landedUrl: page.url(),
      title,
      authState: authStateFromText(bodyText),
      cloudflareBlocked: isCloudflareBlocked(bodyText, title),
      snippet: bodyText.replace(/\s+/g, ' ').slice(0, 360),
    };
    attempts.push(loginAttempt);

    if (loginAttempt.cloudflareBlocked && await waitForCloudflareClearance(page)) {
      const clearedBodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      const clearedTitle = await page.title().catch(() => '');
      Object.assign(loginAttempt, {
        landedUrl: page.url(),
        title: clearedTitle,
        authState: authStateFromText(clearedBodyText),
        cloudflareBlocked: isCloudflareBlocked(clearedBodyText, clearedTitle),
        snippet: clearedBodyText.replace(/\s+/g, ' ').slice(0, 360),
        clearanceWaited: true,
      });
    }

    if (loginAttempt.authState === 'signed_in') {
      await persistWebtracStorageState(page.context());
      return;
    }
    if (loginAttempt.cloudflareBlocked) {
      throw codedError(
        'WEBTRAC_ACCESS_BLOCKED',
        'WebTrac/Cloudflare blocked this worker environment before the login form loaded.',
        { loginAttempts: attempts }
      );
    }

    const password = firstVisible(page, [
      '#weblogin_password',
      'input[name="weblogin_password"]',
      'input[name="password"]',
      'input[name="Password"]',
      'input[id*="pass" i]',
      'input[type="password"]',
    ]);
    const username = await findUsernameForPassword(page, password);

    if (await username.count() && await password.count()) {
      loginAttempt.formFill = await fillLoginFields(username.first(), password.first());
      await clickLogin(page);
      await waitForLoginSettle(page);
      await handleActiveSessionPrompt(page);
      await waitForLoginSettle(page);
      await assertLoggedIn(page, attempts);
      await persistWebtracStorageState(page.context());
      return;
    }
  }

  throw codedError(
    'LOGIN_FORM_NOT_FOUND',
    `Could not find a WebTrac login form. Last attempted: ${lastUrl}`,
    { loginAttempts: attempts }
  );
}

async function readWebtracStorageState() {
  if (!config.webtracStorageStatePath) return null;
  try {
    const raw = await fs.readFile(config.webtracStorageStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.cookies)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function persistWebtracStorageState(context) {
  if (!config.webtracStorageStatePath) return;
  try {
    await fs.mkdir(new URL('.', `file://${config.webtracStorageStatePath}`).pathname, { recursive: true });
    await context.storageState({ path: config.webtracStorageStatePath });
  } catch (e) {
    console.warn('[webtrac:storage_state_failed]', { message: e.message || String(e) });
  }
}

async function waitForCloudflareClearance(page) {
  const started = Date.now();
  while (Date.now() - started < 45000) {
    await page.waitForTimeout(2500);
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const title = await page.title().catch(() => '');
    if (!isCloudflareBlocked(bodyText, title)) return true;
  }
  return false;
}

function firstVisible(page, selectors) {
  return page.locator(selectors.join(', ')).filter({ visible: true });
}

async function findUsernameForPassword(page, passwordLocator) {
  if (!await passwordLocator.count()) return page.locator('__missing_login_username__');
  const password = passwordLocator.first();
  const usernameSelectors = [
    '#weblogin_username',
    'input[name="weblogin_username"]',
    'input[name="username"]',
    'input[name="Username"]',
    'input[name="user"]',
    'input[name="login"]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[type="email"]',
    'input[type="text"]',
  ].join(', ');

  const sameForm = page.locator('form').filter({ has: password }).first();
  if (await sameForm.count()) {
    const inForm = sameForm.locator(usernameSelectors).filter({ visible: true });
    if (await inForm.count()) return inForm;
  }

  const sameLoginBlock = page.locator('section, main, div, article').filter({ has: password }).locator(usernameSelectors).filter({ visible: true });
  if (await sameLoginBlock.count()) return sameLoginBlock;

  return firstVisible(page, usernameSelectors.split(', '));
}

async function fillLoginFields(username, password) {
  await username.click({ timeout: 5000 }).catch(() => {});
  await username.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await username.fill(config.webtracUsername);
  await password.click({ timeout: 5000 }).catch(() => {});
  await password.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await password.fill(config.webtracPassword);

  const [usernameField, passwordField] = await Promise.all([
    inputFillDiagnostic(username, config.webtracUsername.length),
    inputFillDiagnostic(password, config.webtracPassword.length),
  ]);

  return { usernameField, passwordField };
}

async function inputFillDiagnostic(locator, expectedLength) {
  return locator.evaluate((input, expected) => ({
    type: input.getAttribute('type') || '',
    name: input.getAttribute('name') || '',
    id: input.getAttribute('id') || '',
    autocomplete: input.getAttribute('autocomplete') || '',
    placeholder: input.getAttribute('placeholder') || '',
    expectedLength: expected,
    actualLength: input.value ? input.value.length : 0,
    filled: Boolean(input.value) && input.value.length === expected,
  }), expectedLength).catch((error) => ({
    expectedLength,
    actualLength: null,
    filled: false,
    error: error.message,
  }));
}

async function clickLogin(page) {
  const candidates = [
    page.getByRole('button', { name: 'Log In' }),
    page.getByRole('button', { name: 'Login' }),
    page.getByRole('button', { name: 'Sign In' }),
    page.getByRole('link', { name: 'Log In' }),
    page.locator('input[type="submit"]'),
    page.locator('button[type="submit"]'),
  ];
  for (const locator of candidates) {
    if (await locator.count()) {
      await clickAndWaitForPageChange(page, locator.first());
      return;
    }
  }
  throw codedError('LOGIN_BUTTON_NOT_FOUND', 'Could not find a WebTrac login submit control.');
}

async function clickAndWaitForPageChange(page, locator) {
  const beforeUrl = page.url();
  await Promise.all([
    Promise.race([
      page.waitForURL((url) => String(url) !== beforeUrl, { timeout: 20000 }),
      page.locator('input[type="password"]').first().waitFor({ state: 'hidden', timeout: 20000 }),
      page.getByText(/active session already exists|continue with login|logout|log out|invalid|incorrect/i).first().waitFor({ timeout: 20000 }),
    ]).catch(() => {}),
    locator.click(),
  ]);
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

async function waitForLoginSettle(page) {
  for (let i = 0; i < 6; i += 1) {
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (/active session already exists|continue with login|logout|log out|invalid|incorrect/i.test(bodyText)) return;
    const passwordVisible = await page.locator('input[type="password"]').filter({ visible: true }).count().catch(() => 0);
    if (!passwordVisible && !/sign in\s*\/\s*register/i.test(bodyText)) return;
    await page.waitForTimeout(1000);
  }
}

async function assertLoggedIn(page, loginAttempts = []) {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const diagnostics = await loginPageDiagnostics(page, bodyText);
  diagnostics.loginAttempts = loginAttempts;
  if (diagnostics.cloudflareBlocked) {
    throw codedError(
      'WEBTRAC_ACCESS_BLOCKED',
      'WebTrac/Cloudflare blocked this worker environment after the login form was submitted.',
      diagnostics
    );
  }
  if (/invalid|incorrect|failed|try again/i.test(bodyText) && /password|login|username/i.test(bodyText)) {
    throw codedError('LOGIN_FAILED', 'WebTrac rejected the supplied username or password.', diagnostics);
  }
  if (/active session already exists|continue with login/i.test(bodyText)) {
    throw codedError('ACTIVE_SESSION_NOT_RESOLVED', 'WebTrac asked to resume an active session, but the worker could not complete that prompt.', diagnostics);
  }
  const authState = authStateFromText(bodyText);
  if (authState === 'signed_out') {
    throw codedError('LOGIN_NOT_CONFIRMED', 'WebTrac still appears signed out after submitting the login form.', diagnostics);
  }
}

async function loginPageDiagnostics(page, bodyText = '') {
  const text = bodyText || await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const title = await page.title().catch(() => '');
  const visibleInputs = await page.locator('input:visible').evaluateAll((inputs) => inputs.slice(0, 12).map((input) => ({
    type: input.getAttribute('type') || '',
    name: input.getAttribute('name') || '',
    id: input.getAttribute('id') || '',
    placeholder: input.getAttribute('placeholder') || '',
    autocomplete: input.getAttribute('autocomplete') || '',
  }))).catch(() => []);
  const visibleButtons = await page.locator('button:visible, input[type="submit"]:visible, a:visible').evaluateAll((items) => items.slice(0, 20).map((item) => ({
    tag: item.tagName.toLowerCase(),
    type: item.getAttribute('type') || '',
    name: item.getAttribute('name') || '',
    id: item.getAttribute('id') || '',
    text: (item.innerText || item.value || item.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  }))).catch(() => []);
  return {
    landedUrl: page.url(),
    title,
    authState: authStateFromText(text),
    cloudflareBlocked: isCloudflareBlocked(text, title),
    snippet: text.replace(/\s+/g, ' ').slice(0, 600),
    visibleInputs,
    visibleButtons,
  };
}

async function handleActiveSessionPrompt(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (!/active session already exists|continue with login/i.test(bodyText)) return false;

  const candidates = [
    page.locator('#loginresumesession_buttoncontinue'),
    page.getByRole('button', { name: /continue with login/i }),
  ];
  for (const locator of candidates) {
    if (await locator.count()) {
      await clickAndWaitForPageChange(page, locator.first());
      return true;
    }
  }

  throw codedError('ACTIVE_SESSION_CONTINUE_NOT_FOUND', 'WebTrac reported an active session, but the Continue with Login button was not found.');
}

async function inspectSearchPage(page, payload) {
  const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const selectedRange = payload.rangeLabel || `${payload.start} for ${payload.duration} minutes`;
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    hasCartText: /cart|checkout|shopping/i.test(bodyText),
    hasUnavailableText: /unavailable/i.test(bodyText),
    authState: authStateFromText(bodyText),
    selectedRange,
    bodySnippet: bodyText.replace(/\s+/g, ' ').slice(0, 600),
  };
}

async function inspectCartPage(page, expectedBooking = null) {
  const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const compact = bodyText.replace(/\s+/g, ' ').trim();
  const cartCount = compact.match(/CART \((\d+) ITEMS?\)/i);
  const grandTotal = compact.match(/Grand Total Fees Due\s+\$\s*([0-9.,]+)/i);
  const amountToday = compact.match(/Amount To Be Paid Today:\s+\$\s*([0-9.,]+)/i);
  const itemCount = cartCount ? Number(cartCount[1]) : 0;
  const isCartPage = /cart\.html|shopping\s+cart|cart\s*\(/i.test(`${page.url()} ${compact}`);
  const hasCartLineItem = /\bRemove\b.{0,500}\$\s*[0-9,.]+/i.test(compact)
    || /Facility\s+Reservation.{0,500}\$\s*[0-9,.]+/i.test(compact);
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    itemCount,
    confirmed: itemCount > 0 || (isCartPage && hasCartLineItem),
    grandTotal: grandTotal ? `$${grandTotal[1]}` : null,
    amountToday: amountToday ? `$${amountToday[1]}` : null,
    hasProceedToCheckout: /Proceed To Checkout/i.test(compact),
    hasPaymentPrompt: /Select A Payment Method|Payment Method|Amount To Be Paid Today/i.test(compact),
    expectedMatch: expectedBooking ? expectedCartMatch(compact, expectedBooking) : null,
    bodySnippet: compact.slice(0, 900),
  };
}

async function clearWebtracCart(page) {
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(WEBTRAC_ORIGIN + '/webtrac/web/cart.html', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const before = await inspectCartPage(page);
    if (!before.confirmed) {
      return {
        attempted: attempts.length > 0,
        cleared: true,
        before: summarizeCartForOutput(before),
        attempts,
      };
    }

    const clickResult = await clickEmptyCartControl(page);
    attempts.push({
      attempt,
      before: summarizeCartForOutput(before),
      clickResult,
    });
    if (!clickResult.clicked) {
      return {
        attempted: true,
        cleared: false,
        blocked: true,
        reason: 'empty_cart_control_not_found',
        before: summarizeCartForOutput(before),
        attempts,
      };
    }
  }

  await page.goto(WEBTRAC_ORIGIN + '/webtrac/web/cart.html', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const after = await inspectCartPage(page);
  return {
    attempted: true,
    cleared: !after.confirmed,
    blocked: after.confirmed,
    reason: after.confirmed ? 'cart_still_has_items' : null,
    after: summarizeCartForOutput(after),
    attempts,
  };
}

async function clickEmptyCartControl(page) {
  const selectors = [
    '#webcart_buttonemptycart',
    '[id*="emptycart" i]',
    '[name*="emptycart" i]',
    'button',
    'a',
    'input[type="submit"]',
    'input[type="button"]',
  ];

  for (const selector of selectors) {
    const locators = await page.locator(selector).filter({ visible: true }).all().catch(() => []);
    for (const locator of locators) {
      const label = await controlLabel(locator);
      if (!/empty\s+cart|clear\s+cart|remove\s+all/i.test(label)) continue;

      const dialogPromise = page.waitForEvent('dialog', { timeout: 1000 })
        .then(async (dialog) => {
          await dialog.accept();
          return true;
        })
        .catch(() => false);
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        locator.click(),
      ]);
      const dialogAccepted = await dialogPromise;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
      return {
        clicked: true,
        selector,
        label: label.replace(/\s+/g, ' ').trim(),
        dialogAccepted,
        url: page.url(),
      };
    }
  }

  return { clicked: false, reason: 'empty_cart_control_not_found', url: page.url() };
}

function summarizeCartForOutput(cart) {
  if (!cart) return null;
  return {
    url: cart.url,
    title: cart.title,
    itemCount: cart.itemCount,
    confirmed: cart.confirmed,
    grandTotal: cart.grandTotal,
    amountToday: cart.amountToday,
    hasProceedToCheckout: cart.hasProceedToCheckout,
    hasPaymentPrompt: cart.hasPaymentPrompt,
    expectedMatch: cart.expectedMatch || null,
  };
}

function expectedCartMatch(cartText, booking) {
  const text = normalizeMatchText(cartText);
  const expected = expectedCartTerms(booking);
  const court = expected.courts.some((value) => text.includes(normalizeMatchText(value)));
  const unit = !expected.units.length || expected.units.some((value) => text.includes(normalizeMatchText(value)));
  const date = expected.dates.some((value) => text.includes(normalizeMatchText(value)));
  const start = expected.starts.some((value) => text.includes(normalizeMatchText(value)));
  const end = expected.ends.some((value) => text.includes(normalizeMatchText(value)));
  return {
    ok: court && unit && date && start && end,
    court,
    unit,
    date,
    start,
    end,
    expected: {
      courtName: booking.courtName || null,
      courtCode: booking.courtCode || null,
      courtUnitName: booking.courtUnitName || null,
      courtUnitDisplayName: booking.courtUnitDisplayName || null,
      webtracFacilityId: booking.webtracFacilityId || null,
      date: booking.date || null,
      start: booking.start || null,
      end: booking.end || null,
    },
  };
}

function expectedCartTerms(booking) {
  return {
    courts: uniqueTerms([
      booking.courtName,
      booking.courtCode,
      booking.courtId,
      String(booking.courtName || '').replace(/\s+(park|center|ms)$/i, ''),
    ]),
    units: courtUnitTerms(booking),
    dates: dateTerms(booking.date, booking.dateWebtrac),
    starts: timeTerms(booking.start),
    ends: timeTerms(booking.end),
  };
}

function courtUnitTerms(booking) {
  const rawTerms = uniqueTerms([
    booking.courtUnitName,
    booking.courtUnitDisplayName,
    booking.courtUnitId,
    booking.webtracFacilityId,
  ]);
  const terms = [...rawTerms];
  for (const value of rawTerms) {
    const text = String(value);
    const match = text.match(/\b(?:court|ct)\s*#?\s*([0-9]+[A-Z]?)\b/i)
      || text.match(/#\s*([0-9]+[A-Z]?)\b/i)
      || text.match(/\b([0-9]+[A-Z]?)\b$/i);
    if (match) {
      terms.push(`Court ${match[1]}`);
      terms.push(`Court #${match[1]}`);
      terms.push(`#${match[1]}`);
    }
  }
  return uniqueTerms(terms);
}

function dateTerms(isoDate, webtracDate) {
  const terms = [];
  if (webtracDate) terms.push(webtracDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) {
    const [year, month, day] = String(isoDate).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    terms.push(`${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`);
    terms.push(`${month}/${day}/${year}`);
    terms.push(date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
    terms.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
    terms.push(date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }));
    terms.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }));
  }
  return uniqueTerms(terms);
}

function timeTerms(hhmm) {
  const match = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return [];
  const hour = Number(match[1]);
  const minute = match[2];
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const paddedHour12 = String(hour12).padStart(2, '0');
  return uniqueTerms([
    `${hour12}:${minute} ${ampm}`,
    `${paddedHour12}:${minute} ${ampm}`,
    `${hour12}:${minute}${ampm.toLowerCase()}`,
    `${paddedHour12}:${minute}${ampm.toLowerCase()}`,
    `${hour12}:${minute} ${ampm.toLowerCase()}`,
    `${paddedHour12}:${minute} ${ampm.toLowerCase()}`,
    `${hour12}:${minute} ${ampm[0]}.M.`,
    `${paddedHour12}:${minute} ${ampm[0]}.M.`,
  ]);
}

function uniqueTerms(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function normalizeMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

async function confirmCartState(page, searchUrl, expectedBooking = null) {
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      await page.waitForTimeout(900 * attempt);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    await page.goto(WEBTRAC_ORIGIN + '/webtrac/web/cart.html', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const cartState = await inspectCartPage(page, expectedBooking);
    attempts.push({
      attempt,
      url: cartState.url,
      title: cartState.title,
      itemCount: cartState.itemCount,
      confirmed: cartState.confirmed,
      grandTotal: cartState.grandTotal,
      amountToday: cartState.amountToday,
      expectedMatch: cartState.expectedMatch,
      snippet: cartState.bodySnippet,
    });
    if (cartState.confirmed) return { ...cartState, attempts };
  }
  const last = attempts[attempts.length - 1] || {};
  return {
    url: last.url || page.url(),
    title: last.title || await page.title().catch(() => ''),
    itemCount: last.itemCount || 0,
    confirmed: false,
    grandTotal: last.grandTotal || null,
    amountToday: last.amountToday || null,
    hasProceedToCheckout: false,
    hasPaymentPrompt: false,
    bodySnippet: last.snippet || '',
    attempts,
  };
}

async function inspectCheckoutStep(page, step) {
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const compact = bodyText.replace(/\s+/g, ' ').trim();
  const controls = await relevantCheckoutControls(page);
  const cartState = await inspectCartPage(page).catch(() => null);
  const markers = checkoutMarkers(compact, controls, page.url());

  return {
    step,
    url: page.url(),
    title: await page.title().catch(() => ''),
    markers,
    cart: cartState && {
      confirmed: cartState.confirmed,
      itemCount: cartState.itemCount,
      grandTotal: cartState.grandTotal,
      amountToday: cartState.amountToday,
      hasProceedToCheckout: cartState.hasProceedToCheckout,
      hasPaymentPrompt: cartState.hasPaymentPrompt,
    },
    controls,
    stopReason: checkoutStopReason(markers),
  };
}

async function relevantCheckoutControls(page) {
  return page.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function labelFor(el) {
      return [
        el.innerText,
        el.value,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('name'),
        el.getAttribute('id'),
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }

    return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        label: labelFor(el),
        id: el.getAttribute('id') || '',
        name: el.getAttribute('name') || '',
      }))
      .filter((item) => /continue|next|checkout|payment|pay|submit|complete|confirm|cart|agree|place order|purchase/i.test(item.label))
      .slice(0, 25);
  });
}

function checkoutMarkers(text, controls, url) {
  const labelText = controls.map((control) => control.label).join(' ');
  const combined = `${url} ${text} ${labelText}`;
  return {
    cartEmpty: /cart\s*\(0\s+items?\)|cart\s+is\s+empty|no\s+items\s+in\s+your\s+cart/i.test(combined),
    hasCartItem: /cart\s*\([1-9]\d*\s+items?\)|Remove.{0,500}\$\s*[0-9,.]+|Facility\s+Reservation.{0,500}\$\s*[0-9,.]+/i.test(combined),
    hasProceedToCheckout: /proceed\s+to\s+checkout/i.test(labelText),
    hasContinue: /\bcontinue\b|\bnext\b/i.test(labelText),
    hasPaymentPrompt: /payment\s+method|credit\s+card|card\s+number|select\s+a\s+payment|security\s+code|expiration\s+date/i.test(combined),
    hasFinalPaymentAction: /submit\s+payment|complete\s+(order|transaction)|place\s+order|make\s+payment|process\s+payment|confirm\s+(and\s+)?pay|purchase/i.test(combined),
  };
}

function checkoutStopReason(markers) {
  if (markers.cartEmpty) return 'empty_cart';
  if (markers.hasProceedToCheckout) return null;
  if (markers.hasFinalPaymentAction) return 'final_payment_action';
  if (markers.hasPaymentPrompt) return 'payment_page';
  return null;
}

function checkoutStopMessage(reason) {
  if (reason === 'empty_cart') return 'Checkout inspection stopped because the WebTrac cart is empty.';
  if (reason === 'payment_page') return 'Checkout inspection reached the payment step and stopped before entering or submitting payment.';
  if (reason === 'final_payment_action') return 'Checkout inspection found a final payment/confirmation action and stopped before clicking it.';
  return 'Checkout inspection stopped.';
}

async function inspectPaymentMethodSelector(page) {
  const selectors = [
    '#webcheckout_requiredmethod_vm_1_button',
    '[id*="requiredmethod" i]',
    '[name*="requiredmethod" i]',
    'button',
    'a',
  ];

  for (const selector of selectors) {
    const locators = await page.locator(selector).filter({ visible: true }).all().catch(() => []);
    for (const locator of locators) {
      const label = await controlLabel(locator);
      if (!/select\s+a\s+payment\s+method|payment\s+method/i.test(label)) continue;
      if (/submit|make\s+payment|process\s+payment|complete|purchase/i.test(label)) continue;

      await locator.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);

      return {
        clicked: true,
        selector,
        label: label.replace(/\s+/g, ' ').trim(),
        url: page.url(),
        options: await visiblePaymentMethodOptions(page),
      };
    }
  }

  return {
    clicked: false,
    reason: 'payment_method_selector_not_found',
    options: await visiblePaymentMethodOptions(page),
  };
}

async function visiblePaymentMethodOptions(page) {
  return page.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function labelFor(el) {
      const id = el.getAttribute('id');
      return [
        el.innerText,
        el.textContent,
        el.value,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('name'),
        id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : '',
        el.closest('label, li, tr, .dropdown-menu, .ui-menu-item, .form-group')?.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }

    const optionElements = [
      ...Array.from(document.querySelectorAll('select option')).filter((el) => !el.disabled),
      ...Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"], button, a, [role="option"], [role="menuitem"], li')),
    ];

    const seen = new Set();
    return optionElements
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        id: el.getAttribute('id') || '',
        name: el.getAttribute('name') || '',
        value: String(el.value || '').slice(0, 80),
        label: labelFor(el).slice(0, 220),
      }))
      .map((item) => {
        const text = `${item.label} ${item.name} ${item.id} ${item.value}`;
        const method = text.match(/Credit Card - Web|eCheck|Saved Card|New Credit Card|Credit Card|Bank Account/i)?.[0] || '';
        return method ? { ...item, method } : null;
      })
      .filter(Boolean)
      .filter((item) => {
        const key = `${item.method}|${item.tag}|${item.id}|${item.name}|${item.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 40);
  });
}

async function inspectCreditCardEntryStep(page) {
  const selected = await selectPaymentMethodOption(page, /Credit Card - Web/i);
  if (!selected.selected) {
    return {
      selected,
      continued: { clicked: false, reason: 'credit_card_web_option_not_found' },
      entryPage: null,
    };
  }

  const continued = await clickCheckoutContinueButton(page);
  if (!continued.clicked) {
    return { selected, continued, entryPage: null };
  }

  const activePage = continued.page || page;
  return {
    selected,
    continued: withoutPageHandle(continued),
    entryPage: await inspectPaymentEntryPage(activePage),
  };
}

async function selectPaymentMethodOption(page, pattern) {
  let result = await clickVisiblePaymentMethodOption(page, pattern);
  if (result.selected) return result;

  await inspectPaymentMethodSelector(page);
  result = await clickVisiblePaymentMethodOption(page, pattern);
  return result;
}

async function clickVisiblePaymentMethodOption(page, pattern) {
  const patternSource = pattern.source;
  return page.evaluate((source) => {
    const re = new RegExp(source, 'i');

    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function labelFor(el) {
      return [
        el.innerText,
        el.textContent,
        el.value,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }

    const candidates = [
      ...Array.from(document.querySelectorAll('select option')).filter((el) => !el.disabled),
      ...Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li, a, button, input[type="radio"]')),
    ];

    for (const el of candidates) {
      if (!visible(el)) continue;
      const label = labelFor(el);
      if (!re.test(label)) continue;

      if (el.tagName === 'OPTION') {
        const select = el.closest('select');
        if (!select) continue;
        select.value = el.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.tagName === 'INPUT') {
        el.checked = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.click();
      }

      return {
        selected: true,
        label: label.match(/Credit Card - Web|eCheck|Saved Card|New Credit Card|Credit Card|Bank Account/i)?.[0] || label.slice(0, 120),
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute('id') || '',
        name: el.getAttribute('name') || '',
      };
    }

    return { selected: false, reason: 'matching_payment_option_not_visible' };
  }, patternSource);
}

async function clickCheckoutContinueButton(page) {
  const locator = page.locator('#webcheckout_buttoncontinue').filter({ visible: true });
  if (!await locator.count().catch(() => 0)) {
    return { clicked: false, reason: 'checkout_continue_not_found' };
  }

  const popupPromise = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
    locator.first().click(),
  ]);
  const popup = await popupPromise;
  const activePage = popup || page;
  await activePage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await activePage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  return {
    clicked: true,
    selector: '#webcheckout_buttoncontinue',
    label: 'Continue',
    url: activePage.url(),
    openedNewPage: Boolean(popup),
    page: activePage,
  };
}

function withoutPageHandle(result) {
  const { page, ...json } = result;
  return json;
}

async function inspectPaymentEntryPage(page) {
  const frames = [];
  for (const frame of page.frames()) {
    frames.push({
      url: frame.url(),
      name: frame.name(),
      details: await inspectPaymentFrame(frame),
    });
  }

  const combinedText = frames.map((frame) => [
    frame.url,
    frame.details.textSnippet,
    ...frame.details.fields.map((field) => `${field.label} ${field.name} ${field.id} ${field.placeholder} ${field.autocomplete}`),
    ...frame.details.controls.map((control) => control.label),
  ].join(' ')).join(' ');

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    markers: {
      hasCardField: /card\s*number|cc-?number|cardnumber|credit\s*card/i.test(combinedText),
      hasExpirationField: /expir|expiry|cc-exp|expmonth|expyear/i.test(combinedText),
      hasSecurityCodeField: /security\s*code|cvv|cvc|cid|cc-csc/i.test(combinedText),
      hasSubmitPaymentAction: /submit\s+payment|make\s+payment|process\s+payment|complete\s+(order|transaction)|place\s+order|purchase/i.test(combinedText),
    },
    frames: frames.map(redactPaymentFrameForOutput),
  };
}

async function inspectCheckoutPaymentState(page) {
  const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const compact = text.replace(/\s+/g, ' ').trim();
  const controls = await relevantCheckoutControls(page).catch(() => []);
  const markers = checkoutMarkers(compact, controls, page.url());
  const amountTodayCents = parseLabeledMoneyCents(compact, /Amount To Be Paid Today/i);
  const totalBalanceCents = parseLabeledMoneyCents(compact, /Total Balance for household/i);
  const newChargesCents = parseLabeledMoneyCents(compact, /New Charges In Shopping Cart/i);
  const balanceDueCents = amountTodayCents ?? totalBalanceCents ?? newChargesCents;

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    markers,
    amountTodayCents,
    totalBalanceCents,
    newChargesCents,
    balanceDueCents,
    needsPaymentMethod: balanceDueCents !== 0 && markers.hasPaymentPrompt && /select\s+a\s+payment\s+method|payment\s+method/i.test(compact),
    appearsCoveredByCredit: [amountTodayCents, totalBalanceCents].some((amount) => amount === 0)
      && /credit|balance|amount\s+to\s+be\s+paid\s+today/i.test(compact),
  };
}

function redactPaymentFrameForOutput(frame) {
  return {
    ...frame,
    details: {
      ...frame.details,
      textSnippet: frame.details.textSnippet
        ? '[redacted page text; field/control metadata retained]'
        : '',
    },
  };
}

async function inspectPaymentFrame(frame) {
  return frame.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function labelFor(el) {
      const id = el.getAttribute('id');
      return [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : '',
        el.closest('label, tr, li, .form-group, .field, div')?.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    }

    const fields = Array.from(document.querySelectorAll('input, select, textarea'))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        id: el.getAttribute('id') || '',
        name: el.getAttribute('name') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        placeholder: el.getAttribute('placeholder') || '',
        label: labelFor(el),
      }))
      .filter((field) => /card|credit|cc-|expir|expiry|cvv|cvc|cid|security|name|address|zip|postal|email|phone/i.test(`${field.label} ${field.name} ${field.id} ${field.autocomplete} ${field.placeholder}`))
      .slice(0, 40);

    const controls = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        id: el.getAttribute('id') || '',
        name: el.getAttribute('name') || '',
        label: [
          el.innerText,
          el.value,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160),
      }))
      .filter((control) => /continue|next|submit|payment|pay|complete|place order|purchase|cancel|back/i.test(`${control.label} ${control.name} ${control.id}`))
      .slice(0, 30);

    return {
      title: document.title,
      textSnippet: document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 500) : '',
      fields,
      controls,
    };
  }).catch((e) => ({
    error: e.message || String(e),
    textSnippet: '',
    fields: [],
    controls: [],
  }));
}

async function fillWebtracPaymentProfile(page) {
  const billing = await fillBillingFields(page);
  const cardShell = await fillHostedPaymentShellFields(page);
  const cardFrame = await fillBasisTheoryCardFrame(page);
  return { billing, cardShell, cardFrame };
}

async function fillBillingFields(page) {
  const fields = [
    ['#webcheckout_billfirstname', config.payment.firstName],
    ['#webcheckout_billlastname', config.payment.lastName],
    ['#webcheckout_billphone', config.payment.phone],
    ['#webcheckout_billemail', config.payment.email],
    ['#webcheckout_billemail_2', config.payment.email],
  ];
  const filled = [];
  const missing = [];
  for (const [selector, value] of fields) {
    const locator = page.locator(selector).filter({ visible: true });
    if (!await locator.count().catch(() => 0)) {
      missing.push(selector);
      continue;
    }
    await locator.first().fill(value);
    filled.push(selector);
  }
  return { filled, missing };
}

async function fillHostedPaymentShellFields(page) {
  const values = [
    { label: 'name_on_card', patterns: [/name\s+on\s+card/i], value: config.payment.cardName },
    { label: 'street_address_1', patterns: [/street\s+address\s+1/i, /address\s+1/i], value: config.payment.address1 },
    { label: 'postal_code', patterns: [/postal\s+code/i, /\bzip\b/i], value: config.payment.postalCode },
  ];
  return page.evaluate((items) => {
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function contextText(el) {
      const id = el.getAttribute('id');
      return [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : '',
        el.closest('label, tr, li, .form-group, .field, div')?.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }

    const inputs = Array.from(document.querySelectorAll('input, textarea')).filter((el) => visible(el) && !el.disabled && !el.readOnly);
    const filled = [];
    const missing = [];

    for (const item of items) {
      const patterns = item.patterns.map((source) => new RegExp(source, 'i'));
      const input = inputs.find((el) => patterns.some((pattern) => pattern.test(contextText(el))));
      if (!input) {
        missing.push(item.label);
        continue;
      }
      input.value = item.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push(item.label);
    }

    return { filled, missing };
  }, values.map((item) => ({
    label: item.label,
    patterns: item.patterns.map((pattern) => pattern.source),
    value: item.value,
  })));
}

async function fillBasisTheoryCardFrame(page) {
  const cardFrame = page.frames().find((frame) => /basis(?:theory)?\.com\/.*card-element/i.test(frame.url()));
  if (!cardFrame) {
    return { filled: [], missing: ['basis_theory_card_frame'] };
  }

  const fields = [
    ['#cardNumber', config.payment.cardNumber, 'cardNumber'],
    ['#expirationDate', config.payment.cardExp, 'expirationDate'],
    ['#cvc', config.payment.cardCvc, 'cvc'],
  ];
  const filled = [];
  const missing = [];
  for (const [selector, value, name] of fields) {
    const locator = cardFrame.locator(selector);
    if (!await locator.count().catch(() => 0)) {
      missing.push(name);
      continue;
    }
    await locator.first().fill(value);
    filled.push(name);
  }

  return { filled, missing, frameUrl: cardFrame.url() };
}

async function waitForRecaptchaIfPresent(page) {
  const hasRecaptcha = await page.locator('iframe[src*="recaptcha"]').count().then((count) => count > 0).catch(() => false);
  if (!hasRecaptcha) return { present: false, solved: true };

  const started = Date.now();
  while (Date.now() - started < config.recaptchaWaitMs) {
    const solved = await page.evaluate(() => {
      const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
      return Boolean(textarea && textarea.value && textarea.value.length > 20);
    }).catch(() => false);
    if (solved) return { present: true, solved: true, waitedMs: Date.now() - started };
    await page.waitForTimeout(1000);
  }

  return { present: true, solved: false, waitedMs: Date.now() - started };
}

async function clickFinalWebtracContinue(page) {
  const locator = page.locator('#webcheckout_buttoncontinue').filter({ visible: true });
  if (!await locator.count().catch(() => 0)) {
    return { clicked: false, reason: 'final_continue_not_found', url: page.url() };
  }

  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {}),
    locator.first().click(),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  return { clicked: true, selector: '#webcheckout_buttoncontinue', label: 'Continue', url: page.url() };
}

async function inspectFinalWebtracConfirmation(page) {
  const text = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  const compact = text.replace(/\s+/g, ' ').trim();
  const confirmationId =
    compact.match(/(?:receipt|confirmation|transaction|order)\s*(?:number|#|id)?[:\s#]+([A-Z0-9-]{4,})/i)?.[1] || null;
  const hasSuccessText = /thank you|receipt|confirmed|confirmation|transaction approved|payment approved|enrollment complete/i.test(compact);
  const hasErrorText = /declined|failed|error|invalid|required|captcha|try again/i.test(compact);
  const cartCount = Number(compact.match(/CART \((\d+) ITEMS?\)/i)?.[1] || 0);
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    confirmed: hasSuccessText && !hasErrorText,
    confirmationId,
    hasSuccessText,
    hasErrorText,
    cartCount,
    amountTodayCents: parseLabeledMoneyCents(compact, /Amount To Be Paid Today/i),
    totalBalanceCents: parseLabeledMoneyCents(compact, /Total Balance for household/i),
    pageText: compact ? '[redacted page text; confirmation markers retained]' : '',
  };
}

function parseLabeledMoneyCents(text, labelPattern) {
  const source = String(text || '');
  const labelMatch = source.match(labelPattern);
  if (!labelMatch) return null;
  const afterLabel = source.slice(labelMatch.index + labelMatch[0].length);
  return parseFirstMoneyCents(afterLabel);
}

function parseFirstMoneyCents(text) {
  const match = String(text || '').match(/\$\s*([0-9,]+)(?:\.(\d{2}))?/);
  if (!match) return null;
  const dollars = Number(match[1].replace(/,/g, ''));
  const cents = Number(match[2] || 0);
  if (!Number.isFinite(dollars) || !Number.isFinite(cents)) return null;
  return dollars * 100 + cents;
}

async function clickCheckoutInspectionNext(page) {
  const selectors = [
    '#webcart_buttoncheckout',
    '[id*="checkout" i]',
    '[name*="checkout" i]',
    '[id*="buttoncontinue" i]',
    '[name*="buttoncontinue" i]',
    'input[type="submit"]',
    'button[type="submit"]',
    'button',
    'a',
  ];

  for (const selector of selectors) {
    const locators = await page.locator(selector).filter({ visible: true }).all().catch(() => []);
    for (const locator of locators) {
      const label = await controlLabel(locator);
      if (!isSafeCheckoutInspectionLabel(label)) continue;

      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        locator.click(),
      ]);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      return { clicked: true, selector, label: label.replace(/\s+/g, ' ').trim(), url: page.url() };
    }
  }

  return { clicked: false, reason: 'safe_checkout_next_not_found' };
}

function isSafeCheckoutInspectionLabel(label) {
  const text = String(label || '');
  if (/payment|pay|complete|purchase|place\s+order|submit\s+payment|make\s+payment|process\s+payment|confirm\s+(and\s+)?pay/i.test(text)) {
    return false;
  }
  return /proceed\s+to\s+checkout|\bcontinue\b|\bnext\b/i.test(text);
}

function authStateFromText(bodyText) {
  const text = String(bodyText || '');
  if (/\b(sign out|log out|logout)\b/i.test(text)) return 'signed_in';
  if (/sign in\s*\/\s*register/i.test(text)) return 'signed_out';
  return 'unknown';
}

function isCloudflareBlocked(bodyText, title = '') {
  const text = `${title} ${bodyText}`;
  return /attention required|sorry,\s*you have been blocked|cloudflare|cf-error-details/i.test(text);
}

async function callUpdateSelection(page, selectionUrl) {
  const absoluteUrl = new URL(selectionUrl, WEBTRAC_ORIGIN).toString();
  const result = await page.evaluate(async (url) => {
    const res = await fetch(url, {
      credentials: 'include',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
    });
    const text = await res.text();
    return { httpStatus: res.status, text };
  }, absoluteUrl);

  let json = null;
  try { json = JSON.parse(result.text); } catch (e) {}
  const status = json && typeof json.status === 'string' ? json.status.toLowerCase() : '';
  const ok = result.httpStatus >= 200 && result.httpStatus < 300 && status !== 'invalid';
  return {
    ok,
    httpStatus: result.httpStatus,
    webtracStatus: status || null,
    descriptions: json && json.descriptions || null,
    label: json && json.label || null,
    raw: json ? undefined : result.text.slice(0, 500),
  };
}

async function addSelectedItemsToCart(page, searchUrl) {
  await page.waitForTimeout(500);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const candidates = [
    page.locator('#frwebsearch_buttonaddtocart'),
    page.locator('#websearch_buttonaddtocart'),
    page.locator('#websearch_buttonadd'),
    page.locator('[id*="addtocart" i]'),
    page.locator('[name*="addtocart" i]'),
    page.getByRole('button', { name: /add.*cart|add selected|checkout/i }),
    page.getByRole('link', { name: /add.*cart|add selected|checkout/i }),
  ];

  for (const locator of candidates) {
    const visible = await locator.filter({ visible: true }).count().catch(() => 0);
    if (!visible) continue;
    const first = locator.filter({ visible: true }).first();
    const label = await first.innerText().catch(async () => first.getAttribute('value').catch(() => ''));
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
      first.click(),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return {
      attempted: true,
      method: 'click',
      label: String(label || '').replace(/\s+/g, ' ').trim(),
      url: page.url(),
    };
  }

  const formResult = await page.evaluate(() => {
    const form = document.querySelector('form#frwebsearch, form[action*="search.html"]');
    if (!form) return { attempted: false, reason: 'search_form_not_found' };
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.name = 'frwebsearch_buttonaddtocart';
    submit.value = 'yes';
    submit.hidden = true;
    form.appendChild(submit);
    submit.click();
    return { attempted: true, method: 'synthetic_submit', name: submit.name };
  });

  if (formResult.attempted) {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return { ...formResult, url: page.url() };
  }

  return formResult;
}

async function completeCartPrompts(page, payload) {
  const results = [];
  const headcount = String(payload.headcount || 2);

  for (let step = 1; step <= 5; step += 1) {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);

    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const compact = bodyText.replace(/\s+/g, ' ').trim();
    const onAddToCartPage = /\/addtocart\.html/i.test(page.url());
    const cartState = await inspectCartPage(page).catch(() => null);

    if (cartState?.confirmed) {
      results.push({ step, action: 'cart_confirmed', url: page.url() });
      break;
    }

    if (!onAddToCartPage && isCheckoutOrPaymentPage(compact)) {
      results.push({ step, action: 'stopped_before_checkout', url: page.url() });
      break;
    }

    const looksLikeHeadcount = /facility\s*head\s*count|head\s*count|number\s+attending|participants?|attendees?/i.test(compact);
    const looksLikeAgreement = /tennis\s+and\s+pickleball\s+agreements?|agree\s+to\s+the\s+above|i\s+agree|acknowledge|waiver|facility\s+rules|rental\s+policy|refund\s+policy/i.test(compact);
    const fillResult = looksLikeHeadcount ? await fillHeadcountFields(page, headcount) : { filled: 0 };
    const agreementResult = looksLikeAgreement ? await checkAgreementFields(page) : { checked: 0 };
    const clickResult = await clickSafeCartContinue(page, looksLikeHeadcount || looksLikeAgreement || onAddToCartPage);

    results.push({
      step,
      action: clickResult.clicked ? 'continued_prompt' : 'no_prompt_action',
      url: page.url(),
      onAddToCartPage,
      looksLikeHeadcount,
      looksLikeAgreement,
      fillResult,
      agreementResult,
      clickResult,
      snippet: compact.slice(0, 500),
    });

    if (!clickResult.clicked) break;
  }

  return results;
}

function isCheckoutOrPaymentPage(text) {
  return /proceed\s+to\s+checkout|payment\s+method|amount\s+to\s+be\s+paid\s+today|credit\s+card|checkout\/payment/i.test(text || '');
}

async function checkAgreementFields(page) {
  return page.evaluate(() => {
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));

    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function contextText(el) {
      const id = el.getAttribute('id');
      return [
        el.getAttribute('name'),
        id,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : '',
        el.closest('label, tr, li, .form-group, .form__row, p, div')?.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }

    const candidates = checkboxes.filter((el) => {
      if (el.disabled || el.checked) return false;
      const text = contextText(el);
      return /tennis\s+and\s+pickleball|agree|above|acknowledge|required|waiver|policy|rules|terms/i.test(text)
        || (checkboxes.length === 1 && (visible(el) || /addtocart/i.test(location.href)));
    });

    const details = [];
    for (const el of candidates) {
      el.checked = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      details.push({
        name: el.getAttribute('name') || '',
        id: el.getAttribute('id') || '',
        context: contextText(el).slice(0, 160),
      });
    }

    return { checked: details.length, details };
  });
}

async function fillHeadcountFields(page, headcount) {
  return page.evaluate((value) => {
    const controls = Array.from(document.querySelectorAll('input, select, textarea'));

    function visible(el) {
      if (el.type === 'hidden') return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function contextText(el) {
      const id = el.getAttribute('id');
      const labels = [
        el.getAttribute('name'),
        id,
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : '',
        el.closest('tr, .form-group, .form__row, li, p, div')?.textContent,
      ];
      return labels.filter(Boolean).join(' ');
    }

    const candidates = controls.filter((el) => {
      if (!visible(el) || el.disabled || el.readOnly) return false;
      if (el.tagName === 'SELECT') return true;
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (!['text', 'number', 'tel'].includes(type)) return false;
      const text = contextText(el);
      return /head\s*count|facility\s*head\s*count|attend|participant|people|quantity|qty|count/i.test(text)
        || String(el.value || '').trim() === '0';
    });

    const details = [];
    for (const el of candidates) {
      if (el.tagName === 'SELECT') {
        const option = Array.from(el.options).find((opt) => String(opt.value) === value || String(opt.textContent || '').trim() === value);
        if (!option) continue;
        el.value = option.value;
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      details.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        id: el.getAttribute('id') || '',
      });
    }

    return { filled: details.length, details };
  }, headcount);
}

async function clickSafeCartContinue(page, isHeadcountPrompt) {
  const selectors = [
    '#frheadcount_buttoncontinue',
    '#fraddtocart_buttoncontinue',
    '#webaddtocart_buttoncontinue',
    '#addtocart_buttoncontinue',
    '#webcart_buttoncontinue',
    '#webcart_buttonaddtocart',
    '[id*="headcount" i][id*="continue" i]',
    '[name*="headcount" i][name*="continue" i]',
    '[id*="addtocart" i][id*="continue" i]',
    '[name*="addtocart" i][name*="continue" i]',
    '[id*="buttonaddtocart" i]',
    '[name*="buttonaddtocart" i]',
    '[id*="buttoncontinue" i]',
    '[name*="buttoncontinue" i]',
    'input[type="submit"]',
    'button[type="submit"]',
    'button',
    'a',
  ];

  for (const selector of selectors) {
    const locators = await page.locator(selector).filter({ visible: true }).all().catch(() => []);
    for (const locator of locators) {
      const label = await controlLabel(locator);
      if (!label) continue;
      if (!isSafeCartPromptLabel(label, isHeadcountPrompt)) continue;

      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        locator.click(),
      ]);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      return { clicked: true, selector, label: label.replace(/\s+/g, ' ').trim(), url: page.url() };
    }
  }

  return { clicked: false, reason: 'safe_continue_not_found' };
}

async function controlLabel(locator) {
  const text = await locator.innerText().catch(() => '');
  const value = await locator.getAttribute('value').catch(() => '');
  const aria = await locator.getAttribute('aria-label').catch(() => '');
  const title = await locator.getAttribute('title').catch(() => '');
  return String(text || value || aria || title || '').replace(/\s+/g, ' ').trim();
}

function isSafeCartPromptLabel(label, isHeadcountPrompt) {
  const text = String(label || '');
  if (/proceed\s+to\s+checkout|checkout|payment|pay|remove|delete|cancel|back|sign\s*out|log\s*out/i.test(text)) return false;
  if (/continue|next|submit|save|update|add\s+to\s+cart|add\s+selected|\bagree\b/i.test(text)) return true;
  return isHeadcountPrompt && /^ok$/i.test(text);
}

async function extractSelectionUrlsFromPage(page, payload) {
  const requestedStart = hhmmToMins(payload.start);
  const requestedEnd = requestedStart + Number(payload.duration || 60);
  if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd)) return [];

  const entries = await page.evaluate(() => {
    function toMins(h, m, ampm) {
      const ap = String(ampm || '').toLowerCase();
      let h24 = Number(h);
      if (ap === 'am') h24 = h24 === 12 ? 0 : h24;
      else h24 = h24 === 12 ? 12 : h24 + 12;
      return h24 * 60 + Number(m);
    }

    return Array.from(document.querySelectorAll('a.cart-button--state-block, a.cart-button'))
      .map((a) => {
        const text = a.innerText || a.textContent || '';
        const range = text.match(/(\d{1,2}):(\d{2})\s*([ap]m)\s*-\s*(\d{1,2}):(\d{2})\s*([ap]m)/i);
        const href = a.getAttribute('href') || '';
        const className = a.className || '';
        const tooltip = a.getAttribute('data-tooltip') || '';
        const unavailable = /Unavailable/i.test(`${text} ${tooltip}`) || /\berror\b/i.test(className);
        if (!range || unavailable || !/UpdateSelection/i.test(href)) return null;
        return {
          href,
          start: toMins(range[1], range[2], range[3]),
          end: toMins(range[4], range[5], range[6]),
          text: text.replace(/\s+/g, ' ').trim(),
        };
      })
      .filter(Boolean);
  });

  const single = entries.find((entry) => entry.start === requestedStart && entry.end >= requestedEnd);
  if (single) return [single.href];

  const urls = [];
  for (let mins = requestedStart; mins < requestedEnd; mins += 30) {
    const exact = entries.find((entry) => entry.start === mins && entry.end >= mins + 30);
    const covering = exact || entries.find((entry) => entry.start <= mins && entry.end >= mins + 30);
    if (!covering) return [];
    if (!urls.includes(covering.href)) urls.push(covering.href);
  }

  return urls;
}

function buildSearchUrl(payload) {
  const u = new URL(WEBTRAC_ORIGIN + SEARCH_PATH);
  u.searchParams.set('Action', 'Start');
  u.searchParams.set('SubAction', '');
  u.searchParams.set('type', payload.sportType);
  u.searchParams.set('location', payload.courtCode);
  u.searchParams.set('primarycode', '');
  u.searchParams.set('date', payload.dateWebtrac);
  u.searchParams.set('begintime', '08:00 am');
  u.searchParams.set('frheadcount', String(payload.headcount || 2));
  u.searchParams.set('blockstodisplay', '26');
  u.searchParams.set('display', 'Detail');
  u.searchParams.set('search', 'yes');
  u.searchParams.set('page', '1');
  u.searchParams.set('module', 'FR');
  u.searchParams.set('frwebsearch_buttonsearch', 'yes');
  return u.toString();
}

function normalizeSearchUrl(searchUrl, payload) {
  if (!searchUrl) return buildSearchUrl(payload);
  const u = new URL(searchUrl, WEBTRAC_ORIGIN);
  u.searchParams.set('frheadcount', String(payload.headcount || 2));
  return u.toString();
}

function normalizeSelectionUrls(payload) {
  if (Array.isArray(payload.webtracUpdateSelectionUrls)) {
    return payload.webtracUpdateSelectionUrls.filter(Boolean);
  }
  return payload.webtracUpdateSelectionUrl ? [payload.webtracUpdateSelectionUrl] : [];
}

function parseAvailabilityHtml(html) {
  const aggregateSlotMap = new Map();
  const courtMap = new Map();
  const unitLabels = new Map();
  let currentCourt = null;

  const linkRe = /<([a-z][\w:-]*)\s+([^>]*?cart-button[^>]*?)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[2];
    const inner = m[3];

    if (/cart-button--state-label/.test(attrs)) {
      const label = cleanAvailabilityText(inner) || cleanAvailabilityText(attributeValue(attrs, 'title')) || `Court ${courtMap.size + 1}`;
      currentCourt = isMeaningfulAvailabilityCourtLabel(label) ? ensureAvailabilityCourt(courtMap, label) : null;
      continue;
    }
    if (!/cart-button--state-block/.test(attrs)) continue;

    const t = inner.match(/(\d{1,2}):(\d{2})\s*([ap]m)\s*-\s*(\d{1,2}):(\d{2})\s*([ap]m)/i);
    if (!t) continue;

    const isUnavailable =
      /data-tooltip\s*=\s*"Unavailable"/i.test(attrs) ||
      /\bUnavailable\b/i.test(inner) ||
      /\berror\b/.test(attrs);
    const isAvailable = !isUnavailable;

    const href = decodeAvailabilityEntities(attributeValue(attrs, 'href'));
    const unitId = webtracFacilityUnitIdFromHref(href);
    let bookingUrl = null;
    if (isAvailable && href && href !== '#' && /UpdateSelection/i.test(href)) bookingUrl = href;

    const startMins = toAvailabilityMins(parseInt(t[1], 10), parseInt(t[2], 10), t[3]);
    const endMins = toAvailabilityMins(parseInt(t[4], 10), parseInt(t[5], 10), t[6]);
    if (!Number.isFinite(startMins) || !Number.isFinite(endMins) || endMins <= startMins) continue;

    const unitCourt = currentCourt || (unitId ? ensureAvailabilityCourtForUnit(courtMap, unitLabels, unitId) : null);
    let unitBookingUrl = bookingUrl;
    for (let mins = startMins; mins < endMins; mins += 30) {
      const key = minsToAvailabilityHHMM(mins);
      if (unitCourt) mergeAvailabilitySlot(unitCourt.slotMap, key, isAvailable, unitBookingUrl);
      mergeAvailabilitySlot(aggregateSlotMap, key, isAvailable, unitBookingUrl);
      unitBookingUrl = null;
    }
  }

  const courts = Array.from(courtMap.values())
    .map((court) => ({
      id: court.id,
      label: court.label,
      webtracFacilityId: court.webtracFacilityId || null,
      slots: availabilitySlotMapToSlots(court.slotMap),
    }))
    .filter((court) => court.slots.length)
    .sort((a, b) => availabilityCourtSortLabel(a.label).localeCompare(availabilityCourtSortLabel(b.label), undefined, { numeric: true }));

  return {
    slots: availabilitySlotMapToSlots(aggregateSlotMap),
    courts,
    courtCount: courts.length,
  };
}

function mergeAvailabilitySlot(slotMap, key, isAvailable, bookingUrl) {
  const prev = slotMap.get(key);
  if (prev === undefined) {
    slotMap.set(key, { available: isAvailable, bookingUrl });
  } else if (isAvailable && !prev.available) {
    slotMap.set(key, { available: true, bookingUrl });
  } else if (isAvailable && prev.available && !prev.bookingUrl && bookingUrl) {
    slotMap.set(key, { available: true, bookingUrl });
  }
}

function availabilitySlotMapToSlots(slotMap) {
  return Array.from(slotMap.entries())
    .map(([start, info]) => ({ start, available: info.available, bookingUrl: info.bookingUrl || null }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

function ensureAvailabilityCourt(courtMap, label) {
  const normalized = normalizeAvailabilityCourtLabel(label);
  const id = slugifyAvailabilityCourt(normalized || `court-${courtMap.size + 1}`);
  if (!courtMap.has(id)) {
    courtMap.set(id, {
      id,
      label: normalized || `Court ${courtMap.size + 1}`,
      slotMap: new Map(),
    });
  }
  return courtMap.get(id);
}

function ensureAvailabilityCourtForUnit(courtMap, unitLabels, unitId) {
  const key = String(unitId || '').trim();
  if (!key) return null;
  if (!unitLabels.has(key)) unitLabels.set(key, `Court ${unitLabels.size + 1}`);
  const label = unitLabels.get(key);
  const id = `unit-${slugifyAvailabilityCourt(key)}`;
  if (!courtMap.has(id)) {
    courtMap.set(id, {
      id,
      label,
      webtracFacilityId: key,
      slotMap: new Map(),
    });
  }
  return courtMap.get(id);
}

function normalizeAvailabilityCourtLabel(label) {
  return cleanAvailabilityText(label)
    .replace(/\bFacility Reservation\b/gi, '')
    .replace(/\bBook Now\b/gi, '')
    .replace(/\bUnavailable\b/gi, '')
    .replace(/^[\s:.|/\\-]+|[\s:.|/\\-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningfulAvailabilityCourtLabel(label) {
  const normalized = normalizeAvailabilityCourtLabel(label);
  return /[a-z0-9]/i.test(normalized) && !/^court$/i.test(normalized);
}

function availabilityCourtSortLabel(label) {
  return String(label || '').replace(/^.*?(\d+)$/, 'Court $1');
}

function slugifyAvailabilityCourt(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'court';
}

function cleanAvailabilityText(value) {
  return decodeAvailabilityEntities(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function attributeValue(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = attrs.match(re);
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function decodeAvailabilityEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function toAvailabilityMins(hour, minute, ampm) {
  let h = hour;
  const ap = String(ampm || '').toLowerCase();
  if (ap === 'am') h = h === 12 ? 0 : h;
  if (ap === 'pm') h = h === 12 ? 12 : h + 12;
  return h * 60 + minute;
}

function minsToAvailabilityHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function webtracFacilityUnitIdFromHref(href) {
  const match = String(href || '').match(/(?:^|[?&])(?:frfacility|facility|item|key|id)=([^&]+)/i);
  return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
}

function hhmmToMins(hhmm) {
  const match = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function codedError(code, message, details = null) {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}
