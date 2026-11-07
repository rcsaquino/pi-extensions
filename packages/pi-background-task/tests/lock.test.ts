import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createRunLock } from "../src/lock.ts";

test("operations on one key run one at a time in call order", async () => {
  const lock = createRunLock();
  const order: string[] = [];
  await Promise.all([
    lock("run", async () => { order.push("a-start"); await delay(40); order.push("a-end"); }),
    lock("run", async () => { order.push("b-start"); order.push("b-end"); }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("a throwing operation releases the key", async () => {
  const lock = createRunLock();
  await assert.rejects(lock("run", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await lock("run", async () => "recovered"), "recovered");
});

test("different keys do not wait for each other", async () => {
  const lock = createRunLock();
  let release!: () => void;
  const blocked = lock("one", () => new Promise<void>(resolve => { release = resolve; }));
  const other = await lock("two", async () => "ran");
  assert.equal(other, "ran");
  release();
  await blocked;
});
