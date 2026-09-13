const DEFAULT_TIMEOUT_MS = 30_000;

export class LLMClientError extends Error {
  constructor(message, { code = 'LLM_REQUEST_FAILED', cause, status, body } = {}) {
    super(message, { cause });
    this.name = 'LLMClientError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new LLMClientError('LLM returned a non-JSON response', {
      code: 'LLM_INVALID_RESPONSE', cause, body: text.slice(0, 1_000)
    });
  }
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new LLMClientError('LLM did not return a JSON object', {
        code: 'LLM_INVALID_JSON', body: trimmed.slice(0, 1_000)
      });
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (cause) {
      throw new LLMClientError('LLM returned malformed JSON', {
        code: 'LLM_INVALID_JSON', cause, body: trimmed.slice(0, 1_000)
      });
    }
  }
}

/** OpenAI-compatible chat client with injectable fetch for tests and local stubs. */
export class LLMClient {
  constructor(config = {}, options = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.model = config.model || 'gpt-4o-mini';
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetch = options.fetch ?? config.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new LLMClientError('A fetch implementation is required', { code: 'LLM_FETCH_UNAVAILABLE' });
    }
  }

  async createChatCompletion({
    messages, model = this.model, temperature = 0.7, maxTokens = 500, responseFormat, signal, ...extra
  }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new TypeError('messages must be a non-empty array');
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('LLM request timed out')), this.timeoutMs);
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const payload = { model, messages, temperature, max_tokens: maxTokens, ...extra };
    if (responseFormat) payload.response_format = responseFormat;

    try {
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new LLMClientError(body?.error?.message || `LLM request failed with HTTP ${response.status}`, {
          code: 'LLM_HTTP_ERROR', status: response.status, body
        });
      }
      const message = body?.choices?.[0]?.message;
      if (!message || typeof message.content !== 'string') {
        throw new LLMClientError('LLM response did not include choices[0].message.content', {
          code: 'LLM_INVALID_RESPONSE', body
        });
      }
      return { content: message.content, message, usage: body.usage, raw: body };
    } catch (error) {
      if (error instanceof LLMClientError) throw error;
      const timedOut = controller.signal.aborted && !signal?.aborted;
      throw new LLMClientError(timedOut ? 'LLM request timed out' : 'LLM request failed', {
        code: timedOut ? 'LLM_TIMEOUT' : 'LLM_REQUEST_FAILED', cause: error
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async completeJSON(options) {
    const completion = await this.createChatCompletion({
      ...options, responseFormat: options.responseFormat ?? { type: 'json_object' }
    });
    return { ...completion, data: extractJsonObject(completion.content) };
  }
}
