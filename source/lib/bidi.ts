const RTL_PATTERN = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/;

export const RLM = "\u200f";
export const LRM = "\u200e";
export const LRI = "\u2066";
export const PDI = "\u2069";

export function hasRtl(value: string): boolean {
  return RTL_PATTERN.test(value);
}

export function directionalText(value: string): string {
  const text = value.trim();
  return `${hasRtl(text) ? RLM : LRM}${text}`;
}

export function rtlText(value: string): string {
  return `${RLM}${value.trim()}`;
}

export function rtlBlock(value: string): string {
  return value
    .trim()
    .split("\n")
    .map((line) => (line ? `${RLM}${line}` : ""))
    .join("\n");
}

export function isolateLtr(value: string | number): string {
  return `${LRI}${String(value)}${PDI}`;
}
