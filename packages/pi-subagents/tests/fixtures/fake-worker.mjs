#!/usr/bin/env node
// Deterministic RPC worker used by the offline supervisor tests. It ignores the
// pi arguments and follows PI_FAKE_SCENARIO (a JSON file path).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scenario = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(process.env.PI_FAKE_SCENARIO, 'utf8')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (name, data) => {
  if (!scenario.recordDir) return;
  mkdirSync(scenario.recordDir, { recursive: true });
  writeFileSync(join(scenario.recordDir, name), typeof data === 'string' ? data : `${JSON.stringify(data)}\n`);
};
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);

let generation = 0;
let running = false;
let buffer = Buffer.alloc(0);

function response(command, id, success = true, data = {}) {
  send({ type: 'response', command, id, success, data });
}

function assistant(text) {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() };
}

async function runTurn() {
  generation += 1;
  running = true;
  record(`started-${generation}.json`, { at: Date.now() });
  send({ type: 'agent_start' });
  const turns = scenario.turns ?? 1;
  for (let turn = 0; turn < turns; turn += 1) {
    await sleep(scenario.stepDelayMs ?? 20);
    const text = scenario.texts?.[turn] ?? scenario.text ?? `report-${generation}-${turn}`;
    send({ type: 'message_end', message: assistant(text) });
    send({ type: 'turn_end', message: assistant(text), toolResults: [] });
  }
  for (const method of scenario.dialogMethods ?? []) {
    const id = `dialog-${generation}-${method}`;
    send({ type: 'extension_ui_request', id, method, title: `test ${method}` });
    await waitForResponse(id);
  }
  if (scenario.stderrBytes) {
    process.stderr.write(Buffer.alloc(scenario.stderrBytes, 0x78));
  }
  if (scenario.crashAfterTurns) process.exit(1);
  await sleep(scenario.settleDelayMs ?? 50);
  if (scenario.hang) return;
  running = false;
  send({ type: 'agent_settled', aborted: false });
  record(`settled-${generation}.json`, { at: Date.now() });
}

const waiting = new Map();
function waitForResponse(id) {
  return new Promise(resolve => waiting.set(id, resolve));
}

process.stdin.on('data', async chunk => {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  let index;
  while ((index = buffer.indexOf(10)) !== -1) {
    const line = buffer.subarray(0, index).toString('utf8');
    buffer = buffer.subarray(index + 1);
    if (!line.trim()) continue;
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    if (command.type === 'extension_ui_response') {
      record('dialog-response.json', command);
      const resolve = waiting.get(command.id);
      if (resolve) { waiting.delete(command.id); resolve(); }
      continue;
    }
    if (command.type === 'set_steering_mode' || command.type === 'set_follow_up_mode') {
      response(command.type, command.id); continue;
    }
    if (command.type === 'abort') {
      response('abort', command.id);
      if (scenario.ignoreAbort) continue;
      setTimeout(() => {
        if (running) send({ type: 'agent_settled', aborted: true });
        running = false;
      }, 10);
      continue;
    }
    if (command.type === 'steer') {
      record('steers.txt', `${command.message}\n`);
      const reply = scenario.steerReply ?? 'queued';
      if (reply === 'reject') response('steer', command.id, false);
      else response('steer', command.id, true, { disposition: reply });
      continue;
    }
    if (command.type === 'prompt') {
      record('prompts.txt', `${command.message}\n`);
      const reply = scenario.promptReply ?? 'started';
      if (reply === 'reject') { response('prompt', command.id, false); continue; }
      response('prompt', command.id, true, { disposition: reply });
      if (reply === 'handled') continue;
      if (scenario.exitOnPrompt) { process.exit(1); }
      if (scenario.badJson) { process.stdout.write('not json\n'); continue; }
      if (scenario.floodBytes) {
        const chunk = Buffer.alloc(1024 * 1024, 0x78);
        let left = scenario.floodBytes;
        while (left > 0) {
          const part = chunk.subarray(0, Math.min(left, chunk.length));
          if (!process.stdout.write(part)) await new Promise(resolve => process.stdout.once('drain', resolve));
          left -= part.length;
        }
        await sleep(60000);
        return;
      }
      void runTurn();
      continue;
    }
    response(command.type, command.id);
  }
});

process.stdin.on('end', () => process.exit(0));

// Keep a stuck worker alive until it is killed by the supervisor.
if (scenario.ignoreAbort) setInterval(() => {}, 1000);
