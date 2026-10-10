import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import test from "node:test";
import type { InputEvent } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { HumanInputScope } from "../src/human-input.ts";

function fixture(t: test.TestContext) {
  const scope = new HumanInputScope();
  t.after(() => scope.close());
  const owner = {};
  let valid = true;
  const live = () => valid;
  const image: ImageContent = { type: "image", data: "synthetic", mimeType: "image/png" };
  const event: InputEvent = { type: "input", source: "extension", text: "Synthetic prompt", images: [image] };
  const send = (action: () => void, steering = false) => scope.send(event.text, "session", live, action, { images: [image], owner, steering });
  const arm = () => { assert.ok(scope.admit(event, "session", owner)); assert.ok(scope.prepare(event.text, [image], "session", owner)); scope.startRun("session"); };
  return { scope, owner, image, event, send, arm, invalidate: () => { valid = false; } };
}

test("admission and lifecycle are one-use; trusted normalization is independent of prompt text", t => {
  const h = fixture(t);
  h.send(() => {
    assert.equal(h.scope.consume([], "session", h.owner), undefined, "unadmitted starts do not own replies");
    h.arm();
    assert.equal(h.scope.admit(h.event, "session", h.owner), false);
    assert.deepEqual(h.scope.consume([{ type: "text", text: "Host normalized text" }], "session", h.owner), { steering: false, text: h.event.text });
    assert.equal(h.scope.consume([{ type: "text", text: h.event.text }], "session", h.owner), undefined, "replayed same-text starts do not own replies");
    assert.equal(h.scope.hasPending(h.owner), false);
  });
});

test("same-text generic, local, nested-owner and out-of-scope starts fail closed", t => {
  const h = fixture(t);
  let consume!: () => unknown;
  h.send(() => {
    assert.equal(h.scope.admit({ ...h.event, source: "interactive" }, "session", h.owner), false);
    assert.equal(h.scope.admit(h.event, "session", {}), false, "nested worker owner cannot borrow admission");
    assert.equal(h.scope.admit({ ...h.event, images: [{ ...h.image }] }, "session", h.owner), false, "same-text native-image spoof is not submission identity");
    h.arm();
    consume = AsyncResource.bind(() => h.scope.consume([], "session", h.owner));
    assert.equal(h.scope.consume([], "session", {}), undefined);
  });
  assert.equal(h.scope.consume([], "session", h.owner), undefined);
  assert.equal(h.scope.admit(h.event, "session", h.owner), false);
  assert.ok(consume(), "only the original run's async context can consume");
});

test("stale sessions and cancelled/generation-revoked submissions cannot consume", t => {
  const h = fixture(t);
  h.send(() => {
    h.arm();
    assert.equal(h.scope.consume([], "different-session", h.owner), undefined);
    h.invalidate();
    assert.equal(h.scope.consume([], "session", h.owner), undefined);
    assert.equal(h.scope.hasPending(h.owner), false);
  });
});

test("queued steering uses admitted exact native content in the authenticated run, never arbitrary suffixes", t => {
  const h = fixture(t);
  let run!: (content: unknown) => unknown;
  h.send(() => {
    h.arm(); h.scope.consume([], "session", h.owner);
    run = AsyncResource.bind(content => h.scope.consume(content, "session", h.owner));
  });
  for (let i = 0; i < 2; i++) h.send(() => {
    assert.ok(h.scope.admit({ ...h.event, streamingBehavior: "steer" }, "session", h.owner));
    assert.equal(h.scope.consume([{ type: "text", text: h.event.text }, h.image], "session", h.owner), undefined, "a queued input is not itself an agent run");
  }, true);
  assert.equal(run([{ type: "text", text: `${h.event.text}\n\nArbitrary suffix` }, h.image]), undefined);
  assert.equal(run([{ type: "text", text: h.event.text }, { ...h.image }]), undefined);
  for (let i = 0; i < 2; i++) assert.deepEqual(run([{ type: "text", text: h.event.text }, h.image]), { steering: true, text: h.event.text });
  assert.equal(run([{ type: "text", text: h.event.text }, h.image]), undefined);
  assert.equal(h.scope.hasPending(h.owner), false, "identical corrections each consume once");
});

test("handled/unarmed admission cannot consume and close clears pending capabilities", t => {
  const h = fixture(t);
  h.send(() => {
    assert.ok(h.scope.admit(h.event, "session", h.owner));
    h.scope.startRun("session");
    assert.equal(h.scope.consume([], "session", h.owner), undefined);
    assert.ok(h.scope.hasPending(h.owner));
    h.scope.close();
    assert.equal(h.scope.hasPending(h.owner), false);
  });
});
