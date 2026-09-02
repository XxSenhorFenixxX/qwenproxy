import type { Context } from 'hono';
import crypto from 'crypto';
import { createQwenStream, RetryableQwenStreamError } from '../services/qwen.js';
import type { OpenAIRequest } from '../utils/types.js';
import { getModelContextWindow } from '../core/model-registry.js'
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.js';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo, markAccountInUse, releaseAccountInUse, getInUseAccounts } from '../core/account-manager.js';
import { loadAccounts } from '../core/accounts.js';
import { registerStream, removeStream, getStream } from '../core/stream-registry.js';
import { metrics } from '../core/metrics.js'
import {
  getForcedToolName,
  getRecentToolNames,
  selectCandidateTools,
  buildCompactToolManifest,
  buildToolCallContract,
  getToolChoiceMode,
} from './tool-handler.js';
import { handleStreamingResponse, handleNonStreamingResponse } from './stream-handler.js';

export { getIncrementalDelta } from './sse-parser.js';
export type { DeltaResult } from './sse-parser.js';

export async function chatCompletions(c: Context) {
  const requestId = ((c as any).get('requestId') as string | undefined) || crypto.randomUUID();
  const requestStartedAt = Date.now();
  console.log(`[Chat][${requestId}] request_received`, { method: c.req.method, path: c.req.path });
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    console.log(`[Chat][${requestId}] request_parsed`, {
      model: body.model,
      messageCount: body.messages?.length || 0,
      stream: isStream,
    });
    
    let prompt = '';
    const messages = body.messages || [];
    let systemPrompt = '';
    // Accumulate into arrays and join once at the end. For long conversations this
    // avoids repeated O(n) string reallocation on every `+=`.
    const promptParts: string[] = [];
    const systemPromptParts: string[] = [];
    const pendingMultimodal: Array<Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }>> = [];

    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls)) {
        for (const tc of (msg as any).tool_calls) {
          if (tc.id && tc.function?.name) {
            toolCallIdToName.set(tc.id, tc.function.name);
          }
        }
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const multimodalParts: Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }> = [];
        
        for (const p of msg.content as any[]) {
          if (p.type === "text" && p.text) {
            textParts.push(p.text);
          } else if (
            (p.type === "image_url" && p.image_url?.url) ||
            (p.type === "video_url" && p.video_url?.url) ||
            (p.type === "audio_url" && p.audio_url?.url) ||
            (p.type === "file_url" && p.file_url?.url)
          ) {
            multimodalParts.push(p);
          }
        }
        
        contentStr = textParts.join("\n");
        if (multimodalParts.length > 0) {
          pendingMultimodal.push(multimodalParts);
        }
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system') {
        systemPromptParts.push((contentStr || '') + '\n');
      } else if (msg.role === 'user') {
        promptParts.push(`User: ${contentStr || ''}\n`);
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr || '';
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
             const args = tc.function?.arguments;
             let parsedArgs: any = {};
             if (typeof args === 'string') {
               try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
             } else if (args && typeof args === 'object') {
               parsedArgs = args;
             }
             const payload = { name: tc.function?.name, arguments: parsedArgs };
             const toolCallStr = `\nTOOL: ${tc.function?.name} | ${JSON.stringify(parsedArgs)}`;
             assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim();
           }
        }
        promptParts.push(`Assistant: ${assistantContent.trim()}\n`);
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let toolName = msg.name;
        if (!toolName && msg.tool_call_id) {
          toolName = toolCallIdToName.get(msg.tool_call_id);
        }
        promptParts.push(`Tool Response (${toolName || 'tool'}): ${contentStr || ''}`);
      }
    }

    systemPrompt = systemPromptParts.length ? systemPromptParts.join('\n') + '\n' : '';
    prompt = promptParts.length ? promptParts.join('\n') + '\n' : '';

    const bodyAny = body as any;
    const hasTools = Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0;
    const toolChoiceMode = getToolChoiceMode(bodyAny.tool_choice);
    const forcedToolName = getForcedToolName(bodyAny.tool_choice);
    
    // Compute candidate tools BEFORE building systemPrompt so we only list
    // the tools that will actually be sent to the model.
    const toolContextTextPre = `${systemPrompt}\n${prompt}`;
    const recentToolNamesPre = hasTools ? getRecentToolNames(messages) : new Set<string>();
    const candidateTools = hasTools ? selectCandidateTools(bodyAny.tools, toolContextTextPre, forcedToolName, recentToolNamesPre) : [];
    
    if (hasTools && toolChoiceMode !== 'none') {
      const formattedTools = candidateTools.map((t: any) => {
        if (t.type === 'function' && t.function) {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters || {}
          };
        }
        return {
          name: t.name || '',
          description: t.description || '',
          parameters: t.parameters || {}
        };
      });
      const toolsJson = JSON.stringify(formattedTools);
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n`;
      
      if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    const modelId = body.model.replace('-no-thinking', '').replace('-thinking', '');
    const modelContextWindow = getModelContextWindow(modelId)
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt, modelId);
    const parallelToolCalls = bodyAny.parallel_tool_calls !== false && toolChoiceMode !== 'forced';
    
    let finalPrompt: string;
    if (estimatedTokens > modelContextWindow - 1000) {
      const truncated = truncateMessages(messages, modelContextWindow, systemPrompt, modelId);
      const truncatedBody = truncated.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n');
      finalPrompt = systemPrompt ? `${systemPrompt}\n\n${truncatedBody}` : truncatedBody;
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    if (hasTools && toolChoiceMode === 'none') {
      finalPrompt += '\n\n[TOOL USE DISABLED]\nDo not call tools in this response. Answer directly using available context.';
    }

    if (hasTools && toolChoiceMode !== 'none') {
      const compactManifest = buildCompactToolManifest(candidateTools, forcedToolName);
      const toolContract = buildToolCallContract(candidateTools, forcedToolName, parallelToolCalls);
      finalPrompt += `\n\n${toolContract}`;
      if (compactManifest) finalPrompt += `\n\n${compactManifest}`;
    }

    const isThinkingModel = !body.model.includes('no-thinking');

    const isGuestModeOnly = process.env.QWEN_GUEST_MODE_ONLY?.toLowerCase() === 'true';
    let stream: ReadableStream | undefined;
    let uiSessionId = '';
    const completionId = 'chatcmpl-' + crypto.randomUUID();
    let lastError: any = null;

    if (isGuestModeOnly) {
      console.log(`[Chat][${requestId}] account_selected`, { accountId: 'guest', reason: 'guest_mode_only' });
      try {
        const result = await createQwenStream(
          finalPrompt,
          isThinkingModel,
          body.model,
          null,
          'guest',
          undefined,
          pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
          requestId,
        );
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        registerStream(completionId, {
          abortController: result.controller,
          accountId: 'guest',
          uiSessionId: result.uiSessionId,
          targetResponseId: '',
          headers: result.headers,
        });
      } catch (err: any) {
        console.error('[Chat] Guest mode failed:', err.message);
        throw err;
      }
    } else {
      let account = getNextAccount();
      const triedAccountIds = new Set<string>();

      if (!account) {
        const inUse = getInUseAccounts();
        if (inUse.length === 0) {
          throw new RetryableQwenStreamError('No available account lanes', 1000);
        }

        const waitStart = Date.now();
        const MAX_LANE_WAIT_MS = 30000;
        while (!account) {
          const elapsed = Date.now() - waitStart;
          if (elapsed > MAX_LANE_WAIT_MS) {
            throw new RetryableQwenStreamError(
              `All configured account lanes are busy: ${getInUseAccounts().join(', ')}`,
              1000
            );
          }
          await new Promise(r => setTimeout(r, 300));
          account = getNextAccount();
        }
        console.log(`[Chat] Waited ${Date.now() - waitStart}ms for a free lane`);
      }

      while (account) {
        const accountId = account.id;
        const accountEmail = account.email;

        if (triedAccountIds.has(accountId)) {
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }
        triedAccountIds.add(accountId);

        const cooldownInfo = getAccountCooldownInfo(accountId);
        if (cooldownInfo && accountId !== 'global') {
          console.log(`[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }

        console.log(`[Chat][${requestId}] account_selected`, { accountId });
        markAccountInUse(accountId);

        let retries = 3;
        let retryDelay = 500;
        let success = false;

        try {
          while (retries > 0) {
            try {
              const result = await createQwenStream(
                finalPrompt,
                isThinkingModel,
                body.model,
                null,
                accountId === 'global' ? undefined : accountId,
                undefined,
                pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
                requestId,
              );
              stream = result.stream;
              uiSessionId = result.uiSessionId;
              registerStream(completionId, {
                abortController: result.controller,
                accountId: result.accountId,
                uiSessionId: result.uiSessionId,
                targetResponseId: '',
                headers: result.headers,
              });
              success = true;
              releaseAccountInUse(accountId);
              break;
            } catch (err: any) {
              retries--;

              if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
                const hourHint = err.message?.match(/Wait about (\d+) hour/);
                const hours = hourHint ? parseInt(hourHint[1]) : 24;
                const cooldownMs = hours * 60 * 60 * 1000;
                markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
                console.warn(`[Chat] Account ${accountEmail} (${accountId}) rate-limited. Entering cooldown for ${hours} hours.`);
                lastError = err;
                break;
              }

              if (retries === 0) {
                if (err.upstreamStatus && err.upstreamStatus >= 500) {
                  markAccountRateLimited(accountId, undefined, 'ServerError');
                  console.warn(`[Chat] Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`);
                }
                lastError = err;
                break;
              }

              let useDelay = retryDelay;
              if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
                useDelay = err.retryAfterMs;
              }
              const isRetryable = err instanceof RetryableQwenStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
              if (!isRetryable) {
                lastError = err;
                break;
              }
              console.warn(`[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
              await new Promise(r => setTimeout(r, useDelay));
              retryDelay = Math.min(retryDelay * 2, 5000);
            }
          }
        } finally {
          if (!success) {
            releaseAccountInUse(accountId);
          }
        }

        if (success) {
          break;
        }

        account = getNextAvailableAccount(triedAccountIds);
      }
    }

    if (!stream) {
      removeStream(completionId);
      const accounts = loadAccounts();
      const allOnCooldown = accounts.length === 0 || accounts.every(a => getAccountCooldownInfo(a.id) !== null);
      
      if (allOnCooldown) {
        console.warn(`[Chat] CRITICAL: All accounts are rate-limited, on cooldown, or none configured! Falling back to GUEST mode.`);
        try {
          const result = await createQwenStream(
            finalPrompt,
            isThinkingModel,
            body.model,
            null,
            'guest',
            undefined,
            pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
            requestId,
          );
          stream = result.stream;
          uiSessionId = result.uiSessionId;
          registerStream(completionId, {
            abortController: result.controller,
            accountId: 'guest',
            uiSessionId: result.uiSessionId,
            targetResponseId: '',
            headers: result.headers,
          });
        } catch (guestErr: any) {
          console.error('[Chat] Guest mode also failed:', guestErr.message);
          throw lastError || new Error('All accounts and guest mode failed');
        }
      } else {
        throw lastError || new Error('All accounts failed');
      }
    }

    if (!isStream) {
      console.log(`[Chat][${requestId}] upstream_stream_ready`, { completionId, mode: 'non_stream', elapsedMs: Date.now() - requestStartedAt });
      return handleNonStreamingResponse(c, stream!, completionId, body.model, uiSessionId, hasTools && toolChoiceMode !== 'none', bodyAny.tools || [], requestId);
    }

    console.log(`[Chat][${requestId}] upstream_stream_ready`, { completionId, mode: 'stream', elapsedMs: Date.now() - requestStartedAt });
    return handleStreamingResponse(c, {
      stream: stream!,
      completionId,
      model: body.model,
      uiSessionId,
      hasTools: hasTools && toolChoiceMode !== 'none',
      tools: bodyAny.tools || [],
      finalPrompt,
      streamOptions: body.stream_options,
      requestId,
    });
  } catch (err: any) {
    console.error(`[Chat][${requestId}] request_error:`, err)
    const status = err.upstreamStatus || 500
    if (status >= 500) {
      metrics.increment('requests.errors')
    }
    return c.json({ error: { message: err.message } }, status)
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id } = body;

    if (!chat_id || !response_id) {
      return c.json({ error: 'chat_id and response_id are required' }, 400);
    }

    const stream = getStream(chat_id);
    if (!stream) {
      return c.json({ error: 'Stream not found' }, 404);
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json({ error: 'response_id mismatch' }, 400);
    }

    const stopResponse = await fetch(`https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${chat_id}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Content-Type': 'application/json',
        'Cookie': stream.headers.cookie,
        'Origin': 'https://chat.qwen.ai',
        'Referer': `https://chat.qwen.ai/c/${chat_id}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': stream.headers['user-agent'],
        'X-Request-Id': crypto.randomUUID(),
        'bx-ua': stream.headers['bx-ua'],
        'bx-umidtoken': stream.headers['bx-umidtoken'],
        'bx-v': stream.headers['bx-v'],
      },
      body: JSON.stringify({ chat_id, response_id }),
    });

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error(`[Stop] Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`);
      return c.json({ error: 'Failed to stop generation' }, stopResponse.status as any);
    }

    stream.abortController.abort();
    removeStream(chat_id);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error('Error in chatCompletionsStop:', err);
    return c.json({ error: err.message }, 500);
  }
}
