import assert from "node:assert/strict";
import test from "node:test";
import { pageText } from "../lib/pdf-text.ts";

function item(str: string, x: number, width: number, hasEOL = false) {
  return { str, width, height: 10, transform: [10, 0, 0, 10, x, 700], hasEOL };
}

test("rejoins Persian glyph fragments but preserves real visual word gaps", () => {
  const text = pageText([
    item("پ", 183.38, 3.159),
    item("ی", 179.055, 4.324),
    item("شگ", 165.13, 14.068),
    item("ی", 160.94, 4.324),
    item("ر", 155.66, 5.279),
    item("ی", 146.54, 9.084),
    item("از", 130, 8, true),
  ]);
  assert.equal(text, "پیشگیری از");
});

test("keeps an LTR digit correctly spaced inside an RTL Persian line", () => {
  assert.equal(
    pageText([
      item("ماده", 522.58, 17.6),
      item("4", 511.9, 6.58),
      item("قانون", 406.26, 101.2, true),
    ]),
    "ماده 4 قانون",
  );
});
