import { getDocumentProxy } from "unpdf";

export type PdfTextRange = {
  total_pages: number;
  page_start: number;
  page_end: number;
  text: string;
};

type PositionedTextItem = Record<string, unknown> & {
  str?: string;
  dir?: string;
  width?: number;
  height?: number;
  hasEOL?: boolean;
  transform?: number[];
};

function separator(
  previous: PositionedTextItem,
  current: PositionedTextItem,
): string {
  if (previous.hasEOL) return "";
  const previousTransform = previous.transform;
  const currentTransform = current.transform;
  if (
    !Array.isArray(previousTransform) ||
    previousTransform.length < 6 ||
    !Array.isArray(currentTransform) ||
    currentTransform.length < 6 ||
    typeof previous.width !== "number" ||
    typeof current.width !== "number"
  )
    return " ";

  const previousY = Number(previousTransform[5]);
  const currentY = Number(currentTransform[5]);
  const fontSize = Math.max(
    6,
    Math.abs(Number(previousTransform[0]) || 0),
    Math.abs(Number(currentTransform[0]) || 0),
    Number(previous.height) || 0,
    Number(current.height) || 0,
  );
  if (Math.abs(previousY - currentY) > fontSize * 0.55) return "\n";

  const previousX = Number(previousTransform[4]);
  const currentX = Number(currentTransform[4]);
  const gap =
    currentX < previousX
      ? previousX - (currentX + current.width)
      : currentX - (previousX + previous.width);
  return gap > Math.max(1.2, fontSize * 0.16) ? " " : "";
}

export function pageText(items: Array<Record<string, unknown>>): string {
  let text = "";
  let previous: PositionedTextItem | null = null;
  for (const rawItem of items) {
    const item = rawItem as PositionedTextItem;
    if (typeof item.str !== "string") continue;
    if (previous && previous.str && item.str) text += separator(previous, item);
    text += item.str;
    if (item.hasEOL) text += "\n";
    previous = item;
  }
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdfTextRange(
  buffer: ArrayBuffer,
  requestedStart: number,
  requestedEnd: number,
): Promise<PdfTextRange> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer).slice());
  try {
    const totalPages = pdf.numPages;
    const pageStart = Math.max(
      1,
      Math.min(Math.floor(requestedStart), totalPages),
    );
    const pageEnd = Math.max(
      pageStart,
      Math.min(Math.floor(requestedEnd), totalPages),
    );
    const pages: string[] = [];
    for (let pageNumber = pageStart; pageNumber <= pageEnd; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = pageText(content.items as Array<Record<string, unknown>>);
      pages.push(`--- PDF PAGE ${pageNumber} ---\n${text}`);
      page.cleanup();
    }
    return {
      total_pages: totalPages,
      page_start: pageStart,
      page_end: pageEnd,
      text: pages.join("\n\n").slice(0, 80_000),
    };
  } finally {
    await pdf.destroy();
  }
}
