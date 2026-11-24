import assert from "node:assert/strict";
import test from "node:test";
import {
  directionalText,
  isolateLtr,
  LRM,
  LRI,
  PDI,
  RLM,
  rtlBlock,
} from "../lib/bidi.ts";

test("adds a right-to-left mark to Persian text", () => {
  assert.equal(directionalText("گزینه دوم"), `${RLM}گزینه دوم`);
});

test("adds a left-to-right mark to English text", () => {
  assert.equal(directionalText("Option B"), `${LRM}Option B`);
});

test("isolates progress counters from surrounding Persian", () => {
  assert.equal(isolateLtr("2/15"), `${LRI}2/15${PDI}`);
});

test("marks every Persian status line as right-to-left", () => {
  assert.equal(rtlBlock("خط اول\n\nخط دوم"), `${RLM}خط اول\n\n${RLM}خط دوم`);
});
