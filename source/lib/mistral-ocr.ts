import type { InlineQuizImage } from "./gemini.ts";

const MISTRAL_API_ROOT = "https://api.mistral.ai/v1";
const OCR_MODEL = "mistral-ocr-latest";

type OcrPage = { index?: number; markdown?: string };
type OcrResponse = { pages?: OcrPage[] };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

async function mistralError(response: Response): Promise<Error> {
  const code =
    response.status === 401 || response.status === 403
      ? "AUTH"
      : response.status === 429
        ? "QUOTA"
        : response.status >= 500
          ? "UPSTREAM"
          : "REQUEST";
  return new Error(`Mistral OCR request failed [M-${code}]`);
}

async function ocrDocument(
  apiKey: string,
  document: Record<string, string>,
  timeoutMs = 18_000,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await fetch(`${MISTRAL_API_ROOT}/ocr`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OCR_MODEL,
      document,
      ...extra,
      include_image_base64: false,
      table_format: "markdown",
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await mistralError(response);
  const payload = (await response.json()) as OcrResponse;
  const pages = Array.isArray(payload.pages) ? payload.pages : [];
  const text = pages
    .map((page, index) => {
      const markdown = String(page.markdown ?? "").trim();
      return markdown
        ? `--- PDF PAGE ${Number(page.index ?? index) + 1} ---\n${markdown}`
        : "";
    })
    .filter(Boolean)
    .join("\n\n");
  if (!text) throw new Error("Mistral OCR returned no text [M-OUTPUT]");
  return text;
}

export async function validateMistralApiKey(
  apiKey: string,
  timeoutMs = 8_000,
): Promise<number> {
  const response = await fetch(`${MISTRAL_API_ROOT}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await mistralError(response);
  const payload = (await response.json()) as { data?: unknown[] };
  return Array.isArray(payload.data) ? payload.data.length : 0;
}

export async function mistralOcrPdf(
  buffer: ArrayBuffer,
  apiKey: string,
  pageStart = 1,
  pageEnd = pageStart + 19,
): Promise<string> {
  if (buffer.byteLength > 12 * 1024 * 1024) {
    throw new Error("PDF is too large for inline Mistral OCR [M-SIZE]");
  }
  const data = bytesToBase64(new Uint8Array(buffer));
  const pages = Array.from(
    { length: Math.max(1, pageEnd - pageStart + 1) },
    (_, index) => Math.max(0, pageStart - 1 + index),
  );
  return await ocrDocument(
    apiKey,
    {
      type: "document_url",
      document_url: `data:application/pdf;base64,${data}`,
    },
    24_000,
    { pages },
  );
}

export async function mistralOcrImages(
  images: InlineQuizImage[],
  apiKey: string,
): Promise<string[]> {
  return await Promise.all(
    images.map(
      async (image) =>
        await ocrDocument(
          apiKey,
          {
            type: "image_url",
            image_url: `data:${image.mime_type};base64,${image.data}`,
          },
          15_000,
        ),
    ),
  );
}
