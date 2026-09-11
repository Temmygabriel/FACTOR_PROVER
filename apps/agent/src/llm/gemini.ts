/**
 * Google Gemini client — the second tier.
 *
 * Used when Groq is rate-limited or down. Gemini's free tier also needs no card,
 * which is what makes the two-tier arrangement viable for a builder with no
 * payment method.
 *
 * Gemini's REST shape differs from the OpenAI dialect in three ways that matter:
 * the system prompt is a separate `systemInstruction` field rather than a
 * message, generation parameters live under `generationConfig`, and JSON output
 * is requested with `responseMimeType` rather than `response_format`. It also
 * names the model in the URL path.
 */

import { ProviderError } from './openaiCompat.js';

export interface GeminiParams {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface GeminiResult {
  text: string;
  model: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function geminiGenerate(params: GeminiParams): Promise<GeminiResult> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${BASE}/${encodeURIComponent(params.model)}:generateContent`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header rather than ?key= so the secret does not land in URLs/logs.
        'x-goog-api-key': params.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.system }] },
        contents: [{ role: 'user', parts: [{ text: params.user }] }],
        generationConfig: {
          temperature: params.temperature ?? 0.9,
          maxOutputTokens: params.maxTokens ?? 800,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });

    const raw = await res.text();

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(
        `gemini failed: HTTP ${res.status} ${raw.slice(0, 200)}`,
        { status: res.status, retryable },
      );
    }

    let body: GeminiResponse;
    try {
      body = JSON.parse(raw) as GeminiResponse;
    } catch {
      throw new ProviderError(`gemini response was not JSON: ${raw.slice(0, 200)}`);
    }

    if (body.error) {
      throw new ProviderError(`gemini error: ${body.error.message ?? 'unknown'}`);
    }
    if (body.promptFeedback?.blockReason) {
      throw new ProviderError(`gemini blocked the prompt: ${body.promptFeedback.blockReason}`);
    }

    const text = body.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('')
      .trim();

    if (!text) {
      const reason = body.candidates?.[0]?.finishReason ?? 'no candidates';
      throw new ProviderError(`gemini returned no content (${reason})`);
    }

    return { text, model: params.model };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError(`gemini timed out after ${timeoutMs}ms`);
    }
    throw new ProviderError(
      `gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
