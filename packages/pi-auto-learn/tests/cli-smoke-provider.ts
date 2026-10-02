// Isolated, zero-network provider used ONLY by the workspace CLI smoke test.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
export default function smokeProvider(pi: ExtensionAPI) {
  pi.registerProvider('auto-learn-smoke', {
    apiKey: 'fake-local-smoke-credential', api: 'auto-learn-smoke-api', baseUrl: 'http://127.0.0.1',
    models: [{ id: 'main', name: 'Zero-network smoke model', reasoning: true, input: ['text'], contextWindow: 200_000, maxTokens: 65_536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const learning = options?.sessionId?.startsWith('auto-learn-');
      let text = 'Completed the reusable workflow and verified its result.';
      if (learning) {
        const last = context.messages.filter(m => m.role === 'user').at(-1)!;
        const raw = last.role === 'user' ? (typeof last.content === 'string' ? last.content : last.content.filter(c => c.type === 'text').map(c => c.text).join('')) : '';
        const input = JSON.parse(raw);
        text = getCurrentSystemPrompt(context.messages).includes('fresh review inference') ? JSON.stringify({ protocolVersion: 1, verdict: 'approve', reason: 'Explicit request and validated scoped workflow.' }) : JSON.stringify({ protocolVersion: 1, decision: 'change', evidenceIds: input.evidence.map((e: { id: string }) => e.id), changes: [{ operation: 'create', skillId: 'release-checklist', baseHash: null, workflow: 'release checklist procedure', reason: 'Explicit reusable workflow intent', files: [{ path: 'SKILL.md', content: '---\nname: release-checklist\ndescription: Verify a repeatable release checklist.\n---\n\nCheck prerequisites. Verify the result.\n' }] }] });
      }
      queueMicrotask(() => {
        const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text }], provider: model.provider, api: model.api, model: model.id, timestamp: Date.now(), stopReason: 'pending', usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message }); message.stopReason = 'stop'; stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      });
      return stream;
    },
  });
}
