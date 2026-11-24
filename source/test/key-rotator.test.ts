import assert from "node:assert/strict";
import test from "node:test";
import {
  isKeyRotationError,
  ProviderKeyRotator,
  splitProviderKeys,
} from "../lib/key-rotator.ts";

test("deduplicates provider keys from primary, backup and encrypted lists", () => {
  assert.deepEqual(
    splitProviderKeys("key-one\nkey-two", "key-two,key-three", undefined),
    ["key-one", "key-two", "key-three"],
  );
});

test("rotates immediately after a 429 quota error", async () => {
  const attempted: string[] = [];
  const result = await new ProviderKeyRotator(["limited", "working"]).run(
    async (key) => {
      attempted.push(key);
      if (key === "limited") throw new Error("Provider: 429 [C-QUOTA]");
      return "ok";
    },
  );
  assert.equal(result, "ok");
  assert.deepEqual(attempted, ["limited", "working"]);
});

test("does not waste another key on an output/model error", async () => {
  const attempted: string[] = [];
  await assert.rejects(
    new ProviderKeyRotator(["first", "second"]).run(async (key) => {
      attempted.push(key);
      throw new Error("Provider returned invalid JSON [C-OUTPUT]");
    }),
    /\[C-OUTPUT\]/,
  );
  assert.deepEqual(attempted, ["first"]);
  assert.equal(isKeyRotationError(new Error("401 [C-AUTH]")), true);
});
