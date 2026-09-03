export type { BrowserType } from './browser-manager.js';
export {
  CHROME_UA,
  CHROME_CLIENT_HINTS,
  Mutex,
  activePage,
  resolveBrowserEngine,
  resolveBraveExecutable,
  initPlaywright,
  closePlaywright,
  loginToQwen,
  initPlaywrightForAccount,
  launchManualLoginAccount,
  extractAccountInfoFromContext,
  closePlaywrightForAccount,
  getPageForAccount,
  saveStorageState,
  importSessionFromRunningBrowser,
  refreshPageToFreshChat,
} from './browser-manager.js';

export {
  getCookies,
  getBasicHeaders,
  getGuestHeaders,
  getQwenHeaders,
} from './header-interceptor.js';

export {
  browserFetch,
  browserStreamFetch,
  hasStuckEvals,
  cleanupPageEvals,
} from './stream-bridge.js';

export { getStealthScript, getLoginStealthScript } from './stealth.js';
export { solveBaxiaCaptcha, startCaptchaWatcher } from './captcha-solver.js';
