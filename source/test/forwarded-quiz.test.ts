import assert from "node:assert/strict";
import test from "node:test";
import { resetBotStateForTest } from "../lib/bot-state.ts";
import { processTelegramUpdate } from "../lib/telegram.ts";

const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  WEBHOOK_SECRET: "test-secret",
  OWNER_ID: "1",
};

test("collects forwarded Telegram quizzes and starts them after explicit confirmation", async () => {
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
        result: { message_id: nextMessageId++, poll: { id: "rebuilt-poll-1" } },
      });
    }
    return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
  };

  try {
    await processTelegramUpdate(env, {
      update_id: 800,
      message: {
        message_id: 80,
        chat: { id: 80, type: "private" },
        from: { id: 80 },
        text: "📨 آزمون از کوئیزهای فورواردی",
      },
    });
    await processTelegramUpdate(env, {
      update_id: 801,
      message: {
        message_id: 81,
        chat: { id: 80, type: "private" },
        from: { id: 80 },
        poll: {
          id: "source-poll-1",
          question: "کدام گزینه صحیح است؟",
          options: [
            { text: "گزینه اول", voter_count: 1 },
            { text: "گزینه دوم", voter_count: 2 },
            { text: "گزینه سوم", voter_count: 0 },
            { text: "گزینه چهارم", voter_count: 0 },
          ],
          type: "quiz",
          correct_option_id: 1,
          explanation: "گزینه دوم مطابق منبع صحیح است.",
        },
      },
    });
    assert.ok(
      calls.some(
        (call) =>
          call.method === "editMessageText" &&
          String(call.body.text).includes("تعداد دریافت‌شده:") &&
          String(call.body.text)
            .replace(/\p{Cf}/gu, "")
            .includes("1"),
      ),
    );

    await processTelegramUpdate(env, {
      update_id: 802,
      message: {
        message_id: 82,
        chat: { id: 80, type: "private" },
        from: { id: 80 },
        text: "/BUILD",
      },
    });
    assert.ok(
      calls.some(
        (call) =>
          call.method === "sendMessage" &&
          String(call.body.text).includes("زمان‌دار باشد یا بدون زمان"),
      ),
    );

    await processTelegramUpdate(env, {
      update_id: 803,
      callback_query: {
        id: "forward-mode",
        from: { id: 80 },
        data: "chatquiz_untimed",
        message: { message_id: 83, chat: { id: 80, type: "private" } },
      },
    });
    const rebuilt = calls.find((call) => call.method === "sendPoll");
    assert.equal(rebuilt?.body.correct_option_id, 1);
    assert.equal(rebuilt?.body.allows_revoting, true);
    assert.ok(calls.some((call) => call.method === "pinChatMessage"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("asks for a manual answer when Telegram hides the forwarded quiz key", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const texts: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
    if (body.text) texts.push(body.text);
    return Response.json({ ok: true, result: { message_id: 90 } });
  };
  try {
    await processTelegramUpdate(env, {
      update_id: 900,
      message: {
        message_id: 90,
        chat: { id: 90, type: "private" },
        from: { id: 90 },
        text: "📨 آزمون از کوئیزهای فورواردی",
      },
    });
    await processTelegramUpdate(env, {
      update_id: 901,
      message: {
        message_id: 91,
        chat: { id: 90, type: "private" },
        from: { id: 90 },
        poll: {
          id: "source-poll-hidden-key",
          question: "پاسخ چیست؟",
          options: [{ text: "اول" }, { text: "دوم" }],
          type: "quiz",
        },
      },
    });
    assert.ok(
      texts.some((text) => text.includes("جواب سبز این کوئیز فورواردی")),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
