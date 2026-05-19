import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { config } from './config.js';

const WEBTRAC_ORIGIN = 'https://vaarlingtonweb.myvscloud.com';
const SEARCH_PATH = '/webtrac/web/search.html';
const LOGIN_CANDIDATES = [
  '/webtrac/web/login.html',
  '/webtrac/web/householdlogin.html',
  '/webtrac/web/splash.html?ccode=login',
];

export async function reserveWithWebtrac(payload) {
  await resetArtifactDir();
  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.slowMo,
    executablePath: config.chromeExecutablePath || undefined,
    artifactsPath: config.artifactDir,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await login(page);
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
        message: 'Logged in, reached WebTrac search, and found selection URLs. No cart mutation was attempted because DRY_RUN=true.',
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
    const addToCartResult = await addSelectedItemsToCart(page, searchUrl);
    const promptResults = await completeCartPrompts(page, payload);

    const cartState = await confirmCartState(page, searchUrl);
    const cartReady = addResults.every(r => r.ok) && cartState.confirmed;

    return {
      status: cartReady ? 'cart_updated' : 'cart_update_uncertain',
      code: cartReady ? 'WEBTRAC_CART_READY' : 'WEBTRAC_CART_UPDATE_UNCERTAIN',
      message: cartReady
        ? 'Added to the WebTrac cart. Checkout/payment is intentionally not automated yet.'
        : 'WebTrac accepted the selection request, but the worker could not confirm the item in the cart after retries.',
      dryRun: false,
      addResults,
      addToCartResult,
      promptResults,
      selectionSource,
      cartState,
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

async function login(page) {
  let lastUrl = null;
  for (const path of LOGIN_CANDIDATES) {
    lastUrl = WEBTRAC_ORIGIN + path;
    await page.goto(lastUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const username = firstVisible(page, [
      'input[name="username"]',
      'input[name="Username"]',
      'input[name="user"]',
      'input[name="login"]',
      'input[id*="user" i]',
      'input[id*="email" i]',
      'input[type="email"]',
      'input[type="text"]',
    ]);
    const password = firstVisible(page, [
      'input[name="password"]',
      'input[name="Password"]',
      'input[id*="pass" i]',
      'input[type="password"]',
    ]);

    if (await username.count() && await password.count()) {
      await username.first().fill(config.webtracUsername);
      await password.first().fill(config.webtracPassword);
      await clickLogin(page);
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await handleActiveSessionPrompt(page);
      await assertLoggedIn(page);
      return;
    }
  }

  throw codedError('LOGIN_FORM_NOT_FOUND', `Could not find a WebTrac login form. Last attempted: ${lastUrl}`);
}

function firstVisible(page, selectors) {
  return page.locator(selectors.join(', ')).filter({ visible: true });
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
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        locator.first().click(),
      ]);
      return;
    }
  }
  throw codedError('LOGIN_BUTTON_NOT_FOUND', 'Could not find a WebTrac login submit control.');
}

async function assertLoggedIn(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (/invalid|incorrect|failed|try again/i.test(bodyText) && /password|login|username/i.test(bodyText)) {
    throw codedError('LOGIN_FAILED', 'WebTrac rejected the supplied username or password.');
  }
  if (/active session already exists|continue with login/i.test(bodyText)) {
    throw codedError('ACTIVE_SESSION_NOT_RESOLVED', 'WebTrac asked to resume an active session, but the worker could not complete that prompt.');
  }
  const authState = authStateFromText(bodyText);
  if (authState === 'signed_out') {
    throw codedError('LOGIN_NOT_CONFIRMED', 'WebTrac still appears signed out after submitting the login form.');
  }
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
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        locator.first().click(),
      ]);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
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

async function inspectCartPage(page) {
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
    bodySnippet: compact.slice(0, 900),
  };
}

async function confirmCartState(page, searchUrl) {
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      await page.waitForTimeout(900 * attempt);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    await page.goto(WEBTRAC_ORIGIN + '/webtrac/web/cart.html', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const cartState = await inspectCartPage(page);
    attempts.push({
      attempt,
      url: cartState.url,
      title: cartState.title,
      itemCount: cartState.itemCount,
      confirmed: cartState.confirmed,
      grandTotal: cartState.grandTotal,
      amountToday: cartState.amountToday,
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

function authStateFromText(bodyText) {
  const text = String(bodyText || '');
  if (/\b(sign out|log out|logout)\b/i.test(text)) return 'signed_in';
  if (/sign in\s*\/\s*register/i.test(text)) return 'signed_out';
  return 'unknown';
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
    const cartState = await inspectCartPage(page).catch(() => null);

    if (cartState?.confirmed) {
      results.push({ step, action: 'cart_confirmed', url: page.url() });
      break;
    }

    if (isCheckoutOrPaymentPage(compact)) {
      results.push({ step, action: 'stopped_before_checkout', url: page.url() });
      break;
    }

    const looksLikeHeadcount = /facility\s*head\s*count|head\s*count|number\s+attending|participants?|attendees?/i.test(compact);
    const fillResult = looksLikeHeadcount ? await fillHeadcountFields(page, headcount) : { filled: 0 };
    const clickResult = await clickSafeCartContinue(page, looksLikeHeadcount);

    results.push({
      step,
      action: clickResult.clicked ? 'continued_prompt' : 'no_prompt_action',
      url: page.url(),
      looksLikeHeadcount,
      fillResult,
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
    '#webcart_buttoncontinue',
    '#webcart_buttonaddtocart',
    '[id*="headcount" i][id*="continue" i]',
    '[name*="headcount" i][name*="continue" i]',
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
  if (/continue|next|submit|save|update|add\s+to\s+cart|add\s+selected/i.test(text)) return true;
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

function hhmmToMins(hhmm) {
  const match = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
