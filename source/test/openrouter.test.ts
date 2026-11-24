import assert from "node:assert/strict";
import test from "node:test";
import {
  extractImagesWithOpenRouterStage,
  extractPdfTextWithOpenRouter,
  getOpenRouterKeyInfo,
} from "../lib/gemini.ts";

const validQuestion = {
  total_pages: 1,
  questions: [
    {
      number: "1",
      text: "پایتخت ایران کدام شهر است؟",
      options: ["تهران", "شیراز", "تبریز", "رشت"],
      correct_index: 0,
      answer_evidence: "EXPLICIT_ANSWER: option 1; پاسخ: گزینه ۱",
      explanation: "",
    },
  ],
};

test("validates an OpenRouter key without generation and reads safe quota metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /openrouter\.ai\/api\/v1\/key$/);
    assert.match(
      String((init?.headers as Record<string, string>)?.Authorization),
      /^Bearer /,
    );
    return Response.json({
      data: { is_free_tier: true, limit_remaining: 2.5 },
    });
  };
  try {
    assert.deepEqual(await getOpenRouterKeyInfo("sk-or-test-key"), {
      is_free_tier: true,
      limit_remaining: 2.5,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses OpenRouter free routing for Persian PDF text and screenshot vision", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      model: "example/free-vision-model",
      choices: [{ message: { content: JSON.stringify(validQuestion) } }],
    });
  };
  try {
    const textQuestions = await extractPdfTextWithOpenRouter(
      [
        "۱- پایتخت ایران کدام شهر است؟",
        "۱) تهران ۲) شیراز ۳) تبریز ۴) رشت",
        "پاسخ: گزینه ۱",
        "این متن برای عبور از حداقل طول پردازش PDF عمداً کمی توضیح اضافه دارد.",
      ].join("\n"),
      "sk-or-test-key",
      { page_start: 1, page_end: 1, total_pages: 1 },
    );
    const imageQuestions = await extractImagesWithOpenRouterStage(
      [{ mime_type: "image/jpeg", data: "AQID" }],
      "sk-or-test-key",
    );
    assert.equal(textQuestions.length, 1);
    assert.equal(imageQuestions.length, 1);
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((body) => body.model === "openrouter/free"));
    assert.ok(
      bodies.every(
        (body) => (body.reasoning as { exclude?: boolean }).exclude === true,
      ),
    );
    const imageContent = (
      bodies[1].messages as Array<{ content: unknown[] }>
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
