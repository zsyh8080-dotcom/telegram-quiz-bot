import { QUIZ_SCHEMA, validateExtraction, type QuizQuestion } from "./quiz.ts";
import type { InlineQuizImage } from "./gemini.ts";

export const TOKENROUTER_BASE_URL = "https://api.tokenrouter.com/v1";
export const TOKENROUTER_DEFAULT_MODEL = "z-ai/glm-5.2-free";
export const FORGE_BASE_URL = "https://forge-gateway-api.fly.dev/v1";
export const FORGE_DEFAULT_MODEL = "gemini-3.5-flash";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "qwen/qwen3.6-27b";
export const SAMBANOVA_BASE_URL = "https://api.sambanova.ai/v1";
export const SAMBANOVA_DEFAULT_MODEL = "Meta-Llama-3.3-70B-Instruct";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
export const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
export const MISTRAL_DEFAULT_MODEL = "mistral-small-latest";

export type CompatibleProviderConfig = {
  name: string;
  base_url: string;
  model: string;
};

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}

export function safeCompatibleConfig(
  value: CompatibleProviderConfig,
): CompatibleProviderConfig | null {
  const name = value.name.trim().slice(0, 40);
  const model = value.model.trim().slice(0, 160);
  let url: URL;
  try {
    url = new URL(cleanBaseUrl(value.base_url));
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const privateHost =
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.endsWith(".local");
  if (
    url.protocol !== "https:" ||
    privateHost ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !name ||
    !model
  )
    return null;
  return { name, model, base_url: cleanBaseUrl(url.toString()) };
}

function providerText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = (
    choices[0] as { message?: Record<string, unknown> } | undefined
  )?.message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      })
      .join("");
  }
  throw new Error("OpenAI-compatible response content missing [C-OUTPUT]");
}

function parseJsonText(text: string): unknown {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start)
      return JSON.parse(clean.slice(start, end + 1)) as unknown;
    throw new Error("OpenAI-compatible JSON output invalid [C-OUTPUT]");
  }
}

function providerError(label: string, response: Response, body: string): Error {
  let detail = body.slice(0, 700);
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string") detail = message.slice(0, 700);
  } catch {}
  const code =
    response.status === 401 || response.status === 403
      ? "AUTH"
      : response.status === 402 || response.status === 429
        ? "QUOTA"
        : response.status >= 500
          ? "UPSTREAM"
          : "REQUEST";
  return new Error(
    `${label}: ${response.status} [C-${code}] ${detail}`.slice(0, 1000),
  );
}

async function compatibleChat(
  config: CompatibleProviderConfig,
  apiKey: string,
  content: unknown,
  structured: boolean,
  timeoutMs = 16_000,
  maxTokens = 4_000,
): Promise<Record<string, unknown>> {
  const safe = safeCompatibleConfig(config);
  if (!safe)
    throw new Error(
      "OpenAI-compatible provider configuration is unsafe [C-CONFIG]",
    );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const normalizedKey = apiKey.trim();
  if (normalizedKey) headers.Authorization = `Bearer ${normalizedKey}`;
  const response = await fetch(`${safe.base_url}/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: safe.model,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      ...(structured ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const body = await response.text();
  if (!response.ok) throw providerError(safe.name, response, body);
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`${safe.name} returned invalid JSON [C-OUTPUT]`);
  }
}

export async function validateCompatibleApiKey(
  config: CompatibleProviderConfig,
  apiKey: string,
  timeoutMs = 12_000,
): Promise<void> {
  const payload = await compatibleChat(
    config,
    apiKey,
    "Reply with exactly OK.",
    false,
    timeoutMs,
    12,
  );
  if (!providerText(payload).trim()) {
    throw new Error(
      `${config.name} validation returned empty output [C-OUTPUT]`,
    );
  }
}

function pdfPrompt(
  text: string,
  metadata: { page_start: number; page_end: number; total_pages: number },
): string {
  return [
    "You digitize Persian multiple-choice employment exams from locally extracted PDF text.",
    `The document has exactly ${metadata.total_pages} physical pages.`,
    `Read questions that start on pages ${metadata.page_start} through ${metadata.page_end} only.`,
    "Preserve Persian wording and ordered options. Set correct_index only when the source explicitly prints the answer.",
    "Answer labels ۱/۲/۳/۴, الف/ب/ج/د and A/B/C/D map to the original option order.",
    "Set answer_evidence to EXPLICIT_ANSWER: option N; plus a short source fragment, and set correct_index to N minus one.",
    "Never solve or guess. Omit every question whose correct answer is not printed in the source.",
    "Repair ordinary Persian RTL spacing and ignore headers, footers, page numbers, links and watermarks.",
    "Return only one JSON object matching this schema, without Markdown:",
    JSON.stringify(QUIZ_SCHEMA),
    "",
    text,
  ].join("\n");
}

function imagePrompt(imageCount: number): string {
  return [
    `Read ${imageCount} Persian quiz screenshot(s).`,
    "Green marks the correct answer and red marks the user's wrong choice when colors are present.",
    "Keep exact question and option wording. Do not solve or guess an answer that is not explicitly shown.",
    "Set answer_evidence to EXPLICIT_ANSWER: option N; plus a short visible source fragment.",
    "Return only one JSON object matching this schema, without Markdown:",
    JSON.stringify(QUIZ_SCHEMA),
  ].join("\n");
}

async function extractCompatible(
  config: CompatibleProviderConfig,
  apiKey: string,
  content: unknown,
): Promise<QuizQuestion[]> {
  let lastError: unknown;
  for (const [index, structured] of [true, false].entries()) {
    try {
      const payload = await compatibleChat(
        config,
        apiKey,
        content,
        structured,
        index === 0 ? 16_000 : 8_000,
      );
      const questions = validateExtraction(
        parseJsonText(providerText(payload)),
      ).questions;
      if (!questions.length)
        throw new Error(
          `${config.name} returned no explicit questions [C-OUTPUT]`,
        );
      return questions;
    } catch (error) {
      lastError = error;
      if (/\[C-(?:AUTH|QUOTA)\]/.test(String(error))) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${config.name} extraction failed`);
}

export async function extractPdfTextWithCompatible(
  text: string,
  apiKey: string,
  config: CompatibleProviderConfig,
  metadata: { page_start: number; page_end: number; total_pages: number },
): Promise<QuizQuestion[]> {
  if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 80)
    throw new Error("PDF_TEXT_EMPTY");
  return await extractCompatible(config, apiKey, pdfPrompt(text, metadata));
}

export async function extractImagesWithCompatible(
  images: InlineQuizImage[],
  apiKey: string,
  config: CompatibleProviderConfig,
): Promise<QuizQuestion[]> {
  const content = [
    { type: "text", text: imagePrompt(images.length) },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mime_type};base64,${image.data}` },
    })),
  ];
  return await extractCompatible(config, apiKey, content);
}

export function tokenRouterConfig(model?: string): CompatibleProviderConfig {
  return {
    name: "TokenRouter",
    base_url: TOKENROUTER_BASE_URL,
    model: model?.trim() || TOKENROUTER_DEFAULT_MODEL,
  };
}

export function forgeConfig(model?: string): CompatibleProviderConfig {
  return {
    name: "Forge",
    base_url: FORGE_BASE_URL,
    model: model?.trim() || FORGE_DEFAULT_MODEL,
  };
}

export function groqConfig(model?: string): CompatibleProviderConfig {
  return {
    name: "Groq",
    base_url: GROQ_BASE_URL,
    model: model?.trim() || GROQ_DEFAULT_MODEL,
  };
}

export function sambaNovaConfig(model?: string): CompatibleProviderConfig {
  return {
    name: "SambaNova",
    base_url: SAMBANOVA_BASE_URL,
    model: model?.trim() || SAMBANOVA_DEFAULT_MODEL,
  };
}

export function deepSeekConfig(model?: string): CompatibleProviderConfig {
  return {
    name: "DeepSeek",
    base_url: DEEPSEEK_BASE_URL,
    model: model?.trim() || DEEPSEEK_DEFAULT_MODEL,
  };
}

export function mistralChatConfig(model?: string): CompatibleProviderConfig {
  return {
    name: "Mistral",
    base_url: MISTRAL_BASE_URL,
    model: model?.trim() || MISTRAL_DEFAULT_MODEL,
  };
}
