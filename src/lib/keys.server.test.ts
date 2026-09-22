import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { imageKeyStartIndex, releaseAllImageKeys, withImageKey } from "./keys.server";

const names = Array.from({ length: 9 }, (_, index) => `AGNES_API_KEY_${index + 1}`);

afterEach(() => {
  releaseAllImageKeys();
  for (const name of names) delete process.env[name];
});

describe("Agnes key scheduling", () => {
  test("wraps the tenth and later jobs across the same nine keys", () => {
    const selected = Array.from({ length: 27 }, (_, slot) => imageKeyStartIndex(slot, 0, 9));
    assert.deepEqual(selected.slice(0, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(selected.slice(9, 18), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(selected.slice(18), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("spreads the first nine slots across all nine keys", async () => {
    names.forEach((name, index) => {
      process.env[name] = `test-key-${index + 1}`;
    });

    const selected = await Promise.all(
      names.map((_, slot) => withImageKey(slot, 0, async (_key, keyIndex) => keyIndex)),
    );

    assert.equal(new Set(selected).size, 9);
    assert.deepEqual(selected.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});