import assert from "node:assert/strict";
import test from "node:test";
import {
  extractExplicitQuizFromOcr,
  extractQuizFromImages,
} from "../lib/gemini.ts";

test("extracts a quiz from inline screenshots using the green answer contract", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; body?: Record<string, any> }> = [];
  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, any>)
      : undefined;
    requests.push({ method, body });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({
      id: "image-interaction-1",
      status: "completed",
      output_text: JSON.stringify({
        total_pages: 1,
        questions: [
          {
            number: "7",
            text: "پایتخت ایران کدام است؟",
            options: ["تهران", "شیراز", "تبریز", "رشت"],
            correct_index: 0,
            answer_evidence: "EXPLICIT_ANSWER: option 1; گزینه سبز تهران",
            explanation: "تهران در تصویر سبز است.",
          },
        ],
      }),
    });
  };

  try {
    const result = await extractQuizFromImages(
      [{ data: "aGVsbG8=", mime_type: "image/jpeg" }],
      "test-key",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].correct_index, 0);
    const creation = requests.find((request) => request.method === "POST");
    assert.equal(creation?.body?.input[1].type, "image");
    assert.match(creation?.body?.input[0].text, /GREEN/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the official generateContent endpoint when Interactions is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/interactions")) {
      return Response.json(
        { error: { status: "UNAUTHENTICATED", message: "API key invalid" } },
        { status: 401 },
      );
    }
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    assert.equal(body.contents[0].parts[1].inline_data.mime_type, "image/jpeg");
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  total_pages: 1,
                  questions: [
                    {
                      number: "2",
                      text: "دو به علاوه دو چند است؟",
                      options: ["۳", "۴", "۵", "۶"],
                      correct_index: 1,
                      answer_evidence: "EXPLICIT_ANSWER: option 2; گزینه سبز ۴",
                      explanation: "",
                    },
                  ],
                }),
              },
            ],
          },
        },
      ],
    });
  };

  try {
    const result = await extractQuizFromImages(
      [{ data: "aGVsbG8=", mime_type: "image/jpeg" }],
      "test-key",
    );
    assert.equal(result[0].correct_index, 1);
    assert.ok(urls.some((url) => url.includes(":generateContent")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to OCR text only when an explicit printed answer exists", async () => {
  const originalFetch = globalThis.fetch;
  let ocrCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.ocr.space")) {
      ocrCalls++;
      return Response.json({
        IsErroredOnProcessing: false,
        ParsedResults: [
          {
            ParsedText: [
              "۱- پایتخت ایران کدام است؟",
              "۱) تهران",
              "۲) شیراز",
              "۳) رشت",
              "۴) تبریز",
              "پاسخ کارشناس: گزینه ۱",
            ].join("\n"),
          },
        ],
      });
    }
    return Response.json(
      { error: { status: "UNAUTHENTICATED", message: "API key invalid" } },
      { status: 401 },
    );
  };

  try {
    const result = await extractQuizFromImages(
      [{ data: "aGVsbG8=", mime_type: "image/jpeg" }],
      "bad-key",
    );
    assert.equal(ocrCalls, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "پایتخت ایران کدام است؟");
    assert.deepEqual(result[0].options, ["تهران", "شیراز", "رشت", "تبریز"]);
    assert.equal(result[0].correct_index, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses BluesMinds after both Gemini image routes fail", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("generativelanguage.googleapis.com")) {
      return Response.json(
        { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } },
        { status: 429 },
      );
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "gemini-2.5-flash" }] });
    }
    if (url.endsWith("/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      assert.equal(body.model, "gemini-2.5-flash");
      assert.equal(body.messages[0].content[1].type, "image_url");
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                total_pages: 1,
                questions: [
                  {
                    number: "9",
                    text: "رنگ پاسخ درست چیست؟",
                    options: ["سبز", "قرمز", "آبی", "زرد"],
                    correct_index: 0,
                    answer_evidence: "EXPLICIT_ANSWER: option 1; گزینه سبز است",
                    explanation: "",
                  },
                ],
              }),
            },
          },
        ],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const result = await extractQuizFromImages(
      [{ data: "aGVsbG8=", mime_type: "image/jpeg" }],
      "exhausted-gemini-key",
      { bluesMindsApiKey: "bluesminds-test-key-long-enough" },
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].correct_index, 0);
    assert.ok(urls.some((url) => url.endsWith("/v1/models")));
    assert.ok(urls.some((url) => url.endsWith("/v1/chat/completions")));
    assert.ok(!urls.some((url) => url.includes("api.ocr.space")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the deterministic OCR parser rejects text without an explicit answer", () => {
  assert.deepEqual(
    extractExplicitQuizFromOcr([
      "1- پایتخت ایران کدام است؟\n1) تهران\n2) شیراز",
    ]),
    [],
  );
});
