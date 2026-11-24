import assert from "node:assert/strict";
import test from "node:test";
import {
  loadProviderAvailability,
  loadCustomProviderConfig,
  resetBotStateForTest,
  saveProviderAvailability,
} from "../lib/bot-state.ts";
import {
  activeCustomOpenAiApiKey,
  activeForgeApiKey,
  activeGeminiApiKey,
  activeOpenRouterApiKey,
} from "../lib/secure-config.ts";
import {
  checkGeminiQuotaRecovery,
  mainMenuMarkup,
  processTelegramUpdate,
} from "../lib/telegram.ts";

test("shows mistake review, photo import, and home in the main menu", () => {
  const markup = mainMenuMarkup() as {
    keyboard: Array<Array<{ text: string }>>;
  };
  const labels = markup.keyboard.flat().map((button) => button.text);
  assert.ok(labels.includes("🔀 آزمون تست‌های غلط"));
  assert.ok(labels.includes("🖼 افزودن عکس‌های غلط"));
  assert.ok(labels.includes("🤖 ساخت آزمون از متن ChatGPT"));
  assert.ok(labels.includes("📨 آزمون از کوئیزهای فورواردی"));
  assert.ok(labels.includes("📚 مرور غلط‌ها"));
  assert.ok(labels.includes("⌨️ بستن منو"));
  assert.ok(labels.includes("🏠 خانه"));
  assert.ok(!labels.includes("🛠 پنل مدیریت"));
  const adminMarkup = mainMenuMarkup(true) as {
    keyboard: Array<Array<{ text: string }>>;
  };
  assert.ok(
    adminMarkup.keyboard
      .flat()
      .some((button) => button.text === "🛠 پنل مدیریت"),
  );
  assert.ok(
    !adminMarkup.keyboard
      .flat()
      .some((button) => button.text === "➕ افزودن API"),
  );
  assert.ok(
    !adminMarkup.keyboard
      .flat()
      .some((button) => button.text === "🎛 موتور پردازش"),
  );
});

test("serves the start menu to a non-owner private user", async () => {
  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { text?: string };
    sentTexts.push(body.text ?? "");
    return Response.json({ ok: true, result: { message_id: 1 } });
  };

  try {
    await processTelegramUpdate(
      {
        TELEGRAM_BOT_TOKEN: "test-token",
        GEMINI_API_KEY: "test-key",
        WEBHOOK_SECRET: "test-secret",
        OWNER_ID: "1",
        PUBLIC_ACCESS: "false",
      },
      {
        update_id: 10,
        message: {
          message_id: 20,
          chat: { id: 30, type: "private" },
          from: { id: 999 },
          text: "/start",
        },
      },
    );
    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0], /به ربات تست‌زنی خوش اومدی/);
    assert.doesNotMatch(sentTexts[0], /فقط برای مدیر/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner can validate and securely replace the Gemini key from admin panel", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const replacement = "test-gemini-key-that-is-long-enough-12345";
  const env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    GEMINI_API_KEY: "old-gemini-key-that-is-long-enough",
    WEBHOOK_SECRET: "test-secret-for-encryption",
    OWNER_ID: "1",
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("generativelanguage.googleapis.com/v1beta/models")) {
      if (url.endsWith(":generateContent")) {
        return Response.json({
          candidates: [{ content: { parts: [{ text: "OK" }] } }],
        });
      }
      return Response.json({
        models: [
          {
            name: "models/gemini-2.0-flash-lite-001",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      });
    }
    if (url.includes("api.telegram.org/bot")) {
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await processTelegramUpdate(env, {
      update_id: 20,
      callback_query: {
        id: "admin-callback",
        from: { id: 1 },
        data: "admin_gemini_help",
        message: { message_id: 30, chat: { id: 1, type: "private" } },
      },
    });
    await processTelegramUpdate(env, {
      update_id: 21,
      message: {
        message_id: 31,
        chat: { id: 1, type: "private" },
        from: { id: 1 },
        text: replacement,
      },
    });
    assert.equal(await activeGeminiApiKey(env), replacement);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("notifies the owner once when Gemini recovers from quota exhaustion", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const notifications: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(":generateContent")) {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "OK" }] } }],
      });
    }
    if (url.includes("api.telegram.org/bot")) {
      const body = JSON.parse(String(init?.body)) as { text?: string };
      notifications.push(body.text ?? "");
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    GEMINI_API_KEY: "test-gemini-key-that-is-long-enough",
    WEBHOOK_SECRET: "test-secret",
    OWNER_ID: "77",
  };
  try {
    await saveProviderAvailability("gemini", {
      status: "quota",
      unavailable_since: Date.now() - 60 * 60_000,
      last_checked: Date.now() - 31 * 60_000,
    });
    await checkGeminiQuotaRecovery(env);
    await checkGeminiQuotaRecovery(env);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /دوباره فعال شد/);
    assert.equal(
      (await loadProviderAvailability("gemini"))?.status,
      "available",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner can validate and securely replace the OpenRouter key", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const replacement = "sk-or-v1-test-key-that-is-long-enough-123456789";
  const env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "test-secret-for-encryption",
    OWNER_ID: "1",
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("openrouter.ai/api/v1/key")) {
      return Response.json({
        data: { is_free_tier: true, limit_remaining: null },
      });
    }
    if (url.includes("api.telegram.org/bot")) {
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await processTelegramUpdate(env, {
      update_id: 30,
      callback_query: {
        id: "openrouter-callback",
        from: { id: 1 },
        data: "admin_openrouter_help",
        message: { message_id: 40, chat: { id: 1, type: "private" } },
      },
    });
    await processTelegramUpdate(env, {
      update_id: 31,
      message: {
        message_id: 41,
        chat: { id: 1, type: "private" },
        from: { id: 1 },
        text: replacement,
      },
    });
    assert.equal(await activeOpenRouterApiKey(env), replacement);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner can validate and securely replace the Forge key", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const replacement = "fg-test-key-that-is-long-enough-123456";
  const env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "test-secret-for-encryption",
    OWNER_ID: "1",
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://forge-gateway-api.fly.dev/v1/chat/completions") {
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    }
    if (url.includes("api.telegram.org/bot")) {
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await processTelegramUpdate(env, {
      update_id: 32,
      callback_query: {
        id: "forge-callback",
        from: { id: 1 },
        data: "admin_forge_help",
        message: { message_id: 42, chat: { id: 1, type: "private" } },
      },
    });
    await processTelegramUpdate(env, {
      update_id: 33,
      message: {
        message_id: 43,
        chat: { id: 1, type: "private" },
        from: { id: 1 },
        text: replacement,
      },
    });
    assert.equal(await activeForgeApiKey(env), replacement);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner can register an auth-free custom OpenAI-compatible provider", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  let authorization: string | undefined;
  const env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "test-secret-for-encryption",
    OWNER_ID: "1",
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://public-model.example/v1/chat/completions") {
      authorization = (init?.headers as Record<string, string>)?.Authorization;
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    }
    if (url.includes("api.telegram.org/bot")) {
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await processTelegramUpdate(env, {
      update_id: 34,
      callback_query: {
        id: "custom-callback",
        from: { id: 1 },
        data: "admin_custom_help",
        message: { message_id: 44, chat: { id: 1, type: "private" } },
      },
    });
    await processTelegramUpdate(env, {
      update_id: 35,
      message: {
        message_id: 45,
        chat: { id: 1, type: "private" },
        from: { id: 1 },
        text: "name=Public model\nbase_url=https://public-model.example/v1\nmodel=public/model\napi_key=",
      },
    });
    assert.equal(authorization, undefined);
    assert.equal(await activeCustomOpenAiApiKey(env), "");
    assert.equal((await loadCustomProviderConfig())?.model, "public/model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("defers PDF download and BluesMinds work until after webhook acknowledgement", async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1) ?? "";
    methods.push(method);
    const body = JSON.parse(String(init?.body)) as { text?: string };
    return Response.json({
      ok: true,
      result: { message_id: 44, chat: { id: 30 }, text: body.text },
    });
  };

  try {
    const backgroundTask = await processTelegramUpdate(
      {
        TELEGRAM_BOT_TOKEN: "test-token",
        GEMINI_API_KEY: "test-key",
        WEBHOOK_SECRET: "test-secret",
      },
      {
        update_id: 11,
        message: {
          message_id: 21,
          chat: { id: 30, type: "private" },
          from: { id: 999 },
          document: {
            file_id: "telegram-file",
            file_name: "exam.pdf",
            mime_type: "application/pdf",
            file_size: 1024,
          },
        },
      },
      "https://bot.test",
    );

    assert.equal(typeof backgroundTask, "function");
    assert.deepEqual(methods, ["sendMessage"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
