import { classifyErrorStatus } from '../services/error-handler.js';

export interface DeltaResult {
  delta: string;
  matchedContent: string;
  contentLength: number;
  contentSuffix: string;
}

export function getIncrementalDelta(oldStr: string, newStr: string, prevLength: number = 0, prevSuffix: string = ''): DeltaResult {
  if (!oldStr) {
    return {
      delta: newStr,
      matchedContent: newStr,
      contentLength: newStr.length,
      contentSuffix: newStr.slice(-64)
    };
  }
  if (newStr === oldStr) {
    return { delta: '', matchedContent: oldStr, contentLength: prevLength, contentSuffix: prevSuffix };
  }

  if (newStr.length > prevLength && prevLength > 0) {
    // Fast-path (O(1)): pure append. Qwen streams with incremental_output=true,
    // so the vast majority of chunks are strict appends. Verify by comparing a
    // short suffix window instead of scanning the whole accumulated content.
    const delta = newStr.slice(prevLength);
    const checkLen = Math.min(32, prevLength);
    const expectedSuffix = prevSuffix.slice(-checkLen);
    const actualSuffix = newStr.slice(prevLength - checkLen, prevLength);

    if (expectedSuffix === actualSuffix) {
      return {
        delta,
        matchedContent: newStr,
        contentLength: newStr.length,
        contentSuffix: newStr.slice(-64)
      };
    }
  }

  if (newStr.startsWith(oldStr)) {
    const delta = newStr.slice(oldStr.length);
    return {
      delta,
      matchedContent: newStr,
      contentLength: newStr.length,
      contentSuffix: newStr.slice(-64)
    };
  }

  const scanWindow = Math.min(2000, oldStr.length);
  const maxLen = Math.min(scanWindow, newStr.length);

  let commonPrefixLen = 0;
  const segmentLen = 64;
  while (commonPrefixLen + segmentLen <= maxLen) {
    if (oldStr.slice(commonPrefixLen, commonPrefixLen + segmentLen) !==
        newStr.slice(commonPrefixLen, commonPrefixLen + segmentLen)) {
      break;
    }
    commonPrefixLen += segmentLen;
  }

  while (commonPrefixLen < maxLen && oldStr[commonPrefixLen] === newStr[commonPrefixLen]) {
    commonPrefixLen++;
  }

  const threshold = Math.min(scanWindow, 4);
  if (commonPrefixLen >= threshold) {
    return {
      delta: newStr.substring(commonPrefixLen),
      matchedContent: newStr,
      contentLength: newStr.length,
      contentSuffix: newStr.slice(-64)
    };
  }

  const combined = oldStr + newStr;
  return {
    delta: newStr,
    matchedContent: combined,
    contentLength: combined.length,
    contentSuffix: combined.slice(-64)
  };
}

/**
 * Extracts a Qwen error from an already-parsed JSON payload (SSE chunk or full
 * body). Returns null when the payload is not an error. Shared by the tail-buffer
 * check and mid-stream chunk inspection so every error surface is detected once.
 */
export function parseQwenErrorObject(payload: any): { message: string; status: number } | null {
  if (!payload || typeof payload !== 'object') return null;

  if (payload.success === false) {
    const code = payload.data?.code || payload.code || 'UpstreamError';
    const details = payload.data?.details || payload.message || 'Qwen returned an error';
    const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
    return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status: classifyErrorStatus(code) };
  }
  if (payload.error) {
    const msg = typeof payload.error === 'string' ? payload.error : (payload.error.message || JSON.stringify(payload.error));
    return { message: `Qwen upstream error: ${msg}`, status: 502 };
  }

  return null;
}

export function parseQwenErrorPayload(raw: string): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith('data: ')) return null;

  try {
    return parseQwenErrorObject(JSON.parse(text));
  } catch {
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }
}
