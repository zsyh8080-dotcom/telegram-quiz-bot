import type { QuizQuestion } from "./quiz.ts";
import type { GeminiJob } from "./gemini.ts";

const STATE_ORIGIN =
  "https://zsyh-telegram-pdf-quiz.charlotte1989flare.chatgpt.site";
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const MAX_WRONG_QUESTIONS = 600;
const MAX_TRACKED_CHAT_MESSAGES = 240;
const MEMORY_TTL_MS = 5 * 60_000;

type CacheWithDefault = CacheStorage & { default?: Cache };
type MemoryEntry = { expiresAt: number; json: string };

const memory = new Map<string, MemoryEntry>();

export type SecretProvider =
  | "gemini"
  | "bluesminds"
  | "mistral"
  | "openrouter"
  | "tokenrouter"
  | "forge"
  | "groq"
  | "sambanova"
  | "deepseek"
  | "custom";

export type ProviderMode =
  | "auto"
  | "gemini"
  | "groq"
  | "sambanova"
  | "deepseek"
  | "tokenrouter"
  | "forge"
  | "openrouter"
  | "bluesminds"
  | "mistral"
  | "custom"
  | "local";

export type CustomProviderConfig = {
  name: string;
  base_url: string;
  model: string;
  updated_at: number;
};

export type PhotoFile = {
  file_id: string;
  mime_type: string;
};

export type PhotoSession = {
  chat_id: number;
  status_message_id: number;
  files: PhotoFile[];
  started_at: number;
  processing?: {
    stage:
      | "gemini"
      | "groq"
      | "tokenrouter"
      | "forge"
      | "openrouter"
      | "custom"
      | "bluesminds"
      | "mistral"
      | "ocr"
      | "deliver";
    cursor: number;
    ocr_texts: string[];
    partial_questions?: QuizQuestion[];
    started_at: number;
    result_count?: number;
    bank_count?: number;
  };
};

export type WrongReviewSession = {
  questions: QuizQuestion[];
  offset: number;
  started_at: number;
};

export type WrongQuestionEntry = {
  question: QuizQuestion;
  first_wrong_at: number;
  last_wrong_at: number;
  wrong_count: number;
};

export type ActivePdfSession = {
  chat_id: number;
  status_message_id: number;
  job: GeminiJob;
};

export type PdfBatchSession = {
  job_id: string;
  page_start: number;
  page_end: number;
  questions: QuizQuestion[];
};

export type PendingPdfSession = {
  chat_id: number;
  status_message_id: number;
  requester_id: number;
  reply_to_message_id?: number;
  file_id: string;
  filename: string;
  announced_size: number;
  started_at: number;
};

export type AdminKeyInputSession = {
  provider: SecretProvider;
  started_at: number;
};

export type ChatQuizMode = "timed" | "untimed";

export type ChatQuizSession = {
  session_id: string;
  chat_id: number;
  status: "awaiting_text" | "choose_mode" | "running" | "completed";
  questions: QuizQuestion[];
  source?: "chatgpt" | "forwarded" | "photos" | "wrongs" | "group";
  input_text?: string;
  mode?: ChatQuizMode;
  current_index: number;
  answers: Array<number | null>;
  poll_ids: string[];
  poll_message_ids?: number[];
  current_poll_id?: string;
  current_poll_message_id?: number;
  current_poll_started_at?: number;
  started_at: number;
  summary_sent?: boolean;
};

export type ChatQuizPollRecord = {
  session_id: string;
  user_id: number;
  chat_id: number;
  question_index: number;
  message_id: number;
  timed: boolean;
};

export type ForwardQuizSession = {
  chat_id: number;
  status_message_id: number;
  questions: QuizQuestion[];
  pending?: {
    text: string;
    options: string[];
    explanation: string;
  };
  started_at: number;
};

export type ProviderAvailability = {
  status: "available" | "quota";
  last_checked: number;
  unavailable_since?: number;
  notified_at?: number;
};

export type EncryptedProviderSecret = {
  version: 1;
  iv: string;
  ciphertext: string;
  updated_at: number;
};

type PollRecord = {
  owner_id: number;
  question: QuizQuestion;
  wrong_recorded?: boolean;
};

export type PinnedQuizRecord = {
  chat_id: number;
  message_id: number;
  pinned_at: number;
  unpin_at: number;
};

export type AdminProviderAlert = {
  message_id?: number;
  alerted_at: number;
  context: string;
};

function key(scope: string, id: string | number): string {
  return `${STATE_ORIGIN}/__bot_state/${scope}/${encodeURIComponent(String(id))}`;
}

function cache(): Cache | undefined {
  return (globalThis.caches as CacheWithDefault | undefined)?.default;
}

async function readJson<T>(
  scope: string,
  id: string | number,
): Promise<T | null> {
  const stateKey = key(scope, id);
  const local = memory.get(stateKey);
  if (local && local.expiresAt > Date.now()) {
    return JSON.parse(local.json) as T;
  }
  if (local) memory.delete(stateKey);

  try {
    const response = await cache()?.match(new Request(stateKey));
    if (!response) return null;
    const json = await response.text();
    memory.set(stateKey, { expiresAt: Date.now() + MEMORY_TTL_MS, json });
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

async function writeJson(
  scope: string,
  id: string | number,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const stateKey = key(scope, id);
  const json = JSON.stringify(value);
  memory.set(stateKey, {
    expiresAt: Date.now() + Math.min(ttlSeconds * 1000, MEMORY_TTL_MS),
    json,
  });
  try {
    await cache()?.put(
      new Request(stateKey),
      new Response(json, {
        headers: {
          "Cache-Control": `public, max-age=${ttlSeconds}`,
          "Content-Type": "application/json; charset=utf-8",
        },
      }),
    );
  } catch {}
}

async function deleteJson(scope: string, id: string | number): Promise<void> {
  const stateKey = key(scope, id);
  memory.delete(stateKey);
  try {
    await cache()?.delete(new Request(stateKey));
  } catch {}
}

export function questionFingerprint(question: QuizQuestion): string {
  const source = [question.text, ...question.options]
    .join("\u001f")
    .toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function rememberPoll(
  pollId: string,
  ownerId: number,
  question: QuizQuestion,
): Promise<void> {
  await writeJson(
    "poll",
    pollId,
    { owner_id: ownerId, question } satisfies PollRecord,
    YEAR_SECONDS,
  );
}

export async function addWrongQuestions(
  userId: number,
  incoming: QuizQuestion[],
  wrongAt = Date.now(),
): Promise<number> {
  const current = await readJson<{
    questions?: QuizQuestion[];
    entries?: WrongQuestionEntry[];
  }>("wrong", userId);
  const legacyQuestions = Array.isArray(current?.questions)
    ? current.questions
    : [];
  const entries = Array.isArray(current?.entries)
    ? current.entries
    : legacyQuestions.map((question) => ({
        question,
        first_wrong_at: 0,
        last_wrong_at: 0,
        wrong_count: 1,
      }));
  const indexes = new Map(
    entries.map((entry, index) => [questionFingerprint(entry.question), index]),
  );
  for (const question of incoming) {
    const fingerprint = questionFingerprint(question);
    const existingIndex = indexes.get(fingerprint);
    if (existingIndex !== undefined) {
      const previous = entries[existingIndex];
      entries[existingIndex] = {
        ...previous,
        question,
        first_wrong_at: previous.first_wrong_at || wrongAt,
        last_wrong_at: wrongAt,
        wrong_count: Math.max(1, previous.wrong_count) + 1,
      };
      continue;
    }
    indexes.set(fingerprint, entries.length);
    entries.push({
      question,
      first_wrong_at: wrongAt,
      last_wrong_at: wrongAt,
      wrong_count: 1,
    });
  }
  const limited = entries.slice(-MAX_WRONG_QUESTIONS);
  await writeJson(
    "wrong",
    userId,
    {
      entries: limited,
      questions: limited.map((entry) => entry.question),
    },
    YEAR_SECONDS,
  );
  return limited.length;
}

export async function loadWrongEntries(
  userId: number,
): Promise<WrongQuestionEntry[]> {
  const current = await readJson<{
    questions?: QuizQuestion[];
    entries?: WrongQuestionEntry[];
  }>("wrong", userId);
  if (Array.isArray(current?.entries)) return current.entries;
  return Array.isArray(current?.questions)
    ? current.questions.map((question) => ({
        question,
        first_wrong_at: 0,
        last_wrong_at: 0,
        wrong_count: 1,
      }))
    : [];
}

export async function loadWrongQuestions(
  userId: number,
  since = 0,
): Promise<QuizQuestion[]> {
  const entries = await loadWrongEntries(userId);
  return entries
    .filter((entry) => entry.last_wrong_at >= since)
    .map((entry) => entry.question);
}

export async function recordPollAnswer(
  pollId: string,
  userId: number,
  optionIds: number[],
): Promise<{ added: boolean; count: number } | null> {
  const record = await readJson<PollRecord>("poll", pollId);
  if (!record || record.owner_id !== userId) return null;
  const existing = await loadWrongQuestions(userId);
  if (
    !optionIds.length ||
    optionIds.includes(record.question.correct_index) ||
    record.wrong_recorded
  ) {
    return { added: false, count: existing.length };
  }
  const count = await addWrongQuestions(userId, [record.question]);
  await writeJson(
    "poll",
    pollId,
    { ...record, wrong_recorded: true },
    YEAR_SECONDS,
  );
  return { added: count > existing.length, count };
}

export async function trackChatMessage(
  chatId: number,
  messageId: number,
): Promise<void> {
  const current = await readJson<{ ids?: number[] }>("chat-messages", chatId);
  const ids = Array.isArray(current?.ids)
    ? current.ids.filter(Number.isSafeInteger)
    : [];
  if (!ids.includes(messageId)) ids.push(messageId);
  await writeJson(
    "chat-messages",
    chatId,
    { ids: ids.slice(-MAX_TRACKED_CHAT_MESSAGES) },
    2 * DAY_SECONDS,
  );
}

export async function loadTrackedChatMessages(
  chatId: number,
): Promise<number[]> {
  const current = await readJson<{ ids?: number[] }>("chat-messages", chatId);
  return Array.isArray(current?.ids)
    ? current.ids.filter(Number.isSafeInteger)
    : [];
}

export async function clearTrackedChatMessages(chatId: number): Promise<void> {
  await deleteJson("chat-messages", chatId);
}

export async function savePinnedQuiz(
  userId: number,
  pin: PinnedQuizRecord,
): Promise<void> {
  await writeJson("pinned-quiz", userId, pin, 2 * DAY_SECONDS);
}

export async function loadPinnedQuiz(
  userId: number,
): Promise<PinnedQuizRecord | null> {
  return await readJson<PinnedQuizRecord>("pinned-quiz", userId);
}

export async function clearPinnedQuiz(userId: number): Promise<void> {
  await deleteJson("pinned-quiz", userId);
}

export async function saveAdminProviderAlert(
  alert: AdminProviderAlert,
): Promise<void> {
  await writeJson("admin-provider-alert", "global", alert, DAY_SECONDS);
}

export async function loadAdminProviderAlert(): Promise<AdminProviderAlert | null> {
  return await readJson<AdminProviderAlert>("admin-provider-alert", "global");
}

export async function savePhotoSession(
  userId: number,
  session: PhotoSession,
): Promise<void> {
  await writeJson("photos", userId, session, DAY_SECONDS);
}

export async function loadPhotoSession(
  userId: number,
): Promise<PhotoSession | null> {
  return await readJson<PhotoSession>("photos", userId);
}

export async function appendPhoto(
  userId: number,
  file: PhotoFile,
): Promise<PhotoSession | null> {
  const session = await loadPhotoSession(userId);
  if (!session) return null;
  if (!session.files.some((item) => item.file_id === file.file_id)) {
    session.files.push(file);
    await savePhotoSession(userId, session);
  }
  return session;
}

export async function clearPhotoSession(userId: number): Promise<void> {
  await deleteJson("photos", userId);
}

export async function saveWrongReview(
  userId: number,
  session: WrongReviewSession,
): Promise<void> {
  await writeJson("review", userId, session, DAY_SECONDS);
}

export async function loadWrongReview(
  userId: number,
): Promise<WrongReviewSession | null> {
  return await readJson<WrongReviewSession>("review", userId);
}

export async function clearWrongReview(userId: number): Promise<void> {
  await deleteJson("review", userId);
}

export async function saveActivePdf(
  userId: number,
  session: ActivePdfSession,
): Promise<void> {
  await writeJson("active-pdf", userId, session, DAY_SECONDS);
}

export async function loadActivePdf(
  userId: number,
): Promise<ActivePdfSession | null> {
  return await readJson<ActivePdfSession>("active-pdf", userId);
}

export async function clearActivePdf(userId: number): Promise<void> {
  await deleteJson("active-pdf", userId);
}

export async function savePdfBatch(
  userId: number,
  session: PdfBatchSession,
): Promise<void> {
  await writeJson("pdf-batch", userId, session, DAY_SECONDS);
}

export async function loadPdfBatch(
  userId: number,
): Promise<PdfBatchSession | null> {
  return await readJson<PdfBatchSession>("pdf-batch", userId);
}

export async function clearPdfBatch(userId: number): Promise<void> {
  await deleteJson("pdf-batch", userId);
}

export async function savePendingPdf(
  userId: number,
  session: PendingPdfSession,
): Promise<void> {
  await writeJson("pending-pdf", userId, session, DAY_SECONDS);
}

export async function loadPendingPdf(
  userId: number,
): Promise<PendingPdfSession | null> {
  return await readJson<PendingPdfSession>("pending-pdf", userId);
}

export async function clearPendingPdf(userId: number): Promise<void> {
  await deleteJson("pending-pdf", userId);
}

export async function saveAdminKeyInputSession(
  userId: number,
  session: AdminKeyInputSession,
): Promise<void> {
  await writeJson("admin-key-input", userId, session, 10 * 60);
}

export async function loadAdminKeyInputSession(
  userId: number,
): Promise<AdminKeyInputSession | null> {
  return await readJson<AdminKeyInputSession>("admin-key-input", userId);
}

export async function clearAdminKeyInputSession(userId: number): Promise<void> {
  await deleteJson("admin-key-input", userId);
}

export async function saveEncryptedProviderSecret(
  provider: SecretProvider,
  secret: EncryptedProviderSecret,
): Promise<void> {
  await writeJson("provider-secret", provider, secret, YEAR_SECONDS);
}

export async function loadEncryptedProviderSecret(
  provider: SecretProvider,
): Promise<EncryptedProviderSecret | null> {
  return await readJson<EncryptedProviderSecret>("provider-secret", provider);
}

export async function saveProviderAvailability(
  provider: SecretProvider,
  availability: ProviderAvailability,
): Promise<void> {
  await writeJson(
    "provider-availability",
    provider,
    availability,
    YEAR_SECONDS,
  );
}

export async function loadProviderAvailability(
  provider: SecretProvider,
): Promise<ProviderAvailability | null> {
  return await readJson<ProviderAvailability>(
    "provider-availability",
    provider,
  );
}

export async function saveProviderMode(mode: ProviderMode): Promise<void> {
  await writeJson("provider-routing", "global", { mode }, YEAR_SECONDS);
}

export async function loadProviderMode(): Promise<ProviderMode> {
  const current = await readJson<{ mode?: ProviderMode }>(
    "provider-routing",
    "global",
  );
  return current?.mode ?? "auto";
}

export async function saveCustomProviderConfig(
  config: CustomProviderConfig,
): Promise<void> {
  await writeJson("custom-provider", "global", config, YEAR_SECONDS);
}

export async function loadCustomProviderConfig(): Promise<CustomProviderConfig | null> {
  return await readJson<CustomProviderConfig>("custom-provider", "global");
}

export async function saveChatQuizSession(
  userId: number,
  session: ChatQuizSession,
): Promise<void> {
  await writeJson("chat-quiz", userId, session, DAY_SECONDS);
}

export async function loadChatQuizSession(
  userId: number,
): Promise<ChatQuizSession | null> {
  return await readJson<ChatQuizSession>("chat-quiz", userId);
}

export async function clearChatQuizSession(userId: number): Promise<void> {
  await deleteJson("chat-quiz", userId);
}

export async function saveForwardQuizSession(
  userId: number,
  session: ForwardQuizSession,
): Promise<void> {
  await writeJson("forward-quiz", userId, session, DAY_SECONDS);
}

export async function loadForwardQuizSession(
  userId: number,
): Promise<ForwardQuizSession | null> {
  return await readJson<ForwardQuizSession>("forward-quiz", userId);
}

export async function clearForwardQuizSession(userId: number): Promise<void> {
  await deleteJson("forward-quiz", userId);
}

export async function saveChatQuizPoll(
  pollId: string,
  record: ChatQuizPollRecord,
): Promise<void> {
  await writeJson("chat-quiz-poll", pollId, record, DAY_SECONDS);
}

export async function loadChatQuizPoll(
  pollId: string,
): Promise<ChatQuizPollRecord | null> {
  return await readJson<ChatQuizPollRecord>("chat-quiz-poll", pollId);
}

export async function clearChatQuizPoll(pollId: string): Promise<void> {
  await deleteJson("chat-quiz-poll", pollId);
}

export function resetBotStateForTest(): void {
  memory.clear();
}
