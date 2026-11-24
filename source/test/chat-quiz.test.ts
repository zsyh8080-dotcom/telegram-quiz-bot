import assert from "node:assert/strict";
import test from "node:test";
import { resetBotStateForTest } from "../lib/bot-state.ts";
import { processTelegramUpdate } from "../lib/telegram.ts";

const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  WEBHOOK_SECRET: "test-secret",
  OWNER_ID: "1",
};

const fortyQuestions = JSON.stringify({
  title: "آزمون نمونه",
  questions: Array.from({ length: 40 }, (_, index) => ({
    number: String(index + 1),
    question: `سؤال نمونه شماره ${index + 1} کدام پاسخ را دارد؟`,
    options: [
      "گزینه درست",
      "گزینه نزدیک دوم",
      "گزینه نزدیک سوم",
      "گزینه نزدیک چهارم",
    ],
    answer: 1,
    explanation: "گزینه اول بر اساس متن منبع صحیح است.",
  })),
});

test("accepts a user-selected question count instead of requiring forty", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const texts: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
    if (body.text) texts.push(body.text);
    return Response.json({ ok: true, result: { message_id: 69 } });
  };
  try {
    const three = JSON.stringify({
      questions: Array.from({ length: 3 }, (_, index) => ({
        question: `سؤال ${index + 1}`,
        options: ["درست", "نزدیک ۲", "نزدیک ۳", "نزدیک ۴"],
        answer: 1,
        explanation: "توضیح",
      })),
    });
    await processTelegramUpdate(env, {
      message: {
        message_id: 69,
        chat: { id: 69, type: "private" },
        from: { id: 69 },
        text: three,
      },
    });
    assert.ok(
      texts.some((text) =>
        text.replace(/\p{Cf}/gu, "").includes("3 تست معتبر دریافت شد"),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts a 40-question ChatGPT JSON directly without asking for PDF", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const texts: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
    if (body.text) texts.push(body.text);
    return Response.json({ ok: true, result: { message_id: 70 } });
  };
  try {
    await processTelegramUpdate(env, {
      update_id: 700,
      message: {
        message_id: 70,
        chat: { id: 70, type: "private" },
        from: { id: 70 },
        text: fortyQuestions,
      },
    });
    assert.ok(
      texts.some((text) =>
        text.replace(/\p{Cf}/gu, "").includes("40 تست معتبر دریافت شد"),
      ),
    );
    assert.ok(texts.every((text) => !text.includes("یک فایل PDF")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("imports ChatGPT JSON, runs a 45-second quiz, pins the first poll, and grades it", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let nextMessageId = 100;
  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ method, body });
    if (method === "sendPoll") {
      return Response.json({
        ok: true,
        result: { message_id: nextMessageId++, poll: { id: "timed-poll-1" } },
      });
    }
    return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
  };

  try {
    await processTelegramUpdate(env, {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 50, type: "private" },
        from: { id: 50 },
        text: "🤖 ساخت آزمون از متن ChatGPT",
      },
    });
    assert.ok(
      calls.some(
        (call) =>
          call.method === "sendMessage" &&
          String(call.body.text).includes("<pre>"),
      ),
    );

    await processTelegramUpdate(env, {
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 50, type: "private" },
        from: { id: 50 },
        text: fortyQuestions.slice(0, Math.floor(fortyQuestions.length / 2)),
      },
    });
    await processTelegramUpdate(env, {
      update_id: 22,
      message: {
        message_id: 111,
        chat: { id: 50, type: "private" },
        from: { id: 50 },
        text: fortyQuestions.slice(Math.floor(fortyQuestions.length / 2)),
      },
    });
    await processTelegramUpdate(env, {
      update_id: 3,
      callback_query: {
        id: "mode-timed",
        from: { id: 50 },
        data: "chatquiz_timed",
        message: { message_id: 12, chat: { id: 50, type: "private" } },
      },
    });
    const pollCall = calls.find((call) => call.method === "sendPoll");
    assert.equal(pollCall?.body.open_period, 45);
    assert.equal(pollCall?.body.allows_revoting, false);
    assert.ok(calls.some((call) => call.method === "pinChatMessage"));

    await processTelegramUpdate(env, {
      update_id: 4,
      poll_answer: {
        poll_id: "timed-poll-1",
        user: { id: 50 },
        option_ids: [0],
      },
    });
    await processTelegramUpdate(env, {
      update_id: 5,
      callback_query: {
        id: "finish-timed",
        from: { id: 50 },
        data: "chatquiz_finish",
        message: { message_id: 13, chat: { id: 50, type: "private" } },
      },
    });
    assert.ok(calls.some((call) => call.method === "stopPoll"));
    assert.ok(
      calls.some(
        (call) =>
          call.method === "sendMessage" &&
          String(call.body.text).includes("درست:") &&
          String(call.body.text)
            .replace(/\p{Cf}/gu, "")
            .includes("1 از 40"),
      ),
    );
    const score = calls.findLast(
      (call) =>
        call.method === "sendMessage" &&
        String(call.body.text).includes("آزمون تمام شد"),
    );
    const scoreMarkup = score?.body.reply_markup as
      | {
          inline_keyboard?: Array<Array<{ text?: string }>>;
        }
      | undefined;
    const scoreButtons =
      scoreMarkup?.inline_keyboard?.flat().map((button) => button.text) ?? [];
    assert.ok(scoreButtons.includes("🔁 آزمون دوباره"));
    assert.ok(scoreButtons.includes("❌ آزمون از غلط‌های همین آزمون"));
    assert.ok(scoreButtons.includes("🧾 خلاصه و درسنامهٔ جواب‌های اشتباه"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("untimed imported quiz keeps revoting enabled and can be finished manually", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let pollNumber = 0;
  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ method, body });
    return Response.json({
      ok: true,
      result:
        method === "sendPoll"
          ? {
              message_id: 80 + pollNumber,
              poll: { id: `untimed-poll-${++pollNumber}` },
            }
          : { message_id: 81 },
    });
  };
  try {
    await processTelegramUpdate(env, {
      message: {
        message_id: 20,
        chat: { id: 60, type: "private" },
        from: { id: 60 },
        text: "/chatquiz",
      },
    });
    await processTelegramUpdate(env, {
      message: {
        message_id: 21,
        chat: { id: 60, type: "private" },
        from: { id: 60 },
        text: fortyQuestions,
      },
    });
    await processTelegramUpdate(env, {
      callback_query: {
        id: "mode-untimed",
        from: { id: 60 },
        data: "chatquiz_untimed",
        message: { message_id: 22, chat: { id: 60, type: "private" } },
      },
    });
    const pollCall = calls.find((call) => call.method === "sendPoll");
    assert.equal(pollCall?.body.allows_revoting, true);
    assert.equal(pollCall?.body.open_period, undefined);
    await processTelegramUpdate(env, {
      poll_answer: {
        poll_id: "untimed-poll-1",
        user: { id: 60 },
        option_ids: [0],
      },
    });
    await processTelegramUpdate(env, {
      poll_answer: {
        poll_id: "untimed-poll-1",
        user: { id: 60 },
        option_ids: [],
      },
    });
    await processTelegramUpdate(env, {
      callback_query: {
        id: "finish-untimed",
        from: { id: 60 },
        data: "chatquiz_finish",
        message: { message_id: 23, chat: { id: 60, type: "private" } },
      },
    });
    assert.ok(
      calls.some(
        (call) =>
          call.method === "sendMessage" &&
          String(call.body.text)
            .replace(/\p{Cf}/gu, "")
            .includes("بدون پاسخ: 40"),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
