import assert from "node:assert/strict";
import test from "node:test";
import { mistralOcrPdf, validateMistralApiKey } from "../lib/mistral-ocr.ts";

test("uses Mistral's official OCR endpoint with a bounded PDF page range", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/models"))
      return Response.json({ data: [{ id: "mistral-ocr-latest" }] });
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      pages: [{ index: 1, markdown: "۱- سؤال؟\n۱) الف\n۲) ب\nپاسخ: گزینه ۱" }],
    });
  };
  try {
    assert.equal(
      await validateMistralApiKey("mistral-test-key-long-enough"),
      1,
    );
    const text = await mistralOcrPdf(
      new TextEncoder().encode("%PDF-test").buffer,
      "mistral-test-key-long-enough",
      2,
      3,
    );
    assert.deepEqual(requestBody.pages, [1, 2]);
    assert.equal(requestBody.model, "mistral-ocr-latest");
    assert.match(text, /سؤال/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
