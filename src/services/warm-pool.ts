import { getBasicHeaders, getPageForAccount } from './playwright.js';
import { markAccountRateLimitedByMessage } from '../core/account-manager.js';
import { isRateLimitError } from './error-handler.js';
import { config } from '../core/config.js';
import { QwenUpstreamError } from './error-handler.js';
import type { Page } from 'playwright';
import crypto from 'crypto';

const CACHED_TIMEZONE = new Date().toString().split(' (')[0];
const QWEN_WEB_VERSION = '0.2.66';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface WarmPoolEntry {
  chatId: string;
  headers: Record<string, string>;
  accountId: string;
  timestamp: number;
}

const warmPool: Map<string, WarmPoolEntry[]> = new Map();

const inFlightWarmChats = new Set<string>();

const refillPromises: Map<string, Promise<void>> = new Map();

// Resolvers waiting for the FIRST chat of a pool to become available. The
// refill pushes chats one at a time; a request that finds the pool empty should
// resume as soon as ONE chat exists instead of awaiting the whole refill
// (which creates N chats sequentially with 300-1000ms sleeps between them).
const firstChatWaiters = new Map<string, Set<() => void>>();

function notifyChatAvailable(accountId: string): void {
  const waiters = firstChatWaiters.get(accountId);
  if (!waiters) return;
  firstChatWaiters.delete(accountId);
  for (const resolve of waiters) resolve();
}

function waitForFirstChat(accountId: string, timeoutMs: number): Promise<void> {
  const pool = warmPool.get(accountId);
  if (pool && pool.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const waiters = firstChatWaiters.get(accountId);
      if (waiters) {
        waiters.delete(resolve);
        if (waiters.size === 0) firstChatWaiters.delete(accountId);
      }
      resolve();
    }, timeoutMs);
    timer.unref?.();
    let waiters = firstChatWaiters.get(accountId);
    if (!waiters) { waiters = new Set(); firstChatWaiters.set(accountId, waiters); }
    waiters.add(resolve);
  });
}

const WARM_POOL_SIZE = config.warmPool.size;
const WARM_POOL_TTL_MS = config.warmPool.ttlMs;
const WARM_POOL_LOW_WATER = config.warmPool.lowWater;

function cleanupStalePool(accountId: string) {
  const pool = warmPool.get(accountId);
  if (!pool) return;
  const now = Date.now();
  const filtered = pool.filter(e => now - e.timestamp <= WARM_POOL_TTL_MS);
  if (filtered.length !== pool.length) warmPool.set(accountId, filtered);
}

function warmChatKey(accountId: string, chatId: string) {
  return `${accountId}:${chatId}`;
}

function markWarmChatInFlight(accountId: string, chatId: string) {
  inFlightWarmChats.add(warmChatKey(accountId, chatId));
}

export function releaseWarmChat(accountId: string, chatId: string) {
  inFlightWarmChats.delete(warmChatKey(accountId, chatId));
}

function isWarmChatInFlight(accountId: string, chatId: string) {
  return inFlightWarmChats.has(warmChatKey(accountId, chatId));
}

async function getBasicQwenHeaders(accountId?: string): Promise<Record<string, string>> {
  const { cookie, userAgent, bxV, bxUa, bxUmidtoken } = await getBasicHeaders(accountId);
  if (!cookie || !userAgent || !bxV || !bxUa || !bxUmidtoken) {
    throw new Error('Missing required browser anti-bot headers for warm pool');
  }
  return {
    cookie,
    'user-agent': userAgent,
    'bx-v': bxV,
    'bx-ua': bxUa,
    'bx-umidtoken': bxUmidtoken,
  };
}

async function browserJsonFetch<T>(page: Page, url: string, options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; body: string; json: T | null }> {
  return await page.evaluate(async ({ url, options }) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        signal: controller.signal,
      });
      const body = await response.text();
      let json = null;
      try { json = JSON.parse(body); } catch { /* not json */ }
      return { status: response.status, body, json };
    } finally {
      clearTimeout(timeoutId);
    }
  }, { url, options });
}

async function createRealQwenChat(header: Record<string, string>, accountId?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return process.env.TEST_SESSION_ID || `mock-chat-${crypto.randomUUID()}`;
  }

  const page = getPageForAccount(accountId);
  const body = JSON.stringify({
    title: 'Nova Conversa',
    models: ['qwen3.8-max'],
    chat_mode: 'normal',
    chat_type: 't2t',
    timestamp: Date.now(),
    project_id: '',
  });

  const pageUrl = page?.url() || '';
  const isOnQwenOrigin = pageUrl.includes('chat.qwen.ai');

  if (page && !page.isClosed() && isOnQwenOrigin) {
    try {
      const result = await browserJsonFetch<any>(page, 'https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-request-id': crypto.randomUUID(),
          'timezone': CACHED_TIMEZONE,
          'version': QWEN_WEB_VERSION,
          'source': 'web',
        },
        body,
        timeoutMs: config.timeouts.http,
      });

      if (result.status === 429) {
        throw new QwenUpstreamError('Qwen upstream error: RateLimited: Too many requests.', 'RateLimited', 429);
      }
      if (!result.status || result.status >= 400) {
        throw new Error(`Failed to create chat: ${result.status} - ${result.body}`);
      }
      const json = result.json ?? JSON.parse(result.body);
      if (json && json.success === false) {
        const code = json.data?.code || json.code || 'UpstreamError';
        const details = json.data?.details || json.message || 'Qwen returned an error';
        const wait = json.data?.num !== undefined ? ` Wait about ${json.data.num} hour(s) before trying again.` : '';
        let status = 502;
        if (code === 'RateLimited') status = 429;
        throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, status);
      }
      const chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
      if (!chatId) throw new Error(`Unexpected chat response: ${JSON.stringify(json).slice(0, 200)}`);
      return chatId;
    } catch (err: any) {
      if (err instanceof QwenUpstreamError) throw err;
      throw new Error(`Browser chat creation failed with active Qwen page: ${err.message}`, { cause: err });
    }
  }

  throw new Error(`Cannot create Qwen chat outside an active Qwen browser page for ${accountId || 'global'}. Refusing direct fetch to avoid TMD challenge.`);
}

async function fetchUnusedChats(headers: Record<string, string>, accountId?: string): Promise<string[]> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return [];

  const page = getPageForAccount(accountId);
  const url = 'https://chat.qwen.ai/api/v2/chats/?page=1&exclude_project=true';
  const reqHeaders: Record<string, string> = {
    'accept': 'application/json, text/plain, */*',
    'x-request-id': crypto.randomUUID(),
    'timezone': CACHED_TIMEZONE,
    'source': 'web',
  };

  let body = '';
  if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
    try {
      const result = await browserJsonFetch<any>(page, url, {
        method: 'GET',
        headers: reqHeaders,
        timeoutMs: config.timeouts.http,
      });
      if (result.status && result.status < 400) {
        body = result.body;
      }
    } catch (err: any) {
      console.warn('[WarmPool] Isolated browser fetch failed for chat list with active Qwen context:', err.message);
      return [];
    }
  }

  if (!body) return [];

  try {
    const json = JSON.parse(body);
    if (!json.success || !Array.isArray(json.data)) return [];
    const unused: string[] = [];
    for (const chat of json.data) {
      if (chat.title === 'Nova Conversa' && chat.created_at === chat.updated_at) {
        unused.push(chat.id);
      }
    }
    return unused;
  } catch {
    return [];
  }
}

async function refillPoolForAccount(accountId: string) {
  let pool = warmPool.get(accountId);
  if (!pool) { pool = []; warmPool.set(accountId, pool); }
  cleanupStalePool(accountId);
  const need = Math.max(0, WARM_POOL_SIZE - pool.length);
  if (need === 0) return;

  let headers: Record<string, string>;
  try {
    const acctId = accountId === 'global' ? undefined : accountId;
    headers = await getBasicQwenHeaders(acctId);
  } catch (err) {
    console.error(`[WarmPool] header fetch failed for ${accountId}:`, (err as Error).message);
    return;
  }

  const acctId = accountId === 'global' ? undefined : accountId;
  const existingIds = new Set(pool.map(e => e.chatId));

  let reused = 0;
  try {
    const unusedChats = await fetchUnusedChats(headers, acctId);
    for (const chatId of unusedChats) {
      if (reused >= need) break;
      if (existingIds.has(chatId)) continue;
      if (isWarmChatInFlight(accountId, chatId)) continue;
      pool.push({ chatId, headers, accountId, timestamp: Date.now() });
      existingIds.add(chatId);
      reused++;
      notifyChatAvailable(accountId);
    }
    if (reused > 0) {
      console.log(`[WarmPool] Reused ${reused} existing unused chats for ${accountId}`);
    }
  } catch (err: any) {
    console.warn(`[WarmPool] Failed to fetch unused chats for ${accountId}:`, err.message);
  }

  const stillNeed = Math.max(0, need - reused);
  for (let i = 0; i < stillNeed; i++) {
    if (i > 0) {
      await sleep(300 + Math.floor(Math.random() * 700));
    }
    try {
      const chatId = await createRealQwenChat(headers, acctId);
      pool.push({ chatId, headers, accountId, timestamp: Date.now() });
      notifyChatAvailable(accountId);
    } catch (err: any) {
      if (isRateLimitError(err)) {
        markAccountRateLimitedByMessage(accountId, err.message, 'RateLimited');
        console.warn(`[WarmPool] Account ${accountId} rate-limited during chat creation. Marked for cooldown.`);
        break;
      }
      console.error(`[WarmPool] chat creation failed for ${accountId}:`, (err as Error).message);
    }
  }
}

export async function getWarmedChat(accountId?: string) {
  if (WARM_POOL_SIZE <= 0) {
    const acctId = accountId === 'global' ? undefined : accountId;
    const headers = await getBasicQwenHeaders(acctId);
    const chatId = await createRealQwenChat(headers, acctId);
    const key = accountId || 'global';
    markWarmChatInFlight(key, chatId);
    return { chatId, headers, accountId: key, timestamp: Date.now() };
  }

  const key = accountId || 'global';
  let pool = warmPool.get(key);
  if (!pool) { pool = []; warmPool.set(key, pool); }
  cleanupStalePool(key);

  if (pool.length < WARM_POOL_LOW_WATER && !refillPromises.has(key)) {
    refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
  }

  if (pool.length === 0) {
    // Resume as soon as the FIRST chat is ready — not after the whole pool
    // refills (which creates N chats sequentially with sleeps between them).
    // Race the first-chat notification against the refill promise settling so
    // a FAILED refill (e.g. header fetch error) fails fast instead of making
    // waiters sit for the full timeout. Give it two attempts: the refill may
    // transiently fail on the first try (old code also retried once).
    for (let attempt = 0; attempt < 2; attempt++) {
      let refillPromise = refillPromises.get(key);
      if (!refillPromise) {
        refillPromise = refillPoolForAccount(key).finally(() => refillPromises.delete(key));
        refillPromises.set(key, refillPromise);
      }
      await Promise.race([
        waitForFirstChat(key, 20000),
        refillPromise.then(() => undefined, () => undefined),
      ]);
      if (pool.length > 0) break;
    }
  }
  if (pool.length === 0) throw new Error(`Warm pool empty after refill for ${key}`);
  const entry = pool.shift()!;
  markWarmChatInFlight(key, entry.chatId);
  return entry;
}

export async function warmAllPools(accountIds: string[]) {
  if (!config.warmPool.startup || WARM_POOL_SIZE <= 0) return;
  for (const id of accountIds) refillPoolForAccount(id).catch(() => {});
}
