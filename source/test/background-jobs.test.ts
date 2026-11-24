import assert from "node:assert/strict";
import test from "node:test";
import {
  loadActivePdf,
  loadChatQuizSession,
  loadPendingPdf,
  loadPhotoSession,
  resetBotStateForTest,
  savePendingPdf,
  savePhotoSession,
} from "../lib/bot-state.ts";
import { runPdfStartJob, runPhotoProcessingJob } from "../lib/telegram.ts";
import { extractPdfTextRange } from "../lib/pdf-text.ts";

const env = {
  TELEGRAM_BOT_TOKEN: "telegram-test",
  GEMINI_API_KEY: "gemini-test",
  BLUESMINDS_API_KEY: "blues-test-key-long-enough",
  WEBHOOK_SECRET: "webhook-test",
};
const envWithoutGemini = {
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
  BLUESMINDS_API_KEY: env.BLUESMINDS_API_KEY,
  WEBHOOK_SECRET: env.WEBHOOK_SECRET,
};

test("photo state resumes through all configured AI and OCR fallbacks", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("api.telegram.org/bot")) {
      const method = url.split("/").at(-1);
      if (method === "getFile") {
        return Response.json({
          ok: true,
          result: { file_path: "photos/one.jpg" },
        });
      }
      if (method === "sendPoll") {
        polls++;
        return Response.json({
          ok: true,
          result: { poll: { id: `poll-${polls}` } },
        });
      }
      return Response.json({ ok: true, result: { message_id: 90 } });
    }
    if (url.includes("api.telegram.org/file/")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "gemini-2.5-flash" }] });
    }
    if (url.endsWith("/v1/chat/completions")) {
      return Response.json(
        { error: { message: "upstream unavailable" } },
        { status: 503 },
      );
    }
    if (url.includes("api.ocr.space")) {
      return Response.json({
        IsErroredOnProcessing: false,
        ParsedResults: [
          {
            ParsedText:
              "۱- پایتخت ایران کدام است؟\n۱) تهران\n۲) شیراز\n۳) رشت\n۴) تبریز\nپاسخ: گزینه ۱",
          },
        ],
      });
    }
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  };

  try {
    await savePhotoSession(7, {
      chat_id: 7,
      status_message_id: 70,
      files: [{ file_id: "photo-1", mime_type: "image/jpeg" }],
      started_at: Date.now(),
      processing: {
        stage: "gemini",
        cursor: 0,
        ocr_texts: [],
        started_at: Date.now(),
      },
    });
    const payload = { chat_id: 7, user_id: 7, status_message_id: 70 };
    assert.equal(await runPhotoProcessingJob(env, payload), true);
    assert.equal((await loadPhotoSession(7))?.processing?.stage, "tokenrouter");
    assert.equal(await runPhotoProcessingJob(env, payload), true);
    assert.equal((await loadPhotoSession(7))?.processing?.stage, "forge");
    assert.equal(await runPhotoProcessingJob(env, payload), true);
    assert.equal((await loadPhotoSession(7))?.processing?.stage, "openrouter");
    assert.equal(await runPhotoProcessingJob(env, payload), true);
    assert.equal((await loadPhotoSession(7))?.processing?.stage, "custom");
    assert.equal(await runPhotoProcessingJob(env, payload), true);
    assert.equal((await loadPhotoSession(7))?.processing?.stage, "bluesminds");
    assert.equal(await runPhotoProcessingJob(env, payload), true);
    assert.equal((await loadPhotoSession(7))?.processing?.stage, "mistral");
    assert.equal(await runPhotoProcessingJob(env, payload), true);
    assert.equal((await loadPhotoSession(7))?.processing?.stage, "ocr");
    assert.equal(await runPhotoProcessingJob(env, payload), true);
    assert.equal((await loadPhotoSession(7))?.processing?.stage, "deliver");
    assert.equal(await runPhotoProcessingJob(env, payload), false);
    assert.equal(await loadPhotoSession(7), null);
    assert.equal(polls, 0);
    assert.equal((await loadChatQuizSession(7))?.source, "photos");
    assert.equal((await loadChatQuizSession(7))?.status, "choose_mode");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function onePagePdf(): Uint8Array {
  const content = [
    "BT /F1 12 Tf 14 TL 72 720 Td",
    "(1. Which city is the capital in this explicit employment examination sample?) Tj T*",
    "(1 - Tehran) Tj T*",
    "(2 - Shiraz) Tj T*",
    "(Answer: option 1) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(new TextEncoder().encode(source).length);
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(source).length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(source);
}

test("PDF buffer can be extracted more than once during fallback", async () => {
  const pdf = onePagePdf();
  const buffer = pdf.buffer.slice(
    pdf.byteOffset,
    pdf.byteOffset + pdf.byteLength,
  ) as ArrayBuffer;
  const first = await extractPdfTextRange(buffer, 1, 1);
  const second = await extractPdfTextRange(buffer, 1, 1);
  assert.equal(first.text, second.text);
  assert.ok(buffer.byteLength > 0);
});

test("PDF uses BluesMinds when Gemini is not configured", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const pdf = onePagePdf();
  let bluesCalls = 0;
  let geminiCalls = 0;
  let polls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.telegram.org/bot")) {
      const method = url.split("/").at(-1);
      if (method === "getFile") {
        return Response.json({
          ok: true,
          result: { file_path: "docs/test.pdf" },
        });
      }
      if (method === "sendPoll") {
        polls++;
        return Response.json({
          ok: true,
          result: { poll: { id: "pdf-poll" } },
        });
      }
      return Response.json({ ok: true, result: { message_id: 80 } });
    }
    if (url.includes("api.telegram.org/file/")) {
      return new Response(
        pdf.buffer.slice(
          pdf.byteOffset,
          pdf.byteOffset + pdf.byteLength,
        ) as ArrayBuffer,
      );
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiCalls++;
      throw new Error("Gemini must not be called");
    }
    if (url.endsWith("/v1/models")) {
      bluesCalls++;
      return Response.json({ data: [{ id: "provider/custom-chat-2026" }] });
    }
    if (url.endsWith("/v1/chat/completions")) {
      bluesCalls++;
      return Response.json({
        choices: [
          {
            message: {
              content: `نتیجهٔ استخراج:\n${JSON.stringify({
                total_pages: 1,
                questions: [
                  {
                    number: "1",
                    text: "Capital?",
                    options: ["Tehran", "Shiraz"],
                    correct_index: 0,
                    answer_evidence:
                      "EXPLICIT_ANSWER: option 1; Answer: option 1",
                    explanation: "",
                  },
                ],
              })}\nپایان`,
            },
          },
        ],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await savePendingPdf(8, {
      chat_id: 8,
      status_message_id: 80,
      requester_id: 8,
      file_id: "pdf-1",
      filename: "test.pdf",
      announced_size: pdf.byteLength,
      started_at: Date.now(),
    });
    await runPdfStartJob(envWithoutGemini, "https://bot.test", {
      requester_id: 8,
    });
    assert.equal(await loadPendingPdf(8), null);
    assert.equal(await loadActivePdf(8), null);
    assert.equal(bluesCalls, 2);
    assert.equal(geminiCalls, 0);
    assert.equal(polls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PDF falls back to the local OCR parser when BluesMinds rejects the prompt", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const pdf = onePagePdf();
  let polls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.telegram.org/bot")) {
      const method = url.split("/").at(-1);
      if (method === "getFile") {
        return Response.json({
          ok: true,
          result: { file_path: "docs/local-ocr.pdf" },
        });
      }
      if (method === "sendPoll") {
        polls++;
        return Response.json({
          ok: true,
          result: { poll: { id: "ocr-poll" } },
        });
      }
      return Response.json({ ok: true, result: { message_id: 81 } });
    }
    if (url.includes("api.telegram.org/file/")) {
      return new Response(
        pdf.buffer.slice(
          pdf.byteOffset,
          pdf.byteOffset + pdf.byteLength,
        ) as ArrayBuffer,
      );
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "gpt-4o" }] });
    }
    if (url.endsWith("/v1/chat/completions")) {
      return Response.json(
        { error: { message: "content policy" } },
        { status: 400 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await savePendingPdf(9, {
      chat_id: 9,
      status_message_id: 81,
      requester_id: 9,
      file_id: "pdf-local-ocr",
      filename: "local-ocr.pdf",
      announced_size: pdf.byteLength,
      started_at: Date.now(),
    });
    await runPdfStartJob(envWithoutGemini, "https://bot.test", {
      requester_id: 9,
    });
    assert.equal(await loadPendingPdf(9), null);
    assert.equal(polls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PDF prefers synchronous Gemini over BluesMinds", async () => {
  resetBotStateForTest();
  const originalFetch = globalThis.fetch;
  const pdf = onePagePdf();
  let geminiCalls = 0;
  let bluesCalls = 0;
  let polls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.telegram.org/bot")) {
      const method = url.split("/").at(-1);
      if (method === "getFile") {
        return Response.json({
          ok: true,
          result: { file_path: "docs/gemini.pdf" },
        });
      }
      if (method === "sendPoll") {
        polls++;
        return Response.json({
          ok: true,
          result: { poll: { id: "gemini-poll" } },
        });
      }
      return Response.json({ ok: true, result: { message_id: 82 } });
    }
    if (url.includes("api.telegram.org/file/")) {
      return new Response(
        pdf.buffer.slice(
          pdf.byteOffset,
          pdf.byteOffset + pdf.byteLength,
        ) as ArrayBuffer,
      );
    }
    if (
      url.includes("generativelanguage.googleapis.com") &&
      url.endsWith(":generateContent")
    ) {
      geminiCalls++;
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
                        number: "1",
                        text: "Capital?",
                        options: ["Tehran", "Shiraz"],
                        correct_index: 0,
                        answer_evidence:
                          "EXPLICIT_ANSWER: option 1; Answer: option 1",
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
    }
    if (url.includes("api.bluesminds.com")) {
      bluesCalls++;
      throw new Error("BluesMinds must not be called after Gemini succeeds");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await savePendingPdf(10, {
      chat_id: 10,
      status_message_id: 82,
      requester_id: 10,
      file_id: "pdf-gemini",
      filename: "gemini.pdf",
      announced_size: pdf.byteLength,
      started_at: Date.now(),
    });
    await runPdfStartJob(env, "https://bot.test", { requester_id: 10 });
    assert.equal(await loadPendingPdf(10), null);
    assert.equal(geminiCalls, 1);
    assert.equal(bluesCalls, 0);
    assert.equal(polls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
