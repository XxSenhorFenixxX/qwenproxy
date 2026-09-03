import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { QwenAccount } from '../core/accounts.js';
import { config } from '../core/config.js';
import { getBaseAccountId } from '../core/account-lanes.js';
import { getStealthScript, getLoginStealthScript } from './stealth.js';
import { getFingerprintProfile, type FingerprintProfile } from './fingerprint.js';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge' | 'brave';

interface BrowserEngineConfig {
  engine: typeof chromium | typeof firefox | typeof webkit;
  channel?: string;
  executablePath?: string;
}

const BRAVE_EXECUTABLE_CANDIDATES = [
  '/usr/bin/brave-browser',
  '/usr/bin/brave-browser-stable',
  '/usr/bin/brave',
  '/opt/brave.com/brave/brave-browser',
  '/snap/bin/brave',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
];

export function resolveBraveExecutable(): string | undefined {
  const fromEnv = config.browser.bravePath;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return BRAVE_EXECUTABLE_CANDIDATES.find(p => fs.existsSync(p));
}

export function resolveBrowserEngine(browserType: BrowserType): BrowserEngineConfig {
  switch (browserType) {
    case 'firefox': return { engine: firefox };
    case 'webkit': return { engine: webkit };
    case 'chrome': return { engine: chromium, channel: 'chrome' };
    case 'edge': return { engine: chromium, channel: 'msedge' };
    case 'brave': {
      const executablePath = resolveBraveExecutable();
      if (!executablePath) {
        throw new Error('[Playwright] Brave executable not found. Install Brave or set BRAVE_PATH env var.');
      }
      return { engine: chromium, executablePath };
    }
    case 'chromium':
    default: return { engine: chromium };
  }
}

export interface AccountHeaderCache {
  currentHeaders: Record<string, string>;
  cachedQwenHeaders: { headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null;
  lastHeadersTime: number;
  refreshInProgress: boolean;
}

export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
export const CHROME_CLIENT_HINTS = '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="99"';
export const BROWSER_VIEWPORT = { width: 1366, height: 768 };
export const BROWSER_LOCALE = 'pt-BR';
export const BROWSER_TIMEZONE = 'America/Sao_Paulo';

/**
 * Decides whether the runtime should FORGE the browser fingerprint.
 *
 * - auto: forge only for bundled engines (chromium/firefox/webkit); for real
 *   installed browsers (chrome/edge/brave) keep the REAL fingerprint.
 * - true: always forge (previous default behavior).
 * - false: never forge — the browser presents its genuine identity.
 *
 * When the session was created in a real browser (manual login / [E] import),
 * forging a Chrome/Windows identity in the runtime is exactly the inconsistency
 * that TMD detects and silently answers with empty 200 OK responses.
 */
export function shouldForgeFingerprint(): boolean {
  const mode = config.browser.forgeFingerprint;
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return ['chromium', 'firefox', 'webkit'].includes(config.browser.type);
}

/**
 * Selectors that appear when the user is NOT logged in (across locales).
 * Used by isPageLoggedIn to detect stale/expired sessions.
 */
const LOGIN_BUTTON_SELECTORS = [
  'button:has-text("Fazer login")',
  'button:has-text("Login")',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
  'a:has-text("Fazer login")',
  'a:has-text("Login")',
  'a:has-text("Log in")',
  'a:has-text("Sign in")',
];

/**
 * Checks whether a Qwen page shows a logged-in state by looking for the
 * "Fazer login" / "Login" / "Sign in" button. If ANY such button is
 * visible the page is in guest mode (session expired or never authenticated).
 */
export async function isPageLoggedIn(_page: Page): Promise<boolean> {
  // DISABLED: giving false positives on landing page. Always return true
  // to prevent unnecessary re-login that destroys valid sessions.
  return true;
}

export function getBrowserIdentity(accountId?: string): { userAgent: string; secChUa: string; platform: string; profile?: FingerprintProfile } {
  if (!shouldForgeFingerprint()) {
    // Real fingerprint: the installed browser presents its genuine identity.
    return { userAgent: '', secChUa: '', platform: '', profile: undefined };
  }
  const profile = accountId ? getFingerprintProfile(accountId) : undefined;
  return {
    userAgent: profile?.userAgent || CHROME_UA,
    secChUa: profile?.secChUa || CHROME_CLIENT_HINTS,
    platform: profile?.platform || 'Windows',
    profile,
  };
}

export function getClientHintsHeaders(accountId?: string): Record<string, string> {
  const identity = getBrowserIdentity(accountId);
  if (!identity.secChUa) return {}; // real fingerprint: browser sends its own hints
  return {
    'sec-ch-ua': identity.secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${identity.platform}"`,
  };
}

function getBrowserLaunchArgs(): string[] {
  if (!shouldForgeFingerprint()) {
    // Real installed browser: clean desktop-style flags (no --no-sandbox /
    // --disable-gpu / --no-zygote container/automation signatures), only hide
    // the automation hint and first-run dialogs — same philosophy as manual login.
    // EXCEPTIONS kept for environments where they are required:
    //  - --no-sandbox when running as root (Docker default) — Chromium refuses
    //    to launch as root without it.
    //  - --disable-dev-shm-usage — harmless and prevents /dev/shm exhaustion
    //    in containers with small shared memory.
    const rootArgs: string[] = [];
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      rootArgs.push('--no-sandbox');
    }
    return Array.from(new Set([
      ...rootArgs,
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      // Off-screen: the shared runtime browser serves the accounts without
      // showing windows on the desktop. Manual login [M] keeps its own args.
      '--window-position=-32000,-32000',
    ]));
  }
  return Array.from(new Set([
    ...config.browser.args,
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-accelerated-2d-canvas',
    // Off-screen: the shared runtime browser serves the accounts without
    // showing windows on the desktop. Manual login [M] keeps its own args.
    '--window-position=-32000,-32000',
  ]));
}

/**
 * Clean desktop-style launch args for the interactive manual login flow.
 * A real user's browser is NOT launched with --no-sandbox, --disable-gpu,
 * --no-zygote or container-style flags — those are automation/container
 * signatures that anti-bot systems (TMD) flag. We only keep the args that
 * hide the automation hint and first-run dialogs.
 */
function getManualLoginLaunchArgs(): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
  ];
}

export function sharedContextOptions(accountId?: string): BrowserContextOptions {
  const identity = getBrowserIdentity(accountId);

  const base: BrowserContextOptions = {
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    viewport: identity.profile?.viewport ?? BROWSER_VIEWPORT,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
  };

  if (!identity.userAgent) {
    // Real fingerprint: don't pin UA and don't inject forged client hints — the
    // installed browser presents its genuine identity (matches the login session).
    return base;
  }

  return {
    ...base,
    userAgent: identity.userAgent,
    extraHTTPHeaders: {
      ...config.browser.headers,
      ...getClientHintsHeaders(accountId),
    },
  };
}

export const HEADERS_TTL = config.headers.ttlMs;
export const COOKIE_CACHE_TTL = 5 * 60 * 1000;
export const REFRESH_THRESHOLD = 0.7;
export const GUEST_HEADERS_TTL = 30 * 60 * 1000;

export const PROFILES_DIR = path.resolve(config.browser.userDataDir);

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const accountContexts = new Map<string, BrowserContext>();
export const accountPages = new Map<string, Page>();
export const accountHeaderCaches = new Map<string, AccountHeaderCache>();
export const cachedUserAgents = new Map<string, string>();
export const cookieCaches = new Map<string, { cookie: string, timestamp: number }>();

let browser: Browser | null = null;
// Shared in-flight launch: when accounts are initialized concurrently, every
// caller that finds no connected browser awaits this SAME promise instead of
// launching its own duplicate browser process (fixes the startup race).
let launchingPromise: Promise<Browser> | null = null;
let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let guestContext: BrowserContext | null = null;
let guestPage: Page | null = null;
let guestHeadersCache: { headers: Record<string, string>, timestamp: number } | null = null;

export function getBrowser(): Browser | null { return browser; }
export function setBrowser(b: Browser | null) { browser = b; }
export function getContext(): BrowserContext | null { return context; }
export function setContext(c: BrowserContext | null) { context = c; }
export function getActivePage(): Page | null { return activePage; }
export function setActivePage(p: Page | null) { activePage = p; }
export function getGuestContext(): BrowserContext | null { return guestContext; }
export function setGuestContext(c: BrowserContext | null) { guestContext = c; }
export function getGuestPage(): Page | null { return guestPage; }
export function setGuestPage(p: Page | null) { guestPage = p; }
export function getGuestHeadersCache(): { headers: Record<string, string>, timestamp: number } | null { return guestHeadersCache; }
export function setGuestHeadersCache(c: { headers: Record<string, string>, timestamp: number } | null) { guestHeadersCache = c; }

export function getAccountHeaderCache(accountId: string): AccountHeaderCache {
  let cache = accountHeaderCaches.get(accountId);
  if (!cache) {
    cache = {
      currentHeaders: {},
      cachedQwenHeaders: null,
      lastHeadersTime: 0,
      refreshInProgress: false,
    };
    accountHeaderCaches.set(accountId, cache);
  }
  return cache;
}

export function storageStatePath(accountId: string): string {
  return path.join(PROFILES_DIR, `${accountId}_state.json`);
}

export function loadStorageState(accountId: string): string | undefined {
  const p = storageStatePath(accountId);
  if (!fs.existsSync(p)) return undefined;

  try {
    const raw = fs.readFileSync(p, 'utf8');
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object') {
      console.warn(`[Playwright] Invalid storageState structure for ${accountId}, discarding.`);
      fs.rmSync(p, { force: true });
      return undefined;
    }
    if (!Array.isArray(state.cookies)) {
      console.warn(`[Playwright] StorageState for ${accountId} missing cookies array, discarding.`);
      fs.rmSync(p, { force: true });
      return undefined;
    }
    if (!Array.isArray(state.origins)) {
      state.origins = [];
    }

    const now = Date.now();
    const validCookies = state.cookies.filter((c: any) => {
      if (!c || !c.name || !c.value) return false;
      if (c.expires && c.expires > 0 && c.expires * 1000 < now) return false;
      return true;
    });

    if (validCookies.length === 0) {
      console.warn(`[Playwright] StorageState for ${accountId} has no valid cookies, discarding.`);
      fs.rmSync(p, { force: true });
      return undefined;
    }

    if (validCookies.length !== state.cookies.length) {
      console.log(`[Playwright] Pruned ${state.cookies.length - validCookies.length} expired cookies for ${accountId}.`);
      state.cookies = validCookies;
      fs.writeFileSync(p, JSON.stringify(state, null, 2));
    }

    return p;
  } catch (err: any) {
    console.warn(`[Playwright] Failed to read storageState for ${accountId}: ${err.message}. Discarding.`);
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    return undefined;
  }
}

export async function saveStorageState(ctx: BrowserContext, accountId: string): Promise<void> {
  try {
    if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
    await ctx.storageState({ path: storageStatePath(accountId) });
  } catch (err: any) {
    console.warn(`[Playwright] Failed to save storageState for ${accountId}: ${err.message}`);
  }
}

export async function clearPageRuntimeState(page: Page | null): Promise<void> {
  if (!page || page.isClosed()) return;

  try {
    await page.context().clearCookies();
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear cookies during profile reset: ${err.message}`);
  }

  try {
    await page.context().clearPermissions();
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear permissions during profile reset: ${err.message}`);
  }

  try {
    await page.evaluate(() => {
      try { window.localStorage.clear(); } catch { /* ignore */ }
      try { window.sessionStorage.clear(); } catch { /* ignore */ }
    });
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear page storage during profile reset: ${err.message}`);
  }
}

export async function getOrLaunchBrowser(browserType: BrowserType = 'chromium'): Promise<Browser> {
  // Reuse the already-running shared browser when it is still connected.
  if (browser?.isConnected()) return browser;

  // Another caller is already launching the shared browser: wait for that
  // same launch instead of starting a second (duplicate) browser process.
  if (launchingPromise) return launchingPromise;

  const { engine, channel, executablePath } = resolveBrowserEngine(browserType);
  console.log(`[Playwright] Launching shared ${browserType} browser...`);

  const launchArgs = getBrowserLaunchArgs();

  const launchPromise = (async (): Promise<Browser> => {
    try {
      const launched = await engine.launch({
        headless: config.browser.headless,
        channel,
        executablePath,
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features'],
        args: launchArgs,
      });
      browser = launched;
      launched.on('disconnected', () => { browser = null; });
      return launched;
    } finally {
      // Clear the shared launch promise on success AND failure, so the next
      // caller can start a fresh launch if needed.
      launchingPromise = null;
    }
  })();

  launchingPromise = launchPromise;
  return launchPromise;
}

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const uiMutexes = new Map<string, Mutex>();
export function getUiMutex(accountId: string): Mutex {
  let m = uiMutexes.get(accountId);
  if (!m) {
    m = new Mutex();
    uiMutexes.set(accountId, m);
  }
  return m;
}

export async function hasValidAuthCookie(page: Page | null): Promise<boolean> {
  if (!page) return false;
  try {
    const cookies = await page.context().cookies();
    return cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
  } catch {
    return false;
  }
}

async function checkValidSession(): Promise<boolean> {
  if (!activePage) return false;
  try {
    const hasAuth = await hasValidAuthCookie(activePage);
    if (!hasAuth) return false;
    await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
    const isLogged = !activePage.url().includes('auth') && !activePage.url().includes('login');
    return isLogged;
  } catch {
    return false;
  }
}

export async function loginToQwenWithContext(acctContext: BrowserContext, acctPage: Page, email: string, password: string): Promise<boolean> {
  await acctPage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  const result = await acctPage.evaluate(async ({ email, password }) => {
    try {
      const response = await fetch("https://chat.qwen.ai/api/v2/auths/signin", {
        method: "POST",
        headers: {
          "accept": "application/json, text/plain, */*",
          "content-type": "application/json",
          "source": "web",
          "timezone": new Date().toString().split(' (')[0],
          "x-request-id": crypto.randomUUID()
        },
        body: JSON.stringify({ email, password, login_type: "email" })
      });
      const data = await response.json();
      return { ok: response.ok, data };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }, { email, password: hashedPassword });

  if (result.ok) {
    await acctPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
    const isLogged = !(acctPage.url().includes('auth') || acctPage.url().includes('login'));
    if (isLogged) {
      console.log(`[Playwright] Login confirmed for ${email}.`);
      return true;
    }
  }

  console.error(`[Playwright] Login failed for ${email}:`, result.data || result.error);
  return false;
}

export async function loginToQwen(email: string, password: string): Promise<boolean> {
  if (!activePage) throw new Error('Playwright not initialized');
  console.log(`[Playwright] Attempting API login for ${email}...`);
  return loginToQwenWithContext(activePage.context(), activePage, email, password);
}

async function loginToQwenUI(email: string, password: string): Promise<boolean> {
  if (!activePage) throw new Error('Playwright not initialized');

  console.log('[Playwright] Attempting UI login...');
  await activePage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  if (!activePage.url().includes('/auth')) {
    console.log('[Playwright] Already logged in');
    return true;
  }

  try {
    await activePage.waitForSelector('input[type="email"], input[placeholder*="Email"]', { timeout: config.timeouts.page });
  } catch {
    if (activePage.url().includes('/auth')) throw new Error('Email input not found');
    console.log('[Playwright] Already logged in');
    return true;
  }

  console.log('[Playwright] UI: Filling email...');
  await activePage.fill('input[type="email"], input[placeholder*="Email"]', email);
  await activePage.keyboard.press('Enter');
  await sleep(1000);

  await activePage.waitForSelector('input[type="password"]', { timeout: config.timeouts.page });
  console.log('[Playwright] UI: Filling password...');
  await activePage.fill('input[type="password"]', password);
  await activePage.keyboard.press('Enter');

  await sleep(2000);

  const isLogged = !activePage.url().includes('auth') && !activePage.url().includes('login');
  if (isLogged) {
    console.log('[Playwright] UI login OK');
    return true;
  }

  console.log('[Playwright] UI login failed');
  return false;
}

async function attemptAutoLogin(): Promise<void> {
  const email = process.env.QWEN_EMAIL;
  const password = process.env.QWEN_PASSWORD;
  if (!email || !password) return;
  console.log('[Playwright] Attempting auto-login with credentials from .env...');
  try {
    const success = await loginToQwen(email, password);
    if (success) {
      console.log('[Playwright] Auto-login successful.');
      return;
    }
    console.warn('[Playwright] API login failed, trying UI fallback...');
    const uiSuccess = await loginToQwenUI(email, password);
    if (uiSuccess) {
      console.log('[Playwright] UI login fallback successful.');
    } else {
      console.warn('[Playwright] Both API and UI login failed. Manual login may be required.');
    }
  } catch (err: any) {
    console.error('[Playwright] Auto-login error:', err.message);
  }
}

export async function resetBrowserProfile(cacheKey: string, accountId?: string): Promise<void> {
  const profileId = accountId === 'guest' ? '_guest' : (accountId || '_default');
  const profilePath = path.join(PROFILES_DIR, profileId);

  try {
    if (accountId === 'guest') {
      await clearPageRuntimeState(guestPage);
      if (guestContext) {
        await guestContext.close();
        guestContext = null;
      }
      guestPage = null;
    } else if (accountId) {
      const acctPage = accountPages.get(accountId) ?? null;
      await clearPageRuntimeState(acctPage);
      const acctContext = accountContexts.get(accountId);
      if (acctContext) {
        await acctContext.close();
        accountContexts.delete(accountId);
      }
      accountPages.delete(accountId);
    } else {
      await clearPageRuntimeState(activePage);
      if (context) {
        await context.close();
        context = null;
      }
      activePage = null;
    }

    if (browser?.isConnected()) {
      await browser.close();
      browser = null;
    }

    accountHeaderCaches.delete(cacheKey);
    cookieCaches.delete(cacheKey);
    cachedUserAgents.delete(cacheKey);
    accountContexts.clear();
    accountPages.clear();
    context = null;
    activePage = null;
    guestContext = null;
    guestPage = null;
    guestHeadersCache = null;
    fs.rmSync(profilePath, { recursive: true, force: true });
    fs.rmSync(storageStatePath(profileId), { force: true });

    console.warn(`[Playwright] Cleared browser profile for ${cacheKey}: ${profilePath}`);
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear browser profile for ${cacheKey}: ${err.message}`);
  }
}

export async function initPlaywright(_headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const sharedBrowser = await getOrLaunchBrowser(browserType);
  console.log(`[Playwright] Creating default context on shared browser...`);

  const storageState = loadStorageState('_default');
  const defaultProfile = shouldForgeFingerprint() ? getFingerprintProfile('_default') : null;
  context = await sharedBrowser.newContext({
    ...sharedContextOptions('_default'),
    ...(storageState ? { storageState } : {}),
  });

  await context.addInitScript(defaultProfile ? getStealthScript(defaultProfile) : getLoginStealthScript());

  activePage = await context.newPage();

  const hasCredentials = !!(process.env.QWEN_EMAIL && process.env.QWEN_PASSWORD);
  const hasValidSession = await checkValidSession();

  if (!hasValidSession && !hasCredentials) {
    console.warn('[Playwright] No valid session AND no credentials in .env. Manual login will be required.');
  }

  if (!hasValidSession) {
    await attemptAutoLogin();
  }

  if (await hasValidAuthCookie(activePage)) {
    await saveStorageState(context, '_default');
  }
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  for (const cache of accountHeaderCaches.values()) {
    cache.refreshInProgress = false;
  }
  if (context) {
    if (await hasValidAuthCookie(activePage)) {
      await saveStorageState(context, '_default');
    }
    await context.close();
    context = null;
    activePage = null;
  }
  if (guestContext) {
    if (await hasValidAuthCookie(guestPage)) {
      await saveStorageState(guestContext, '_guest');
    }
    await guestContext.close();
    guestContext = null;
    guestPage = null;
  }
  for (const acctId of accountContexts.keys()) {
    await closePlaywrightForAccount(acctId);
  }
  if (browser?.isConnected()) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

export async function initPlaywrightForAccount(account: QwenAccount, _headless = true, browserType: BrowserType = 'chromium') {
  const sharedBrowser = await getOrLaunchBrowser(browserType);
  const baseAccountId = getBaseAccountId(account.id);

  console.log(`[Playwright] Creating context for account ${account.email} on shared browser...`);

  const storageState = loadStorageState(baseAccountId);
  const acctProfile = shouldForgeFingerprint() ? getFingerprintProfile(account.id) : null;
  const acctContext = await sharedBrowser.newContext({
    ...sharedContextOptions(account.id),
    ...(storageState ? { storageState } : {}),
  });

  await acctContext.addInitScript(acctProfile ? getStealthScript(acctProfile) : getLoginStealthScript());

  const acctPage = await acctContext.newPage();
  accountContexts.set(account.id, acctContext);
  accountPages.set(account.id, acctPage);

  const hasAuth = await hasValidAuthCookie(acctPage);

  if (!hasAuth && account.email && account.password) {
    await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
  } else if (!hasAuth && account.email && !account.password) {
    // Google OAuth account — no password to use for API re-login.
    // The session must be re-imported from a real browser.
    console.warn(`[Playwright] ${account.email}: No auth cookies and no password stored (Google OAuth?). Session must be re-imported via login.ts [E].`);
  }

  try {
    await acctPage.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
    const url = acctPage.url();
    if (url.includes('auth') || url.includes('login')) {
      // Session expired and redirected to auth page
      if (account.email && account.password) {
        console.log(`[Playwright] Session expired for ${account.email} (redirected to auth), re-logging in...`);
        await acctContext.clearCookies();
        await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
        await acctPage.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
      } else {
        console.warn(`[Playwright] Session expired for ${account.email} — no password stored (Google OAuth?). Re-import session via login.ts [E] or set password via login.ts [P].`);
      }
    } else {
      // URL looks OK — but verify the page actually shows a logged-in state.
      // Qwen does NOT redirect to /auth on session expiry; it stays on
      // chat.qwen.ai/c/... and shows a "Fazer login" button instead.
      const loggedIn = await isPageLoggedIn(acctPage);
      if (loggedIn) {
        console.log(`[Playwright] Session validated for ${account.email}.`);
      } else {
        console.warn(`[Playwright] Session expired for ${account.email} (page shows login button). Re-logging in...`);
        if (account.email && account.password) {
          // Clear stale cookies BEFORE re-login so the new auth tokens
          // from the API signin call are not shadowed by old expired ones.
          await acctContext.clearCookies();
          await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
          await acctPage.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
          const recheck = await isPageLoggedIn(acctPage);
          if (recheck) {
            console.log(`[Playwright] Re-login successful for ${account.email}.`);
          } else {
            console.warn(`[Playwright] Re-login failed for ${account.email} (still showing login button). Manual intervention may be needed.`);
          }
        } else {
          console.warn(`[Playwright] Session expired for ${account.email} — no password stored (Google OAuth?). Re-import session via login.ts [E] or set password via login.ts [P].`);
        }
      }
    }
  } catch (err: any) {
    console.warn(`[Playwright] Failed to validate session for ${account.email}: ${err.message}`);
  }

  if (await hasValidAuthCookie(acctPage)) {
    await saveStorageState(acctContext, baseAccountId);
  }
}

/**
 * Manual login flow: launches a REAL installed browser (or a persistent
 * chromium profile) with a persistent user data dir, so the browser presents
 * a genuine fingerprint (history, localStorage, cache accumulate across runs).
 * This is far less detectable than a fresh ephemeral profile. The login stealth
 * script only removes automation traces and does NOT forge the fingerprint.
 */
export async function launchManualLoginAccount(accountId: string, browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext, page: Page }> {
  const { engine, channel, executablePath } = resolveBrowserEngine(browserType);

  // Stable shared profile dir (not keyed by the per-run UUID) so history,
  // localStorage and cache accumulate across manual logins — a real-browser
  // look instead of a brand-new profile every time.
  const manualProfileDir = path.join(PROFILES_DIR, 'manual_login');
  fs.mkdirSync(manualProfileDir, { recursive: true });

  const acctContext = await engine.launchPersistentContext(manualProfileDir, {
    headless: false,
    channel,
    executablePath,
    ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features'],
    args: getManualLoginLaunchArgs(),
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    viewport: null,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
  });

  await acctContext.addInitScript(getLoginStealthScript());

  // The shared profile keeps history/localStorage/cache (real-browser look),
  // but its stale Qwen session cookies must not leak into the new login:
  // clear them so session detection reflects a genuinely fresh login and
  // saveStorageState persists only the new account's cookies.
  try {
    await acctContext.clearCookies();
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear cookies for manual login: ${err.message}`);
  }

  const acctPage = acctContext.pages()[0] ?? await acctContext.newPage();
  await acctPage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

  return { context: acctContext, page: acctPage };
}

/**
 * Imports a session from the user's OWN real browser already open with
 * --remote-debugging-port. The user logs into chat.qwen.ai in that normal
 * browser window (which TMD does NOT flag — it is a genuine user browser),
 * and we connect over CDP to export the fresh session cookies.
 *
 * IMPORTANT: this does NOT call browser.close() — over CDP that would close
 * the user's real browser. The connection is dropped when the process exits.
 */
export async function importSessionFromRunningBrowser(
  debugPort: number,
  accountId: string,
  baseUrl: string = config.qwen.baseUrl,
): Promise<{ email: string | null, hasSession: boolean }> {
  const cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  try {
    const contexts = cdpBrowser.contexts();
    const ctx = contexts[0] ?? await cdpBrowser.newContext();

    let page = ctx.pages().find(p => !p.isClosed() && p.url().includes('qwen.ai'));
    if (!page) {
      page = await ctx.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
    }

    const hasSession = await hasValidAuthCookie(page);
    if (hasSession) {
      await saveStorageState(ctx, accountId);
    }

    return { email: null, hasSession };
  } finally {
    // Do not close the connected browser — it is the user's real browser.
  }
}

export async function extractAccountInfoFromContext(page: Page): Promise<{ email: string | null, hasSession: boolean }> {
  const cookies = await page.context().cookies();
  const hasSession = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));

  let email: string | null = null;
  if (hasSession) {
    try {
      email = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="user-email"], .user-email, [class*="email"]');
        return el?.textContent?.trim() || null;
      });
    } catch { /* ignore */ }
  }

  return { email, hasSession };
}

export async function closePlaywrightForAccount(accountId: string) {
  const acctContext = accountContexts.get(accountId);
  const acctPage = accountPages.get(accountId);
  if (acctContext) {
    if (await hasValidAuthCookie(acctPage || null)) {
      await saveStorageState(acctContext, accountId);
    }
    await acctContext.close();
    accountContexts.delete(accountId);
    accountPages.delete(accountId);
  }
}

export function getPageForAccount(accountId?: string): Page | null {
  if (accountId === 'guest') return guestPage;
  if (accountId) return accountPages.get(accountId) || null;
  return activePage;
}

/**
 * Navigate a Qwen page to a fresh chat to recover from a stuck/broken state.
 * Returns true if the page was successfully refreshed.
 */
export async function refreshPageToFreshChat(page: Page | null): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  try {
    await page.goto('https://chat.qwen.ai/c/new-chat', {
      waitUntil: 'domcontentloaded',
      timeout: config.timeouts.navigation,
    });
    // Check we didn't land on auth page
    if (page.url().includes('auth') || page.url().includes('login')) {
      console.warn('[Playwright] Page refresh landed on auth page — session may be expired.');
      return false;
    }
    console.log('[Playwright] Page refreshed to fresh chat successfully.');
    return true;
  } catch (err: any) {
    console.warn(`[Playwright] Failed to refresh page: ${err.message}`);
    return false;
  }
}
