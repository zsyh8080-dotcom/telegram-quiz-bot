import assert from "node:assert/strict";
import test from "node:test";
import {
  extractImagesWithCompatible,
  extractPdfTextWithCompatible,
  deepSeekConfig,
  forgeConfig,
  groqConfig,
  mistralChatConfig,
  safeCompatibleConfig,
  sambaNovaConfig,
  tokenRouterConfig,
  validateCompatibleApiKey,
} from "../lib/openai-compatible.ts";

const extraction = {
  total_pages: 1,
  questions: [
    {
      number: "1",
      text: "پایتخت ایران کدام است؟",
      options: ["تهران", "شیراز", "تبریز", "رشت"],
      correct_index: 0,
      answer_evidence: "EXPLICIT_ANSWER: option 1; پاسخ: گزینه ۱",
      explanation: "",
    },
  ],
};

test("accepts safe public HTTPS OpenAI-compatible endpoints and blocks private ones", () => {
  assert.deepEqual(
    safeCompatibleConfig({
      name: "Example",
      base_url: "https://api.example.com/v1/",
      model: "vendor/model",
    }),
    {
      name: "Example",
      base_url: "https://api.example.com/v1",
      model: "vendor/model",
    },
  );
  assert.equal(
    safeCompatibleConfig({
      name: "Local",
      base_url: "http://127.0.0.1:8080/v1",
      model: "model",
    }),
    null,
  );
});

test("uses the official Forge gateway preset and supports an empty API key", async () => {
  const originalFetch = globalThis.fetch;
  let receivedHeaders: Record<string, string> = {};
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://forge-gateway-api.fly.dev/v1/chat/completions",
    );
    receivedHeaders = init?.headers as Record<string, string>;
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  };
  try {
    const config = forgeConfig();
    await validateCompatibleApiKey(config, "");
    assert.equal(config.model, "gemini-3.5-flash");
    assert.equal(receivedHeaders.Authorization, undefined);
    assert.equal(receivedHeaders["Content-Type"], "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Groq's official OpenAI-compatible gateway and vision model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://api.groq.com/openai/v1/chat/completions",
    );
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    assert.equal(body.model, "qwen/qwen3.6-27b");
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  };
  try {
    await validateCompatibleApiKey(
      groqConfig(),
      "gsk_test_key_that_is_long_enough_for_validation",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses official SambaNova, DeepSeek and Mistral chat presets", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; model?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    requests.push({ url: String(input), model: body.model });
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  };
  try {
    await validateCompatibleApiKey(
      sambaNovaConfig(),
      "samba-test-key-that-is-long-enough",
    );
    await validateCompatibleApiKey(
      deepSeekConfig(),
      "deepseek-test-key-that-is-long-enough",
    );
    await validateCompatibleApiKey(
      mistralChatConfig(),
      "mistral-test-key-that-is-long-enough",
    );
    assert.deepEqual(requests, [
      {
        url: "https://api.sambanova.ai/v1/chat/completions",
        model: "Meta-Llama-3.3-70B-Instruct",
      },
      {
        url: "https://api.deepseek.com/chat/completions",
        model: "deepseek-v4-flash",
      },
      {
        url: "https://api.mistral.ai/v1/chat/completions",
        model: "mistral-small-latest",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses TokenRouter OpenAI-compatible chat completions for validation and extraction", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://api.tokenrouter.com/v1/chat/completions",
    );
    assert.match(
      String((init?.headers as Record<string, string>)?.Authorization),
      /^Bearer /,
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const maxTokens = Number(body.max_tokens);
    return Response.json({
      choices: [
        {
          message: {
            content: maxTokens <= 12 ? "OK" : JSON.stringify(extraction),
          },
        },
      ],
    });
  };
  try {
    const config = tokenRouterConfig();
    await validateCompatibleApiKey(
      config,
      "sk-tokenrouter-test-key-that-is-long-enough",
    );
    const questions = await extractPdfTextWithCompatible(
      "۱- پایتخت ایران کدام است؟ ۱) تهران ۲) شیراز ۳) تبریز ۴) رشت پاسخ: گزینه ۱ این متن برای عبور از حداقل طول کافی است.",
      "sk-tokenrouter-test-key-that-is-long-enough",
      config,
      { page_start: 1, page_end: 1, total_pages: 1 },
    );
    const imageQuestions = await extractImagesWithCompatible(
      [{ mime_type: "image/jpeg", data: "AQID" }],
      "sk-tokenrouter-test-key-that-is-long-enough",
      config,
    );
    assert.equal(questions.length, 1);
    assert.equal(imageQuestions.length, 1);
    assert.ok(bodies.every((body) => body.model === "z-ai/glm-5.2-free"));
    const imageContent = (
      bodies.at(-1)?.messages as Array<{ content: unknown[] }>
    )[0].content;
    assert.ok(
      imageContent.some(
        (part) => (part as { type?: string }).type === "image_url",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
