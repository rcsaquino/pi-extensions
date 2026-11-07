import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildEtaMissing, buildEtaReminder, reminderState } from "../src/notice.ts";
import { applyEta, type RunMeta } from "../src/store.ts";

const start = Date.parse("2026-11-07T12:00:00.000Z");
const base: RunMeta = {
  id: "bg-20261107-120000-abc123",
  title: "Audit run",
  parentSessionId: "parent",
  childSessionId: "bg-20261107-120000-abc123",
  pid: 1234,
  cwd: "/tmp",
  startedAt: new Date(start).toISOString(),
  status: "running",
  etaMinutes: 10,
};

test("nothing is due before the ETA", () => {
  assert.equal(reminderState(base, start + 9 * 60_000), "none");
  assert.equal(reminderState(base, start + 10 * 60_000), "remind");
});

test("settled runs and missing ETAs are never due", () => {
  assert.equal(reminderState({ ...base, status: "done" }, start + 60 * 60_000), "none");
  assert.equal(reminderState({ ...base, etaMinutes: undefined }, start + 60 * 60_000), "none");
  assert.equal(reminderState({ ...base, etaMinutes: 0 }, start + 60 * 60_000), "none");
});

test("an unanswered reminder becomes an error at the next interval", () => {
  const sentAt = start + 10 * 60_000;
  const sent: RunMeta = { ...base, reminders: 1, lastReminderAt: new Date(sentAt).toISOString(), etaPending: new Date(sentAt).toISOString() };
  assert.equal(reminderState(sent, sentAt + 9 * 60_000), "none");
  assert.equal(reminderState(sent, sentAt + 10 * 60_000), "missing");
  const legacy: RunMeta = { ...base, reminders: 1, lastReminderAt: new Date(sentAt).toISOString() };
  assert.equal(reminderState(legacy, sentAt + 10 * 60_000), "remind");
});

test("a revised ETA clears the pending flag and rebases the window", () => {
  const overrun = { ...base, reminders: 2, lastReminderAt: new Date(start + 30 * 60_000).toISOString(), etaPending: new Date(start + 30 * 60_000).toISOString() };
  const now = start + 30 * 60_000;
  const revised = applyEta(overrun, 5, new Date(now).toISOString());
  assert.equal(revised.etaMinutes, 5);
  assert.equal(revised.etaFrom, new Date(now).toISOString());
  assert.equal(revised.reminders, 0);
  assert.equal(revised.lastReminderAt, undefined);
  assert.equal(revised.etaPending, undefined);
  assert.equal(reminderState(revised, now + 4 * 60_000), "none");
  assert.equal(reminderState(revised, now + 5 * 60_000), "remind");
});

test("the reminder states the overrun in plain words", () => {
  const text = buildEtaReminder(base);
  assert.match(text, /^Task exceeded its 10m ETA\. Tell the user\./m);
  assert.match(text, /Record the new estimate with background_eta/);
  assert.match(text, /\n\n/);
  assert.doesNotMatch(text, /in your own words|Do not reuse|current estimate|Next reminder|Running:/i);
});

test("the missing-ETA message is an error with a way out", () => {
  const text = buildEtaMissing(base);
  assert.match(text, /Error: no revised estimate was recorded/);
  assert.match(text, /background_eta/);
  assert.match(text, /background_kill/);
});
