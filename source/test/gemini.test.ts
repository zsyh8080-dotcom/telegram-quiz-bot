import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { classifyGeminiFailure } from "../lib/gemini-errors.ts";
import { startQuizExtraction } from "../lib/gemini.ts";
import { detectPdfPageCount } from "../lib/pdf.ts";

test("classifies safe Gemini provider failures without exposing response bodies", () => {
  assert.equal(
    classifyGeminiFailure(400, "Invalid JSON payload. Unknown field schema"),
    "SCHEMA",
  );
  assert.equal(
    classifyGeminiFailure(404, "model gemini-x is not found"),
    "MODEL",
  );
  assert.equal(
    classifyGeminiFailure(403, "permission denied for model gemini-x"),
    "MODEL",
  );
  assert.equal(classifyGeminiFailure(429, "RESOURCE_EXHAUSTED"), "QUOTA");
  assert.equal(classifyGeminiFailure(403, "permission denied"), "AUTH");
});

test("falls back to a stored synchronous interaction when background is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let backgroundAttempts = 0;
  let synchronousAttempts = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/upload/v1beta/files")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-goog-upload-url": "https://upload.test/pdf" },
      });
    }
    if (url === "https://upload.test/pdf") {
      return Response.json({
        file: {
          name: "files/test-pdf",
          uri: "https://generativelanguage.googleapis.com/v1beta/files/test-pdf",
          state: "ACTIVE",
        },
      });
    }
    if (url.endsWith("/v1beta/interactions")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(
        new Headers(init?.headers).get("Api-Revision"),
        "2026-05-20",
      );
      if (body.background === true) {
        backgroundAttempts++;
        return Response.json(
          {
            error: {
              status: "INVALID_ARGUMENT",
              message: "Background execution is not enabled for this project.",
            },
          },
          { status: 400 },
        );
      }
      synchronousAttempts++;
      assert.ok(body.response_format);
      return Response.json({ id: "interaction-sync-1", status: "completed" });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };

  try {
    const bytes = new TextEncoder().encode(
      "%PDF-1.7\n1 0 obj <</Type /Page>>\n%%EOF",
    );
    const job = await startQuizExtraction(
      bytes.buffer as ArrayBuffer,
      "test.pdf",
      "test-key",
    );
    assert.equal(job.kind, "interaction");
    assert.equal(job.id, "interaction-sync-1");
    assert.equal(backgroundAttempts, 1);
    assert.equal(synchronousAttempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("detects ordinary PDF page objects", () => {
  const bytes = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj <</Type /Pages /Count 2>>\n2 0 obj <</Type /Page>>\n3 0 obj <</Type /Page>>",
  );
  assert.equal(detectPdfPageCount(bytes.buffer as ArrayBuffer), 2);
});

test("detects all 554 pages in the supplied IranEstekhdam fixture when available", async (t) => {
  const path = new URL(
    "../../upload/Downloaded_File_[Iranestekhdam.ir] (1).pdf",
    import.meta.url,
  );
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    t.skip("uploaded PDF is not present outside this workspace");
    return;
  }
  const array = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  assert.equal(detectPdfPageCount(array as ArrayBuffer), 554);
});
