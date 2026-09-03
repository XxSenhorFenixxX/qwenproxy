export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

const RATE_LIMIT_MESSAGE_SIGNALS = [
  'ratelimited',
  'rate limited',
  'rate-limit',
  'too many requests',
  'upper limit',
  'daily limit',
  'usage limit',
  'limit for today',
  'quota exceeded',
];

function messageIsRateLimit(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes('429')) return true;
  return RATE_LIMIT_MESSAGE_SIGNALS.some(signal => lower.includes(signal));
}

/**
 * Detects a rate-limit condition from ANY error shape: QwenUpstreamError
 * fields (upstreamCode/upstreamStatus), plain HTTP 429, or the message text.
 * Qwen sometimes reports the daily limit with non-canonical codes or non-JSON
 * bodies, so we cannot rely on `code === 'RateLimited'` alone.
 */
export function isRateLimitError(err: any): boolean {
  if (!err) return false;
  if (err.upstreamStatus === 429) return true;
  // NOTE: deliberately does NOT match bare "limit" — Qwen also uses *limit*
  // codes for per-request context-length errors, which must not lock an account.
  // Message-based signals below still catch daily-limit wordings like
  // "upper limit for today's usage".
  if (err.upstreamCode && /ratelimited|too.?many|quota/i.test(String(err.upstreamCode))) return true;
  return messageIsRateLimit(String(err.message || ''));
}

/**
 * Extracts the cooldown duration from a rate-limit error message.
 * Qwen signals the daily-limit wait as "Wait about N hour(s) before trying again."
 */
export function getRateLimitHintHours(message?: string): number | null {
  if (!message) return null;
  const hint = String(message).match(/Wait about (\d+)\s*hour/i);
  return hint ? parseInt(hint[1], 10) : null;
}

export function classifyErrorStatus(code: string): number {
  if (code === 'RateLimited' || /ratelimited|too.?many|quota/i.test(code)) return 429;
  if (code === 'Not_Found') return 404;
  return 502;
}

export function handleErrorBody(peekText: string, status: number): never {
  try {
    const errorJson = JSON.parse(peekText);
    if (errorJson && (errorJson.success === false || errorJson.error)) {
      const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
      const details = errorJson.data?.details || errorJson.message || errorJson.error?.message || 'Qwen returned an error';
      const wait = errorJson.data?.num !== undefined ? ` Wait about ${errorJson.data.num} hour(s) before trying again.` : '';
      const errStatus = classifyErrorStatus(code);
      throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, errStatus);
    }
  } catch (e) {
    if (e instanceof QwenUpstreamError) throw e;
  }
  throw new Error(`Qwen returned status ${status}: ${peekText.slice(0, 500)}`);
}

export function handleJsonErrorBody(errText: string): never {
  try {
    const errorJson = JSON.parse(errText);
    if (errorJson?.data?.details?.includes('chat is in progress') || errorJson?.data?.details?.includes('The chat is in progress')) {
      const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
      throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, retryAfterMs);
    }
    if (errorJson?.success === false) {
      const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
      const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
      const wait = errorJson.data?.num !== undefined ? ` Wait about ${errorJson.data.num} hour(s) before trying again.` : '';
      throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, classifyErrorStatus(code));
    }
    if (errorJson?.data?.details?.includes('is not exist') || errorJson?.data?.details?.includes('not exist') || errorJson.data?.details?.includes('does not exist')) {
      throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, 0);
    }
  } catch (e) {
    if (e instanceof RetryableQwenStreamError || e instanceof QwenUpstreamError) throw e;
  }
  throw new Error(`Qwen JSON error: ${errText.slice(0, 500)}`);
}
