import assert from "node:assert/strict";
import test from "node:test";
import { deliverBatch } from "../lib/telegram.ts";
import type { QuizQuestion } from "../lib/quiz.ts";

test("puts the continue button below the last poll in a batch", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    calls.push({ method, body });
    return Response.json({
      ok: true,
      result: { message_id: calls.length, chat: { id: 123 }, text: body.text },
    });
  };

  const questions: QuizQuestion[] = Array.from({ length: 13 }, (_, index) => ({
    number: String(index + 1),
    text: `متن سؤال ${index + 1}`,
    options: ["گزینه یک", "گزینه دو"],
    correct_index: 0,
    answer_evidence: "پاسخ صریح گزینه ۱",
    explanation: "",
  }));

  try {
    await deliverBatch(
      {
        TELEGRAM_BOT_TOKEN: "test-token",
        GEMINI_API_KEY: "test-key",
        WEBHOOK_SECRET: "test-secret",
      },
      123,
      456,
      {
        job: {
          kind: "interaction",
          id: "interaction-1",
          uri: "gemini://file",
          source_file: "file-1",
          started_at: Date.now(),
          filename: "quiz.pdf",
          size: 1024,
          page_start: 1,
          page_end: 20,
          total_pages: 40,
        },
        offset: 0,
        requester_id: 789,
        delivered: 0,
      },
      questions,
    );

    const polls = calls.filter((call) => call.method === "sendPoll");
    assert.equal(polls.length, 8);
    assert.ok(polls.every((call) => call.body.allows_revoting === true));
    const last = calls.at(-1);
    assert.equal(last?.method, "sendMessage");
    assert.match(String(last?.body.text), /این بسته تموم شد/);
    assert.equal(
      last?.body.reply_markup.inline_keyboard[0][0].text,
      "▶️ ادامه تست‌های بعدی",
    );
    assert.equal(
      last?.body.reply_markup.inline_keyboard[0][0].callback_data,
      "job_next",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
