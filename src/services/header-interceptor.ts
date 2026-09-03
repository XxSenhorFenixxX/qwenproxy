import { config } from '../core/config.js';
import { getActiveAccountCount } from '../core/account-manager.js';
import { getBaseAccountId } from '../core/account-lanes.js';
import {
  CHROME_UA,
  HEADERS_TTL,
  COOKIE_CACHE_TTL,
  REFRESH_THRESHOLD,
  GUEST_HEADERS_TTL,
  sleep,
  accountContexts,
  accountPages,
  cachedUserAgents,
  cookieCaches,
  getAccountHeaderCache,
  getActivePage,
  getGuestPage,
  getGuestHeadersCache,
  setGuestHeadersCache,
  setGuestContext,
  setGuestPage,
  getOrLaunchBrowser,
  loadStorageState,
  sharedContextOptions,
  getUiMutex,
  resetBrowserProfile,
  initPlaywright,
  initPlaywrightForAccount,
  shouldForgeFingerprint,
  isPageLoggedIn,
  loginToQwenWithContext,
} from './browser-manager.js';
import { getStealthScript, getLoginStealthScript } from './stealth.js';
import { startCaptchaWatcher } from './captcha-solver.js';
import { humanType, humanDelay } from './human-behavior.js';
import { getFingerprintProfile } from './fingerprint.js';

export async function getCookies(accountId?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  const cacheKey = accountId || 'global';
  const now = Date.now();
  const cached = cookieCaches.get(cacheKey);
  if (cached && (now - cached.timestamp) < COOKIE_CACHE_TTL) {
    return cached.cookie;
  }
  const page = accountId ? accountPages.get(accountId) : getActivePage();
  if (!page) return '';
  const cookies = await page.context().cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  cookieCaches.set(cacheKey, { cookie: cookieStr, timestamp: now });
  return cookieStr;
}

export async function getBasicHeaders(accountId?: string): Promise<{ cookie: string, userAgent: string, bxV: string, bxUa?: string, bxUmidtoken?: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return { cookie: 'token=mock', userAgent: 'mock', bxV: '2.5.36', bxUa: 'mock-bx-ua', bxUmidtoken: 'mock-bx-umidtoken' };

  let page = accountId ? accountPages.get(accountId) : getActivePage();
  if (accountId && !page) {
    const { getAccountCredentials } = await import('../core/accounts.js');
    const creds = getAccountCredentials(getBaseAccountId(accountId));
    if (creds) {
      await initPlaywrightForAccount({ ...creds, id: accountId }, config.browser.headless, config.browser.type);
      page = accountPages.get(accountId);
    }
  }

  if (!page) throw new Error('Playwright not initialized');

  const cookie = await getCookies(accountId);
  const cacheKey = accountId || 'global';

  let userAgent = cachedUserAgents.get(cacheKey);
  if (!userAgent) {
    userAgent = await page.evaluate(() => navigator.userAgent);
    cachedUserAgents.set(cacheKey, userAgent);
  }

  const cache = getAccountHeaderCache(cacheKey);
  let bxUa = cache.currentHeaders['bx-ua'];
  let bxUmidtoken = cache.currentHeaders['bx-umidtoken'];
  const bxV = cache.currentHeaders['bx-v'] || '2.5.36';

  if (!bxUa || !bxUmidtoken) {
    console.log(`[Playwright] Missing bx-ua/bx-umidtoken for ${cacheKey}, triggering header interception...`);
    try {
      const result = await getQwenHeaders(true, accountId);
      bxUa = result.headers['bx-ua'];
      bxUmidtoken = result.headers['bx-umidtoken'];
      return {
        cookie: await getCookies(accountId),
        userAgent,
        bxV: result.headers['bx-v'] || bxV,
        bxUa,
        bxUmidtoken,
      };
    } catch (err: any) {
      console.warn(`[Playwright] Failed to auto-recover headers for ${cacheKey}: ${err.message}`);
    }
  }

  return { cookie, userAgent, bxV, bxUa, bxUmidtoken };
}

export async function getGuestHeaders(): Promise<Record<string, string>> {
  const cached = getGuestHeadersCache();
  if (cached && (Date.now() - cached.timestamp) < GUEST_HEADERS_TTL) {
    return cached.headers;
  }

  let guestPage = getGuestPage();
  if (!guestPage) {
    const sharedBrowser = await getOrLaunchBrowser(config.browser.type);
    const storageState = loadStorageState('_guest');
    const guestProfile = shouldForgeFingerprint() ? getFingerprintProfile('_guest') : null;
    const guestCtx = await sharedBrowser.newContext({
      ...sharedContextOptions('_guest'),
      ...(storageState ? { storageState } : {}),
    });
    await guestCtx.addInitScript(guestProfile ? getStealthScript(guestProfile) : getLoginStealthScript());
    setGuestContext(guestCtx);
    guestPage = await guestCtx.newPage();
    setGuestPage(guestPage);

    await guestPage.goto('https://chat.qwen.ai/c/guest', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });

    try {
      const keepSessionBtn = await guestPage.$('button:has-text("Manter sessão terminada"), button:has-text("Keep session ended"), button:has-text("Manter sessão encerrada")');
      if (keepSessionBtn) {
        await keepSessionBtn.click();
        console.log('[Playwright] Guest: Clicked "Manter sessão terminada"');
        await sleep(1000);
      }
    } catch { /* ignore popup errors */ }
  }

  const watcher = startCaptchaWatcher(guestPage!, config.timeouts.headers);
  try {
    return await new Promise<Record<string, string>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        resetBrowserProfile('guest', 'guest')
          .catch((err: any) => console.warn(`[Playwright] Failed to reset guest profile after timeout: ${err.message}`))
          .finally(() => reject(new Error('Timeout getting guest headers')));
      }, config.timeouts.headers);

      const routeHandler = async (route: any, request: any) => {
        clearTimeout(timeout);
        const reqHeaders = request.headers();
        console.log('[Playwright] Guest intercepted request:', request.url());

        const extractedHeaders = {
          'cookie': reqHeaders['cookie'] || '',
          'bx-ua': reqHeaders['bx-ua'] || '',
          'bx-umidtoken': reqHeaders['bx-umidtoken'] || '',
          'bx-v': reqHeaders['bx-v'] || '2.5.36',
          'user-agent': reqHeaders['user-agent'] || CHROME_UA,
        };

        if (extractedHeaders['bx-ua']) {
          console.log('[Playwright] Guest: Successfully captured bx-ua');
          setGuestHeadersCache({ headers: extractedHeaders, timestamp: Date.now() });
          await route.abort('aborted');
          await guestPage!.unroute('**/api/v2/chat/completions*', routeHandler);

          import('./qwen.js').then(m => m.disableNativeTools('guest').catch(() => {}));

          resolve(extractedHeaders);
        } else {
          console.log('[Playwright] Guest: Request missing bx-ua, continuing route. Headers:', Object.keys(reqHeaders));
          await route.continue();
          if (request.url().includes('/api/v2/chat/completions')) {
             await guestPage!.unroute('**/api/v2/chat/completions*', routeHandler);
             reject(new Error('Guest completions request was missing bx-ua; refusing to cache inconsistent anti-bot headers.'));
          }
        }
      };

      guestPage!.route('**/api/v2/chat/completions*', routeHandler).then(async () => {
        const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
        try {
          await guestPage!.waitForSelector(inputSelector, { timeout: config.timeouts.page });
          await humanType(guestPage!, inputSelector, 'Hello');
          await sleep(humanDelay(800, 1500));

          const selectors = ['.message-input-right-button-send .send-button', '.chat-prompt-send-button', 'button.send-button'];
          let clicked = false;
          for (const selector of selectors) {
            const btn = await guestPage!.$(selector);
            if (btn && await btn.isVisible()) {
              await btn.click({ force: true, delay: 50 }).catch(() => {});
              clicked = true;
              break;
            }
          }
          if (!clicked) {
            await guestPage!.keyboard.press('Enter');
          }
        } catch (e) {
          clearTimeout(timeout);
          reject(e);
        }
      });
    });
  } finally {
    watcher.stop();
  }
}

export async function getQwenHeaders(forceNew = false, accountId?: string): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  if (accountId === 'guest') {
    const headers = await getGuestHeaders();
    return { headers, chatSessionId: 'guest-session', parentMessageId: null };
  }

  const cacheKey = accountId || 'global';
  const cache = getAccountHeaderCache(cacheKey);

  if (!forceNew && cache.cachedQwenHeaders) {
    const age = Date.now() - cache.lastHeadersTime;
    if (age < HEADERS_TTL) {
      if (config.headers.backgroundRefresh && age > HEADERS_TTL * REFRESH_THRESHOLD && !cache.refreshInProgress) {
        cache.refreshInProgress = true;
        getQwenHeaders(true, accountId).catch((err) => {
          console.warn(`[Playwright] Background header refresh failed for ${cacheKey}:`, (err as Error).message);
        }).finally(() => {
          cache.refreshInProgress = false;
        });
      }
      return cache.cachedQwenHeaders;
    }
  }

  const release = await getUiMutex(cacheKey).acquire();
  try {
    if (!forceNew && cache.cachedQwenHeaders && (Date.now() - cache.lastHeadersTime < HEADERS_TTL)) {
      return cache.cachedQwenHeaders;
    }
    return await _getQwenHeadersInternal(forceNew, accountId);
  } finally {
    release();
  }
}

async function tryLightweightCookieRefresh(accountId?: string): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null> {
  const cacheKey = accountId || 'global';
  const cache = getAccountHeaderCache(cacheKey);

  const page = accountId ? accountPages.get(accountId) : getActivePage();
  if (!page) return null;

  try {
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    let userAgent = cachedUserAgents.get(cacheKey);
    if (!userAgent) {
      userAgent = await page.evaluate(() => navigator.userAgent);
      cachedUserAgents.set(cacheKey, userAgent);
    }

    const now = Date.now();
    cookieCaches.set(cacheKey, { cookie: cookieStr, timestamp: now });

    if (cache.cachedQwenHeaders && cache.currentHeaders.cookie) {
      const updatedHeaders = {
        ...cache.cachedQwenHeaders.headers,
        cookie: cookieStr,
        'user-agent': userAgent,
      };
      cache.cachedQwenHeaders = {
        ...cache.cachedQwenHeaders,
        headers: updatedHeaders,
      };
      cache.lastHeadersTime = now;
      cache.currentHeaders = {
        ...cache.currentHeaders,
        cookie: cookieStr,
        'user-agent': userAgent,
      };
      return cache.cachedQwenHeaders;
    }
  } catch { /* ignore cache read errors */ }

  return null;
}

async function _getQwenHeadersInternal(forceNew = false, accountId?: string): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  try {
    return await _getQwenHeadersInternalOnce(forceNew, accountId);
  } catch (err: any) {
    const cacheKey = accountId || 'global';
    if (!forceNew && err?.message?.includes('Timeout waiting for Qwen headers for')) {
      console.warn(`[Playwright] Header capture timed out for ${cacheKey}; clearing browser profile and retrying once...`);
      await resetBrowserProfile(cacheKey, accountId);
      if (!accountId && getActiveAccountCount() === 0) {
        await initPlaywright(config.browser.headless, config.browser.type);
      }
      return await _getQwenHeadersInternalOnce(true, accountId);
    }
    throw err;
  }
}

async function _getQwenHeadersInternalOnce(forceNew = false, accountId?: string): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  const cacheKey = accountId || 'global';
  const cache = getAccountHeaderCache(cacheKey);

  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return {
      headers: {
        'authorization': 'Bearer MOCK',
        'cookie': 'token=mock',
        'user-agent': 'mock',
        'bx-v': '2.5.36',
        'bx-ua': 'mock-bx-ua',
        'bx-umidtoken': 'mock-bx-umidtoken'
      },
      chatSessionId: mockSessionId,
      parentMessageId: null
    };
  }

  if (!forceNew && cache.cachedQwenHeaders) {
    const lightResult = await tryLightweightCookieRefresh(accountId);
    if (lightResult) {
      return lightResult;
    }
  }

  if (accountId && !accountPages.has(accountId)) {
    const { getAccountCredentials } = await import('../core/accounts.js');
    const creds = getAccountCredentials(getBaseAccountId(accountId));
    if (creds) {
      await initPlaywrightForAccount({ ...creds, id: accountId }, config.browser.headless, config.browser.type);
    }
  }

  const page = accountId ? accountPages.get(accountId) : getActivePage();
  if (!page) {
    throw new Error(`Playwright not initialized for account: ${cacheKey}`);
  }

  const currentUrl = page.url();
  const isOnQwen = currentUrl.includes('chat.qwen.ai');
  const _isOnSpecificChat = isOnQwen && /\/c\//.test(currentUrl);

  if (!isOnQwen) {
    console.log(`[Playwright] Navigating to stable Qwen new-chat page for ${cacheKey}... (Current: ${currentUrl})`);
    await page.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded' });
  }

  const isLoginPage = page.url().includes('login') || (await page.$('input[type="email"], input[placeholder*="Email"]'));
  if (isLoginPage) {
    if (!accountId) {
      const email = process.env.QWEN_EMAIL;
      const password = process.env.QWEN_PASSWORD;

      if (email && password) {
        console.log('[Playwright] Detected login page. Attempting automated login...');
        try {
          const { loginToQwen } = await import('./browser-manager.js');
          const loggedIn = await loginToQwen(email, password);
          if (!loggedIn) {
            throw new Error('loginToQwen returned false');
          }
          console.log('[Playwright] Automated login successful.');
        } catch (err: any) {
          console.error('[Playwright] Automated login failed:', err.message);
        }
      } else {
        console.warn('[Playwright] Detected login page but QWEN_EMAIL/PASSWORD not provided in .env');
      }
    } else {
      const { getAccountCredentials } = await import('../core/accounts.js');
      const creds = getAccountCredentials(getBaseAccountId(accountId));
      if (creds && creds.email && creds.password) {
        console.log(`[Playwright] Detected login page for account ${creds.email}. Attempting login...`);
        const acctContext = accountContexts.get(accountId);
        if (acctContext) {
          // Clear stale cookies BEFORE re-login to avoid conflicts
          await acctContext.clearCookies();
          const pageForLogin = accountPages.get(accountId);
          if (pageForLogin) {
            await loginToQwenWithContext(acctContext, pageForLogin, creds.email, creds.password);
          }
        }
      }
    }
  }

  // CRITICAL: Check if the page is actually logged in. Qwen does NOT redirect
  // to /auth on session expiry — it stays on chat.qwen.ai and shows a
  // "Fazer login" button. The isLoginPage check above only catches actual
  // auth redirects and email input fields, NOT this guest-mode state.
  const loggedIn = true; // DISABLED
  if (!loggedIn && accountId) {
    console.warn(`[Playwright] Page not logged in for ${cacheKey} (login button visible). Re-logging in...`);
    const { getAccountCredentials } = await import('../core/accounts.js');
    const creds = getAccountCredentials(getBaseAccountId(accountId));
    if (creds && creds.email && creds.password) {
      const acctContext = accountContexts.get(accountId);
      if (acctContext) {
        // Clear stale cookies BEFORE re-login so new auth tokens are not shadowed
        await acctContext.clearCookies();
        await loginToQwenWithContext(acctContext, page, creds.email, creds.password);
        await page.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
        const recheck = await isPageLoggedIn(page);
        if (recheck) {
          console.log(`[Playwright] Re-login successful for ${cacheKey}.`);
        } else {
          console.warn(`[Playwright] Re-login failed for ${cacheKey}. Headers capture may fail.`);
        }
      }
    } else {
      console.warn(`[Playwright] No password stored for ${cacheKey} (Google OAuth?). Re-import session via login.ts [E] or set password via login.ts [P].`);
    }
  } else if (!loggedIn && !accountId) {
    const email = process.env.QWEN_EMAIL;
    const password = process.env.QWEN_PASSWORD;
    if (email && password) {
      console.log('[Playwright] Guest mode detected for default account. Attempting login...');
      try {
        const { loginToQwen } = await import('./browser-manager.js');
        await loginToQwen(email, password);
      } catch (err: any) {
        console.error('[Playwright] Guest mode login failed:', err.message);
      }
    }
  }

  console.log(`[Playwright] Waiting for chat input for ${cacheKey}...`);
  const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
  await page.waitForSelector(inputSelector, { timeout: config.timeouts.page }).catch(() => {
    console.error(`[Playwright] Chat input not found for ${cacheKey}. Current URL:`, page.url());
    throw new Error(`Timeout waiting for chat input for ${cacheKey}. Are you logged in?`);
  });

  const watcher = startCaptchaWatcher(page, config.timeouts.headers);
  try {
    return await new Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }>((resolve, reject) => {
      const timeout = setTimeout(async () => {
        console.error(`[Playwright] Timeout waiting for Qwen headers for ${cacheKey}. Current URL:`, page.url());
        try {
          const path = await import('path');
          const { PROFILES_DIR } = await import('./browser-manager.js');
          const screenshotPath = path.join(PROFILES_DIR, `error_${cacheKey}.png`);
          await page.screenshot({ path: screenshotPath });
          console.log(`[Playwright] Error screenshot saved to ${screenshotPath}`);
        } catch (err: any) {
          console.error('[Playwright] Failed to save error screenshot:', err.message);
        }
        reject(new Error(`Timeout waiting for Qwen headers for ${cacheKey}`));
      }, config.timeouts.headers);

      console.log(`[Playwright] Setting up route interception for ${cacheKey}...`);
      const routeHandler = async (route: any, request: any) => {
        const reqHeaders = request.headers();
        let uiSessionId = '';
        let uiParentMessageId: string | null = null;

        const postData = request.postData();
        if (postData) {
          try {
            const payload = JSON.parse(postData);
            if (payload.chat_id) {
              uiSessionId = payload.chat_id;
            }
            if (payload.parent_id !== undefined) {
              uiParentMessageId = payload.parent_id;
            }
          } catch { /* ignore parse errors */ }
        }

        const extractedHeaders = {
          'cookie': reqHeaders['cookie'] || '',
          'bx-ua': reqHeaders['bx-ua'] || '',
          'bx-umidtoken': reqHeaders['bx-umidtoken'] || '',
          'bx-v': reqHeaders['bx-v'] || '',
          'x-request-id': reqHeaders['x-request-id'] || '',
          'user-agent': reqHeaders['user-agent'] || ''
        };

        if (!extractedHeaders.cookie || !extractedHeaders['bx-ua']) {
          console.log(`[Playwright] Intercepted request missing critical headers for ${cacheKey}, skipping...`);
          await route.continue();
          return;
        }

        clearTimeout(timeout);

        console.log(`[Playwright] Successfully intercepted headers for ${cacheKey}.`);
        cache.currentHeaders = extractedHeaders;
        cache.cachedQwenHeaders = { headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId };
        cache.lastHeadersTime = Date.now();
        cache.refreshInProgress = false;

        import('./qwen.js').then(m => m.disableNativeTools(accountId).catch(() => {}));

        await route.abort('aborted');

        await page.unroute('**/api/v2/chat/completions*', routeHandler);

        resolve(cache.cachedQwenHeaders);
      };

      page.route('**/api/v2/chat/completions*', routeHandler).then(async () => {
        try {
          console.log(`[Playwright] Triggering request for ${cacheKey}...`);
          const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';

          await humanType(page, inputSelector, 'Hello');
          console.log(`[Playwright] Typed human text for ${cacheKey}, waiting for UI to update...`);
const inputEl = await page.$(inputSelector);
const textareaValue = await page.evaluate((sel) => { const el = document.querySelector(sel) as HTMLTextAreaElement; return el ? el.value : "NOT_FOUND"; }, inputSelector).catch(() => "eval failed");
          // DOM CHECK
          const domInfo = await page.evaluate(() => {
            const textareas = document.querySelectorAll('textarea');
            const editables = document.querySelectorAll('[contenteditable="true"]');
            const sendBtns = document.querySelectorAll('.send-button, .chat-prompt-send-button, [class*="send"]');
            const loginBtns = document.querySelectorAll('button');
            const loginTexts = Array.from(loginBtns).map(b => b.textContent?.trim()).filter(t => t && (t.includes('login') || t.includes('Login') || t.includes('sign')));
            return {
              url: window.location.href,
              title: document.title,
              textareas: textareas.length,
              editables: editables.length,
              sendBtns: sendBtns.length,
              loginTexts: loginTexts.slice(0, 5),
              bodyText: document.body.innerText.substring(0, 300)
            };
          }).catch(e => ({error: e.message}));
          await sleep(humanDelay(1500, 2500));

          const selectors = [
            '.message-input-right-button-send .send-button',
            '.chat-prompt-send-button',
            'button.send-button'
          ];

          let clicked = false;
          for (const selector of selectors) {
            try {
              const btn = await page.$(selector);
              if (btn && await btn.isVisible()) {
                console.log(`[Playwright] Attempting click on: ${selector}`);

                await page.evaluate((sel) => {
                  const element = document.querySelector(sel) as HTMLElement;
                  if (element) {
                    element.focus();
                    element.click();
                  }
                }, selector);

                await btn.click({ force: true, delay: humanDelay(30, 80) }).catch(() => {});

              // DIAGNÓSTICO: verificar estado pós-clique
              const errorText = await page.evaluate(() => {
                const err = document.querySelector(".error-message, .toast-error, [role=alert]");
                return err ? err.textContent : "no error element";
              }).catch(() => "eval failed");
              const hasNetworkActivity = await page.evaluate(() => {
                return (performance.getEntriesByType("resource") as any[]).filter(r => r.name.includes("chat/completions")).length;
              }).catch(() => 0);

                clicked = true;
                break;
              }
            } catch (e) {
              console.error(`[Playwright] Error clicking ${selector} for ${cacheKey}:`, e);
            }
          }

          if (!clicked) {
            console.log(`[Playwright] No send button found/clicked for ${cacheKey}, fallback to Enter...`);
            try {
              await page.focus(inputSelector);
              await page.keyboard.press('Enter');
            } catch (enterErr: any) {
              console.error(`[Playwright] Failed to press Enter for ${cacheKey}: ${enterErr.message}`);
            }
          }
        } catch (triggerErr: any) {
          console.error(`[Playwright] Header trigger failed for ${cacheKey}: ${triggerErr.message}`);
        }
      });
    });
  } finally {
    watcher.stop();
  }
}
