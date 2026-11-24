import assert from "node:assert/strict";
import test from "node:test";
import {
  claimTelegramUpdate,
  resetTelegramUpdateClaimsForTest,
} from "../lib/update-dedupe.ts";

test("accepts a Telegram update once and rejects its retry", async () => {
  resetTelegramUpdateClaimsForTest();
  const first = await claimTelegramUpdate(
    12345,
    "https://bot.example/api/telegram/secret",
    1_000,
  );
  const retry = await claimTelegramUpdate(
    12345,
    "https://bot.example/api/telegram/secret",
    2_000,
  );
  assert.equal(first, true);
  assert.equal(retry, false);
});
