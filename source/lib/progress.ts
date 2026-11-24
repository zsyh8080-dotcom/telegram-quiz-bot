const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

export type ProcessingStage = "upload" | "file" | "interaction";

export type ProcessingRange = {
  minimum: number;
  maximum: number;
};

export function persianNumber(value: number): string {
  return String(Math.max(0, Math.round(value))).replace(
    /\d/g,
    (digit) => PERSIAN_DIGITS[Number(digit)],
  );
}

export function estimateProcessingRangeMinutes(
  size: number,
  pages?: number,
  stage: ProcessingStage = "interaction",
): ProcessingRange {
  const megabytes = Math.max(0, size) / (1024 * 1024);
  if (stage === "upload") {
    return megabytes > 15
      ? { minimum: 1, maximum: 4 }
      : megabytes > 5
        ? { minimum: 1, maximum: 3 }
        : { minimum: 1, maximum: 2 };
  }

  if (stage === "file") {
    const pageCount = Math.max(1, pages ?? 1);
    const base =
      pageCount > 600
        ? { minimum: 4, maximum: 10 }
        : pageCount > 250
          ? { minimum: 3, maximum: 8 }
          : pageCount > 50
            ? { minimum: 2, maximum: 6 }
            : { minimum: 1, maximum: 4 };
    return megabytes > 15
      ? { minimum: base.minimum, maximum: base.maximum + 1 }
      : base;
  }

  const rangePages = Math.max(1, pages ?? 20);
  return rangePages > 10
    ? { minimum: 1, maximum: 5 }
    : { minimum: 1, maximum: 4 };
}

function elapsedText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return "کمتر از یک دقیقه";
  const minutes = Math.floor(seconds / 60);
  return `${persianNumber(minutes)} دقیقه`;
}

function remainingText(
  elapsedMilliseconds: number,
  range: ProcessingRange,
): string {
  const elapsedMinutes = Math.max(0, elapsedMilliseconds / 60_000);
  const minimum = Math.max(0, Math.ceil(range.minimum - elapsedMinutes));
  const maximum = Math.max(0, Math.ceil(range.maximum - elapsedMinutes));
  if (maximum === 0) {
    return "از برآورد اولیه گذشته؛ پردازش هنوز فعاله";
  }
  if (minimum === 0 || minimum === maximum) {
    return `تا حدود ${persianNumber(maximum)} دقیقه`;
  }
  return `حدود ${persianNumber(minimum)} تا ${persianNumber(maximum)} دقیقه`;
}

function tehranClock(now: number): string {
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(now));
}

export function friendlyElapsedText(
  startedAt: number,
  now = Date.now(),
): string {
  const elapsed = Math.max(0, now - startedAt);
  return [
    `⏱ ${elapsedText(elapsed)} گذشته`,
    `🕒 آخرین بررسی: ${tehranClock(now)}`,
  ].join(" • ");
}

export function estimatedFinishUnix(
  startedAt: number,
  size: number,
  pages?: number,
  stage: ProcessingStage = "interaction",
): number {
  const range = estimateProcessingRangeMinutes(size, pages, stage);
  return Math.floor((startedAt + range.maximum * 60_000) / 1000);
}

export function friendlyRemainingText(
  startedAt: number,
  size: number,
  pages?: number,
  now = Date.now(),
  stage: ProcessingStage = "interaction",
): string {
  const elapsed = Math.max(0, now - startedAt);
  const range = estimateProcessingRangeMinutes(size, pages, stage);
  return [
    `⏱ ${elapsedText(elapsed)} گذشته`,
    `⏳ باقی‌ماندهٔ تقریبی: ${remainingText(elapsed, range)}`,
    `🕒 آخرین بررسی: ${tehranClock(now)}`,
  ].join(" • ");
}
