import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { StreamingToolParser } from '../tools/parser.js';
import { QwenStreamParser } from '../utils/qwen-stream-parser.js';
import { getIncrementalDelta, parseQwenErrorPayload } from './sse-parser.js';
import { looksLikeUnwrappedToolCall, parseUnwrappedToolCalls } from './tool-handler.js';
import { removeStream } from '../core/stream-registry.js';
import { updateSessionParent } from '../services/qwen.js';

/**
 * Plain refusal or genuine answer, not a narration that should have been a tool
 * call. Never force a tool call after one of these.
 */
const REFUSAL_RE = /não posso|não consigo|não tenho (acesso|permiss|como)|não vou (poder|fazer)|não é possível|não dispon|não foi possível|cannot|can'?t|can not|unable to|not allowed|forbidden|no access|I (can'?t|cannot|won'?t|am unable)|don'?t have (access|permission)/i;

export interface StreamHandlerContext {
  stream: ReadableStream;
  completionId: string;
  model: string;
  uiSessionId: string;
  hasTools: boolean;
  tools: any[];
  finalPrompt: string;
  streamOptions?: { include_usage?: boolean };
  /**
   * Opens a NEW upstream stream with a reinforced prompt. When present and the
   * response finishes with zero tool calls while tools are active, the handler
   * transparently retries ONCE and serves the retried response.
   */
  retryStreamFactory?: () => Promise<{ stream: ReadableStream; uiSessionId: string }>;
}

export function handleStreamingResponse(c: Context, ctx: StreamHandlerContext): any {
  const socket = (c.env as any)?.incoming?.socket || (c.req.raw as any).socket;
  if (socket && typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return honoStream(c, async (streamWriter: any) => {
    let heartbeatInterval: any;
    // Micro-buffer: coalesce many tiny SSE writes into fewer socket writes to cut
    // syscall overhead on long responses. Ordering is preserved because EVERY write
    // (content, reasoning, events, [DONE]) goes through this single buffer.
    let writeBuffer = '';
    let writeTimer: ReturnType<typeof setTimeout> | null = null;
    const WRITE_FLUSH_BYTES = 8192;
    const WRITE_FLUSH_MS = 3;

    const flushWrites = () => {
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      if (writeBuffer) {
        const data = writeBuffer;
        writeBuffer = '';
        streamWriter.write(data);
      }
    };

    const bufferedWrite = (data: string) => {
      writeBuffer += data;
      if (writeBuffer.length >= WRITE_FLUSH_BYTES) {
        flushWrites();
      } else if (!writeTimer) {
        writeTimer = setTimeout(flushWrites, WRITE_FLUSH_MS);
      }
    };

    try {
      await streamWriter.write(': heartbeat\n\n');
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch { clearInterval(heartbeatInterval);
        }
      }, 15000);

      const writeEvent = (data: any) => {
        bufferedWrite(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      const emittedStreamingToolIds = new Set<string>();

      const emitStreamingToolCall = (tc: { id: string; name: string; arguments: Record<string, unknown> }, index: number) => {
        if (emittedStreamingToolIds.has(tc.id)) return;
        emittedStreamingToolIds.add(tc.id);
        bufferedWrite(`data: ${JSON.stringify({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({
            tool_calls: [{
              index,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
            }]
          })]
        })}\n\n`);
      };

      const createdTimestamp = Math.floor(Date.now() / 1000);

      // Pre-compute the constant parts of the per-chunk SSE envelope once, and use a
      // lightweight manual escaper instead of JSON.stringify().slice() on every chunk.
      const contentPrefix = `data: {"id":"${ctx.completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":${JSON.stringify(ctx.model)},"choices":[{"index":0,"delta":{"content":"`;
      const reasoningPrefix = `data: {"id":"${ctx.completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":${JSON.stringify(ctx.model)},"choices":[{"index":0,"delta":{"reasoning_content":"`;
      const chunkSuffix = `"},"logprobs":null,"finish_reason":null}]}\n\n`;

      // Detects chars that need JSON string escaping: backslash, double-quote, and
      // control characters (U+0000–U+001F). Control chars are intentionally matched.
      // eslint-disable-next-line no-control-regex
      const ESCAPE_RE = /[\\"\u0000-\u001f]/;
      const escapeJsonString = (s: string) => {
        // Cheap check: most LLM text chunks have no chars needing escaping.
        if (!ESCAPE_RE.test(s)) return s;
        return JSON.stringify(s).slice(1, -1);
      };

      let firstPayloadFlushed = false;
      const fastWriteContent = (content: string) => {
        bufferedWrite(contentPrefix + escapeJsonString(content) + chunkSuffix);
        if (!firstPayloadFlushed) { firstPayloadFlushed = true; flushWrites(); }
      };

      const fastWriteReasoning = (content: string) => {
        bufferedWrite(reasoningPrefix + escapeJsonString(content) + chunkSuffix);
        if (!firstPayloadFlushed) { firstPayloadFlushed = true; flushWrites(); }
      };

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });
      // Flush the opening role event immediately so clients see the stream begin.
      flushWrites();

      const canRetry = ctx.hasTools && !!ctx.retryStreamFactory;

      /**
       * Consume one upstream stream and translate it into client SSE. When
       * `holdContent` is true, answer-phase text is buffered locally instead of
       * streamed, so a possible retry can discard it. Tool calls and reasoning
       * are always handled: reasoning streams live; on the first tool call any
       * held content is released first so ordering matches the original text.
       */
      const consumeUpstream = async (
        upstream: ReadableStream,
        sessionId: string,
        holdContent: boolean,
      ): Promise<{
        upstreamError: { message: string; status: number } | null;
        promptTokens: number;
        completionTokens: number;
        heldContent: string[];
        toolCallCount: number;
      }> => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let _reasoningBuffer = '';
        let lastFullContent = '';
        let contentLength = 0;
        let contentSuffix = '';
        let targetResponseId: string | null = null;
        let targetResponseIdSet = false;
        let currentThoughtIndex = 0;
        const toolParser = ctx.hasTools ? new StreamingToolParser(ctx.tools) : null;
        const bufferChunks: string[] = [];
        let bufferLen = 0;
        let lineStart = 0;
        let completionTokens = 0;
        let promptTokens = Math.ceil(ctx.finalPrompt.length / 3.5);
        const heldContent: string[] = [];
        let toolEmitted = false;

        const releaseHeld = () => {
          if (holdContent && !toolEmitted && heldContent.length > 0) {
            for (const held of heldContent) fastWriteContent(held);
            heldContent.length = 0;
          }
        };
        const forwardText = (text: string) => {
          if (holdContent && !toolEmitted) {
            heldContent.push(text);
          } else {
            fastWriteContent(text);
          }
        };

        const processLines = (fullBuffer: string) => {
          let pos = lineStart;
          while (pos < fullBuffer.length) {
            const newlineIdx = fullBuffer.indexOf('\n', pos);
            if (newlineIdx === -1) {
              lineStart = pos;
              return;
            }
            const line = fullBuffer.substring(pos, newlineIdx);
            pos = newlineIdx + 1;
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') {
              bufferedWrite('data: [DONE]\n');
              continue;
            }

            try {
              const chunk = JSON.parse(dataStr);
              if (chunk['response.created'] && chunk['response.created'].response_id) {
                if (!targetResponseId) {
                  targetResponseId = chunk['response.created'].response_id;
                  targetResponseIdSet = true;
                }
                updateSessionParent(sessionId, chunk['response.created'].response_id);
              } else if (chunk.response_id && !targetResponseIdSet) {
                targetResponseId = chunk.response_id;
                targetResponseIdSet = true;
                updateSessionParent(sessionId, chunk.response_id);
              }

              if (chunk.usage) {
                if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
                if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
              }

              let vStr = '';
              let foundStr = false;
              let isThinkingChunk = false;

              if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                  (!targetResponseIdSet || chunk.response_id === targetResponseId)) {
                const delta = chunk.choices[0].delta;
                if (delta.phase === 'thinking_summary') {
                  isThinkingChunk = true;
                  if (delta.extra?.summary_thought?.content) {
                    const thoughts = delta.extra.summary_thought.content;
                    if (thoughts.length > currentThoughtIndex) {
                      vStr = thoughts.slice(currentThoughtIndex).join('\n');
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  }
                } else if (delta.phase === 'answer') {
                  isThinkingChunk = false;
                  if (delta.content !== undefined) {
                    const newContent = delta.content || '';
                    const result = getIncrementalDelta(lastFullContent, newContent, contentLength, contentSuffix);
                    vStr = result.delta;
                    if (vStr) {
                      lastFullContent = result.matchedContent;
                      contentLength = result.contentLength;
                      contentSuffix = result.contentSuffix;
                      foundStr = true;
                    }
                  }
                }
              }

              if (foundStr && vStr !== '') {
                if (vStr === 'FINISHED') continue;
                if (isThinkingChunk) {
                  _reasoningBuffer += vStr;
                  fastWriteReasoning(vStr);
                } else {
                  if (ctx.hasTools && toolParser) {
                    const { text, toolCalls } = toolParser.feed(vStr);
                    if (text) {
                      if (looksLikeUnwrappedToolCall(text)) {
                        const unwrappedToolCalls = parseUnwrappedToolCalls(text);
                        const baseIndex = toolParser.getEmittedToolCallCount();
                        releaseHeld();
                        for (let idx = 0; idx < unwrappedToolCalls.length; idx++) {
                          const tc = unwrappedToolCalls[idx];
                          emitStreamingToolCall(tc, baseIndex + idx);
                          toolEmitted = true;
                        }
                      } else {
                        forwardText(text);
                      }
                    }
                    for (const tc of toolCalls) {
                      releaseHeld();
                      emitStreamingToolCall(tc, toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc));
                      toolEmitted = true;
                    }
                  } else {
                    if (vStr) fastWriteContent(vStr);
                  }
                }
              }
            } catch (e) {
              if (dataStr.length > 10) {
                console.warn(`[Chat] SSE parse error for chunk (${dataStr.length} chars):`, (e as Error).message);
              }
            }
          }
          lineStart = pos;
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          bufferChunks.push(decoded);
          bufferLen += decoded.length;

          if (decoded.includes('\n')) {
            const fullBuffer = bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('');
            processLines(fullBuffer);

            const remaining = fullBuffer.substring(lineStart);
            bufferChunks.length = 0;
            if (remaining) {
              bufferChunks.push(remaining);
              bufferLen = remaining.length;
            } else {
              bufferLen = 0;
            }
            lineStart = 0;
          }
        }

        if (bufferLen > 0) {
          const finalBuffer = bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('');
          processLines(finalBuffer);
        }

        const tailBuffer = bufferChunks.length > 0
          ? (bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('')).substring(lineStart)
          : '';

        const upstreamError = parseQwenErrorPayload(tailBuffer);
        if (upstreamError && holdContent) {
          // Erroring out: release whatever text we were holding so the client
          // still receives the partial response before the error event.
          for (const held of heldContent) fastWriteContent(held);
          heldContent.length = 0;
        }

        // Flush parser state at end of stream (recovers partial/unclosed tool calls).
        if (toolParser) {
          const flushResult = toolParser.flush();
          if (flushResult.text) {
            if (ctx.hasTools && looksLikeUnwrappedToolCall(flushResult.text)) {
              const unwrappedToolCalls = parseUnwrappedToolCalls(flushResult.text);
              const baseIndex = toolParser.getEmittedToolCallCount();
              releaseHeld();
              for (let idx = 0; idx < unwrappedToolCalls.length; idx++) {
                const tc = unwrappedToolCalls[idx];
                emitStreamingToolCall(tc, baseIndex + idx);
                toolEmitted = true;
              }
            } else {
              forwardText(flushResult.text);
            }
          }
          for (const tc of flushResult.toolCalls) {
            releaseHeld();
            emitStreamingToolCall(tc, toolParser.getEmittedToolCallCount() - flushResult.toolCalls.length + flushResult.toolCalls.indexOf(tc));
            toolEmitted = true;
          }
        }

        return {
          upstreamError,
          promptTokens,
          completionTokens,
          heldContent,
          toolCallCount: toolParser ? toolParser.getEmittedToolCallCount() : 0,
        };
      };

      let firstPass = await consumeUpstream(ctx.stream, ctx.uiSessionId, canRetry);
      let selected = firstPass;
      let heldNarration = firstPass.heldContent.join('');

      // Transparent one-shot retry: tools active + no tool call + non-empty
      // narration that is not a refusal + no upstream error. The held narration
      // is discarded and the retried response is streamed live.
      if (
        canRetry &&
        !firstPass.upstreamError &&
        firstPass.toolCallCount === 0 &&
        heldNarration.trim().length > 0 &&
        !REFUSAL_RE.test(heldNarration)
      ) {
        try {
          console.log('[Chat] Zero tool calls with tools active — retrying once with reinforced prompt.');
          const retried = await ctx.retryStreamFactory!();
          selected = await consumeUpstream(retried.stream, retried.uiSessionId, false);
          if (selected.upstreamError) {
            // Retried upstream failed: fall back to the first response.
            console.warn('[Chat] Retried upstream errored, serving first response:', selected.upstreamError.message);
            selected = firstPass;
          }
        } catch (retryErr: any) {
          console.warn('[Chat] Tool-call retry failed, serving first response:', retryErr.message);
          selected = firstPass;
        }
      }

      if (selected.upstreamError) {
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({ content: selected.upstreamError.message })]
        });
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({}, 'stop')]
        });
        bufferedWrite('data: [DONE]\n\n');
        flushWrites();
        return;
      }

      // Serve remaining held content (only when the final pass never emitted a
      // tool call: no tools, no retry, or the narration was kept as-is).
      if (selected.toolCallCount === 0 && selected.heldContent.length > 0) {
        for (const held of selected.heldContent) fastWriteContent(held);
      }

      const usage = {
        prompt_tokens: selected.promptTokens,
        completion_tokens: selected.completionTokens,
        total_tokens: selected.promptTokens + selected.completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };

      const finalFinishReason = selected.toolCallCount > 0 ? 'tool_calls' : 'stop';

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({}, finalFinishReason)],
        ...(ctx.streamOptions?.include_usage ? {} : { usage })
      });

      if (ctx.streamOptions?.include_usage) {
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [],
          usage
        });
      }
      bufferedWrite('data: [DONE]\n\n');
      flushWrites();
    } finally {
      flushWrites();
      clearInterval(heartbeatInterval);
      removeStream(ctx.completionId);
    }
  });
}

export function handleNonStreamingResponse(
  c: Context,
  stream: ReadableStream,
  completionId: string,
  model: string,
  uiSessionId: string,
  hasTools: boolean,
  tools: any[],
  retryStreamFactory?: () => Promise<{ stream: ReadableStream; uiSessionId: string }>,
): any {
  const parseStream = async (
    upstream: ReadableStream,
    sessionId: string,
  ): Promise<{
    upstreamError: { message: string; status: number } | null;
    toolCallsOut: any[];
    finalContent: string;
    reasoningBuffer: string;
    promptTokens: number;
    completionTokens: number;
  }> => {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    const toolCallsOut: any[] = [];
    const seenToolCallIds = new Set<string>();
    let buffer = '';

    const pushToolCall = (tc: { id: string; name: string; arguments: Record<string, unknown> }) => {
      if (seenToolCallIds.has(tc.id)) return;
      seenToolCallIds.add(tc.id);
      toolCallsOut.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
      });
    };

    const qwenParser = new QwenStreamParser(sessionId, {
      tools: hasTools ? tools : [],
      onThinking: () => {},
      onToolCall: (tc) => {
        pushToolCall(tc);
      },
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;
        qwenParser.parseLine(dataStr);
      }
    }

    const upstreamError = parseQwenErrorPayload(buffer);
    if (upstreamError) {
      return {
        upstreamError,
        toolCallsOut: [],
        finalContent: '',
        reasoningBuffer: '',
        promptTokens: 0,
        completionTokens: 0,
      };
    }

    const { text: remainingText, toolCalls: remainingToolCalls } = qwenParser.flush();
    const parserState = qwenParser.state;
    let finalContent = parserState.lastFullContent;
    if (remainingText) finalContent += remainingText;
    for (const tc of remainingToolCalls) {
      pushToolCall(tc);
    }

    if (hasTools && toolCallsOut.length === 0) {
      for (const tc of parseUnwrappedToolCalls(finalContent)) {
        pushToolCall(tc);
      }
      if (toolCallsOut.length > 0) finalContent = '';
    }

    return {
      upstreamError: null,
      toolCallsOut,
      finalContent,
      reasoningBuffer: parserState.reasoningBuffer,
      promptTokens: parserState.promptTokens,
      completionTokens: parserState.completionTokens,
    };
  };

  return (async () => {
    let parsed = await parseStream(stream, uiSessionId);

    // Transparent one-shot retry: tools active + zero tool calls + non-refusal
    // narration + no upstream error.
    if (
      retryStreamFactory &&
      hasTools &&
      !parsed.upstreamError &&
      parsed.toolCallsOut.length === 0 &&
      parsed.finalContent.trim().length > 0 &&
      !REFUSAL_RE.test(parsed.finalContent)
    ) {
      try {
        console.log('[Chat] Non-streaming: zero tool calls with tools active — retrying once with reinforced prompt.');
        const retried = await retryStreamFactory();
        const retriedParsed = await parseStream(retried.stream, retried.uiSessionId);
        if (!retriedParsed.upstreamError) {
          parsed = retriedParsed;
        }
      } catch (retryErr: any) {
        console.warn('[Chat] Non-streaming tool-call retry failed, serving first response:', retryErr.message);
      }
    }

    if (parsed.upstreamError) {
      removeStream(completionId);
      return c.json({ error: { message: parsed.upstreamError.message } }, parsed.upstreamError.status as any);
    }

    const usage = {
      prompt_tokens: parsed.promptTokens,
      completion_tokens: parsed.completionTokens,
      total_tokens: parsed.promptTokens + parsed.completionTokens,
      prompt_tokens_details: { cached_tokens: 0 }
    };
    const message: any = { role: 'assistant', content: parsed.toolCallsOut.length ? null : parsed.finalContent };
    if (parsed.reasoningBuffer) message.reasoning_content = parsed.reasoningBuffer;
    if (parsed.toolCallsOut.length) parsed.toolCallsOut.forEach((tc, idx) => tc.index = idx);
    if (parsed.toolCallsOut.length) message.tool_calls = parsed.toolCallsOut;

    removeStream(completionId);
    return c.json({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        logprobs: null,
        finish_reason: parsed.toolCallsOut.length ? 'tool_calls' : 'stop'
      }],
      usage
    });
  })();
}
