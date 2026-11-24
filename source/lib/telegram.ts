import {
  advanceQuizExtraction,
  cancelQuizExtraction,
  cleanupQuizExtraction,
  detectPdfPageCount,
  extractExplicitQuizFromOcr,
  extractImagesWithBluesMindsStage,
  extractImagesWithGeminiStage,
  extractImagesWithOpenRouterStage,
  extractPdfTextWithGemini,
  extractPdfTextWithOpenRouter,
  extractPdfTextWithBluesMinds,
  listGeminiModels,
  probeGeminiGenerateContent,
  listBluesMindsModels,
  getOpenRouterKeyInfo,
  ocrImagesStage,
  startNextQuizBatch,
  type GeminiJob,
  type GeminiJobResult,
} from "./gemini.ts";
import { extractPdfTextRange } from "./pdf-text.ts";
import {
  addWrongQuestions,
  appendPhoto,
  clearActivePdf,
  clearAdminKeyInputSession,
  clearChatQuizPoll,
  clearChatQuizSession,
  clearForwardQuizSession,
  clearPinnedQuiz,
  clearPhotoSession,
  clearPdfBatch,
  clearPendingPdf,
  clearTrackedChatMessages,
  clearWrongReview,
  loadActivePdf,
  loadAdminProviderAlert,
  loadAdminKeyInputSession,
  loadChatQuizPoll,
  loadChatQuizSession,
  loadForwardQuizSession,
  loadCustomProviderConfig,
  loadPinnedQuiz,
  loadPhotoSession,
  loadPdfBatch,
  loadPendingPdf,
  loadProviderAvailability,
  loadProviderMode,
  loadTrackedChatMessages,
  loadWrongEntries,
  loadWrongQuestions,
  loadWrongReview,
  recordPollAnswer,
  rememberPoll,
  saveActivePdf,
  saveAdminProviderAlert,
  saveAdminKeyInputSession,
  saveChatQuizPoll,
  saveChatQuizSession,
  saveForwardQuizSession,
  savePinnedQuiz,
  saveCustomProviderConfig,
  savePhotoSession,
  savePdfBatch,
  savePendingPdf,
  saveProviderAvailability,
  saveProviderMode,
  saveWrongReview,
  trackChatMessage,
  type PhotoFile,
  type PendingPdfSession,
  type ChatQuizSession,
  type CustomProviderConfig,
  type ProviderMode,
  questionFingerprint,
} from "./bot-state.ts";
import {
  mistralOcrImages,
  mistralOcrPdf,
  validateMistralApiKey,
} from "./mistral-ocr.ts";
import { directionalText, isolateLtr, LRM, RLM, rtlBlock } from "./bidi.ts";
import { friendlyRemainingText } from "./progress.ts";
import {
  CHATGPT_QUIZ_COPY_PROMPT,
  parseChatGptQuizText,
  quizExplanation,
  type QuizQuestion,
} from "./quiz.ts";
import type { RuntimeEnv } from "./runtime.ts";
import {
  activeGeminiApiKey,
  activeBluesMindsApiKey,
  activeMistralApiKey,
  activeMistralApiKeys,
  activeOpenRouterApiKey,
  activeTokenRouterApiKeys,
  activeForgeApiKey,
  activeGroqApiKeys,
  activeSambaNovaApiKeys,
  activeDeepSeekApiKeys,
  activeCustomOpenAiApiKey,
  bluesMindsConfigured,
  geminiConfigured,
  mistralConfigured,
  openRouterConfigured,
  tokenRouterConfigured,
  forgeConfigured,
  groqConfigured,
  sambaNovaConfigured,
  deepSeekConfigured,
  customOpenAiConfigured,
  saveGeminiApiKey,
  saveBluesMindsApiKey,
  saveMistralApiKey,
  saveOpenRouterApiKey,
  saveTokenRouterApiKey,
  saveForgeApiKey,
  saveGroqApiKey,
  saveSambaNovaApiKey,
  saveDeepSeekApiKey,
  saveCustomOpenAiApiKey,
} from "./secure-config.ts";
import {
  extractImagesWithCompatible,
  extractPdfTextWithCompatible,
  safeCompatibleConfig,
  tokenRouterConfig,
  forgeConfig,
  groqConfig,
  sambaNovaConfig,
  deepSeekConfig,
  mistralChatConfig,
  validateCompatibleApiKey,
} from "./openai-compatible.ts";
import { ProviderKeyRotator } from "./key-rotator.ts";

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const AUTO_CHECK_DELAY_MS = 5_000;
const AUTO_MONITOR_MAX_MS = 30 * 60_000;
const POLL_BATCH_SIZE = 8;
const MAX_PHOTO_BATCH = 20;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const CHAT_QUIZ_SECONDS = 45;
const MAX_CHAT_QUIZ_QUESTIONS = 200;
const MAX_CHAT_QUIZ_INPUT_CHARS = 420_000;
const MAX_FORWARDED_QUIZZES = 100;
const PIN_LIFETIME_MS = 24 * 60 * 60_000;
const IRAN_TIME_OFFSET_MS = 3.5 * 60 * 60_000;
const activeJobs = new Set<string>();
let webhookFeaturesConfigured = false;

type TelegramPoll = {
  id?: string;
  question?: string;
  options?: Array<{ text?: string; voter_count?: number }>;
  type?: string;
  correct_option_id?: number;
  explanation?: string;
  is_closed?: boolean;
};

type TelegramMessage = {
  message_id?: number;
  chat?: { id?: number; type?: string; title?: string };
  text?: string;
  poll?: TelegramPoll;
};

type TelegramCallback = {
  id?: string;
  from?: { id?: number };
  data?: string;
  message?: TelegramMessage;
};

export type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number; type?: string; title?: string };
    from?: { id?: number };
    document?: {
      file_id?: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    photo?: Array<{
      file_id?: string;
      file_size?: number;
      width?: number;
      height?: number;
    }>;
    text?: string;
    poll?: TelegramPoll;
  };
  poll_answer?: {
    poll_id?: string;
    user?: { id?: number };
    option_ids?: number[];
  };
  poll?: {
    id?: string;
    is_closed?: boolean;
  };
  callback_query?: TelegramCallback;
  my_chat_member?: {
    chat?: { id?: number; type?: string; title?: string };
    from?: { id?: number };
    new_chat_member?: { status?: string };
  };
};

export type BackgroundTask = () => Promise<void>;

export type TrackedJob = {
  job: GeminiJob;
  offset: number;
  requester_id?: number;
  delivered?: number;
  monitor_started_at?: number;
};

export type AutomaticPdfCheck = {
  chat_id: number;
  message_id: number;
  tracked: TrackedJob;
};

function required(
  env: RuntimeEnv,
  name: "TELEGRAM_BOT_TOKEN" | "GEMINI_API_KEY" | "WEBHOOK_SECRET",
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function geminiKeyForJob(env: RuntimeEnv, job: GeminiJob): string {
  return job.kind === "blues_pdf" ? "" : required(env, "GEMINI_API_KEY");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function telegram<T = unknown>(
  env: RuntimeEnv,
  method: string,
  data: Record<string, unknown>,
): Promise<T> {
  const token = required(env, "TELEGRAM_BOT_TOKEN");
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(6_000),
      },
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (response.ok && payload.ok) return payload.result as T;

    const retryAfter = Number(payload.parameters?.retry_after ?? 0);
    if (retryAfter > 0 && retryAfter <= 2 && attempt < 2) {
      await delay(retryAfter * 1000 + 250);
      continue;
    }
    throw new Error(
      `Telegram ${method}: ${payload.description ?? response.status}`,
    );
  }
  throw new Error(`Telegram ${method} failed`);
}

export async function ensureTelegramWebhookFeatures(
  env: RuntimeEnv,
  origin: string,
): Promise<void> {
  if (webhookFeaturesConfigured) return;
  const secret = required(env, "WEBHOOK_SECRET");
  await telegram(env, "setWebhook", {
    url: `${origin}/api/telegram/${secret}`,
    secret_token: secret,
    allowed_updates: [
      "message",
      "callback_query",
      "poll",
      "poll_answer",
      "my_chat_member",
    ],
    max_connections: 1,
  });
  await telegram(env, "setMyCommands", {
    commands: [
      { command: "start", description: "شروع ربات" },
      { command: "menu", description: "نمایش دوباره منوی پایین" },
      { command: "home", description: "لغو حالت فعلی و خانه" },
      {
        command: "clear",
        description: "پاک‌کردن تست‌ها و پیام‌های ربات از صفحه",
      },
      { command: "reset", description: "برگرداندن آخرین آزمون به حالت نزده" },
      { command: "go", description: "پایان ارسال عکس و شروع آزمون" },
      { command: "chatquiz", description: "ساخت آزمون از متن ChatGPT" },
      { command: "forwardquiz", description: "دریافت کوئیزهای فورواردی" },
      { command: "build", description: "تأیید و شروع آزمون فورواردی" },
      { command: "wrongs", description: "آزمون از غلط‌های امروز" },
      { command: "review", description: "مرور پاسخنامهٔ غلط‌ها" },
      { command: "study", description: "درسنامهٔ آخرین آزمون" },
      { command: "groupquiz", description: "شروع ورود تست از گروه به ربات" },
      { command: "groupstudy", description: "ساخت درسنامه از تست‌های گروه" },
      { command: "status", description: "راهنمای وضعیت پردازش" },
      { command: "help", description: "راهنمای کامل" },
    ],
  });
  await telegram(env, "setMyDescription", {
    description:
      "به ربات تست‌زنی خوش اومدی 👋\nاز PDF، JSON چت‌جی‌پی‌تی، عکس یا کوئیزهای فورواردی آزمون تلگرامی بساز. برای شروع /start رو بزن.",
    language_code: "fa",
  });
  await telegram(env, "setMyShortDescription", {
    short_description:
      "PDF، JSON، عکس یا کوئیز فورواردی را به آزمون تلگرامی تبدیل کن؛ /start",
    language_code: "fa",
  });
  webhookFeaturesConfigured = true;
}

function adminUserId(env: RuntimeEnv): number {
  return Number(env.ADMIN_USER_ID || env.OWNER_ID || "267516215");
}

export function mainMenuMarkup(admin = false): Record<string, unknown> {
  const keyboard = [
    [{ text: "📄 ارسال PDF" }, { text: "⏳ وضعیت پردازش" }],
    [{ text: "🤖 ساخت آزمون از متن ChatGPT" }],
    [{ text: "📨 آزمون از کوئیزهای فورواردی" }],
    [{ text: "🔀 آزمون تست‌های غلط" }, { text: "📚 مرور غلط‌ها" }],
    [{ text: "🖼 افزودن عکس‌های غلط" }],
    [{ text: "ℹ️ راهنما" }, { text: "⌨️ بستن منو" }],
    [{ text: "🏠 خانه" }],
  ];
  if (admin) {
    keyboard.push([{ text: "🛠 پنل مدیریت" }]);
  }
  return {
    keyboard,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "PDF، JSON یا کوئیز فورواردی بفرست...",
  };
}

function adminPanelMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "🔑 مدیریت کلیدها و توکن‌ها", callback_data: "admin_keys" }],
      [{ text: "🎛 انتخاب موتور پردازش", callback_data: "admin_routing" }],
      [{ text: "🧩 وضعیت سرویس‌های پردازش", callback_data: "admin_services" }],
      [{ text: "🏠 خانه", callback_data: "nav_home" }],
    ],
  };
}

function adminKeyMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        {
          text: "➕ ثبت/تعویض کلید Gemini",
          callback_data: "admin_gemini_help",
        },
      ],
      [{ text: "➕ ثبت/تعویض کلید Groq", callback_data: "admin_groq_help" }],
      [
        {
          text: "➕ ثبت/تعویض کلید SambaNova",
          callback_data: "admin_sambanova_help",
        },
      ],
      [
        {
          text: "➕ ثبت/تعویض کلید DeepSeek",
          callback_data: "admin_deepseek_help",
        },
      ],
      [
        {
          text: "➕ ثبت/تعویض کلید TokenRouter",
          callback_data: "admin_tokenrouter_help",
        },
      ],
      [{ text: "➕ ثبت/تعویض کلید Forge", callback_data: "admin_forge_help" }],
      [
        {
          text: "➕ ثبت/تعویض کلید OpenRouter",
          callback_data: "admin_openrouter_help",
        },
      ],
      [
        {
          text: "➕ ثبت/تعویض کلید BluesMinds",
          callback_data: "admin_secondary_help",
        },
      ],
      [
        {
          text: "➕ ثبت/تعویض کلید Mistral AI",
          callback_data: "admin_mistral_help",
        },
      ],
      [
        {
          text: "➕ افزودن سرویس OpenAI-Compatible",
          callback_data: "admin_custom_help",
        },
      ],
      [{ text: "↩️ بازگشت به پنل", callback_data: "admin_panel" }],
    ],
  };
}

const providerModeNames: Record<ProviderMode, string> = {
  auto: "خودکار چندمسیره",
  gemini: "فقط Gemini",
  groq: "فقط Groq",
  sambanova: "فقط SambaNova",
  deepseek: "فقط DeepSeek",
  tokenrouter: "فقط TokenRouter",
  forge: "فقط Forge",
  openrouter: "فقط OpenRouter",
  bluesminds: "فقط BluesMinds",
  mistral: "فقط Mistral AI",
  custom: "فقط سرویس سفارشی",
  local: "فقط استخراج محلی/OCR",
};

function providerRoutingMarkup(active: ProviderMode): Record<string, unknown> {
  const button = (mode: ProviderMode, label: string) => ({
    text: `${active === mode ? "✅ " : ""}${label}`,
    callback_data: `admin_mode_${mode}`,
  });
  return {
    inline_keyboard: [
      [button("auto", "خودکار چندمسیره")],
      [button("groq", "Groq"), button("gemini", "Gemini")],
      [button("sambanova", "SambaNova"), button("deepseek", "DeepSeek")],
      [button("tokenrouter", "TokenRouter")],
      [button("forge", "Forge"), button("openrouter", "OpenRouter")],
      [button("bluesminds", "BluesMinds")],
      [button("mistral", "Mistral AI"), button("custom", "سفارشی")],
      [button("local", "فقط محلی/OCR")],
      [{ text: "↩️ بازگشت به پنل", callback_data: "admin_panel" }],
    ],
  };
}

function providerAllowed(
  mode: ProviderMode,
  provider: Exclude<ProviderMode, "auto">,
): boolean {
  return mode === "auto" || mode === provider;
}

async function showAdminPanel(env: RuntimeEnv, chatId: number): Promise<void> {
  await message(
    env,
    chatId,
    rtlBlock(
      "🛠 <b>پنل مدیریت</b>\nاین بخش فقط برای مدیر اصلی ربات نمایش داده می‌شود.",
    ),
    { parse_mode: "HTML", reply_markup: adminPanelMarkup() },
  );
}

function splitMessage(text: string, limit = 3900): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function message(
  env: RuntimeEnv,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<TelegramMessage> {
  const chunks = splitMessage(text);
  let result: TelegramMessage = {};
  for (let index = 0; index < chunks.length; index++) {
    result = await telegram<TelegramMessage>(env, "sendMessage", {
      chat_id: chatId,
      text: chunks[index],
      ...(index === chunks.length - 1 ? extra : {}),
    });
    if (result.message_id) await trackChatMessage(chatId, result.message_id);
  }
  return result;
}

async function safeEdit(
  env: RuntimeEnv,
  chatId: number,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...extra,
    });
  } catch (error) {
    if (!/message is not modified/i.test(String(error))) throw error;
  }
}

const GEMINI_RECOVERY_CHECK_MS = 30 * 60_000;
const ADMIN_PROVIDER_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

async function notifyAdminProviderFailure(
  env: RuntimeEnv,
  context: string,
): Promise<void> {
  const previous = await loadAdminProviderAlert();
  if (
    previous &&
    Date.now() - previous.alerted_at < ADMIN_PROVIDER_ALERT_COOLDOWN_MS
  )
    return;
  const ownerId = adminUserId(env);
  if (!ownerId) return;
  const alert = await message(
    env,
    ownerId,
    rtlBlock(
      [
        "🚨 <b>هشدار مدیر: مسیرهای پردازش پاسخ ندادند</b>",
        context,
        "کلیدها/سهمیه‌ها را از «پنل مدیریت ← مدیریت کلیدها» بررسی یا یک API تازه ثبت کن.",
        "این هشدار برای دیده‌شدن پین شد و تا ۶ ساعت تکرار نمی‌شود.",
      ].join("\n"),
    ),
    { parse_mode: "HTML", reply_markup: adminPanelMarkup() },
  ).catch(() => ({}) as TelegramMessage);
  if (alert.message_id) {
    await telegram(env, "pinChatMessage", {
      chat_id: ownerId,
      message_id: alert.message_id,
      disable_notification: false,
    }).catch(() => undefined);
  }
  await saveAdminProviderAlert({
    message_id: alert.message_id,
    alerted_at: Date.now(),
    context,
  });
}

async function rememberGeminiQuota(error: unknown): Promise<boolean> {
  if (!/\[G-QUOTA\]|RESOURCE_EXHAUSTED|Gemini[^\n]*429/i.test(String(error)))
    return false;
  const current = await loadProviderAvailability("gemini");
  const now = Date.now();
  await saveProviderAvailability("gemini", {
    status: "quota",
    unavailable_since:
      current?.status === "quota" ? current.unavailable_since : now,
    last_checked: now,
    notified_at: current?.notified_at,
  });
  return true;
}

async function rememberGeminiAvailable(env: RuntimeEnv): Promise<void> {
  const current = await loadProviderAvailability("gemini");
  const now = Date.now();
  if (current?.status !== "quota") {
    await saveProviderAvailability("gemini", {
      status: "available",
      last_checked: now,
    });
    return;
  }
  await saveProviderAvailability("gemini", {
    status: "available",
    last_checked: now,
    notified_at: now,
  });
  const ownerId = adminUserId(env);
  if (ownerId) {
    await message(
      env,
      ownerId,
      rtlBlock(
        "🔔 سهمیهٔ Gemini دوباره فعال شد ✅\nاز این لحظه ربات دوباره مسیر Gemini را امتحان می‌کند.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    ).catch(() => undefined);
  }
}

export async function checkGeminiQuotaRecovery(env: RuntimeEnv): Promise<void> {
  const state = await loadProviderAvailability("gemini");
  const now = Date.now();
  if (
    state?.status !== "quota" ||
    now - state.last_checked < GEMINI_RECOVERY_CHECK_MS
  )
    return;
  const apiKey = await activeGeminiApiKey(env);
  if (!apiKey) return;
  await saveProviderAvailability("gemini", { ...state, last_checked: now });
  try {
    await probeGeminiGenerateContent(apiKey, 6_000);
    await rememberGeminiAvailable(env);
  } catch (error) {
    if (await rememberGeminiQuota(error)) return;
    console.warn("Gemini recovery probe failed without a quota response");
  }
}

function looksLikePdf(buffer: ArrayBuffer): boolean {
  const prefix = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024));
  return new TextDecoder("latin1").decode(prefix).includes("%PDF-");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function encodeTracking(value: TrackedJob): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function decodeTracking(value: string): TrackedJob | null {
  try {
    const padded =
      value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as TrackedJob;
    if (
      !parsed?.job ||
      !["file", "interaction", "blues_pdf"].includes(parsed.job.kind) ||
      typeof parsed.job.id !== "string" ||
      typeof parsed.job.started_at !== "number" ||
      typeof parsed.offset !== "number"
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function trackingFromMessage(text: string | undefined): TrackedJob | null {
  const match = text?.match(/JOB:([A-Za-z0-9_-]+)/);
  return match ? decodeTracking(match[1]) : null;
}

function pageRangeText(job: GeminiJob): string {
  const range = `${isolateLtr(job.page_start)} تا ${isolateLtr(job.page_end)}`;
  return job.total_pages
    ? `صفحات ${range} از ${isolateLtr(job.total_pages)}`
    : `صفحات ${range}`;
}

function trackingHtml(
  title: string,
  detail: string,
  tracked: TrackedJob,
): string {
  const encoded = encodeTracking(tracked);
  const stagePages =
    tracked.job.kind === "file"
      ? tracked.job.total_pages
      : tracked.job.page_end - tracked.job.page_start + 1;
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    tracked.job.kind === "file"
      ? `📍 مرحله ۲ از ۴: آماده‌سازی فایل`
      : `📍 مرحله ۳ از ۴: ${tracked.job.kind === "blues_pdf" ? "پردازش هوشمند از" : "ساخت تست از"} ${pageRangeText(tracked.job)}`,
    escapeHtml(detail),
    escapeHtml(
      friendlyRemainingText(
        tracked.job.started_at,
        tracked.job.size,
        stagePages,
        Date.now(),
        tracked.job.kind === "file" ? "file" : "interaction",
      ),
    ),
    `📄 ${pageRangeText(tracked.job)}`,
    tracked.job.kind === "blues_pdf"
      ? "پردازش این بسته مستقیم انجام می‌شود؛ برای بستهٔ بعدی دکمهٔ ادامه را بزن."
      : "این زمان تقریبی است؛ برای بررسی تازه دکمهٔ پایین را بزن و فایل را دوباره نفرست.",
    "",
    `${LRM}<tg-spoiler>JOB:${encoded}</tg-spoiler>`,
  ];
  return lines.map((line) => (line ? `${RLM}${line}` : "")).join("\n");
}

function continuationHtml(detail: string, tracked: TrackedJob): string {
  const encoded = encodeTracking(tracked);
  const lines = [
    "<b>✅ این بسته تموم شد</b>",
    escapeHtml(detail),
    "برای ادامه، دکمهٔ پایین رو بزن 👇",
    "",
    `${LRM}<tg-spoiler>JOB:${encoded}</tg-spoiler>`,
  ];
  return lines.map((line) => (line ? `${RLM}${line}` : "")).join("\n");
}

export function jobButtons(mode: "check" | "next"): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        {
          text:
            mode === "next"
              ? "▶️ ادامه تست‌های بعدی"
              : "🔄 تازه‌سازی زمان و وضعیت",
          callback_data: mode === "next" ? "job_next" : "job_check",
        },
      ],
      [{ text: "❌ لغو پردازش", callback_data: "job_cancel" }],
    ],
  };
}

async function sendContinuationCard(
  env: RuntimeEnv,
  chatId: number,
  detail: string,
  tracked: TrackedJob,
): Promise<void> {
  await message(env, chatId, continuationHtml(detail, tracked), {
    parse_mode: "HTML",
    reply_markup: jobButtons("next"),
  });
}

async function moveContinuationToBottom(
  env: RuntimeEnv,
  chatId: number,
  messageId: number,
  detail: string,
  tracked: TrackedJob,
): Promise<void> {
  await editTracking(
    env,
    chatId,
    messageId,
    "✅ بستهٔ فعلی ارسال شد",
    detail,
    tracked,
    "none",
  );
  try {
    await sendContinuationCard(env, chatId, detail, tracked);
  } catch (error) {
    console.error("Bottom continuation card failed", error);
    await editTracking(
      env,
      chatId,
      messageId,
      "✅ بستهٔ فعلی ارسال شد",
      `${detail} برای ادامه دکمه را بزن.`,
      tracked,
      "next",
    );
  }
}

async function editTracking(
  env: RuntimeEnv,
  chatId: number,
  messageId: number,
  title: string,
  detail: string,
  tracked: TrackedJob,
  mode: "check" | "next" | "none",
): Promise<void> {
  await safeEdit(env, chatId, messageId, trackingHtml(title, detail, tracked), {
    parse_mode: "HTML",
    reply_markup: mode === "none" ? { inline_keyboard: [] } : jobButtons(mode),
  });
}

function optionLabels(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(index + 1));
}

type QuestionDeliveryOptions = {
  ownerId?: number;
  pin?: boolean;
  timedSeconds?: number;
  allowsRevoting?: boolean;
};

async function safePinMessage(
  env: RuntimeEnv,
  chatId: number,
  messageId: number | undefined,
  ownerId?: number,
): Promise<void> {
  if (!messageId) return;
  await telegram(env, "pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  }).catch((error) => console.warn("Pin first quiz message failed", error));
  if (ownerId) {
    await savePinnedQuiz(ownerId, {
      chat_id: chatId,
      message_id: messageId,
      pinned_at: Date.now(),
      unpin_at: Date.now() + PIN_LIFETIME_MS,
    });
  }
}

async function cleanupExpiredPin(
  env: RuntimeEnv,
  userId: number,
): Promise<void> {
  const pin = await loadPinnedQuiz(userId);
  if (!pin || pin.unpin_at > Date.now()) return;
  await telegram(env, "unpinChatMessage", {
    chat_id: pin.chat_id,
    message_id: pin.message_id,
  }).catch(() => undefined);
  await clearPinnedQuiz(userId);
}

async function sendQuestion(
  env: RuntimeEnv,
  chatId: number,
  question: QuizQuestion,
  position: number,
  total: number,
  delivery: QuestionDeliveryOptions = {},
): Promise<TelegramMessage> {
  const number = question.number || String(position + 1);
  const progress = isolateLtr(`${position + 1}/${total}`);
  const direct = rtlBlock(
    `سؤال ${isolateLtr(number)} — ${progress}\n${directionalText(question.text)}`,
  );
  let pollQuestion = direct;
  let options = question.options;

  if (direct.length > 300 || options.some((option) => option.length > 98)) {
    const labels = optionLabels(options.length);
    await message(
      env,
      chatId,
      rtlBlock(
        [
          `سؤال ${isolateLtr(number)} — ${progress}`,
          directionalText(question.text),
          "",
          ...question.options.map(
            (option, index) =>
              `${isolateLtr(`${labels[index]})`)} ${directionalText(option)}`,
          ),
        ].join("\n"),
      ),
    );
    pollQuestion = rtlBlock(
      `پاسخ سؤال ${isolateLtr(number)} کدام گزینه است؟ — ${progress}`,
    );
    options = labels;
  }

  const explanation = quizExplanation(question, 198);
  const sent = await telegram<TelegramMessage>(env, "sendPoll", {
    chat_id: chatId,
    question: pollQuestion.slice(0, 300),
    options: options.map((text) => ({
      text: directionalText(text).slice(0, 100),
    })),
    type: "quiz",
    is_anonymous: false,
    allows_multiple_answers: false,
    allows_revoting: delivery.allowsRevoting ?? true,
    shuffle_options: false,
    correct_option_id: question.correct_index,
    explanation: rtlBlock(explanation),
    ...(delivery.timedSeconds ? { open_period: delivery.timedSeconds } : {}),
  });
  if (sent.message_id) await trackChatMessage(chatId, sent.message_id);
  if (sent.poll?.id && delivery.ownerId) {
    await rememberPoll(sent.poll.id, delivery.ownerId, question);
  }
  if (delivery.pin)
    await safePinMessage(env, chatId, sent.message_id, delivery.ownerId);
  return sent;
}

function chatQuizModeMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        {
          text: "⏱ زمان‌دار؛ ۴۵ ثانیه برای هر تست",
          callback_data: "chatquiz_timed",
        },
      ],
      [{ text: "♾ بدون زمان", callback_data: "chatquiz_untimed" }],
      [{ text: "🏠 لغو و خانه", callback_data: "chatquiz_cancel" }],
    ],
  };
}

function forwardQuizCollectionMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ تأیید و شروع ساخت آزمون",
          callback_data: "forward_quiz_confirm",
        },
      ],
      [{ text: "🏠 لغو و خانه", callback_data: "forward_quiz_cancel" }],
    ],
  };
}

function groupImportMarkup(study = false): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        {
          text: study
            ? "📚 شروع جمع‌آوری برای درسنامه"
            : "▶️ شروع ساخت آزمون در ربات",
          callback_data: study ? "group_import_study" : "group_import_start",
        },
      ],
      [{ text: "❌ لغو", callback_data: "group_import_cancel" }],
    ],
  };
}

function forwardAnswerMarkup(optionCount: number): Record<string, unknown> {
  const buttons = Array.from({ length: optionCount }, (_, index) => ({
    text: `گزینه ${index + 1}`,
    callback_data: `forward_answer_${index}`,
  }));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < buttons.length; index += 4) {
    rows.push(buttons.slice(index, index + 4));
  }
  rows.push([
    { text: "❌ رد کردن این کوئیز", callback_data: "forward_answer_skip" },
  ]);
  return { inline_keyboard: rows };
}

function chatQuizFinishMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        {
          text: "📊 پایان آزمون و نمایش کارنامه",
          callback_data: "chatquiz_finish",
        },
      ],
      [{ text: "🏠 خانه", callback_data: "chatquiz_cancel" }],
    ],
  };
}

function chatQuizScoreMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "🔁 آزمون دوباره", callback_data: "chatquiz_repeat" },
        {
          text: "❌ آزمون از غلط‌های همین آزمون",
          callback_data: "chatquiz_retry_wrong",
        },
      ],
      [
        {
          text: "🧾 خلاصه و درسنامهٔ جواب‌های اشتباه",
          callback_data: "chatquiz_wrong_summary",
        },
      ],
      [{ text: "🏠 خانه", callback_data: "chatquiz_cancel" }],
    ],
  };
}

function wrongReviewChoiceMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "📅 غلط‌های امروز", callback_data: "wrong_review_today" }],
      [
        {
          text: "📚 همهٔ غلط‌های ذخیره‌شده",
          callback_data: "wrong_review_all",
        },
      ],
      [{ text: "🏠 خانه", callback_data: "nav_home" }],
    ],
  };
}

function newChatQuizId(userId: number): string {
  return `${userId}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

async function beginChatQuizImport(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  await clearForwardQuizSession(userId);
  await clearChatQuizSession(userId);
  await saveChatQuizSession(userId, {
    session_id: newChatQuizId(userId),
    chat_id: chatId,
    status: "awaiting_text",
    questions: [],
    source: "chatgpt",
    current_index: 0,
    answers: [],
    poll_ids: [],
    started_at: Date.now(),
  });
  await message(
    env,
    chatId,
    [
      rtlBlock(
        [
          "🤖 <b>ساخت آزمون از متن ChatGPT</b>",
          "روی کادر زیر بزن و کل دستور را Copy کن؛ در خط «تعداد سؤال» هر تعدادی می‌خواهی بنویس، سپس متن، عکس یا PDF منبع را داخل خود ChatGPT بده.",
          `ربات از ChatGPT فایل نمی‌خواهد؛ فقط JSON نهایی را می‌گیرد و از ${isolateLtr(1)} تا ${isolateLtr(MAX_CHAT_QUIZ_QUESTIONS)} سؤال با گزینه‌های چالش‌برانگیز می‌پذیرد.`,
          "اگر JSON در یک پیام جا نشد، بخش‌های آن را پشت‌سرهم و به‌ترتیب بفرست؛ ربات تا کامل‌شدن متن صبر می‌کند.",
        ].join("\n"),
      ),
      `<pre>${escapeHtml(CHATGPT_QUIZ_COPY_PROMPT)}</pre>`,
      rtlBlock("برای لغو در هر لحظه /Home را بفرست."),
    ].join("\n\n"),
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 لغو و خانه", callback_data: "chatquiz_cancel" }],
        ],
      },
    },
  );
}

async function beginForwardQuizCollection(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  const chatQuiz = await loadChatQuizSession(userId);
  if (chatQuiz) await stopAndForgetChatQuizPolls(env, chatQuiz);
  await clearChatQuizSession(userId);
  await clearForwardQuizSession(userId);
  const status = await message(
    env,
    chatId,
    rtlBlock(
      [
        "📨 <b>دریافت کوئیزهای فورواردی فعال شد</b>",
        "کوئیزهایی را که قبلاً در تلگرام زده‌ای، یکی‌یکی به همین چت Forward کن.",
        "جواب صحیح باید در کوئیز مشخص باشد؛ اگر تلگرام کلید صحیح را به ربات ندهد، آن کوئیز ثبت نمی‌شود.",
        "پس از پایان، دکمهٔ «تأیید و شروع ساخت آزمون» یا دستور /BUILD را بزن.",
        "تعداد دریافت‌شده: ۰",
      ].join("\n"),
    ),
    { parse_mode: "HTML", reply_markup: forwardQuizCollectionMarkup() },
  );
  if (!status.message_id) throw new Error("Forward quiz status ID missing");
  await saveForwardQuizSession(userId, {
    chat_id: chatId,
    status_message_id: status.message_id,
    questions: [],
    started_at: Date.now(),
  });
}

async function acceptForwardedQuiz(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  poll: TelegramPoll,
): Promise<void> {
  const session = await loadForwardQuizSession(userId);
  if (!session || session.chat_id !== chatId) {
    await message(
      env,
      chatId,
      rtlBlock(
        "اول دکمهٔ «📨 آزمون از کوئیزهای فورواردی» را بزن، بعد کوئیزها را Forward کن.",
      ),
      { reply_markup: mainMenuMarkup(userId === adminUserId(env)) },
    );
    return;
  }
  const options = (poll.options ?? [])
    .map((option) => String(option.text ?? "").trim())
    .filter(Boolean);
  const correctIndex = poll.correct_option_id;
  if (
    poll.type !== "quiz" ||
    !String(poll.question ?? "").trim() ||
    options.length < 2 ||
    options.length > 12
  ) {
    await message(
      env,
      chatId,
      rtlBlock(
        [
          "⚠️ این پیام به‌صورت کوئیزِ دارای جواب صحیح قابل‌خواندن نبود و ثبت نشد.",
          "ابتدا در کوئیز اصلی رأی بده تا جواب سبز مشخص شود یا کوئیز بسته‌شده را Forward کن؛ سپس دوباره بفرست.",
        ].join("\n"),
      ),
    );
    return;
  }
  if (
    !Number.isInteger(correctIndex) ||
    correctIndex! < 0 ||
    correctIndex! >= options.length
  ) {
    await saveForwardQuizSession(userId, {
      ...session,
      pending: {
        text: String(poll.question).trim(),
        options,
        explanation: String(poll.explanation ?? "").trim(),
      },
    });
    await message(
      env,
      chatId,
      rtlBlock(
        [
          "⚠️ تلگرام جواب سبز این کوئیز فورواردی را در اختیار Bot API نگذاشت.",
          "برای اینکه تست حذف نشود، جواب درست را یک‌بار از دکمه‌های زیر مشخص کن؛ بعد بقیهٔ کوئیزها را Forward کن.",
          directionalText(String(poll.question)),
        ].join("\n"),
      ),
      { reply_markup: forwardAnswerMarkup(options.length) },
    );
    return;
  }
  if (session.questions.length >= MAX_FORWARDED_QUIZZES) {
    await message(
      env,
      chatId,
      rtlBlock(
        `حداکثر ${isolateLtr(MAX_FORWARDED_QUIZZES)} کوئیز در هر بسته پذیرفته می‌شود؛ حالا /BUILD را بزن.`,
      ),
    );
    return;
  }
  const question: QuizQuestion = {
    number: String(session.questions.length + 1),
    text: String(poll.question).trim(),
    options,
    correct_index: correctIndex!,
    answer_evidence: `EXPLICIT_ANSWER: option ${correctIndex! + 1}; کلید کوئیز فورواردی تلگرام`,
    explanation: String(poll.explanation ?? "").trim(),
  };
  const fingerprint = questionFingerprint(question);
  if (
    session.questions.some((item) => questionFingerprint(item) === fingerprint)
  ) {
    await safeEdit(
      env,
      chatId,
      session.status_message_id,
      rtlBlock(
        `♻️ این کوئیز قبلاً ثبت شده بود. تعداد فعلی: ${isolateLtr(session.questions.length)}`,
      ),
      { reply_markup: forwardQuizCollectionMarkup() },
    );
    return;
  }
  const questions = [...session.questions, question];
  await saveForwardQuizSession(userId, {
    ...session,
    questions,
    pending: undefined,
  });
  await safeEdit(
    env,
    chatId,
    session.status_message_id,
    rtlBlock(
      [
        "📨 کوئیزهای فورواردی در حال جمع‌آوری است.",
        `✅ تعداد دریافت‌شده: ${isolateLtr(questions.length)}`,
        "اگر تمام شده، «تأیید و شروع ساخت آزمون» یا /BUILD را بزن.",
      ].join("\n"),
    ),
    { reply_markup: forwardQuizCollectionMarkup() },
  );
}

async function acceptForwardedQuizAnswer(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  selected: number | null,
): Promise<void> {
  const session = await loadForwardQuizSession(userId);
  if (!session?.pending || session.chat_id !== chatId) {
    await message(
      env,
      chatId,
      rtlBlock("کوئیز منتظرِ تعیین جواب پیدا نشد؛ دوباره آن را Forward کن."),
    );
    return;
  }
  if (selected === null) {
    await saveForwardQuizSession(userId, { ...session, pending: undefined });
    await message(
      env,
      chatId,
      rtlBlock("این کوئیز رد شد؛ بقیه را Forward کن یا /BUILD را بزن."),
      {
        reply_markup: forwardQuizCollectionMarkup(),
      },
    );
    return;
  }
  if (selected < 0 || selected >= session.pending.options.length) return;
  const question: QuizQuestion = {
    number: String(session.questions.length + 1),
    text: session.pending.text,
    options: session.pending.options,
    correct_index: selected,
    answer_evidence: `EXPLICIT_ANSWER: option ${selected + 1}; پاسخ با تأیید کاربر هنگام ورود کوئیز فورواردی`,
    explanation: session.pending.explanation,
  };
  const questions = session.questions.some(
    (item) => questionFingerprint(item) === questionFingerprint(question),
  )
    ? session.questions
    : [...session.questions, question];
  await saveForwardQuizSession(userId, {
    ...session,
    questions,
    pending: undefined,
  });
  await safeEdit(
    env,
    chatId,
    session.status_message_id,
    rtlBlock(
      `✅ جواب ثبت شد. تعداد کوئیزهای آماده: ${isolateLtr(questions.length)}\nبقیه را Forward کن یا /BUILD را بزن.`,
    ),
    { reply_markup: forwardQuizCollectionMarkup() },
  );
}

async function finishForwardQuizCollection(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  const session = await loadForwardQuizSession(userId);
  if (!session?.questions.length) {
    await message(
      env,
      chatId,
      rtlBlock(
        "هنوز هیچ کوئیزِ دارای جواب صحیح ثبت نشده است؛ کوئیزها را Forward کن و بعد دوباره تأیید را بزن.",
      ),
      { reply_markup: forwardQuizCollectionMarkup() },
    );
    return;
  }
  await clearForwardQuizSession(userId);
  await safeEdit(
    env,
    chatId,
    session.status_message_id,
    rtlBlock(
      `✅ دریافت ${isolateLtr(session.questions.length)} کوئیز کامل شد؛ نوع آزمون را انتخاب کن.`,
    ),
    { reply_markup: { inline_keyboard: [] } },
  );
  await saveChatQuizSession(userId, {
    session_id: newChatQuizId(userId),
    chat_id: chatId,
    status: "choose_mode",
    questions: session.questions,
    source: "forwarded",
    current_index: 0,
    answers: Array.from({ length: session.questions.length }, () => null),
    poll_ids: [],
    started_at: Date.now(),
  });
  await message(
    env,
    chatId,
    rtlBlock(
      `✅ ${isolateLtr(session.questions.length)} کوئیز آماده شد. آزمون زمان‌دار باشد یا بدون زمان؟`,
    ),
    { reply_markup: chatQuizModeMarkup() },
  );
}

async function acceptChatQuizText(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  text: string,
): Promise<void> {
  const session = await loadChatQuizSession(userId);
  if (!session || session.status !== "awaiting_text") return;
  const combinedText = `${session.input_text ?? ""}${text}`;
  if (combinedText.length > MAX_CHAT_QUIZ_INPUT_CHARS) {
    await saveChatQuizSession(userId, { ...session, input_text: "" });
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ متن از حد مجاز بزرگ‌تر شد. JSON را از ابتدا و بدون توضیح اضافه، در چند بخش کوتاه‌تر بفرست.",
      ),
    );
    return;
  }
  const questions = parseChatGptQuizText(combinedText);
  if (!questions.length) {
    const trimmed = combinedText.trim();
    const looksComplete =
      trimmed.includes('"questions"') &&
      (trimmed.endsWith("}") || trimmed.endsWith("```"));
    await saveChatQuizSession(userId, {
      ...session,
      input_text: looksComplete ? "" : combinedText,
    });
    await message(
      env,
      chatId,
      rtlBlock(
        [
          looksComplete
            ? "❌ JSON کامل به نظر می‌رسد اما قالب آن معتبر نیست."
            : "📥 این بخش دریافت شد؛ ادامهٔ JSON را بفرست.",
          looksComplete
            ? "JSON را از ابتدا بفرست؛ باید questions، options و answer داشته باشد."
            : "حالت دریافت فعال می‌ماند و لازم نیست دوباره دکمه را بزنی.",
        ].join("\n"),
      ),
    );
    return;
  }
  await saveChatQuizSession(userId, {
    ...session,
    status: "choose_mode",
    source: session.source ?? "chatgpt",
    questions,
    input_text: undefined,
    answers: Array.from({ length: questions.length }, () => null),
    current_index: 0,
  });
  await message(
    env,
    chatId,
    rtlBlock(
      `✅ ${isolateLtr(questions.length)} تست معتبر دریافت شد. آزمون را چطور برگزار کنم؟`,
    ),
    { reply_markup: chatQuizModeMarkup() },
  );
}

function looksLikeChatQuizJson(text: string): boolean {
  const value = text.trim();
  if (!value || (!value.includes("{") && !value.includes("["))) return false;
  return (
    /["“”](?:questions|question|options|answer)["“”]\s*:/i.test(value) ||
    (/\bquestions\b/i.test(value) && /\boptions\b/i.test(value))
  );
}

async function stopAndForgetChatQuizPolls(
  env: RuntimeEnv,
  session: ChatQuizSession,
): Promise<void> {
  for (const pollId of session.poll_ids) {
    const record = await loadChatQuizPoll(pollId);
    if (record) {
      await telegram(env, "stopPoll", {
        chat_id: record.chat_id,
        message_id: record.message_id,
      }).catch(() => undefined);
    }
    await clearChatQuizPoll(pollId);
  }
}

async function finishChatQuiz(
  env: RuntimeEnv,
  userId: number,
  force = false,
): Promise<void> {
  const session = await loadChatQuizSession(userId);
  if (!session || session.status !== "running" || session.summary_sent) return;
  if (
    !force &&
    session.mode === "untimed" &&
    session.answers.some((answer) => answer === null)
  )
    return;
  let correct = 0;
  for (let index = 0; index < session.answers.length; index++) {
    if (session.answers[index] === session.questions[index]?.correct_index)
      correct++;
  }
  const unanswered = session.answers.filter((answer) => answer === null).length;
  const wrong = session.questions.length - correct - unanswered;
  await saveChatQuizSession(userId, {
    ...session,
    status: "completed",
    summary_sent: true,
    current_poll_id: undefined,
    current_poll_message_id: undefined,
    current_poll_started_at: undefined,
  });
  await stopAndForgetChatQuizPolls(env, session);
  const percent = session.questions.length
    ? Math.round((correct / session.questions.length) * 100)
    : 0;
  await message(
    env,
    session.chat_id,
    rtlBlock(
      [
        "🏁 <b>آزمون تمام شد</b>",
        `✅ درست: ${isolateLtr(correct)} از ${isolateLtr(session.questions.length)}`,
        `❌ غلط: ${isolateLtr(wrong)}`,
        `➖ بدون پاسخ: ${isolateLtr(unanswered)}`,
        `📊 نمره: ${isolateLtr(`${percent}٪`)}`,
      ].join("\n"),
    ),
    { parse_mode: "HTML", reply_markup: chatQuizScoreMarkup() },
  );
}

function wrongAnswersFromSession(session: ChatQuizSession): QuizQuestion[] {
  return session.questions.filter((question, index) => {
    const answer = session.answers[index];
    return answer !== null && answer !== question.correct_index;
  });
}

async function sendQuestionCheatSheet(
  env: RuntimeEnv,
  chatId: number,
  title: string,
  questions: QuizQuestion[],
): Promise<void> {
  if (!questions.length) {
    await message(env, chatId, rtlBlock("✅ موردی برای نمایش پیدا نشد."));
    return;
  }
  const cards = questions.map((question, index) => {
    const correct =
      question.options[question.correct_index] ??
      `گزینه ${question.correct_index + 1}`;
    const guide =
      question.explanation.trim() ||
      question.answer_evidence
        .replace(/^EXPLICIT_ANSWER[^;]*;?\s*/i, "")
        .trim();
    return [
      `┏━━ ${index + 1} ━━┓`,
      `❓ ${question.text}`,
      `✅ پاسخ: گزینه ${question.correct_index + 1} — ${correct}`,
      guide ? `💡 نکته: ${guide}` : "",
      "┗━━━━━━┛",
    ]
      .filter(Boolean)
      .join("\n");
  });
  await message(
    env,
    chatId,
    rtlBlock(
      [`🧠 ${title}`, `تعداد: ${questions.length}`, "", ...cards].join("\n\n"),
    ),
  );
}

async function repeatChatQuiz(
  env: RuntimeEnv,
  userId: number,
  wrongOnly: boolean,
): Promise<void> {
  const previous = await loadChatQuizSession(userId);
  if (!previous || !previous.questions.length) {
    await message(
      env,
      userId,
      rtlBlock("آخرین آزمون پیدا نشد؛ از منوی اصلی یک آزمون تازه بساز."),
    );
    return;
  }
  const questions = wrongOnly
    ? wrongAnswersFromSession(previous)
    : previous.questions;
  if (!questions.length) {
    await message(
      env,
      previous.chat_id,
      rtlBlock("🎉 در این آزمون جواب غلطی نداشتی."),
    );
    return;
  }
  await stopAndForgetChatQuizPolls(env, previous);
  await saveChatQuizSession(userId, {
    session_id: newChatQuizId(userId),
    chat_id: previous.chat_id,
    status: "choose_mode",
    source: wrongOnly ? "wrongs" : previous.source,
    questions,
    mode: previous.mode,
    current_index: 0,
    answers: Array.from({ length: questions.length }, () => null),
    poll_ids: [],
    poll_message_ids: [],
    started_at: Date.now(),
  });
  await message(
    env,
    previous.chat_id,
    rtlBlock(
      wrongOnly
        ? `❌ آزمون از ${isolateLtr(questions.length)} غلط همین کارنامه آماده شد.`
        : `🔁 همان ${isolateLtr(questions.length)} تست دوباره آماده شد.`,
    ),
  );
  await startChatQuiz(env, userId, previous.mode ?? "untimed");
}

async function resetCurrentQuiz(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  const previous = await loadChatQuizSession(userId);
  if (!previous?.questions.length) {
    await message(env, chatId, rtlBlock("آزمونی برای ریست پیدا نشد."));
    return;
  }
  await stopAndForgetChatQuizPolls(env, previous);
  const messageIds = new Set([
    ...(previous.poll_message_ids ?? []),
    ...(previous.current_poll_message_id
      ? [previous.current_poll_message_id]
      : []),
  ]);
  for (const messageId of [...messageIds].sort((a, b) => b - a)) {
    await telegram(env, "deleteMessage", {
      chat_id: previous.chat_id,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await saveChatQuizSession(userId, {
    ...previous,
    session_id: newChatQuizId(userId),
    status: "choose_mode",
    current_index: 0,
    answers: Array.from({ length: previous.questions.length }, () => null),
    poll_ids: [],
    poll_message_ids: [],
    current_poll_id: undefined,
    current_poll_message_id: undefined,
    current_poll_started_at: undefined,
    summary_sent: false,
    started_at: Date.now(),
  });
  await message(
    env,
    chatId,
    rtlBlock("♻️ آزمون به حالت نزده برگشت و نسخهٔ تازه‌اش در حال ارسال است."),
  );
  await startChatQuiz(env, userId, previous.mode ?? "untimed");
}

async function sendNextTimedChatQuiz(
  env: RuntimeEnv,
  userId: number,
): Promise<void> {
  const session = await loadChatQuizSession(userId);
  if (!session || session.status !== "running" || session.mode !== "timed")
    return;
  const index = session.current_index;
  if (index >= session.questions.length) {
    await finishChatQuiz(env, userId, true);
    return;
  }
  const sent = await sendQuestion(
    env,
    session.chat_id,
    session.questions[index],
    index,
    session.questions.length,
    {
      ownerId: userId,
      pin: index === 0,
      timedSeconds: CHAT_QUIZ_SECONDS,
      allowsRevoting: false,
    },
  );
  if (!sent.poll?.id || !sent.message_id)
    throw new Error("Timed quiz poll metadata missing");
  await saveChatQuizPoll(sent.poll.id, {
    session_id: session.session_id,
    user_id: userId,
    chat_id: session.chat_id,
    question_index: index,
    message_id: sent.message_id,
    timed: true,
  });
  await saveChatQuizSession(userId, {
    ...session,
    current_poll_id: sent.poll.id,
    current_poll_message_id: sent.message_id,
    current_poll_started_at: Date.now(),
    poll_ids: [...session.poll_ids, sent.poll.id],
    poll_message_ids: [...(session.poll_message_ids ?? []), sent.message_id],
  });
}

async function startChatQuiz(
  env: RuntimeEnv,
  userId: number,
  mode: "timed" | "untimed",
): Promise<void> {
  const session = await loadChatQuizSession(userId);
  if (!session || session.status !== "choose_mode" || !session.questions.length)
    return;
  const running: ChatQuizSession = {
    ...session,
    status: "running",
    mode,
    current_index: 0,
    answers: Array.from({ length: session.questions.length }, () => null),
    poll_ids: [],
    poll_message_ids: [],
    summary_sent: false,
  };
  await saveChatQuizSession(userId, running);
  if (mode === "timed") {
    await message(
      env,
      session.chat_id,
      rtlBlock(
        `⏱ آزمون زمان‌دار شروع شد؛ هر تست ${isolateLtr(CHAT_QUIZ_SECONDS)} ثانیه باز می‌ماند و تست بعدی پس از پاسخ یا پایان زمان می‌آید.`,
      ),
    );
    await sendNextTimedChatQuiz(env, userId);
    return;
  }
  await message(
    env,
    session.chat_id,
    rtlBlock(
      `♾ آزمون بدون زمان شروع شد؛ بعد از پاسخ به همهٔ ${isolateLtr(session.questions.length)} تست، کارنامه خودکار می‌آید.`,
    ),
  );
  const pollIds: string[] = [];
  const pollMessageIds: number[] = [];
  for (let index = 0; index < session.questions.length; index++) {
    const sent = await sendQuestion(
      env,
      session.chat_id,
      session.questions[index],
      index,
      session.questions.length,
      { ownerId: userId, pin: index === 0, allowsRevoting: true },
    );
    if (sent.poll?.id && sent.message_id) {
      pollIds.push(sent.poll.id);
      pollMessageIds.push(sent.message_id);
      await saveChatQuizPoll(sent.poll.id, {
        session_id: session.session_id,
        user_id: userId,
        chat_id: session.chat_id,
        question_index: index,
        message_id: sent.message_id,
        timed: false,
      });
      const latest = (await loadChatQuizSession(userId)) ?? running;
      await saveChatQuizSession(userId, {
        ...latest,
        poll_ids: [...pollIds],
        poll_message_ids: [...pollMessageIds],
      });
    }
    await delay(80);
  }
  await message(
    env,
    session.chat_id,
    rtlBlock("اگر خواستی آزمون را زودتر تمام کنی، دکمهٔ زیر را بزن."),
    { reply_markup: chatQuizFinishMarkup() },
  );
}

async function handleChatQuizPollAnswer(
  env: RuntimeEnv,
  pollId: string,
  userId: number,
  optionIds: number[],
): Promise<void> {
  const record = await loadChatQuizPoll(pollId);
  if (!record || record.user_id !== userId) return;
  const session = await loadChatQuizSession(userId);
  if (
    !session ||
    session.session_id !== record.session_id ||
    session.status !== "running"
  )
    return;
  const selected = optionIds.length ? optionIds[0] : null;
  const answers = [...session.answers];
  answers[record.question_index] = selected;
  if (!record.timed) {
    await saveChatQuizSession(userId, { ...session, answers });
    if (answers.every((answer) => answer !== null))
      await finishChatQuiz(env, userId, true);
    return;
  }
  if (
    selected === null ||
    session.current_index !== record.question_index ||
    session.current_poll_id !== pollId
  ) {
    await saveChatQuizSession(userId, { ...session, answers });
    return;
  }
  await telegram(env, "stopPoll", {
    chat_id: record.chat_id,
    message_id: record.message_id,
  }).catch(() => undefined);
  await clearChatQuizPoll(pollId);
  await saveChatQuizSession(userId, {
    ...session,
    answers,
    current_index: record.question_index + 1,
    current_poll_id: undefined,
    current_poll_message_id: undefined,
    current_poll_started_at: undefined,
  });
  await sendNextTimedChatQuiz(env, userId);
}

async function handleClosedChatQuizPoll(
  env: RuntimeEnv,
  pollId: string,
): Promise<void> {
  const record = await loadChatQuizPoll(pollId);
  if (!record?.timed) return;
  const session = await loadChatQuizSession(record.user_id);
  if (
    !session ||
    session.status !== "running" ||
    session.mode !== "timed" ||
    session.session_id !== record.session_id ||
    session.current_index !== record.question_index ||
    session.current_poll_id !== pollId
  )
    return;
  await clearChatQuizPoll(pollId);
  await saveChatQuizSession(record.user_id, {
    ...session,
    current_index: record.question_index + 1,
    current_poll_id: undefined,
    current_poll_message_id: undefined,
    current_poll_started_at: undefined,
  });
  await sendNextTimedChatQuiz(env, record.user_id);
}

async function recoverExpiredTimedQuiz(
  env: RuntimeEnv,
  userId: number,
): Promise<void> {
  const session = await loadChatQuizSession(userId);
  if (
    !session ||
    session.status !== "running" ||
    session.mode !== "timed" ||
    !session.current_poll_id ||
    !session.current_poll_message_id ||
    !session.current_poll_started_at ||
    Date.now() - session.current_poll_started_at <
      (CHAT_QUIZ_SECONDS + 8) * 1000
  )
    return;
  await telegram(env, "stopPoll", {
    chat_id: session.chat_id,
    message_id: session.current_poll_message_id,
  }).catch(() => undefined);
  await clearChatQuizPoll(session.current_poll_id);
  await saveChatQuizSession(userId, {
    ...session,
    current_index: session.current_index + 1,
    current_poll_id: undefined,
    current_poll_message_id: undefined,
    current_poll_started_at: undefined,
  });
  await sendNextTimedChatQuiz(env, userId);
}

function photoSessionMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "✅ عکس‌ها تمام شد؛ شروع آزمون", callback_data: "photo_go" }],
      [
        { text: "↩️ بازگشت", callback_data: "nav_back" },
        { text: "🏠 خانه", callback_data: "nav_home" },
      ],
    ],
  };
}

function photoResumeMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "▶️ ادامه پردازش عکس‌ها", callback_data: "photo_resume" }],
      [{ text: "🏠 خانه", callback_data: "nav_home" }],
    ],
  };
}

function wrongReviewMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "▶️ ادامه تست‌های غلط", callback_data: "wrong_next" }],
      [{ text: "🏠 خانه", callback_data: "nav_home" }],
    ],
  };
}

function shuffleQuestions(questions: QuizQuestion[]): QuizQuestion[] {
  const shuffled = [...questions];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

async function clearInlineKeyboard(
  env: RuntimeEnv,
  chatId: number,
  messageId: number | undefined,
): Promise<void> {
  if (!messageId) return;
  try {
    await telegram(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (error) {
    if (!/message is not modified/i.test(String(error)))
      console.warn("Keyboard clear failed", error);
  }
}

async function beginPhotoCollection(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  const chatQuiz = await loadChatQuizSession(userId);
  if (chatQuiz) await stopAndForgetChatQuizPolls(env, chatQuiz);
  await clearChatQuizSession(userId);
  await clearForwardQuizSession(userId);
  await clearPhotoSession(userId);
  const status = await message(
    env,
    chatId,
    rtlBlock(
      [
        "🖼 <b>حالت دریافت عکس‌های غلط فعال شد</b>",
        `مرحله ۱ از ۳: عکس‌ها را یکی‌یکی یا دسته‌جمعی بفرست (حداکثر ${isolateLtr(MAX_PHOTO_BATCH)} عکس).`,
        "سبز باید جواب درست و قرمز جواب اشتباه باشد.",
        "وقتی تمام شد دکمهٔ زیر را بزن یا دستور /GO را بفرست.",
        "برای لغو کامل هم /Home را بفرست.",
      ].join("\n"),
    ),
    { parse_mode: "HTML", reply_markup: photoSessionMarkup() },
  );
  if (!status.message_id) throw new Error("Photo session status ID missing");
  await savePhotoSession(userId, {
    chat_id: chatId,
    status_message_id: status.message_id,
    files: [],
    started_at: Date.now(),
  });
}

async function acceptPhoto(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  file: PhotoFile,
): Promise<void> {
  let session = await loadPhotoSession(userId);
  if (!session) {
    await beginPhotoCollection(env, chatId, userId);
    session = await loadPhotoSession(userId);
  }
  if (!session) throw new Error("Photo session could not be created");
  if (session.files.length >= MAX_PHOTO_BATCH) {
    await message(
      env,
      chatId,
      rtlBlock(
        `حداکثر ${isolateLtr(MAX_PHOTO_BATCH)} عکس در هر نوبت پذیرفته می‌شود؛ حالا /GO را بفرست.`,
      ),
    );
    return;
  }
  const updated = await appendPhoto(userId, file);
  if (!updated) return;
  await safeEdit(
    env,
    chatId,
    updated.status_message_id,
    rtlBlock(
      [
        "🖼 <b>عکس‌ها در حال جمع‌شدن هستند</b>",
        `مرحله ۱ از ۳: ${isolateLtr(updated.files.length)} عکس ثبت شد.`,
        "بقیه را بفرست؛ پس از آخرین عکس دکمهٔ شروع را بزن یا /GO را ارسال کن.",
      ].join("\n"),
    ),
    { parse_mode: "HTML", reply_markup: photoSessionMarkup() },
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

async function downloadPhoto(
  env: RuntimeEnv,
  file: PhotoFile,
): Promise<{ data: string; mime_type: string; size: number }> {
  const info = await telegram<{ file_path?: string }>(env, "getFile", {
    file_id: file.file_id,
  });
  if (!info.file_path) throw new Error("Telegram image path missing");
  const token = required(env, "TELEGRAM_BOT_TOKEN");
  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${info.file_path}`,
    {
      signal: AbortSignal.timeout(6_000),
    },
  );
  if (!response.ok)
    throw new Error(`Telegram image download failed: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return {
    data: arrayBufferToBase64(buffer),
    mime_type: file.mime_type,
    size: buffer.byteLength,
  };
}

async function sendWrongReviewBatch(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  sourceMessageId?: number,
): Promise<void> {
  const review = await loadWrongReview(userId);
  if (!review || !review.questions.length) {
    await message(
      env,
      chatId,
      rtlBlock("هنوز تست غلطی برای مرور ذخیره نشده است."),
      {
        reply_markup: mainMenuMarkup(),
      },
    );
    return;
  }
  await clearInlineKeyboard(env, chatId, sourceMessageId);
  let offset = Math.max(0, Math.min(review.offset, review.questions.length));
  const batchStart = offset;
  const end = Math.min(offset + POLL_BATCH_SIZE, review.questions.length);
  const progress = await message(
    env,
    chatId,
    rtlBlock(
      `🔀 در حال ارسال تست‌های غلط ${isolateLtr(offset + 1)} تا ${isolateLtr(end)} از ${isolateLtr(review.questions.length)}…`,
    ),
  );
  for (; offset < end; offset++) {
    await sendQuestion(
      env,
      chatId,
      review.questions[offset],
      offset,
      review.questions.length,
      {
        ownerId: userId,
        pin: offset === batchStart,
      },
    );
    await delay(80);
  }
  if (offset < review.questions.length) {
    await saveWrongReview(userId, { ...review, offset });
    if (progress.message_id) {
      await safeEdit(
        env,
        chatId,
        progress.message_id,
        rtlBlock(
          `✅ ${isolateLtr(offset)} تست از ${isolateLtr(review.questions.length)} تست غلط ارسال شد.`,
        ),
        { reply_markup: { inline_keyboard: [] } },
      );
    }
    await message(
      env,
      chatId,
      rtlBlock("برای بستهٔ شافل بعدی، دکمهٔ زیر را بزن 👇"),
      { reply_markup: wrongReviewMarkup() },
    );
    return;
  }
  await clearWrongReview(userId);
  if (progress.message_id) {
    await safeEdit(
      env,
      chatId,
      progress.message_id,
      rtlBlock(
        `✅ مرور هر ${isolateLtr(review.questions.length)} تست غلط کامل شد.`,
      ),
      { reply_markup: { inline_keyboard: [] } },
    );
  }
  await message(
    env,
    chatId,
    rtlBlock("🏠 برای برگشت به صفحهٔ اصلی، دکمهٔ خانه را بزن."),
    {
      reply_markup: mainMenuMarkup(),
    },
  );
}

async function startWrongReview(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  const shiftedNow = Date.now() + IRAN_TIME_OFFSET_MS;
  const startOfShiftedDay = Math.floor(shiftedNow / 86_400_000) * 86_400_000;
  const todayStart = startOfShiftedDay - IRAN_TIME_OFFSET_MS;
  const questions = await loadWrongQuestions(userId, todayStart);
  if (!questions.length) {
    await message(
      env,
      chatId,
      rtlBlock(
        "امروز هنوز تست غلطی ثبت نشده است. برای دیدن غلط‌های قدیمی، «📚 مرور غلط‌ها» را بزن.",
      ),
      { reply_markup: mainMenuMarkup(userId === adminUserId(env)) },
    );
    return;
  }
  const shuffled = shuffleQuestions(questions);
  await saveChatQuizSession(userId, {
    session_id: newChatQuizId(userId),
    chat_id: chatId,
    status: "choose_mode",
    source: "wrongs",
    questions: shuffled,
    current_index: 0,
    answers: Array.from({ length: shuffled.length }, () => null),
    poll_ids: [],
    poll_message_ids: [],
    started_at: Date.now(),
  });
  await message(
    env,
    chatId,
    rtlBlock(
      `🔀 ${isolateLtr(shuffled.length)} تست غلطِ امروز پیدا شد. نوع آزمون را انتخاب کن:`,
    ),
    { reply_markup: chatQuizModeMarkup() },
  );
}

async function showWrongReviewChoices(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  const entries = await loadWrongEntries(userId);
  if (!entries.length) {
    await message(
      env,
      chatId,
      rtlBlock(
        "هنوز غلطی ذخیره نشده است؛ هر جواب غلط در کوئیزهای ربات خودکار به این دفتر اضافه می‌شود.",
      ),
      { reply_markup: mainMenuMarkup(userId === adminUserId(env)) },
    );
    return;
  }
  await message(
    env,
    chatId,
    rtlBlock(
      "📚 <b>مرور غلط‌ها</b>\nپاسخنامهٔ جمع‌بندی‌شده را برای کدام بازه می‌خواهی؟",
    ),
    { parse_mode: "HTML", reply_markup: wrongReviewChoiceMarkup() },
  );
}

async function sendWrongCheatSheet(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  todayOnly: boolean,
): Promise<void> {
  const shiftedNow = Date.now() + IRAN_TIME_OFFSET_MS;
  const todayStart =
    Math.floor(shiftedNow / 86_400_000) * 86_400_000 - IRAN_TIME_OFFSET_MS;
  const entries = await loadWrongEntries(userId);
  const questions = entries
    .filter((entry) => !todayOnly || entry.last_wrong_at >= todayStart)
    .sort((a, b) => b.last_wrong_at - a.last_wrong_at)
    .map((entry) => entry.question);
  await sendQuestionCheatSheet(
    env,
    chatId,
    todayOnly ? "چیت‌شیت غلط‌های امروز" : "چیت‌شیت همهٔ غلط‌ها",
    questions,
  );
}

export type PhotoJobPayload = {
  chat_id: number;
  user_id: number;
  status_message_id: number;
};

async function processPhotoBatch(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  origin?: string,
): Promise<void> {
  const session = await loadPhotoSession(userId);
  if (!session?.files.length) {
    await message(
      env,
      chatId,
      rtlBlock("اول حداقل یک عکس بفرست؛ بعد /GO را بزن."),
      {
        reply_markup: mainMenuMarkup(),
      },
    );
    return;
  }
  if (session.processing) {
    await safeEdit(
      env,
      chatId,
      session.status_message_id,
      rtlBlock(
        "⏳ پردازش عکس‌ها در حال انجام است؛ همان پیام خودکار به‌روز می‌شود.",
      ),
    );
    return;
  }
  let statusMessageId = session.status_message_id;
  try {
    await safeEdit(
      env,
      chatId,
      session.status_message_id,
      rtlBlock(
        `✅ ${isolateLtr(session.files.length)} عکس دریافت شد؛ وضعیت پردازش در پیام پایین نمایش داده می‌شود.`,
      ),
      { reply_markup: { inline_keyboard: [] } },
    );
    const bottomStatus = await message(
      env,
      chatId,
      rtlBlock(`⚙️ پردازش ${isolateLtr(session.files.length)} عکس شروع شد…`),
    );
    if (bottomStatus.message_id) {
      statusMessageId = bottomStatus.message_id;
    }
    const providerMode = await loadProviderMode();
    const initialStage =
      providerMode === "auto"
        ? "groq"
        : providerMode === "local" ||
            providerMode === "sambanova" ||
            providerMode === "deepseek"
          ? "ocr"
          : providerMode;
    await savePhotoSession(userId, {
      ...session,
      status_message_id: statusMessageId,
      processing: {
        stage: initialStage,
        cursor: 0,
        ocr_texts: [],
        started_at: Date.now(),
      },
    });
    await resumePhotoProcessing(env, {
      chat_id: chatId,
      user_id: userId,
      status_message_id: statusMessageId,
    });
  } catch (error) {
    console.error("Photo worker could not start", error);
    await savePhotoSession(userId, {
      ...session,
      status_message_id: statusMessageId,
    });
    await safeEdit(
      env,
      chatId,
      statusMessageId,
      rtlBlock(
        "❌ شروع پردازش عکس‌ها کامل نشد؛ عکس‌ها نگه داشته شده‌اند. دوباره /GO را بزن.",
      ),
      { reply_markup: photoSessionMarkup() },
    );
  }
}

async function downloadInlineImages(
  env: RuntimeEnv,
  files: PhotoFile[],
): Promise<Array<{ data: string; mime_type: string }>> {
  const downloaded = await Promise.all(
    files.map((file) => downloadPhoto(env, file)),
  );
  const totalBytes = downloaded.reduce((sum, image) => sum + image.size, 0);
  if (totalBytes > MAX_IMAGE_BYTES)
    throw new Error("Image batch exceeds size limit");
  return downloaded.map((image) => ({
    data: image.data,
    mime_type: image.mime_type,
  }));
}

async function preparePhotoDelivery(
  env: RuntimeEnv,
  session: NonNullable<Awaited<ReturnType<typeof loadPhotoSession>>>,
  userId: number,
  questions: QuizQuestion[],
): Promise<void> {
  const bankCount = await addWrongQuestions(userId, questions);
  await saveChatQuizSession(userId, {
    session_id: newChatQuizId(userId),
    chat_id: session.chat_id,
    status: "choose_mode",
    source: "photos",
    questions,
    current_index: 0,
    answers: Array.from({ length: questions.length }, () => null),
    poll_ids: [],
    poll_message_ids: [],
    started_at: Date.now(),
  });
  await savePhotoSession(userId, {
    ...session,
    processing: {
      ...session.processing!,
      stage: "deliver",
      result_count: questions.length,
      bank_count: bankCount,
    },
  });
}

async function failPhotoJob(
  env: RuntimeEnv,
  session: NonNullable<Awaited<ReturnType<typeof loadPhotoSession>>>,
  userId: number,
  detail: string,
): Promise<void> {
  if (/سرویس|پاسخ نداد|quota|429|اعتبار|api/i.test(detail)) {
    await notifyAdminProviderFailure(
      env,
      `پردازش عکس‌ها برای کاربر ${userId} پس از امتحان مسیرهای فعال کامل نشد.`,
    );
  }
  await savePhotoSession(userId, { ...session, processing: undefined });
  await safeEdit(
    env,
    session.chat_id,
    session.status_message_id,
    rtlBlock(
      `❌ ساخت تست از عکس‌ها کامل نشد\n${detail}\nعکس‌ها نگه داشته شده‌اند؛ دوباره /GO را بزن یا /Home را برای لغو بفرست.`,
    ),
    { reply_markup: photoSessionMarkup() },
  );
}

export async function runPhotoProcessingJob(
  env: RuntimeEnv,
  payload: PhotoJobPayload,
): Promise<boolean> {
  const session = await loadPhotoSession(payload.user_id);
  if (
    !session?.processing ||
    session.chat_id !== payload.chat_id ||
    session.status_message_id !== payload.status_message_id
  )
    return false;

  const stage = session.processing.stage;
  const providerMode = await loadProviderMode();
  if (stage === "deliver") {
    const count = session.processing.result_count ?? 0;
    const wrongQuestions = await loadWrongQuestions(payload.user_id);
    const bankCount = session.processing.bank_count ?? wrongQuestions.length;
    await clearPhotoSession(payload.user_id);
    await safeEdit(
      env,
      session.chat_id,
      session.status_message_id,
      rtlBlock(
        `✅ ${isolateLtr(count)} تست از عکس‌ها ساخته شد؛ دفتر غلط‌ها حالا ${isolateLtr(bankCount)} تست دارد.\nنوع آزمون را انتخاب کن:`,
      ),
      { reply_markup: chatQuizModeMarkup() },
    );
    return false;
  }
  if (stage === "groq") {
    await safeEdit(
      env,
      session.chat_id,
      session.status_message_id,
      rtlBlock("⚡ مسیر ۱ از ۹: Groq در حال بررسی سریع عکس‌هاست…"),
    );
    const groqKeys = await activeGroqApiKeys(env);
    if (groqKeys.length && providerAllowed(providerMode, "groq")) {
      const cursor = Math.max(0, session.processing.cursor);
      const files = session.files.slice(cursor, cursor + 5);
      try {
        const images = await downloadInlineImages(env, files);
        const extracted = await new ProviderKeyRotator(groqKeys).run(
          async (apiKey) =>
            await extractImagesWithCompatible(
              images,
              apiKey,
              groqConfig(env.GROQ_MODEL),
            ),
        );
        const merged = [
          ...(session.processing.partial_questions ?? []),
          ...extracted,
        ].filter(
          (question, index, all) =>
            all.findIndex(
              (item) =>
                questionFingerprint(item) === questionFingerprint(question),
            ) === index,
        );
        const nextCursor = cursor + files.length;
        if (nextCursor < session.files.length) {
          await savePhotoSession(payload.user_id, {
            ...session,
            processing: {
              ...session.processing,
              cursor: nextCursor,
              partial_questions: merged,
            },
          });
          await safeEdit(
            env,
            session.chat_id,
            session.status_message_id,
            rtlBlock(
              `⚡ Groq: ${isolateLtr(nextCursor)} از ${isolateLtr(session.files.length)} عکس بررسی شد…`,
            ),
          );
          return true;
        }
        await preparePhotoDelivery(env, session, payload.user_id, merged);
        return true;
      } catch (error) {
        console.warn(
          "Groq photo stage failed; moving to Gemini",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
    await savePhotoSession(payload.user_id, {
      ...session,
      processing: {
        ...session.processing,
        stage: "gemini",
        cursor: 0,
        partial_questions: undefined,
      },
    });
    return true;
  }
  if (stage === "gemini") {
    await safeEdit(
      env,
      session.chat_id,
      session.status_message_id,
      rtlBlock("🧠 مسیر ۲ از ۹: Gemini در حال ساخت تست‌هاست…"),
    );
    const apiKey = await activeGeminiApiKey(env);
    if (apiKey && providerAllowed(providerMode, "gemini")) {
      try {
        const images = await downloadInlineImages(env, session.files);
        const questions = await extractImagesWithGeminiStage(images, apiKey);
        await rememberGeminiAvailable(env);
        await preparePhotoDelivery(env, session, payload.user_id, questions);
        return true;
      } catch (error) {
        await rememberGeminiQuota(error);
        console.warn(
          "Gemini photo stage failed; moving to TokenRouter",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
    await savePhotoSession(payload.user_id, {
      ...session,
      processing: { ...session.processing, stage: "tokenrouter" },
    });
    return true;
  }

  if (stage === "tokenrouter") {
    await safeEdit(
      env,
      session.chat_id,
      session.status_message_id,
      rtlBlock("🆓 مسیر ۳ از ۹: TokenRouter در حال بررسی عکس‌هاست…"),
    );
    if (providerAllowed(providerMode, "tokenrouter")) {
      const keys = await activeTokenRouterApiKeys(env);
      if (keys.length) {
        try {
          const images = await downloadInlineImages(env, session.files);
          const questions = await new ProviderKeyRotator(keys).run(
            async (apiKey) =>
              await extractImagesWithCompatible(
                images,
                apiKey,
                tokenRouterConfig(env.TOKENROUTER_MODEL),
              ),
          );
          await preparePhotoDelivery(env, session, payload.user_id, questions);
          return true;
        } catch (error) {
          console.warn(
            "TokenRouter photo keys failed; moving to next route",
            error instanceof Error ? error.message : "unknown",
          );
        }
      }
    }
    await savePhotoSession(payload.user_id, {
      ...session,
      processing: { ...session.processing, stage: "forge" },
    });
    return true;
  }

  if (stage === "forge") {
    await safeEdit(
      env,
      session.chat_id,
      session.status_message_id,
      rtlBlock("🔥 مسیر ۴ از ۹: Forge در حال بررسی عکس‌هاست…"),
    );
    const apiKey = await activeForgeApiKey(env);
    if (apiKey && providerAllowed(providerMode, "forge")) {
      try {
        const images = await downloadInlineImages(env, session.files);
        const questions = await extractImagesWithCompatible(
          images,
          apiKey,
          forgeConfig(env.FORGE_MODEL),
        );
        await preparePhotoDelivery(env, session, payload.user_id, questions);
        return true;
      } catch (error) {
        console.warn(
          "Forge photo stage failed; moving to OpenRouter",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
    await savePhotoSession(payload.user_id, {
      ...session,
      processing: { ...session.processing, stage: "openrouter" },
    });
    return true;
  }

  if (stage === "openrouter") {
    await safeEdit(
      env,
      session.chat_id,
      session.status_message_id,
      rtlBlock("🧠 مسیر ۵ از ۹: OpenRouter در حال ساخت تست‌هاست…"),
    );
    const apiKey = await activeOpenRouterApiKey(env);
    if (apiKey && providerAllowed(providerMode, "openrouter")) {
      try {
        const images = await downloadInlineImages(env, session.files);
        const questions = await extractImagesWithOpenRouterStage(
          images,
          apiKey,
          env.OPENROUTER_MODEL,
        );
        await preparePhotoDelivery(env, session, payload.user_id, questions);
        return true;
      } catch (error) {
        console.warn(
          "OpenRouter photo stage failed; moving to custom provider",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
    await savePhotoSession(payload.user_id, {
      ...session,
      processing: { ...session.processing, stage: "custom" },
    });
    return true;
  }

  if (stage === "custom") {
    await safeEdit(
      env,
      session.chat_id,
      session.status_message_id,
      rtlBlock("🧰 مسیر ۶ از ۹: سرویس سفارشی در حال بررسی عکس‌هاست…"),
    );
    const config = await loadCustomProviderConfig();
    const apiKey = await activeCustomOpenAiApiKey(env);
    if (config && apiKey !== null && providerAllowed(providerMode, "custom")) {
      try {
        const images = await downloadInlineImages(env, session.files);
        const questions = await extractImagesWithCompatible(
          images,
          apiKey,
          config,
        );
        await preparePhotoDelivery(env, session, payload.user_id, questions);
        return true;
      } catch (error) {
        console.warn(
          "Custom photo stage failed; moving to BluesMinds",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
    await savePhotoSession(payload.user_id, {
      ...session,
      processing: { ...session.processing, stage: "bluesminds" },
    });
    return true;
  }

  if (stage === "bluesminds") {
    await safeEdit(
      env,
      session.chat_id,
      session.status_message_id,
      rtlBlock("🧠 مسیر ۷ از ۹: BluesMinds در حال ساخت تست‌هاست…"),
    );
    const apiKey = await activeBluesMindsApiKey(env);
    if (apiKey && providerAllowed(providerMode, "bluesminds")) {
      try {
        const images = await downloadInlineImages(env, session.files);
        const questions = await extractImagesWithBluesMindsStage(
          images,
          apiKey,
          env.BLUESMINDS_MODEL,
        );
        await preparePhotoDelivery(env, session, payload.user_id, questions);
        return true;
      } catch (error) {
        console.warn(
          "BluesMinds photo stage failed; moving to Mistral OCR",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
    await savePhotoSession(payload.user_id, {
      ...session,
      processing: {
        ...session.processing,
        stage: "mistral",
        cursor: 0,
        ocr_texts: [],
      },
    });
    await safeEdit(
      env,
      session.chat_id,
      session.status_message_id,
      rtlBlock(
        "🔎 مسیر ۸ از ۹: OCR تخصصی فارسی آماده است. دکمهٔ ادامه را بزن.",
      ),
      { reply_markup: photoResumeMarkup() },
    );
    return true;
  }

  if (stage === "mistral") {
    const mistralKey = await activeMistralApiKey(env);
    if (!mistralKey || !providerAllowed(providerMode, "mistral")) {
      await savePhotoSession(payload.user_id, {
        ...session,
        processing: {
          ...session.processing,
          stage: "ocr",
          cursor: 0,
          ocr_texts: [],
        },
      });
      return true;
    }
    const cursor = Math.max(0, session.processing.cursor);
    const files = session.files.slice(cursor, cursor + 3);
    try {
      const images = await downloadInlineImages(env, files);
      const texts = await mistralOcrImages(images, mistralKey);
      const nextCursor = cursor + files.length;
      const nextTexts = [...session.processing.ocr_texts, ...texts];
      if (nextCursor < session.files.length) {
        await savePhotoSession(payload.user_id, {
          ...session,
          processing: {
            ...session.processing,
            cursor: nextCursor,
            ocr_texts: nextTexts,
          },
        });
        await safeEdit(
          env,
          session.chat_id,
          session.status_message_id,
          rtlBlock(
            `🔎 OCR تخصصی: ${isolateLtr(nextCursor)} از ${isolateLtr(session.files.length)} عکس خوانده شد…`,
          ),
        );
        return true;
      }
      const questions = extractExplicitQuizFromOcr(nextTexts);
      if (questions.length) {
        await preparePhotoDelivery(env, session, payload.user_id, questions);
        return true;
      }
    } catch (error) {
      console.warn(
        "Mistral OCR photo stage failed; moving to OCR.Space",
        error instanceof Error ? error.message : "unknown",
      );
    }
    await savePhotoSession(payload.user_id, {
      ...session,
      processing: {
        ...session.processing,
        stage: "ocr",
        cursor: 0,
        ocr_texts: [],
      },
    });
    return true;
  }

  const cursor = Math.max(0, session.processing.cursor);
  const files = session.files.slice(cursor, cursor + 3);
  if (files.length) {
    try {
      const images = await downloadInlineImages(env, files);
      const texts = await ocrImagesStage(images, env.OCR_SPACE_API_KEY);
      const nextCursor = cursor + files.length;
      const nextTexts = [...session.processing.ocr_texts, ...texts];
      await savePhotoSession(payload.user_id, {
        ...session,
        processing: {
          ...session.processing,
          cursor: nextCursor,
          ocr_texts: nextTexts,
        },
      });
      await safeEdit(
        env,
        session.chat_id,
        session.status_message_id,
        rtlBlock(
          `🔎 مسیر ۹ از ۹: ${isolateLtr(nextCursor)} از ${isolateLtr(session.files.length)} عکس بررسی شد…`,
        ),
      );
      if (nextCursor < session.files.length) return true;
      const questions = extractExplicitQuizFromOcr(nextTexts);
      if (questions.length) {
        await preparePhotoDelivery(env, session, payload.user_id, questions);
        return true;
      }
    } catch (error) {
      console.warn(
        "OCR photo stage failed",
        error instanceof Error ? error.message : "unknown",
      );
      await failPhotoJob(
        env,
        session,
        payload.user_id,
        "دانلود عکس یا سرویس OCR پاسخ نداد. عکس‌ها حذف نشده‌اند؛ چند لحظه بعد دوباره تلاش کن.",
      );
      return false;
    }
  }
  await failPhotoJob(
    env,
    session,
    payload.user_id,
    "هیچ سؤال کامل با پاسخ درستِ صریح پیدا نشد. برای جواب‌های رنگی، تصویر باید واضح و کامل باشد.",
  );
  return false;
}

async function resumePhotoProcessing(
  env: RuntimeEnv,
  payload: PhotoJobPayload,
): Promise<void> {
  for (let step = 0; step < 2; step++) {
    const shouldContinue = await runPhotoProcessingJob(env, payload);
    if (!shouldContinue) return;
    const current = await loadPhotoSession(payload.user_id);
    if (!current?.processing) return;
    if (current.processing.stage === "deliver") continue;
    await safeEdit(
      env,
      current.chat_id,
      current.status_message_id,
      current.processing.stage === "ocr"
        ? rtlBlock(
            `🔎 OCR آمادهٔ ادامه است؛ ${isolateLtr(current.processing.cursor)} از ${isolateLtr(current.files.length)} عکس بررسی شده.`,
          )
        : rtlBlock("▶️ برای ادامهٔ پردازش دکمهٔ پایین را بزن."),
      { reply_markup: photoResumeMarkup() },
    );
    return;
  }
}

function friendlyFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/Groq.*(?:\[C-QUOTA\]|402|429)/i.test(detail)) {
    return "سهمیهٔ Groq فعلاً پر یا سرویس شلوغ است؛ در حالت خودکار مسیر Gemini بلافاصله امتحان می‌شود. (کد Q-QUOTA)";
  }
  if (/Groq.*(?:\[C-AUTH\]|401|403)/i.test(detail)) {
    return "کلید Groq معتبر نیست؛ از پنل مدیریت کلید را دوباره ثبت کن. (کد Q-AUTH)";
  }
  if (/TokenRouter.*(?:\[C-QUOTA\]|402|429)/i.test(detail)) {
    return "مدل رایگان TokenRouter فعلاً شلوغ یا محدود شده است؛ در حالت خودکار مسیر بعدی امتحان می‌شود. (کد T-QUOTA)";
  }
  if (/TokenRouter.*(?:\[C-AUTH\]|401|403)/i.test(detail)) {
    return "کلید TokenRouter معتبر نیست؛ از بخش افزودن API کلید را دوباره ثبت کن. (کد T-AUTH)";
  }
  if (/\[O-QUOTA\]|OpenRouter.*(?:402|429)/i.test(detail)) {
    return "اعتبار یا سهمیهٔ OpenRouter فعلاً کافی نیست؛ مسیرهای بعدی خودکار امتحان می‌شوند. (کد O-QUOTA)";
  }
  if (/\[O-AUTH\]|OpenRouter.*(?:401|403)/i.test(detail)) {
    return "کلید OpenRouter معتبر نیست؛ از پنل مدیر کلید را دوباره ثبت کن. (کد O-AUTH)";
  }
  if (/\[O-UPSTREAM\]|OpenRouter.*5\d\d/i.test(detail)) {
    return "OpenRouter موقتاً پاسخ نداد و مسیرهای پشتیبان هم نتیجهٔ کامل ندادند. (کد O-UPSTREAM)";
  }
  if (/\[B-QUOTA\]|BluesMinds.*429/i.test(detail)) {
    return "سهمیهٔ BluesMinds فعلاً پر شده است؛ مسیر OCR برای متن‌های دارای پاسخ صریح استفاده می‌شود. (کد B-429)";
  }
  if (/\[B-AUTH\]|BluesMinds.*(?:401|403)|not configured/i.test(detail)) {
    return "کلید BluesMinds معتبر نیست یا دسترسی مدل ندارد. از پنل مدیریت کلید را بررسی کن. (کد B-AUTH)";
  }
  if (/\[B-UPSTREAM\]|BluesMinds.*5\d\d/i.test(detail)) {
    return "سرویس BluesMinds موقتاً پاسخ نداد و OCR هم سؤال کامل با پاسخ صریح پیدا نکرد. (کد B-UPSTREAM)";
  }
  if (/no compatible text model|model catalog is empty/i.test(detail)) {
    return "حساب BluesMinds مدل چت قابل‌استفاده برنگرداند. مدل‌های حساب را در پنل BluesMinds بررسی کن. (کد B-MODEL)";
  }
  if (/BluesMinds|\[B-|output missing|JSON|Unexpected token/i.test(detail)) {
    return "پاسخ BluesMinds کامل یا قابل‌خواندن نبود و OCR هم تست معتبری پیدا نکرد. دوباره امتحان کن. (کد B-OUTPUT)";
  }
  if (/\[G-QUOTA\]|429|RESOURCE_EXHAUSTED|quota/i.test(detail)) {
    return "سهمیهٔ Gemini فعلاً پر شده است؛ کمی بعد دوباره امتحان کن. (کد G-429)";
  }
  if (/\[G-AUTH\]|401|403|API_KEY_INVALID|API key/i.test(detail)) {
    return "کلید Gemini معتبر نیست یا دسترسی لازم ندارد. (کد G-AUTH)";
  }
  if (/\[G-MODEL\]/i.test(detail)) {
    return "هیچ‌کدام از مدل‌های سازگار Gemini برای این کلید فعال نیست. کلید AI Studio را بررسی کن. (کد G-MODEL)";
  }
  if (/upload/i.test(detail)) {
    return "ثبت فایل در Gemini انجام نشد؛ چند دقیقه بعد دوباره بفرست. (کد G-UPLOAD)";
  }
  if (/\[G-BACKGROUND\]/i.test(detail)) {
    return "حالت پردازش طولانی‌مدت برای این کلید Gemini فعال نیست. (کد G-BACKGROUND)";
  }
  if (/\[G-SCHEMA\]|\[G-FORMAT\]|\[G-CONFIG\]|\[G-REQUEST\]/i.test(detail)) {
    return "Gemini حتی قالب سادهٔ جایگزین را هم نپذیرفت. یک‌بار دیگر بفرست؛ اگر تکرار شد کد G-REQUEST را اعلام کن.";
  }
  if (/exceeds 1000 page|page limit/i.test(detail)) {
    return "این PDF بیش از سقف ۱۰۰۰ صفحهٔ Gemini است؛ فایل را به دو قسمت تقسیم کن. (کد PDF-PAGES)";
  }
  if (/exceeds size limit/i.test(detail)) {
    return "حجم PDF بیشتر از سقف ۲۰ مگابایت ربات است. (کد PDF-SIZE)";
  }
  if (/Invalid PDF signature|download failed|file path missing/i.test(detail)) {
    return "دانلود فایل از تلگرام کامل نشد؛ فایل را دوباره به‌صورت Document بفرست. (کد TG-FILE)";
  }
  const providerStatus = detail.match(/Gemini[^:]*:\s*(\d{3})/i)?.[1];
  if (providerStatus) {
    return `Gemini درخواست این بخش را نپذیرفت؛ دوباره تلاش کن. (کد G-${providerStatus})`;
  }
  if (/incomplete|output invalid|output missing|Unexpected end/i.test(detail)) {
    return "خروجی این بخش ناقص بود؛ ربات آن را کوچک‌تر می‌کند. اگر تکرار شد PDF را دوباره بفرست. (کد G-OUTPUT)";
  }
  if (/No questions with explicit answers/i.test(detail)) {
    return "سؤال تستی همراه با پاسخ صریح داخل PDF پیدا نشد؛ پاسخ‌ها باید در خود فایل نوشته شده باشند.";
  }
  return "پردازش این بخش کامل نشد؛ PDF را دوباره بفرست. (کد G-UNKNOWN)";
}

export async function deliverBatch(
  env: RuntimeEnv,
  chatId: number,
  messageId: number,
  tracked: TrackedJob,
  questions: QuizQuestion[],
): Promise<TrackedJob | null> {
  const total = questions.length;
  if (tracked.requester_id && total > 0) {
    await savePdfBatch(tracked.requester_id, {
      job_id: tracked.job.id,
      page_start: tracked.job.page_start,
      page_end: tracked.job.page_end,
      questions,
    });
  }
  let next = Math.max(0, Math.min(Math.floor(tracked.offset), total));
  const batchStart = next;
  const end = Math.min(next + POLL_BATCH_SIZE, total);

  if (total === 0) {
    if (tracked.requester_id) await clearPdfBatch(tracked.requester_id);
    const nextJob = await startNextQuizBatch(
      tracked.job,
      geminiKeyForJob(env, tracked.job),
    );
    if (nextJob) {
      if (tracked.requester_id) {
        await saveActivePdf(tracked.requester_id, {
          chat_id: chatId,
          status_message_id: messageId,
          job: nextJob,
        });
      }
      const nextTracked = { ...tracked, job: nextJob, offset: 0 };
      await editTracking(
        env,
        chatId,
        messageId,
        "⏭️ عبور از صفحات بدون آزمون",
        "در این محدوده سؤالِ دارای پاسخ صریح نبود؛ بخش بعدی ثبت شد.",
        nextTracked,
        "check",
      );
      return nextTracked;
    }
    await cleanupQuizExtraction(tracked.job, geminiKeyForJob(env, tracked.job));
    if (tracked.requester_id) await clearActivePdf(tracked.requester_id);
    const delivered = tracked.delivered ?? 0;
    await safeEdit(
      env,
      chatId,
      messageId,
      rtlBlock(
        delivered
          ? `✅ <b>پردازش همهٔ صفحات کامل شد</b>\nدر مجموع ${isolateLtr(delivered)} کوئیز ارسال شد.`
          : "❌ <b>سؤال قابل‌ثبت پیدا نشد</b>\nدر PDF سؤال چندگزینه‌ای با پاسخ صریح پیدا نشد.",
      ),
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
    );
    return null;
  }

  await editTracking(
    env,
    chatId,
    messageId,
    "📤 مرحله ۴ از ۴: در حال ارسال آزمون",
    `سؤال‌های معتبر این محدوده: ${isolateLtr(total)}؛ ارسال تست ${isolateLtr(next + 1)} تا ${isolateLtr(end)}`,
    { ...tracked, offset: next },
    "none",
  );

  for (; next < end; next++) {
    try {
      await sendQuestion(env, chatId, questions[next], next, total, {
        ownerId: tracked.requester_id,
        pin: next === batchStart,
      });
      if ((next + 1) % 4 === 0 && next + 1 < end) {
        await editTracking(
          env,
          chatId,
          messageId,
          "📤 مرحله ۴ از ۴: در حال ارسال آزمون",
          `${isolateLtr(next + 1)} سؤال از ${isolateLtr(total)} این محدوده ارسال شد.`,
          { ...tracked, offset: next + 1 },
          "none",
        );
      }
      await delay(80);
    } catch (error) {
      console.error(`Question ${next + 1} failed`, error);
      await editTracking(
        env,
        chatId,
        messageId,
        "ارسال موقتاً متوقف شد",
        `${isolateLtr(next)} سؤال از ${isolateLtr(total)} ارسال شد؛ برای ادامه دوباره دکمه را بزن.`,
        { ...tracked, offset: next },
        "next",
      );
      return null;
    }
  }

  if (next < total) {
    await moveContinuationToBottom(
      env,
      chatId,
      messageId,
      `${isolateLtr(next)} سؤال از ${isolateLtr(total)} این محدوده ارسال شد. ادامه در بستهٔ بعدی است.`,
      { ...tracked, offset: next },
    );
    return null;
  }

  const delivered = (tracked.delivered ?? 0) + total;
  const nextJob = await startNextQuizBatch(
    tracked.job,
    geminiKeyForJob(env, tracked.job),
  );
  if (nextJob) {
    if (tracked.requester_id) {
      await clearPdfBatch(tracked.requester_id);
      await saveActivePdf(tracked.requester_id, {
        chat_id: chatId,
        status_message_id: messageId,
        job: nextJob,
      });
    }
    await moveContinuationToBottom(
      env,
      chatId,
      messageId,
      `${isolateLtr(total)} کوئیز از این محدوده و ${isolateLtr(delivered)} کوئیز در مجموع ارسال شده است.`,
      { ...tracked, job: nextJob, offset: 0, delivered },
    );
    return null;
  }

  await cleanupQuizExtraction(tracked.job, geminiKeyForJob(env, tracked.job));
  if (tracked.requester_id) await clearPdfBatch(tracked.requester_id);
  if (tracked.requester_id) await clearActivePdf(tracked.requester_id);
  await safeEdit(
    env,
    chatId,
    messageId,
    rtlBlock(
      `✅ <b>پردازش همهٔ صفحات کامل شد</b>\nدر مجموع ${isolateLtr(delivered)} کوئیز ارسال شد. تلگرام بعد از انتخاب، جواب درست را نشان می‌دهد.`,
    ),
    { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
  );
  return null;
}

async function checkAndDeliver(
  env: RuntimeEnv,
  chatId: number,
  messageId: number,
  tracked: TrackedJob,
): Promise<TrackedJob | null> {
  if (
    tracked.job.kind === "blues_pdf" &&
    tracked.requester_id &&
    tracked.offset > 0
  ) {
    const cached = await loadPdfBatch(tracked.requester_id);
    if (
      cached &&
      cached.job_id === tracked.job.id &&
      cached.page_start === tracked.job.page_start &&
      cached.page_end === tracked.job.page_end
    ) {
      return await deliverBatch(
        env,
        chatId,
        messageId,
        tracked,
        cached.questions,
      );
    }
  }
  const lockKey = `${tracked.job.kind}:${tracked.job.id}:${tracked.offset}`;
  if (activeJobs.has(lockKey)) return tracked;
  activeJobs.add(lockKey);
  try {
    const result =
      tracked.job.kind === "blues_pdf"
        ? await advanceBluesPdfExtraction(env, tracked.job)
        : await advanceQuizExtraction(
            tracked.job,
            required(env, "GEMINI_API_KEY"),
          );
    if (result.status === "processing") {
      const nextTracked = { ...tracked, job: result.job };
      if (tracked.requester_id) {
        await saveActivePdf(tracked.requester_id, {
          chat_id: chatId,
          status_message_id: messageId,
          job: result.job,
        });
      }
      const fileStage = result.job.kind === "file";
      await editTracking(
        env,
        chatId,
        messageId,
        fileStage
          ? "⏳ فایل هنوز داره آماده می‌شه"
          : "🧠 هنوز دارم تست‌ها رو می‌سازم",
        fileStage
          ? "به‌محض آماده‌شدن فایل، ساخت کوئیز شروع می‌شه."
          : "به‌محض آماده‌شدن، کوئیزها همین‌جا فرستاده می‌شن.",
        nextTracked,
        "check",
      );
      return nextTracked;
    }
    if (result.status === "failed") {
      await cleanupQuizExtraction(result.job, geminiKeyForJob(env, result.job));
      if (tracked.requester_id) await clearActivePdf(tracked.requester_id);
      if (tracked.requester_id) await clearPdfBatch(tracked.requester_id);
      await safeEdit(
        env,
        chatId,
        messageId,
        rtlBlock(
          `❌ <b>پردازش کامل نشد</b>\n${escapeHtml(friendlyFailure(result.reason))}`,
        ),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
      );
      return null;
    }
    return await deliverBatch(
      env,
      chatId,
      messageId,
      { ...tracked, job: result.job },
      result.questions,
    );
  } catch (error) {
    console.error("Job status check failed", error);
    await editTracking(
      env,
      chatId,
      messageId,
      "ارتباط موقتاً قطع شد",
      `${friendlyFailure(error)} دکمهٔ تازه‌سازی را دوباره بزن؛ نتیجه از بین نرفته است.`,
      tracked,
      "check",
    );
    return tracked;
  } finally {
    activeJobs.delete(lockKey);
  }
}

async function enqueueAutomaticPdfCheck(
  env: RuntimeEnv,
  origin: string | undefined,
  payload: AutomaticPdfCheck,
): Promise<void> {
  if (!origin) return;
  const response = await fetch(`${origin}/api/jobs/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bot-internal-secret": required(env, "WEBHOOK_SECRET"),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok)
    throw new Error(`Automatic PDF monitor failed: ${response.status}`);
}

export async function runAutomaticPdfCheck(
  env: RuntimeEnv,
  origin: string,
  payload: AutomaticPdfCheck,
): Promise<void> {
  await delay(AUTO_CHECK_DELAY_MS);
  const tracked = payload.tracked;
  const requesterId = tracked.requester_id;
  if (!requesterId) return;
  const active = await loadActivePdf(requesterId);
  if (
    !active ||
    active.chat_id !== payload.chat_id ||
    active.status_message_id !== payload.message_id ||
    active.job.id !== tracked.job.id
  )
    return;

  const monitorStartedAt = tracked.monitor_started_at ?? tracked.job.started_at;
  if (Date.now() - monitorStartedAt > AUTO_MONITOR_MAX_MS) {
    await editTracking(
      env,
      payload.chat_id,
      payload.message_id,
      "⏸️ پایش خودکار متوقف شد",
      "پردازش حذف نشده؛ برای بررسی دوباره دکمهٔ تازه‌سازی را بزن.",
      tracked,
      "check",
    );
    return;
  }

  const next = await checkAndDeliver(
    env,
    payload.chat_id,
    payload.message_id,
    tracked,
  );
  if (!next) return;
  await enqueueAutomaticPdfCheck(env, origin, {
    ...payload,
    tracked: next,
  });
}

async function goHome(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  const chatQuiz = await loadChatQuizSession(userId);
  if (chatQuiz) await stopAndForgetChatQuizPolls(env, chatQuiz);
  await clearChatQuizSession(userId);
  await clearForwardQuizSession(userId);
  await clearPhotoSession(userId);
  await clearWrongReview(userId);
  await clearAdminKeyInputSession(userId);
  await clearPendingPdf(userId);
  await clearPdfBatch(userId);
  const active = await loadActivePdf(userId);
  if (active) {
    try {
      await cancelQuizExtraction(active.job, geminiKeyForJob(env, active.job));
      await safeEdit(
        env,
        active.chat_id,
        active.status_message_id,
        rtlBlock("🏠 پردازش این PDF با دستور خانه لغو شد."),
        { reply_markup: { inline_keyboard: [] } },
      );
    } catch (error) {
      console.warn("Home cancellation failed", error);
    }
    await clearActivePdf(userId);
  }
  await message(
    env,
    chatId,
    rtlBlock("🏠 به صفحهٔ اصلی برگشتی؛ حالت عکس و آزمون قبلی لغو شد."),
    { reply_markup: mainMenuMarkup(userId === adminUserId(env)) },
  );
}

async function handleCallback(
  env: RuntimeEnv,
  callback: TelegramCallback,
  ownerId: number,
  origin?: string,
): Promise<void> {
  if (!callback.id) return;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const userId = callback.from?.id;
  if ((callback.data ?? "").startsWith("group_import_")) {
    if (
      !chatId ||
      !userId ||
      !groupChat(callback.message?.chat?.type) ||
      userId !== adminUserId(env)
    ) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "این دکمه فقط برای مدیر اصلی ربات داخل گروه فعال است.",
        show_alert: true,
      });
      return;
    }
    if (callback.data === "group_import_cancel") {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "لغو شد.",
      });
      await clearInlineKeyboard(env, chatId, messageId);
      return;
    }
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "ادامه در گفت‌وگوی خصوصی ربات فرستاده شد.",
    });
    await clearInlineKeyboard(env, chatId, messageId);
    await beginForwardQuizCollection(env, userId, userId);
    if (callback.data === "group_import_study") {
      await message(
        env,
        userId,
        rtlBlock(
          "بعد از ساخت و پایان آزمون، /study را بزن تا همهٔ سؤال‌ها، جواب‌ها و راهنماها یکجا به شکل درسنامه بیاید.",
        ),
      );
    }
    await message(
      env,
      chatId,
      rtlBlock(
        "✅ دریافت در چت خصوصی ربات فعال شد؛ پیام‌های موردنظر را انتخاب و برای ربات Forward کن.",
      ),
    );
    return;
  }
  if ((callback.data ?? "").startsWith("forward_answer_")) {
    if (!chatId || !userId || groupChat(callback.message?.chat?.type)) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "این دکمه فقط در گفت‌وگوی خصوصی کار می‌کند.",
        show_alert: true,
      });
      return;
    }
    const suffix = callback.data!.slice("forward_answer_".length);
    const selected = suffix === "skip" ? null : Number(suffix);
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: selected === null ? "رد شد." : "جواب ثبت شد.",
    });
    await clearInlineKeyboard(env, chatId, messageId);
    await acceptForwardedQuizAnswer(
      env,
      chatId,
      userId,
      Number.isInteger(selected) ? selected : null,
    );
    return;
  }
  if ((callback.data ?? "").startsWith("admin_")) {
    if (
      !chatId ||
      !userId ||
      userId !== adminUserId(env) ||
      groupChat(callback.message?.chat?.type)
    ) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "این بخش فقط برای مدیر اصلی فعال است.",
        show_alert: true,
      });
      return;
    }
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "انجام شد.",
    });
    if (callback.data === "admin_panel") {
      await showAdminPanel(env, chatId);
      return;
    }
    if (callback.data === "admin_keys") {
      const geminiActive = await geminiConfigured(env);
      const groqActive = await groqConfigured(env);
      const sambaNovaActive = await sambaNovaConfigured(env);
      const deepSeekActive = await deepSeekConfigured(env);
      const tokenRouterActive = await tokenRouterConfigured(env);
      const forgeActive = await forgeConfigured(env);
      const openRouterActive = await openRouterConfigured(env);
      const secondaryActive = await bluesMindsConfigured(env);
      const mistralActive = await mistralConfigured(env);
      const customActive = await customOpenAiConfigured(env);
      const customConfig = await loadCustomProviderConfig();
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔑 <b>مدیریت کلیدها و توکن‌ها</b>",
            `⚡ Groq (اولین مسیر هوشمند): ${groqActive ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🥇 Gemini (موتور اصلی): ${geminiActive ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🌊 SambaNova: ${sambaNovaActive ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🔷 DeepSeek: ${deepSeekActive ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🆓 TokenRouter / GLM: ${tokenRouterActive ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🔥 Forge: ${forgeActive ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🧭 OpenRouter: ${openRouterActive ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🥈 BluesMinds: ${secondaryActive ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🌪 Mistral AI: ${mistralActive ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🧰 ${customConfig?.name || "سرویس سفارشی"}: ${customActive && customConfig ? "فعال ✅" : "تنظیم نشده ❌"}`,
            `🧾 OCR عمومی/استخراج محلی: ${env.OCR_SPACE_API_KEY?.trim() ? "کلید اختصاصی فعال ✅" : "حالت محلی/عمومی فعال ⚠️"}`,
            "",
            "هیچ مقدار محرمانه‌ای در این صفحه نمایش داده نمی‌شود.",
          ].join("\n"),
        ),
        { parse_mode: "HTML", reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_routing") {
      const mode = await loadProviderMode();
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🎛 <b>انتخاب موتور پردازش</b>",
            `حالت فعلی: ${providerModeNames[mode]}`,
            "در حالت خودکار، استخراج محلی اول انجام می‌شود و سرویس‌های سالم به‌ترتیب امتحان می‌شوند.",
            "در حالت دستی، فقط موتور انتخاب‌شده و مسیر محلیِ ضروری استفاده می‌شود.",
          ].join("\n"),
        ),
        { parse_mode: "HTML", reply_markup: providerRoutingMarkup(mode) },
      );
      return;
    }
    if ((callback.data ?? "").startsWith("admin_mode_")) {
      const requested = callback.data!.slice(
        "admin_mode_".length,
      ) as ProviderMode;
      if (!(requested in providerModeNames)) return;
      await saveProviderMode(requested);
      await message(
        env,
        chatId,
        rtlBlock(
          `✅ موتور پردازش روی «${providerModeNames[requested]}» تنظیم شد.`,
        ),
        { reply_markup: providerRoutingMarkup(requested) },
      );
      return;
    }
    if (callback.data === "admin_gemini_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "gemini",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔐 کلید جدید Gemini را همین‌جا در یک پیام بفرست.",
            "پیام کلید فوراً حذف و دسترسی generateContent آن بررسی می‌شود؛ کلید قبلی فقط پس از تأیید جایگزین خواهد شد.",
            "برای لغو /Home را بزن.",
          ].join("\n"),
        ),
        { reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_groq_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "groq",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔐 کلید Groq را همین‌جا در یک پیام بفرست.",
            `کلید با درگاه رسمی Groq و مدل ${isolateLtr(env.GROQ_MODEL?.trim() || "qwen/qwen3.6-27b")} بررسی می‌شود.`,
            "پیام کلید فوراً حذف و کلید قبلی فقط بعد از پاسخ موفق جایگزین می‌شود.",
            "برای لغو /Home را بزن.",
          ].join("\n"),
        ),
        { reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_sambanova_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "sambanova",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔐 کلید SambaNova را همین‌جا در یک پیام بفرست.",
            `کلید فقط با درگاه رسمی SambaNova و مدل ${isolateLtr(env.SAMBANOVA_MODEL?.trim() || "Meta-Llama-3.3-70B-Instruct")} بررسی می‌شود.`,
            "پیام کلید فوراً حذف و کلید قبلی فقط بعد از پاسخ موفق جایگزین می‌شود.",
            "برای لغو /Home را بزن.",
          ].join("\n"),
        ),
        { reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_deepseek_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "deepseek",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔐 کلید DeepSeek را همین‌جا در یک پیام بفرست.",
            `کلید فقط با درگاه رسمی DeepSeek و مدل ${isolateLtr(env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash")} بررسی می‌شود.`,
            "پیام کلید فوراً حذف و کلید قبلی فقط بعد از پاسخ موفق جایگزین می‌شود.",
            "برای لغو /Home را بزن.",
          ].join("\n"),
        ),
        { reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_secondary_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "bluesminds",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔐 کلید جدید BluesMinds را همین‌جا در یک پیام بفرست.",
            "پیام کلید فوراً حذف و اعتبار آن با فهرست مدل‌های رسمی بررسی می‌شود؛ اگر نامعتبر باشد، کلید قبلی دست‌نخورده می‌ماند.",
            "برای لغو /Home را بزن.",
          ].join("\n"),
        ),
        { reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_openrouter_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "openrouter",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔐 کلید جدید OpenRouter را همین‌جا در یک پیام بفرست.",
            "پیام کلید فوراً حذف و اعتبار/سقف کلید با سرویس رسمی بررسی می‌شود؛ کلید قبلی فقط بعد از تأیید جایگزین خواهد شد.",
            "مدل پیش‌فرض openrouter/free است تا هزینهٔ ناخواسته ایجاد نشود.",
            "برای لغو /Home را بزن.",
          ].join("\n"),
        ),
        { reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_tokenrouter_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "tokenrouter",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔐 کلید TokenRouter را همین‌جا در یک پیام بفرست.",
            `کلید با مدل ${isolateLtr(env.TOKENROUTER_MODEL?.trim() || "z-ai/glm-5.2-free")} اعتبارسنجی و پیام آن فوراً حذف می‌شود.`,
            "کلید قبلی فقط بعد از پاسخ موفق جایگزین می‌شود.",
            "برای لغو /Home را بزن.",
          ].join("\n"),
        ),
        { reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_forge_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "forge",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔐 کلید Forge را همین‌جا در یک پیام بفرست.",
            `کلید با مدل ${isolateLtr(env.FORGE_MODEL?.trim() || "gemini-3.5-flash")} و درگاه رسمی Forge بررسی می‌شود.`,
            "پیام کلید فوراً حذف می‌شود و کلید قبلی فقط بعد از پاسخ موفق جایگزین خواهد شد.",
            "برای لغو /Home را بزن.",
          ].join("\n"),
        ),
        { reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_mistral_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "mistral",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🔐 کلید Mistral را همین‌جا در یک پیام بفرست.",
            `پیام فوراً حذف و کلید با سرویس رسمی و مدل ${isolateLtr(env.MISTRAL_CHAT_MODEL?.trim() || "mistral-small-latest")} بررسی می‌شود؛ کلید قبلی فقط بعد از تأیید جایگزین می‌شود.`,
            "برای لغو /Home را بزن.",
          ].join("\n"),
        ),
        { reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_custom_help") {
      await saveAdminKeyInputSession(userId, {
        provider: "custom",
        started_at: Date.now(),
      });
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🧰 <b>افزودن سرویس OpenAI-Compatible</b>",
            "چهار خط زیر را با اطلاعات سرویس پر کن و در یک پیام بفرست:",
            "",
            `<pre>name=نام سرویس\nbase_url=https://example.com/v1\nmodel=provider/model\napi_key=</pre>`,
            "",
            "API Key اختیاری است؛ اگر سرویس بدون کلید کار می‌کند، خط api_key را خالی بگذار. در این حالت هدر Authorization ارسال نمی‌شود.",
            "فقط HTTPS عمومی پذیرفته می‌شود؛ پیام تنظیمات فوراً حذف و یک درخواست کوتاه برای اعتبارسنجی فرستاده می‌شود.",
          ].join("\n"),
        ),
        { parse_mode: "HTML", reply_markup: adminKeyMarkup() },
      );
      return;
    }
    if (callback.data === "admin_services") {
      const geminiKey = await activeGeminiApiKey(env);
      let geminiStatus = "بدون کلید ⚠️";
      if (geminiKey) {
        try {
          const models = await listGeminiModels(geminiKey, 5_000);
          await probeGeminiGenerateContent(geminiKey, 6_000);
          geminiStatus = `تولید پاسخ فعال ✅ (${isolateLtr(models.ids.length)} مدل)`;
        } catch {
          geminiStatus = "تولید پاسخ/سهمیه در دسترس نیست ❌";
        }
      }
      const groqKeys = await activeGroqApiKeys(env);
      let groqStatus = "بدون کلید ⚠️";
      if (groqKeys.length) {
        try {
          const config = groqConfig(env.GROQ_MODEL);
          await new ProviderKeyRotator(groqKeys).run(
            async (key) => await validateCompatibleApiKey(config, key, 8_000),
          );
          groqStatus = `پاسخ‌گو ✅ (${isolateLtr(config.model)}؛ ${isolateLtr(groqKeys.length)} کلید)`;
        } catch {
          groqStatus = "کلید، سهمیه یا مدل پاسخ نداد ❌";
        }
      }
      const sambaNovaKeys = await activeSambaNovaApiKeys(env);
      let sambaNovaStatus = "بدون کلید ⚠️";
      if (sambaNovaKeys.length) {
        try {
          const config = sambaNovaConfig(env.SAMBANOVA_MODEL);
          await new ProviderKeyRotator(sambaNovaKeys).run(
            async (key) => await validateCompatibleApiKey(config, key, 8_000),
          );
          sambaNovaStatus = `پاسخ‌گو ✅ (${isolateLtr(config.model)}؛ ${isolateLtr(sambaNovaKeys.length)} کلید)`;
        } catch {
          sambaNovaStatus = "کلید، سهمیه یا مدل پاسخ نداد ❌";
        }
      }
      const deepSeekKeys = await activeDeepSeekApiKeys(env);
      let deepSeekStatus = "بدون کلید ⚠️";
      if (deepSeekKeys.length) {
        try {
          const config = deepSeekConfig(env.DEEPSEEK_MODEL);
          await new ProviderKeyRotator(deepSeekKeys).run(
            async (key) => await validateCompatibleApiKey(config, key, 8_000),
          );
          deepSeekStatus = `پاسخ‌گو ✅ (${isolateLtr(config.model)}؛ ${isolateLtr(deepSeekKeys.length)} کلید)`;
        } catch {
          deepSeekStatus = "کلید، سهمیه یا مدل پاسخ نداد ❌";
        }
      }
      const secondaryKey = await activeBluesMindsApiKey(env);
      let secondaryStatus = "بدون کلید ⚠️";
      if (secondaryKey) {
        try {
          const models = await listBluesMindsModels(secondaryKey);
          secondaryStatus = `پاسخ‌گو ✅ (${isolateLtr(models.ids.length)} مدل)`;
        } catch {
          secondaryStatus = "کلید یا سرویس پاسخ نداد ❌";
        }
      }
      const openRouterKey = await activeOpenRouterApiKey(env);
      let openRouterStatus = "بدون کلید ⚠️";
      if (openRouterKey) {
        try {
          const info = await getOpenRouterKeyInfo(openRouterKey, 6_000);
          openRouterStatus =
            info.limit_remaining === null
              ? `فعال ✅ (${info.is_free_tier ? "حساب رایگان" : "بدون سقف مشخص"})`
              : `فعال ✅ (اعتبار باقی‌مانده: ${isolateLtr(info.limit_remaining.toFixed(2))})`;
        } catch {
          openRouterStatus = "کلید یا سرویس پاسخ نداد ❌";
        }
      }
      const tokenRouterKeys = await activeTokenRouterApiKeys(env);
      let tokenRouterStatus = "بدون کلید ⚠️";
      if (tokenRouterKeys.length) {
        try {
          await validateCompatibleApiKey(
            tokenRouterConfig(env.TOKENROUTER_MODEL),
            tokenRouterKeys[0],
            8_000,
          );
          tokenRouterStatus = `پاسخ‌گو ✅ (${isolateLtr(tokenRouterKeys.length)} کلید آماده)`;
        } catch {
          tokenRouterStatus = "کلید، مدل رایگان یا سرویس پاسخ نداد ❌";
        }
      }
      const forgeKey = await activeForgeApiKey(env);
      let forgeStatus = "بدون کلید ⚠️";
      if (forgeKey) {
        try {
          await validateCompatibleApiKey(
            forgeConfig(env.FORGE_MODEL),
            forgeKey,
            8_000,
          );
          forgeStatus = `پاسخ‌گو ✅ (${isolateLtr(env.FORGE_MODEL?.trim() || "gemini-3.5-flash")})`;
        } catch {
          forgeStatus = "کلید، مدل یا سرویس پاسخ نداد ❌";
        }
      }
      const mistralKeys = await activeMistralApiKeys(env);
      let mistralStatus = "بدون کلید ⚠️";
      if (mistralKeys.length) {
        try {
          const config = mistralChatConfig(env.MISTRAL_CHAT_MODEL);
          await new ProviderKeyRotator(mistralKeys).run(
            async (key) => await validateCompatibleApiKey(config, key, 8_000),
          );
          mistralStatus = `پاسخ‌گو ✅ (${isolateLtr(config.model)}؛ ${isolateLtr(mistralKeys.length)} کلید)`;
        } catch {
          mistralStatus = "کلید یا سرویس پاسخ نداد ❌";
        }
      }
      const customConfig = await loadCustomProviderConfig();
      const customKey = await activeCustomOpenAiApiKey(env);
      let customStatus = "تنظیم نشده ⚠️";
      if (customConfig && customKey !== null) {
        try {
          await validateCompatibleApiKey(customConfig, customKey, 8_000);
          customStatus = `${customConfig.name} پاسخ‌گو ✅`;
        } catch {
          customStatus = `${customConfig.name} پاسخ نداد ❌`;
        }
      }
      const mode = await loadProviderMode();
      await message(
        env,
        chatId,
        rtlBlock(
          [
            "🧩 <b>وضعیت سرویس‌های پردازش</b>",
            `۱) Groq: ${groqStatus}`,
            `۲) Gemini: ${geminiStatus}`,
            `۳) SambaNova: ${sambaNovaStatus}`,
            `۴) Mistral AI: ${mistralStatus}`,
            `۵) DeepSeek: ${deepSeekStatus}`,
            `۶) TokenRouter GLM: ${tokenRouterStatus}`,
            `۷) Forge: ${forgeStatus}`,
            `۸) OpenRouter: ${openRouterStatus}`,
            `۹) BluesMinds: ${secondaryStatus}`,
            `۱۰) سرویس سفارشی: ${customStatus}`,
            `۱۱) استخراج محلی/OCR موجود: ${env.OCR_SPACE_API_KEY?.trim() ? "کلید اختصاصی ✅" : "حالت عمومی ⚠️"}`,
            "",
            `🎛 حالت فعال: ${providerModeNames[mode]}`,
            "PDF خودکار: متن مستقیم فایل ← Groq ← Gemini ← SambaNova ← Mistral ← DeepSeek ← TokenRouter ← Forge ← OpenRouter ← سفارشی ← BluesMinds.",
            "عکس خودکار: Groq ← Gemini ← TokenRouter ← Forge ← OpenRouter ← سفارشی ← BluesMinds ← Mistral OCR ← OCR عمومی.",
            "در خطای سهمیه/احراز هویت، کلید بعدی همان سرویس فوراً امتحان می‌شود؛ سپس مسیر بعدی اجرا می‌شود.",
            "اعلان برگشت سهمیهٔ Gemini فعال است و فقط یک‌بار بعد از بازیابی فرستاده می‌شود.",
          ].join("\n"),
        ),
        { parse_mode: "HTML", reply_markup: adminPanelMarkup() },
      );
      return;
    }
    await message(
      env,
      chatId,
      rtlBlock(
        `🧩 مسیر دقیق PDF و OCR فارسی فعال است؛ سپس سرویس‌های هوشمند پشتیبان امتحان می‌شوند. وضعیت Gemini: ${(await geminiConfigured(env)) ? "آماده ✅" : "بدون کلید ⚠️"}`,
      ),
      { reply_markup: adminPanelMarkup() },
    );
    return;
  }
  const chatQuizAction = [
    "chatquiz_timed",
    "chatquiz_untimed",
    "chatquiz_finish",
    "chatquiz_cancel",
    "chatquiz_repeat",
    "chatquiz_retry_wrong",
    "chatquiz_wrong_summary",
    "forward_quiz_confirm",
    "forward_quiz_cancel",
  ].includes(callback.data ?? "");
  if (chatQuizAction) {
    if (!chatId || !userId || groupChat(callback.message?.chat?.type)) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "این آزمون فقط در گفت‌وگوی خصوصی اجرا می‌شود.",
        show_alert: true,
      });
      return;
    }
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text:
        callback.data === "chatquiz_finish"
          ? "در حال ساخت کارنامه…"
          : "انجام شد.",
    });
    if (callback.data !== "chatquiz_wrong_summary") {
      await clearInlineKeyboard(env, chatId, messageId);
    }
    if (callback.data === "chatquiz_timed") {
      await startChatQuiz(env, userId, "timed");
    } else if (callback.data === "chatquiz_untimed") {
      await startChatQuiz(env, userId, "untimed");
    } else if (callback.data === "chatquiz_finish") {
      await finishChatQuiz(env, userId, true);
    } else if (callback.data === "chatquiz_repeat") {
      await repeatChatQuiz(env, userId, false);
    } else if (callback.data === "chatquiz_retry_wrong") {
      await repeatChatQuiz(env, userId, true);
    } else if (callback.data === "chatquiz_wrong_summary") {
      const session = await loadChatQuizSession(userId);
      await sendQuestionCheatSheet(
        env,
        chatId,
        "خلاصهٔ جواب‌های اشتباه همین آزمون",
        session ? wrongAnswersFromSession(session) : [],
      );
    } else if (callback.data === "forward_quiz_confirm") {
      await finishForwardQuizCollection(env, chatId, userId);
    } else if (callback.data === "forward_quiz_cancel") {
      await clearForwardQuizSession(userId);
      await goHome(env, chatId, userId);
    } else {
      const session = await loadChatQuizSession(userId);
      if (session) await stopAndForgetChatQuizPolls(env, session);
      await clearChatQuizSession(userId);
      await goHome(env, chatId, userId);
    }
    return;
  }
  const wrongChoice =
    callback.data === "wrong_review_today" ||
    callback.data === "wrong_review_all";
  if (wrongChoice) {
    if (!chatId || !userId || groupChat(callback.message?.chat?.type)) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "این دکمه فقط در گفت‌وگوی خصوصی کار می‌کند.",
        show_alert: true,
      });
      return;
    }
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "در حال ساخت چیت‌شیت…",
    });
    await sendWrongCheatSheet(
      env,
      chatId,
      userId,
      callback.data === "wrong_review_today",
    );
    return;
  }
  const navigationAction = [
    "photo_go",
    "photo_resume",
    "wrong_next",
    "nav_home",
    "nav_back",
  ].includes(callback.data ?? "");
  if (navigationAction) {
    if (!chatId || !userId || groupChat(callback.message?.chat?.type)) {
      await telegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "این دکمه فقط در گفت‌وگوی خصوصی کار می‌کند.",
        show_alert: true,
      });
      return;
    }
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text:
        callback.data === "photo_go" || callback.data === "photo_resume"
          ? "شروع خواندن عکس‌ها…"
          : "انجام شد.",
    });
    if (callback.data === "photo_go") {
      await processPhotoBatch(env, chatId, userId, origin);
    } else if (callback.data === "photo_resume") {
      const session = await loadPhotoSession(userId);
      if (!session?.processing) {
        await message(
          env,
          chatId,
          rtlBlock("پردازش فعالی پیدا نشد؛ عکس‌ها را دوباره ثبت کن."),
        );
        return;
      }
      await resumePhotoProcessing(env, {
        chat_id: chatId,
        user_id: userId,
        status_message_id: session.status_message_id,
      });
    } else if (callback.data === "wrong_next") {
      await sendWrongReviewBatch(env, chatId, userId, messageId);
    } else {
      await clearInlineKeyboard(env, chatId, messageId);
      await goHome(env, chatId, userId);
    }
    return;
  }
  let tracked = trackingFromMessage(callback.message?.text);
  if (!chatId || !messageId || !tracked) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "اطلاعات این پردازش پیدا نشد؛ PDF را دوباره بفرست.",
      show_alert: true,
    });
    return;
  }
  if (groupChat(callback.message?.chat?.type)) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "PDF را به گفت‌وگوی خصوصی ربات فوروارد کن.",
      show_alert: true,
    });
    return;
  }

  const requesterId = tracked.requester_id ?? ownerId;
  if (callback.from?.id !== requesterId && callback.from?.id !== ownerId) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "این پردازش متعلق به فرستندهٔ همان PDF است.",
      show_alert: true,
    });
    return;
  }

  if (callback.data === "job_cancel") {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "پردازش لغو شد.",
    });
    await cancelQuizExtraction(tracked.job, geminiKeyForJob(env, tracked.job));
    if (tracked.requester_id) await clearActivePdf(tracked.requester_id);
    await safeEdit(
      env,
      chatId,
      messageId,
      rtlBlock("❌ پردازش این PDF لغو شد."),
      { reply_markup: { inline_keyboard: [] } },
    );
    return;
  }

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text:
      callback.data === "job_next"
        ? "در حال ارسال بخش بعدی..."
        : "در حال بررسی...",
  });
  if (callback.data === "job_next") {
    tracked = { ...tracked, monitor_started_at: Date.now() };
  }
  const next = await checkAndDeliver(env, chatId, messageId, tracked);
  if (next && callback.data === "job_next") {
    try {
      await enqueueAutomaticPdfCheck(env, origin, {
        chat_id: chatId,
        message_id: messageId,
        tracked: next,
      });
    } catch (error) {
      console.warn("Automatic PDF monitor could not restart", error);
    }
  }
}

export type PdfStartJobPayload = { requester_id: number };

export async function runPdfStartJob(
  env: RuntimeEnv,
  _origin: string,
  payload: PdfStartJobPayload,
): Promise<void> {
  const pending = await loadPendingPdf(payload.requester_id);
  if (!pending) return;
  try {
    await safeEdit(
      env,
      pending.chat_id,
      pending.status_message_id,
      rtlBlock(
        [
          "📥 مرحله ۱ از ۴: دارم فایل را دریافت می‌کنم…",
          friendlyRemainingText(
            pending.started_at,
            pending.announced_size,
            undefined,
            Date.now(),
            "upload",
          ),
          "همین پیام به‌روز می‌شود؛ فایل را دوباره نفرست.",
        ].join("\n"),
      ),
    );
    const buffer = await downloadPdf(env, pending.file_id);
    const pageEstimate = detectPdfPageCount(buffer);
    await safeEdit(
      env,
      pending.chat_id,
      pending.status_message_id,
      rtlBlock(
        [
          `📄 مرحله ۲ از ۴: ${pageEstimate ? `${isolateLtr(pageEstimate)} صفحه شناسایی شد؛ ` : ""}متن PDF در حال خواندن است…`,
          friendlyRemainingText(
            pending.started_at,
            buffer.byteLength,
            pageEstimate,
            Date.now(),
            "interaction",
          ),
        ].join("\n"),
      ),
    );
    const extracted = await extractPdfTextRange(buffer, 1, 2);
    const job: GeminiJob = {
      kind: "blues_pdf",
      id: pending.file_id,
      started_at: pending.started_at,
      filename: pending.filename,
      size: buffer.byteLength,
      page_start: extracted.page_start,
      page_end: extracted.page_end,
      total_pages: extracted.total_pages,
    };
    const tracked: TrackedJob = {
      job,
      offset: 0,
      requester_id: pending.requester_id,
      delivered: 0,
      monitor_started_at: pending.started_at,
    };
    await saveActivePdf(pending.requester_id, {
      chat_id: pending.chat_id,
      status_message_id: pending.status_message_id,
      job,
    });
    await clearPendingPdf(pending.requester_id);
    const result = await advanceBluesPdfExtraction(env, job, buffer, extracted);
    if (result.status === "failed") {
      await clearActivePdf(pending.requester_id);
      await safeEdit(
        env,
        pending.chat_id,
        pending.status_message_id,
        rtlBlock(
          `❌ <b>پردازش PDF کامل نشد</b>\n${escapeHtml(friendlyFailure(result.reason))}`,
        ),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
      );
      return;
    }
    if (result.status === "processing") return;
    await saveActivePdf(pending.requester_id, {
      chat_id: pending.chat_id,
      status_message_id: pending.status_message_id,
      job: result.job,
    });
    await deliverBatch(
      env,
      pending.chat_id,
      pending.status_message_id,
      { ...tracked, job: result.job },
      result.questions,
    );
  } catch (error) {
    console.error("PDF start worker failed", error);
    await clearPendingPdf(payload.requester_id);
    await clearActivePdf(payload.requester_id);
    await safeEdit(
      env,
      pending.chat_id,
      pending.status_message_id,
      rtlBlock(
        `❌ <b>ثبت PDF کامل نشد</b>\n${escapeHtml(friendlyFailure(error))}`,
      ),
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
    );
  }
}

async function downloadPdf(
  env: RuntimeEnv,
  fileId: string,
): Promise<ArrayBuffer> {
  const file = await telegram<{ file_path?: string }>(env, "getFile", {
    file_id: fileId,
  });
  if (!file.file_path) throw new Error("Telegram file path missing");
  const token = required(env, "TELEGRAM_BOT_TOKEN");
  const download = await fetch(
    `https://api.telegram.org/file/bot${token}/${file.file_path}`,
    { signal: AbortSignal.timeout(6_000) },
  );
  if (!download.ok) throw new Error(`PDF download failed: ${download.status}`);
  const buffer = await download.arrayBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES)
    throw new Error("PDF exceeds size limit");
  if (!looksLikePdf(buffer)) throw new Error("Invalid PDF signature");
  return buffer;
}

async function advanceBluesPdfExtraction(
  env: RuntimeEnv,
  job: GeminiJob,
  suppliedBuffer?: ArrayBuffer,
  suppliedText?: Awaited<ReturnType<typeof extractPdfTextRange>>,
): Promise<GeminiJobResult> {
  if (job.kind !== "blues_pdf") {
    return { status: "failed", job, reason: "Invalid BluesMinds PDF job" };
  }
  try {
    const buffer = suppliedBuffer ?? (await downloadPdf(env, job.id));
    const extracted =
      suppliedText ??
      (await extractPdfTextRange(buffer, job.page_start, job.page_end));
    const currentJob: GeminiJob = {
      ...job,
      size: buffer.byteLength,
      page_start: extracted.page_start,
      page_end: extracted.page_end,
      total_pages: extracted.total_pages,
      started_at: Date.now(),
    };
    const fallbackEnd = Math.min(
      extracted.page_start + 19,
      extracted.total_pages,
    );
    const fallback =
      fallbackEnd > extracted.page_end
        ? await extractPdfTextRange(buffer, extracted.page_start, fallbackEnd)
        : extracted;
    const deterministic = extractExplicitQuizFromOcr([fallback.text]);
    const deterministicCompleteEnough =
      deterministic.length >= 20 ||
      (fallback.total_pages <= 20 && deterministic.length >= 3);
    if (deterministicCompleteEnough) {
      return {
        status: "completed",
        job: {
          ...currentJob,
          model: "pdf-text-layout",
          page_end: fallback.page_end,
          total_pages: fallback.total_pages,
        },
        questions: deterministic,
      };
    }
    const providerMode = await loadProviderMode();
    let providerAttemptCount = 0;
    let providerFailureCount = 0;

    const mistralKey = await activeMistralApiKey(env);
    if (mistralKey && providerAllowed(providerMode, "mistral")) {
      providerAttemptCount++;
      try {
        const ocrText = await mistralOcrPdf(
          buffer,
          mistralKey,
          fallback.page_start,
          fallback.page_end,
        );
        const questions = extractExplicitQuizFromOcr([ocrText]);
        if (questions.length) {
          return {
            status: "completed",
            job: {
              ...currentJob,
              model: "mistral-ocr-latest",
              page_end: fallback.page_end,
              total_pages: fallback.total_pages,
            },
            questions,
          };
        }
      } catch (error) {
        providerFailureCount++;
        console.warn(
          "Mistral PDF OCR failed; moving to AI text providers",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
    const groqKeys = await activeGroqApiKeys(env);
    if (groqKeys.length && providerAllowed(providerMode, "groq")) {
      providerAttemptCount++;
      try {
        const config = groqConfig(env.GROQ_MODEL);
        const questions = await new ProviderKeyRotator(groqKeys).run(
          async (groqKey) =>
            await extractPdfTextWithCompatible(
              extracted.text,
              groqKey,
              config,
              {
                page_start: extracted.page_start,
                page_end: extracted.page_end,
                total_pages: extracted.total_pages,
              },
            ),
        );
        return {
          status: "completed",
          job: { ...currentJob, model: config.model },
          questions,
        };
      } catch (error) {
        providerFailureCount++;
        console.warn(
          "Groq PDF request rejected; moving to Gemini",
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        );
      }
    }
    const geminiKey = await activeGeminiApiKey(env);
    if (geminiKey && providerAllowed(providerMode, "gemini")) {
      providerAttemptCount++;
      try {
        const questions = await extractPdfTextWithGemini(
          extracted.text,
          geminiKey,
          {
            page_start: extracted.page_start,
            page_end: extracted.page_end,
            total_pages: extracted.total_pages,
          },
        );
        await rememberGeminiAvailable(env);
        return {
          status: "completed",
          job: { ...currentJob, model: "gemini-generate-content" },
          questions,
        };
      } catch (error) {
        providerFailureCount++;
        await rememberGeminiQuota(error);
        console.warn(
          "Gemini PDF request rejected; moving to fallback providers",
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        );
      }
    }
    const sambaNovaKeys = await activeSambaNovaApiKeys(env);
    if (sambaNovaKeys.length && providerAllowed(providerMode, "sambanova")) {
      providerAttemptCount++;
      try {
        const config = sambaNovaConfig(env.SAMBANOVA_MODEL);
        const questions = await new ProviderKeyRotator(sambaNovaKeys).run(
          async (apiKey) =>
            await extractPdfTextWithCompatible(extracted.text, apiKey, config, {
              page_start: extracted.page_start,
              page_end: extracted.page_end,
              total_pages: extracted.total_pages,
            }),
        );
        return {
          status: "completed",
          job: { ...currentJob, model: config.model },
          questions,
        };
      } catch (error) {
        providerFailureCount++;
        console.warn(
          "SambaNova PDF request rejected; moving to Mistral",
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        );
      }
    }
    const mistralKeys = await activeMistralApiKeys(env);
    if (mistralKeys.length && providerAllowed(providerMode, "mistral")) {
      providerAttemptCount++;
      try {
        const config = mistralChatConfig(env.MISTRAL_CHAT_MODEL);
        const questions = await new ProviderKeyRotator(mistralKeys).run(
          async (apiKey) =>
            await extractPdfTextWithCompatible(extracted.text, apiKey, config, {
              page_start: extracted.page_start,
              page_end: extracted.page_end,
              total_pages: extracted.total_pages,
            }),
        );
        return {
          status: "completed",
          job: { ...currentJob, model: config.model },
          questions,
        };
      } catch (error) {
        providerFailureCount++;
        console.warn(
          "Mistral chat request rejected; moving to DeepSeek",
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        );
      }
    }
    const deepSeekKeys = await activeDeepSeekApiKeys(env);
    if (deepSeekKeys.length && providerAllowed(providerMode, "deepseek")) {
      providerAttemptCount++;
      try {
        const config = deepSeekConfig(env.DEEPSEEK_MODEL);
        const questions = await new ProviderKeyRotator(deepSeekKeys).run(
          async (apiKey) =>
            await extractPdfTextWithCompatible(extracted.text, apiKey, config, {
              page_start: extracted.page_start,
              page_end: extracted.page_end,
              total_pages: extracted.total_pages,
            }),
        );
        return {
          status: "completed",
          job: { ...currentJob, model: config.model },
          questions,
        };
      } catch (error) {
        providerFailureCount++;
        console.warn(
          "DeepSeek PDF request rejected; moving to TokenRouter",
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        );
      }
    }
    if (providerAllowed(providerMode, "tokenrouter")) {
      const tokenRouterKeys = await activeTokenRouterApiKeys(env);
      if (tokenRouterKeys.length) {
        providerAttemptCount++;
        try {
          const config = tokenRouterConfig(env.TOKENROUTER_MODEL);
          const questions = await new ProviderKeyRotator(tokenRouterKeys).run(
            async (tokenRouterKey) =>
              await extractPdfTextWithCompatible(
                extracted.text,
                tokenRouterKey,
                config,
                {
                  page_start: extracted.page_start,
                  page_end: extracted.page_end,
                  total_pages: extracted.total_pages,
                },
              ),
          );
          return {
            status: "completed",
            job: { ...currentJob, model: config.model },
            questions,
          };
        } catch (error) {
          providerFailureCount++;
          console.warn(
            "TokenRouter PDF keys failed; moving to next route",
            error instanceof Error ? error.message.slice(0, 300) : "unknown",
          );
        }
      }
    }
    const forgeKey = await activeForgeApiKey(env);
    if (forgeKey && providerAllowed(providerMode, "forge")) {
      providerAttemptCount++;
      try {
        const config = forgeConfig(env.FORGE_MODEL);
        const questions = await extractPdfTextWithCompatible(
          extracted.text,
          forgeKey,
          config,
          {
            page_start: extracted.page_start,
            page_end: extracted.page_end,
            total_pages: extracted.total_pages,
          },
        );
        return {
          status: "completed",
          job: { ...currentJob, model: config.model },
          questions,
        };
      } catch (error) {
        providerFailureCount++;
        console.warn(
          "Forge PDF request rejected; moving to OpenRouter",
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        );
      }
    }
    const openRouterKey = await activeOpenRouterApiKey(env);
    if (openRouterKey && providerAllowed(providerMode, "openrouter")) {
      providerAttemptCount++;
      try {
        const questions = await extractPdfTextWithOpenRouter(
          extracted.text,
          openRouterKey,
          {
            page_start: extracted.page_start,
            page_end: extracted.page_end,
            total_pages: extracted.total_pages,
          },
          env.OPENROUTER_MODEL,
        );
        return {
          status: "completed",
          job: {
            ...currentJob,
            model: env.OPENROUTER_MODEL?.trim() || "openrouter/free",
          },
          questions,
        };
      } catch (error) {
        providerFailureCount++;
        console.warn(
          "OpenRouter PDF request rejected; moving to BluesMinds",
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        );
      }
    }
    const customConfig = await loadCustomProviderConfig();
    const customKey = await activeCustomOpenAiApiKey(env);
    if (
      customConfig &&
      customKey !== null &&
      providerAllowed(providerMode, "custom")
    ) {
      providerAttemptCount++;
      try {
        const questions = await extractPdfTextWithCompatible(
          extracted.text,
          customKey,
          customConfig,
          {
            page_start: extracted.page_start,
            page_end: extracted.page_end,
            total_pages: extracted.total_pages,
          },
        );
        return {
          status: "completed",
          job: { ...currentJob, model: customConfig.model },
          questions,
        };
      } catch (error) {
        providerFailureCount++;
        console.warn(
          "Custom provider PDF request rejected; moving to BluesMinds",
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        );
      }
    }
    const apiKey = await activeBluesMindsApiKey(env);
    if (apiKey && providerAllowed(providerMode, "bluesminds")) {
      providerAttemptCount++;
      try {
        const questions = await extractPdfTextWithBluesMinds(
          extracted.text,
          apiKey,
          {
            page_start: extracted.page_start,
            page_end: extracted.page_end,
            total_pages: extracted.total_pages,
          },
          env.BLUESMINDS_MODEL,
        );
        return { status: "completed", job: currentJob, questions };
      } catch (error) {
        providerFailureCount++;
        console.warn(
          "BluesMinds PDF request rejected; using local OCR parser",
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        );
      }
    }
    if (
      providerAttemptCount > 0 &&
      providerFailureCount === providerAttemptCount
    ) {
      await notifyAdminProviderFailure(
        env,
        `تمام ${providerAttemptCount} مسیر API فعال هنگام خواندن PDF با خطا یا کمبود سهمیه روبه‌رو شدند.`,
      );
    }
    return {
      status: "completed",
      job: {
        ...currentJob,
        model: "ocr-local",
        page_end: fallback.page_end,
        total_pages: fallback.total_pages,
      },
      questions: deterministic,
    };
  } catch (error) {
    console.warn(
      "BluesMinds PDF stage failed",
      error instanceof Error ? error.message : "unknown",
    );
    return {
      status: "failed",
      job,
      reason: error instanceof Error ? error.message : "PDF processing failed",
    };
  }
}

async function beginPdf(
  env: RuntimeEnv,
  chatId: number,
  requesterId: number,
  replyToMessageId: number | undefined,
  fileId: string,
  filename: string,
  announcedSize: number,
  origin?: string,
): Promise<BackgroundTask | undefined> {
  const beganAt = Date.now();
  const statusMessage = await message(
    env,
    chatId,
    rtlBlock(
      [
        "📄 فایل رسید رفیق ✅",
        "📍 مرحله ۱ از ۴: دریافت فایل از تلگرام",
        friendlyRemainingText(
          beganAt,
          announcedSize,
          undefined,
          Date.now(),
          "upload",
        ),
        "همین پیام به‌روز می‌شه؛ فایل رو دوباره نفرست.",
      ].join("\n"),
    ),
    replyToMessageId
      ? {
          reply_parameters: {
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {},
  );
  const statusId = statusMessage.message_id;
  if (!statusId) throw new Error("Telegram status message ID missing");
  const pending: PendingPdfSession = {
    chat_id: chatId,
    status_message_id: statusId,
    requester_id: requesterId,
    reply_to_message_id: replyToMessageId,
    file_id: fileId,
    filename,
    announced_size: announcedSize,
    started_at: beganAt,
  };
  await savePendingPdf(requesterId, pending);
  if (!origin) return undefined;
  return async () =>
    await runPdfStartJob(env, origin, { requester_id: requesterId });
}

async function showMainMenu(
  env: RuntimeEnv,
  chatId: number,
  group = false,
): Promise<void> {
  await message(
    env,
    chatId,
    rtlBlock(
      [
        "سلام رفیق، به ربات تست‌زنی خوش اومدی 👋",
        "",
        "📄 PDF آزمونت رو همین‌جا بفرست یا از یک گروه/کانال برای ربات فوروارد کن.",
        "📝 ربات سؤال‌ها و جواب‌های صریح داخل فایل رو پیدا می‌کنه و به شکل کوئیز تلگرام می‌فرسته.",
        "🔢 گزینه‌های عددی، الف/ب/ج/د و A/B/C/D پشتیبانی می‌شن.",
        "🔄 می‌تونی رأیت رو عوض کنی؛ تست‌های غلطت هم برای مرور شافل ذخیره می‌شن.",
        "🤖 JSON قالب‌دار ChatGPT با هر تعداد سؤال را می‌تونی به آزمون زمان‌دار یا عادی تبدیل کنی.",
        "📨 کوئیزهایی که قبلاً در تلگرام زده‌ای را Forward کن و بعد /BUILD را بزن.",
        "🖼 برای عکس‌های تست، «افزودن عکس‌های غلط» رو بزن و آخر کار /GO رو بفرست.",
        "📚 «مرور غلط‌ها» پاسخنامهٔ همهٔ غلط‌ها یا فقط امروز را مثل چیت‌شیت می‌سازد.",
        "♻️ /reset آخرین آزمون را دوباره و نزده می‌فرستد؛ /clear تست‌ها و پیام‌های ربات را از صفحه پاک می‌کند.",
        "⌨️ برای جمع‌کردن منوی پایین «بستن منو» و برای برگرداندنش /menu را بزن.",
        "",
        "حالا از منوی پایین شروع کن 👇",
      ].join("\n"),
    ),
    group ? {} : { reply_markup: mainMenuMarkup(chatId === adminUserId(env)) },
  );
}

async function showFullHelp(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  await message(
    env,
    chatId,
    rtlBlock(
      [
        "ℹ️ <b>راهنمای کامل ربات</b>",
        "",
        "📄 PDF: فایل را بفرست؛ فقط سؤال‌هایی ساخته می‌شوند که جواب صریح داخل فایل داشته باشند.",
        "🤖 متن ChatGPT: دکمهٔ مربوط را بزن، قالب را کپی کن و JSON نهایی را بفرست. تعداد سؤال دلخواه است.",
        "📨 کوئیز فورواردی: کوئیزها را Forward کن و /BUILD را بزن. اگر تلگرام جواب سبز را به ربات ندهد، جواب را از دکمه‌های شماره‌دار مشخص کن.",
        "🖼 عکس: عکس‌ها را بفرست، /GO را بزن و بعد زمان‌دار یا بدون‌زمان را انتخاب کن.",
        "🔀 آزمون غلط‌ها: همهٔ غلط‌های ثبت‌شدهٔ امروز را پیدا می‌کند.",
        "📚 مرور غلط‌ها: چیت‌شیت پاسخ و راهنمای غلط‌های امروز یا کل دفتر را می‌فرستد.",
        "",
        "دستورهای کاربردی:",
        "/menu — بازکردن منوی پایین",
        "/reset — شروع دوبارهٔ آخرین آزمون از حالت نزده",
        "/clear — پاک‌کردن تست‌ها و پیام‌های اخیر ربات",
        "/study — پاسخنامه و درسنامهٔ آخرین آزمون",
        "/home — لغو حالت در حال دریافت و برگشت به خانه",
        "",
        "در آزمون زمان‌دار هر سؤال ۴۵ ثانیه فرصت دارد. اگر پاسخ ندهی، سؤال بعدی با بسته‌شدن خودکار کوئیز می‌آید؛ اگر تلگرام به‌علت قطعی رویداد بسته‌شدن را دیر رساند، اولین پیام یا دستور بعدی آزمون را ادامه می‌دهد.",
      ].join("\n"),
    ),
    {
      parse_mode: "HTML",
      reply_markup: mainMenuMarkup(userId === adminUserId(env)),
    },
  );
}

async function clearChatScreen(
  env: RuntimeEnv,
  chatId: number,
  commandMessageId?: number,
): Promise<void> {
  const ids = new Set(await loadTrackedChatMessages(chatId));
  if (commandMessageId) ids.add(commandMessageId);
  for (const messageId of [...ids].sort((a, b) => b - a)) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearTrackedChatMessages(chatId);
  await message(
    env,
    chatId,
    rtlBlock("🧹 صفحه از تست‌ها و پیام‌های اخیر ربات پاک شد."),
  );
}

async function studyLastQuiz(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
): Promise<void> {
  const session = await loadChatQuizSession(userId);
  if (!session?.questions.length) {
    await message(
      env,
      chatId,
      rtlBlock("آخرین آزمونی برای ساخت درسنامه پیدا نشد."),
    );
    return;
  }
  await sendQuestionCheatSheet(
    env,
    chatId,
    "پاسخنامه و درسنامهٔ آخرین آزمون",
    session.questions,
  );
}

function groupChat(type: string | undefined): boolean {
  return type === "group" || type === "supergroup";
}

async function acceptAdminGeminiKey(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const apiKey = value.trim();
  if (apiKey.length < 24 || /\s/.test(apiKey)) {
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ قالب کلید درست نیست؛ کلید قبلی تغییر نکرد. دوباره از پنل مدیریت، ثبت کلید Gemini را بزن.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    const models = await listGeminiModels(apiKey, 8_000);
    await probeGeminiGenerateContent(apiKey, 8_000);
    await saveGeminiApiKey(env, apiKey);
    await saveProviderAvailability("gemini", {
      status: "available",
      last_checked: Date.now(),
    });
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ کلید Gemini اعتبارسنجی و امن ثبت شد. ${isolateLtr(models.ids.length)} مدل تولید محتوا در دسترس است و از این به بعد اول امتحان می‌شود.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "Gemini key validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ این کلید فعلاً امکان تولید پاسخ ندارد (نامعتبر، بدون سهمیه یا موقتاً قطع است)؛ کلید قبلی تغییر نکرد.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

async function acceptAdminBluesMindsKey(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const apiKey = value.trim();
  if (apiKey.length < 24 || /\s/.test(apiKey)) {
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ قالب کلید درست نیست؛ کلید قبلی تغییر نکرد. دوباره از پنل مدیریت، ثبت کلید BluesMinds را بزن.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    const models = await listBluesMindsModels(apiKey);
    await saveBluesMindsApiKey(env, apiKey);
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ کلید BluesMinds اعتبارسنجی و امن ثبت شد. ${isolateLtr(models.ids.length)} مدل در حساب در دسترس است و به‌عنوان مسیر پشتیبان استفاده می‌شود.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "BluesMinds key validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ BluesMinds این کلید را نپذیرفت یا موقتاً در دسترس نبود؛ کلید قبلی تغییر نکرد. کمی بعد دوباره امتحان کن.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

async function acceptAdminOpenRouterKey(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const apiKey = value.trim();
  if (!apiKey.startsWith("sk-or-") || apiKey.length < 40 || /\s/.test(apiKey)) {
    await message(
      env,
      chatId,
      rtlBlock("❌ قالب کلید OpenRouter درست نیست؛ کلید قبلی تغییر نکرد."),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    const info = await getOpenRouterKeyInfo(apiKey, 8_000);
    await saveOpenRouterApiKey(env, apiKey);
    const quota =
      info.limit_remaining === null
        ? info.is_free_tier
          ? "حساب رایگان فعال است"
          : "سقف مشخصی گزارش نشده"
        : `اعتبار باقی‌مانده ${isolateLtr(info.limit_remaining.toFixed(2))} است`;
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ کلید OpenRouter اعتبارسنجی و امن ثبت شد؛ ${quota}. این مسیر بعد از Gemini و قبل از BluesMinds اجرا می‌شود.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "OpenRouter key validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ OpenRouter این کلید را نپذیرفت یا سرویس موقتاً پاسخ نداد؛ کلید قبلی تغییر نکرد.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

async function acceptAdminTokenRouterKey(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const apiKey = value.trim();
  if (apiKey.length < 24 || /\s/.test(apiKey)) {
    await message(
      env,
      chatId,
      rtlBlock("❌ قالب کلید TokenRouter درست نیست؛ کلید قبلی تغییر نکرد."),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    const config = tokenRouterConfig(env.TOKENROUTER_MODEL);
    await validateCompatibleApiKey(config, apiKey, 12_000);
    await saveTokenRouterApiKey(env, apiKey);
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ کلید TokenRouter اعتبارسنجی و امن ثبت شد. مدل فعال: ${isolateLtr(config.model)}.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "TokenRouter key validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ TokenRouter این کلید را نپذیرفت یا مدل رایگان موقتاً شلوغ است؛ کلید قبلی تغییر نکرد.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

async function acceptAdminGroqKey(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const apiKey = value.trim();
  if (!apiKey.startsWith("gsk_") || apiKey.length < 30 || /\s/.test(apiKey)) {
    await message(
      env,
      chatId,
      rtlBlock("❌ قالب کلید Groq درست نیست؛ کلید قبلی تغییر نکرد."),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    const config = groqConfig(env.GROQ_MODEL);
    await validateCompatibleApiKey(config, apiKey, 12_000);
    await saveGroqApiKey(env, apiKey);
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ کلید Groq اعتبارسنجی و امن ثبت شد. در حالت خودکار، مدل ${isolateLtr(config.model)} اولین مسیر هوشمند است.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "Groq key validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ Groq این کلید را نپذیرفت یا سهمیه/مدل موقتاً پاسخ نداد؛ کلید قبلی تغییر نکرد.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

async function acceptAdminSambaNovaKey(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const apiKey = value.trim();
  if (apiKey.length < 24 || /\s/.test(apiKey)) {
    await message(
      env,
      chatId,
      rtlBlock("❌ قالب کلید SambaNova درست نیست؛ کلید قبلی تغییر نکرد."),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    const config = sambaNovaConfig(env.SAMBANOVA_MODEL);
    await validateCompatibleApiKey(config, apiKey, 12_000);
    await saveSambaNovaApiKey(env, apiKey);
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ کلید SambaNova اعتبارسنجی و امن ثبت شد. مدل فعال: ${isolateLtr(config.model)}.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "SambaNova key validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ SambaNova این کلید را نپذیرفت یا سهمیه/مدل موقتاً پاسخ نداد؛ کلید قبلی تغییر نکرد.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

async function acceptAdminDeepSeekKey(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const apiKey = value.trim();
  if (apiKey.length < 24 || /\s/.test(apiKey)) {
    await message(
      env,
      chatId,
      rtlBlock("❌ قالب کلید DeepSeek درست نیست؛ کلید قبلی تغییر نکرد."),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    const config = deepSeekConfig(env.DEEPSEEK_MODEL);
    await validateCompatibleApiKey(config, apiKey, 12_000);
    await saveDeepSeekApiKey(env, apiKey);
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ کلید DeepSeek اعتبارسنجی و امن ثبت شد. مدل فعال: ${isolateLtr(config.model)}.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "DeepSeek key validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ DeepSeek این کلید را نپذیرفت یا سهمیه/مدل موقتاً پاسخ نداد؛ کلید قبلی تغییر نکرد.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

async function acceptAdminForgeKey(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const apiKey = value.trim();
  if (!apiKey.startsWith("fg-") || apiKey.length < 24 || /\s/.test(apiKey)) {
    await message(
      env,
      chatId,
      rtlBlock("❌ قالب کلید Forge درست نیست؛ کلید قبلی تغییر نکرد."),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    const config = forgeConfig(env.FORGE_MODEL);
    await validateCompatibleApiKey(config, apiKey, 12_000);
    await saveForgeApiKey(env, apiKey);
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ کلید Forge اعتبارسنجی و امن ثبت شد. مدل فعال: ${isolateLtr(config.model)}.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "Forge key validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ Forge این کلید را نپذیرفت یا سرویس/مدل موقتاً پاسخ نداد؛ کلید قبلی تغییر نکرد.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

function parseCustomProviderInput(value: string): {
  config: CustomProviderConfig;
  apiKey: string;
} | null {
  const fields: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z_]+)\s*=\s*(.*?)\s*$/i);
    if (match) fields[match[1].toLowerCase()] = match[2];
  }
  const safe = safeCompatibleConfig({
    name: fields.name ?? "",
    base_url: fields.base_url ?? "",
    model: fields.model ?? "",
  });
  const apiKey = fields.api_key?.trim() ?? "";
  if (!safe || (apiKey && (apiKey.length < 16 || /\s/.test(apiKey))))
    return null;
  return {
    config: { ...safe, updated_at: Date.now() },
    apiKey,
  };
}

async function acceptAdminCustomProvider(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const parsed = parseCustomProviderInput(value);
  if (!parsed) {
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ تنظیمات معتبر نبود. نام، Base URL عمومیِ HTTPS، مدل و API Key باید در چهار خط جدا باشند؛ سرویس قبلی تغییر نکرد.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    await validateCompatibleApiKey(parsed.config, parsed.apiKey, 12_000);
    await saveCustomProviderConfig(parsed.config);
    await saveCustomOpenAiApiKey(env, parsed.apiKey);
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ سرویس «${parsed.config.name}» اعتبارسنجی و امن ثبت شد. مدل: ${isolateLtr(parsed.config.model)}؛ احراز هویت: ${parsed.apiKey ? "Bearer API Key" : "بدون API Key"}.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "Custom provider validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ سرویس سفارشی با این Base URL، مدل و کلید پاسخ نداد؛ تنظیم قبلی دست‌نخورده ماند.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

async function acceptAdminMistralKey(
  env: RuntimeEnv,
  chatId: number,
  userId: number,
  messageId: number | undefined,
  value: string,
): Promise<void> {
  if (messageId) {
    await telegram(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => undefined);
  }
  await clearAdminKeyInputSession(userId);
  const apiKey = value.trim();
  if (apiKey.length < 24 || /\s/.test(apiKey)) {
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ قالب کلید درست نیست؛ کلید قبلی تغییر نکرد. دوباره از پنل مدیریت، ثبت کلید Mistral AI را بزن.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
    return;
  }
  try {
    const modelCount = await validateMistralApiKey(apiKey, 8_000);
    const config = mistralChatConfig(env.MISTRAL_CHAT_MODEL);
    await validateCompatibleApiKey(config, apiKey, 12_000);
    await saveMistralApiKey(env, apiKey);
    await message(
      env,
      chatId,
      rtlBlock(
        `✅ کلید Mistral امن ثبت شد و ${isolateLtr(modelCount)} مدل حساب دیده شد. مدل چت فعال: ${isolateLtr(config.model)}.`,
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  } catch (error) {
    console.warn(
      "Mistral key validation failed",
      error instanceof Error ? error.message : "unknown",
    );
    await message(
      env,
      chatId,
      rtlBlock(
        "❌ سرویس رسمی Mistral این کلید را نپذیرفت یا موقتاً پاسخ نداد؛ کلید قبلی تغییر نکرد.",
      ),
      { reply_markup: mainMenuMarkup(true) },
    );
  }
}

export async function processTelegramUpdate(
  env: RuntimeEnv,
  update: TelegramUpdate,
  origin?: string,
): Promise<BackgroundTask | undefined> {
  const ownerId = adminUserId(env);
  const pollAnswer = update.poll_answer;
  if (pollAnswer?.poll_id && pollAnswer.user?.id) {
    await cleanupExpiredPin(env, pollAnswer.user.id);
    const optionIds = Array.isArray(pollAnswer.option_ids)
      ? pollAnswer.option_ids
      : [];
    await recordPollAnswer(pollAnswer.poll_id, pollAnswer.user.id, optionIds);
    await handleChatQuizPollAnswer(
      env,
      pollAnswer.poll_id,
      pollAnswer.user.id,
      optionIds,
    );
    return undefined;
  }
  if (update.poll?.id && update.poll.is_closed) {
    await handleClosedChatQuizPoll(env, update.poll.id);
    return undefined;
  }
  if (update.callback_query) {
    if (update.callback_query.from?.id) {
      await cleanupExpiredPin(env, update.callback_query.from.id);
      await recoverExpiredTimedQuiz(env, update.callback_query.from.id);
    }
    await handleCallback(env, update.callback_query, ownerId, origin);
    return undefined;
  }

  const membership = update.my_chat_member;
  const memberChatId = membership?.chat?.id;
  if (membership && memberChatId) {
    return undefined;
  }

  const incoming = update.message;
  if (!incoming?.chat?.id || !incoming.from?.id) return undefined;
  const chatId = incoming.chat.id;
  const inGroup = groupChat(incoming.chat.type);
  const text = incoming.text?.trim() ?? "";
  const command = text.toLocaleLowerCase("en-US");
  if (inGroup) {
    if (command.startsWith("/groupquiz") || command.startsWith("/groupstudy")) {
      if (incoming.from.id !== ownerId) {
        await message(
          env,
          chatId,
          rtlBlock("این دستور فقط برای مدیر اصلی ربات فعال است."),
        );
        return undefined;
      }
      const study = command.startsWith("/groupstudy");
      await message(
        env,
        chatId,
        rtlBlock(
          [
            study
              ? "📚 <b>ساخت درسنامه از تست‌های گروه</b>"
              : "🧪 <b>ساخت آزمون از تست‌های گروه</b>",
            "تلگرام به Bot API اجازهٔ خواندن خودکار پیام‌های قدیمی گروه را نمی‌دهد.",
            "دکمهٔ شروع را بزن؛ سپس کوئیزهای قبلی را از همین گروه انتخاب و به چت خصوصی ربات Forward کن.",
            "عکس‌های گروه را در یک نوبت جدا با دکمهٔ «افزودن عکس‌های غلط» وارد کن تا OCR و آزمون مستقل آن‌ها ساخته شود.",
            "بعد از /BUILD حالت زمان‌دار یا بدون‌زمان را انتخاب می‌کنی.",
          ].join("\n"),
        ),
        { parse_mode: "HTML", reply_markup: groupImportMarkup(study) },
      );
    }
    return undefined;
  }
  await cleanupExpiredPin(env, incoming.from.id);
  await recoverExpiredTimedQuiz(env, incoming.from.id);

  if (
    command.startsWith("/home") ||
    text === "🏠 خانه" ||
    text === "↩️ بازگشت"
  ) {
    await goHome(env, chatId, incoming.from.id);
    return undefined;
  }
  if (command.startsWith("/clear")) {
    await clearChatScreen(env, chatId, incoming.message_id);
    return undefined;
  }
  if (command.startsWith("/reset")) {
    await resetCurrentQuiz(env, chatId, incoming.from.id);
    return undefined;
  }
  if (text === "⌨️ بستن منو") {
    await message(
      env,
      chatId,
      rtlBlock("⌨️ منوی پایین جمع شد. هر وقت خواستی /menu را بزن."),
      {
        reply_markup: { remove_keyboard: true },
      },
    );
    return undefined;
  }
  if (command.startsWith("/go") || text === "✅ پایان ارسال عکس‌ها") {
    await processPhotoBatch(env, chatId, incoming.from.id, origin);
    return undefined;
  }
  if (command.startsWith("/admin") || text === "🛠 پنل مدیریت") {
    if (incoming.from.id !== ownerId) {
      await message(
        env,
        chatId,
        rtlBlock("این بخش فقط برای مدیر اصلی ربات فعال است."),
      );
      return undefined;
    }
    await showAdminPanel(env, chatId);
    return undefined;
  }
  if (text === "➕ افزودن API" || text === "🎛 موتور پردازش") {
    if (incoming.from.id !== ownerId) {
      await message(
        env,
        chatId,
        rtlBlock("این بخش فقط برای مدیر اصلی ربات فعال است."),
      );
      return undefined;
    }
    if (text === "➕ افزودن API") {
      await message(
        env,
        chatId,
        rtlBlock(
          "🔑 سرویس کلید را انتخاب کن؛ بعد کلید را همین‌جا می‌فرستی و ربات خودش اعتبارسنجی و ذخیره می‌کند.",
        ),
        { reply_markup: adminKeyMarkup() },
      );
    } else {
      const mode = await loadProviderMode();
      await message(
        env,
        chatId,
        rtlBlock(
          `🎛 حالت فعلی: ${providerModeNames[mode]}\nحالت خودکار یا موتور دلخواهت را انتخاب کن.`,
        ),
        { reply_markup: providerRoutingMarkup(mode) },
      );
    }
    return undefined;
  }

  if (incoming.from.id === ownerId && text) {
    const keyInput = await loadAdminKeyInputSession(ownerId);
    if (keyInput?.provider === "gemini") {
      await acceptAdminGeminiKey(
        env,
        chatId,
        ownerId,
        incoming.message_id,
        text,
      );
      return undefined;
    }
    if (keyInput?.provider === "bluesminds") {
      await acceptAdminBluesMindsKey(
        env,
        chatId,
        ownerId,
        incoming.message_id,
        text,
      );
      return undefined;
    }
    if (keyInput?.provider === "openrouter") {
      await acceptAdminOpenRouterKey(
        env,
        chatId,
        ownerId,
        incoming.message_id,
        text,
      );
      return undefined;
    }
    if (keyInput?.provider === "tokenrouter") {
      await acceptAdminTokenRouterKey(
        env,
        chatId,
        ownerId,
        incoming.message_id,
        text,
      );
      return undefined;
    }
    if (keyInput?.provider === "groq") {
      await acceptAdminGroqKey(env, chatId, ownerId, incoming.message_id, text);
      return undefined;
    }
    if (keyInput?.provider === "sambanova") {
      await acceptAdminSambaNovaKey(
        env,
        chatId,
        ownerId,
        incoming.message_id,
        text,
      );
      return undefined;
    }
    if (keyInput?.provider === "deepseek") {
      await acceptAdminDeepSeekKey(
        env,
        chatId,
        ownerId,
        incoming.message_id,
        text,
      );
      return undefined;
    }
    if (keyInput?.provider === "forge") {
      await acceptAdminForgeKey(
        env,
        chatId,
        ownerId,
        incoming.message_id,
        text,
      );
      return undefined;
    }
    if (keyInput?.provider === "custom") {
      await acceptAdminCustomProvider(
        env,
        chatId,
        ownerId,
        incoming.message_id,
        text,
      );
      return undefined;
    }
    if (keyInput?.provider === "mistral") {
      await acceptAdminMistralKey(
        env,
        chatId,
        ownerId,
        incoming.message_id,
        text,
      );
      return undefined;
    }
  }

  if (command.startsWith("/start") || command.startsWith("/menu")) {
    await showMainMenu(env, chatId, inGroup);
    return undefined;
  }
  if (command.startsWith("/help") || text === "ℹ️ راهنما") {
    await showFullHelp(env, chatId, incoming.from.id);
    return undefined;
  }
  if (
    command.startsWith("/chatquiz") ||
    text === "🤖 ساخت آزمون از متن ChatGPT"
  ) {
    await beginChatQuizImport(env, chatId, incoming.from.id);
    return undefined;
  }
  if (
    command.startsWith("/forwardquiz") ||
    text === "📨 آزمون از کوئیزهای فورواردی"
  ) {
    await beginForwardQuizCollection(env, chatId, incoming.from.id);
    return undefined;
  }
  if (
    command.startsWith("/build") ||
    text === "✅ تأیید و شروع آزمون" ||
    text === "✅ تأیید و شروع ساخت آزمون"
  ) {
    await finishForwardQuizCollection(env, chatId, incoming.from.id);
    return undefined;
  }
  const chatQuiz = await loadChatQuizSession(incoming.from.id);
  if (chatQuiz?.status === "awaiting_text" && text) {
    await acceptChatQuizText(env, chatId, incoming.from.id, text);
    return undefined;
  }
  if (!chatQuiz && text && looksLikeChatQuizJson(text)) {
    await saveChatQuizSession(incoming.from.id, {
      session_id: newChatQuizId(incoming.from.id),
      chat_id: chatId,
      status: "awaiting_text",
      questions: [],
      source: "chatgpt",
      input_text: "",
      current_index: 0,
      answers: [],
      poll_ids: [],
      poll_message_ids: [],
      started_at: Date.now(),
    });
    await acceptChatQuizText(env, chatId, incoming.from.id, text);
    return undefined;
  }
  if (incoming.poll) {
    await acceptForwardedQuiz(env, chatId, incoming.from.id, incoming.poll);
    return undefined;
  }
  if (text === "📄 ارسال PDF") {
    await message(
      env,
      chatId,
      rtlBlock(
        "از گیرهٔ کاغذ تلگرام، فایل را به‌صورت Document و با پسوند PDF ارسال کن.",
      ),
      inGroup ? {} : { reply_markup: mainMenuMarkup() },
    );
    return undefined;
  }
  if (text === "🖼 افزودن عکس‌های غلط") {
    await beginPhotoCollection(env, chatId, incoming.from.id);
    return undefined;
  }
  if (text === "🔀 آزمون تست‌های غلط") {
    await startWrongReview(env, chatId, incoming.from.id);
    return undefined;
  }
  if (command.startsWith("/wrongs")) {
    await startWrongReview(env, chatId, incoming.from.id);
    return undefined;
  }
  if (command.startsWith("/review") || text === "📚 مرور غلط‌ها") {
    await showWrongReviewChoices(env, chatId, incoming.from.id);
    return undefined;
  }
  if (command.startsWith("/study")) {
    await studyLastQuiz(env, chatId, incoming.from.id);
    return undefined;
  }
  if (text.startsWith("/status") || text === "⏳ وضعیت پردازش") {
    await message(
      env,
      chatId,
      rtlBlock(
        `ربات هر بار یک بستهٔ کوتاه از PDF را با مسیر انتخاب‌شده می‌خواند تا پردازش قطع نشود. حالت فعلی: ${providerModeNames[await loadProviderMode()]}. بعد از هر بسته، دکمهٔ «▶️ ادامه تست‌های بعدی» پایین پیام می‌آید.`,
      ),
      inGroup ? {} : { reply_markup: mainMenuMarkup() },
    );
    return undefined;
  }
  if (text.startsWith("/cancel")) {
    await message(
      env,
      chatId,
      rtlBlock("برای لغو، دکمهٔ «❌ لغو پردازش» زیر پیام همان PDF را بزن."),
    );
    return undefined;
  }

  const largestPhoto = incoming.photo?.at(-1);
  const documentMime = incoming.document?.mime_type?.toLowerCase() ?? "";
  const imageDocument =
    documentMime === "image/jpeg" ||
    documentMime === "image/png" ||
    documentMime === "image/webp";
  if (largestPhoto?.file_id || (imageDocument && incoming.document?.file_id)) {
    await acceptPhoto(env, chatId, incoming.from.id, {
      file_id: largestPhoto?.file_id ?? incoming.document!.file_id!,
      mime_type: largestPhoto?.file_id ? "image/jpeg" : documentMime,
    });
    return undefined;
  }

  const document = incoming.document;
  const isPdf =
    document?.mime_type === "application/pdf" ||
    document?.file_name?.toLowerCase().endsWith(".pdf");
  if (!document?.file_id || !isPdf) {
    if (inGroup) return undefined;
    await message(
      env,
      chatId,
      rtlBlock(
        "پیام شناخته نشد. می‌توانی PDF بفرستی، JSON آزمون ChatGPT را مستقیم ارسال کنی، یا از منوی کوئیزهای فورواردی استفاده کنی.",
      ),
      { reply_markup: mainMenuMarkup() },
    );
    return undefined;
  }
  if ((document.file_size ?? 0) > MAX_PDF_BYTES) {
    await message(
      env,
      chatId,
      rtlBlock("حجم PDF باید حداکثر ۲۰ مگابایت باشد."),
    );
    return undefined;
  }

  return await beginPdf(
    env,
    chatId,
    incoming.from.id,
    incoming.message_id,
    document.file_id,
    document.file_name || "quiz.pdf",
    document.file_size ?? 0,
    origin,
  );
}
