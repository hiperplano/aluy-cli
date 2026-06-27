// EST-0957 · CA-3/CA-5 · CLI-SEC-4 — o loop SEMEIA os anexos `@arquivo` ANTES do
// objetivo, como DADO rotulado/envelopado (observation), NUNCA como instrução.

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import {
  attachmentObservation,
  buildMessages,
  ATTACHMENT_TOOL_NAME,
  type HistoryItem,
} from '../../src/agent/context.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import { ScriptedModelCaller, allowAllEngine, makePorts } from './helpers.js';

function loopWith(model: ScriptedModelCaller): AgentLoop {
  return new AgentLoop({
    model,
    permission: allowAllEngine,
    tools: new ToolRegistry(NATIVE_TOOLS),
    ports: makePorts().ports,
    sessionId: 'sess-test',
  });
}

describe('attachmentObservation — rótulo + canal', () => {
  it('produz uma observation rotulada [arquivo: path]', () => {
    const item = attachmentObservation('src/a.ts', 'CONTENT');
    expect(item.role).toBe('observation');
    expect(item.toolName).toBe(ATTACHMENT_TOOL_NAME);
    expect(item.text).toBe('[arquivo: src/a.ts]\nCONTENT');
  });
});

describe('AgentLoop.run — anexos como DADO antes do objetivo', () => {
  it('CA-3 — o conteúdo anexado vira `user` ENVELOPADO, nunca `system`', () => {
    const item = attachmentObservation('src/auth/session.ts', 'export const X = 1;');
    const messages = buildMessages([], [item, { role: 'goal', text: 'explique' }]);
    const system = messages.find((m) => m.role === 'system');
    // o conteúdo do arquivo NÃO está no canal de instrução (system).
    expect(system?.content).not.toContain('export const X');
    // ele entrou ENVELOPADO num user (CLI-SEC-4).
    const envelope = messages.find(
      (m) => m.role === 'user' && m.content.includes('DADO_NAO_CONFIAVEL'),
    );
    expect(envelope).toBeDefined();
    expect(envelope!.content).toContain('[arquivo: src/auth/session.ts]');
    expect(envelope!.content).toContain('export const X = 1;');
  });

  it('CA-3 — o anexo é semeado ANTES do objetivo no histórico', async () => {
    const model = new ScriptedModelCaller([{ text: 'ok' }]);
    const attachments: HistoryItem[] = [attachmentObservation('a.ts', 'AAA')];
    const res = await loopWith(model).run('meu objetivo', undefined, attachments);
    const roles = res.history.map((h) => h.role);
    // ordem: observation(anexo) → goal → model
    expect(roles[0]).toBe('observation');
    expect(roles[1]).toBe('goal');
    expect(res.history[0]).toMatchObject({ toolName: ATTACHMENT_TOOL_NAME });
    expect((res.history[1] as { text: string }).text).toBe('meu objetivo');
  });

  it('CA-5 — multi-anexo: dois arquivos entram como dados DISTINTOS', async () => {
    const model = new ScriptedModelCaller([{ text: 'ok' }]);
    const attachments: HistoryItem[] = [
      attachmentObservation('a/x.ts', 'XXX'),
      attachmentObservation('b/y.ts', 'YYY'),
    ];
    const res = await loopWith(model).run('compare', undefined, attachments);
    const obs = res.history.filter((h) => h.role === 'observation');
    expect(obs.length).toBe(2);
    expect((obs[0] as { text: string }).text).toContain('[arquivo: a/x.ts]');
    expect((obs[1] as { text: string }).text).toContain('[arquivo: b/y.ts]');
  });

  it('sem anexos: comportamento inalterado (compatível)', async () => {
    const model = new ScriptedModelCaller([{ text: 'ok' }]);
    const res = await loopWith(model).run('só objetivo');
    expect(res.history[0]).toMatchObject({ role: 'goal', text: 'só objetivo' });
  });
});
