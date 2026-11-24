import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateProcessingRangeMinutes,
  friendlyRemainingText,
} from "../lib/progress.ts";

test("uses a realistic range for a large employment-exam PDF", () => {
  assert.deepEqual(
    estimateProcessingRangeMinutes(5 * 1024 * 1024, 554, "file"),
    { minimum: 3, maximum: 8 },
  );
});

test("counts the range down and stops pretending one minute remains forever", () => {
  const startedAt = 1_000_000;
  const current = friendlyRemainingText(
    startedAt,
    5 * 1024 * 1024,
    554,
    startedAt + 61_000,
    "file",
  );
  assert.match(current, /۱ دقیقه گذشته/);
  assert.match(current, /حدود ۲ تا ۷ دقیقه/);

  const overdue = friendlyRemainingText(
    startedAt,
    5 * 1024 * 1024,
    554,
    startedAt + 20 * 60_000,
    "file",
  );
  assert.match(overdue, /از برآورد اولیه گذشته/);
  assert.doesNotMatch(overdue, /۱ دقیقه دیگه/);
});

test("shows elapsed time, a remaining range, and the last check clock", () => {
  const text = friendlyRemainingText(0, 1024, 20, 0, "interaction");
  assert.match(text, /کمتر از یک دقیقه گذشته/);
  assert.match(text, /حدود ۱ تا ۵ دقیقه/);
  assert.match(text, /آخرین بررسی:/);
});
