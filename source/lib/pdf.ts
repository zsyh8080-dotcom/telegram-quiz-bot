const MAX_PDF_PAGES = 1000;

export function detectPdfPageCount(buffer: ArrayBuffer): number | undefined {
  const source = new TextDecoder("latin1").decode(new Uint8Array(buffer));
  const pageObjects = source.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  if (pageObjects >= 1 && pageObjects <= MAX_PDF_PAGES) return pageObjects;

  const counts = Array.from(source.matchAll(/\/Count\s+(\d{1,5})\b/g))
    .map((match) => Number(match[1]))
    .filter(
      (value) =>
        Number.isInteger(value) && value >= 1 && value <= MAX_PDF_PAGES,
    );
  return counts.length ? Math.max(...counts) : undefined;
}
