// EST-SEC-HARDEN (F21) · AG-0008 — GUARDRAIL do combo perigoso NO LOOP.
//
// FRUGAL: sem modelo real — caller ROTEIRIZADO. Provas (DoD):
//   1. COMBO detectado (yolo + tier-fraco + untrusted no contexto): emite o WARN no
//      sink UMA vez E injeta o REFORÇO (`reanchor`) UMA vez — one-shot (não a cada
//      iteração), e o reforço entra como `assistant` (canal trusted), nunca `system`/DADO;
//   2. cada perna do AND, isolada, DESLIGA o guardrail:
//        - NÃO-yolo (engine normal) ⇒ nada;
//        - tier FORTE ⇒ nada;
//        - contexto SEM untrusted (turno conversacional puro) ⇒ nada;
//   3. one-shot: mesmo com várias leituras (várias iterações com untrusted), o WARN
//      sai UMA vez e há SÓ UM reforço no histórico.
//   4. ausente (sem `weakYoloGuardrail`) ⇒ baseline (nada).
//
// NÃO regride: a catraca/budget/self-check seguem; o loop encerra normal.

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import {
  WEAK_YOLO_WARNING_MARKER,
  WEAK_YOLO_REANCHOR_MARKER,
} from '../../src/agent/weak-yolo-guardrail.js';
import { PolicyPermissionEngine } from '../../src/permission/engine.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import {
  MemoryFs,
  ScriptedModelCaller,
  allowAllEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

/** Conta, na ÚLTIMA chamada capturada, as mensagens `assistant` com o marcador do reforço. */
function countReanchor(model: ScriptedModelCaller): number {
  const last = model.calls[model.calls.length - 1];
  if (!last) return 0;
  return last.messages.filter(
    (m) => m.role === 'assistant' && m.content.includes(WEAK_YOLO_REANCHOR_MARKER),
  ).length;
}

/** `true` se o reforço NUNCA apareceu como `system` ou `user` em nenhuma chamada. */
function reanchorNeverSystemOrUser(model: ScriptedModelCaller): boolean {
  return model.calls.every((c) =>
    c.messages.every(
      (m) =>
        !(
          (m.role === 'system' || m.role === 'user') &&
          m.content.includes(WEAK_YOLO_REANCHOR_MARKER)
        ),
    ),
  );
}

/** Script que LÊ a.txt 3× e então conclui (3 leituras ⇒ 3 observações untrusted). */
function readThriceThenFinal(): ConstructorParameters<typeof ScriptedModelCaller>[0] {
  return [
    { text: toolCallBlock('read_file', { path: 'a.txt' }) },
    { text: toolCallBlock('read_file', { path: 'a.txt' }) },
    { text: toolCallBlock('read_file', { path: 'a.txt' }) },
    { text: 'pronto.' },
  ];
}

describe('F21 · guardrail do combo no loop', () => {
  it('COMBO (yolo + tier-fraco + untrusted) ⇒ WARN one-shot + UM reforço (canal assistant)', async () => {
    const fs = new MemoryFs(new Map([['a.txt', 'conteúdo qualquer']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller(readThriceThenFinal());
    const warnings: string[] = [];
    const loop = new AgentLoop({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }), // YOLO
      tools: registry(),
      ports,
      sessionId: 's',
      weakYoloGuardrail: { tier: () => 'custom', onWarn: (w) => warnings.push(w) },
    });
    const res = await loop.run('leia a.txt algumas vezes');
    expect(res.stop.kind).toBe('final');
    // WARN saiu UMA vez (one-shot por execução) e com o marcador:
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(WEAK_YOLO_WARNING_MARKER);
    // UM reforço no histórico (one-shot), no canal `assistant` (trusted):
    expect(countReanchor(model)).toBe(1);
    expect(reanchorNeverSystemOrUser(model)).toBe(true);
  });

  it('NÃO-yolo (engine normal) ⇒ NADA (perna yolo falsa)', async () => {
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller(readThriceThenFinal());
    const warnings: string[] = [];
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine, // não é PolicyPermissionEngine ⇒ não-yolo
      tools: registry(),
      ports,
      sessionId: 's',
      weakYoloGuardrail: { tier: () => 'custom', onWarn: (w) => warnings.push(w) },
    });
    await loop.run('leia a.txt');
    expect(warnings).toHaveLength(0);
    expect(countReanchor(model)).toBe(0);
  });

  it('tier FORTE ⇒ NADA (perna tier falsa)', async () => {
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller(readThriceThenFinal());
    const warnings: string[] = [];
    const loop = new AgentLoop({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      tools: registry(),
      ports,
      sessionId: 's',
      weakYoloGuardrail: { tier: () => 'granito', onWarn: (w) => warnings.push(w) },
    });
    await loop.run('leia a.txt');
    expect(warnings).toHaveLength(0);
    expect(countReanchor(model)).toBe(0);
  });

  it('SEM untrusted no contexto (conversa pura) ⇒ NADA (perna untrusted falsa)', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'olá! tudo bem?' }]);
    const warnings: string[] = [];
    const loop = new AgentLoop({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      tools: registry(),
      ports,
      sessionId: 's',
      weakYoloGuardrail: { tier: () => 'custom', onWarn: (w) => warnings.push(w) },
    });
    await loop.run('oi');
    expect(warnings).toHaveLength(0);
    expect(countReanchor(model)).toBe(0);
  });

  it('AUSENTE (sem weakYoloGuardrail) ⇒ baseline — nada (mesmo em yolo+custom+untrusted)', async () => {
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller(readThriceThenFinal());
    const loop = new AgentLoop({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      tools: registry(),
      ports,
      sessionId: 's',
    });
    const res = await loop.run('leia a.txt');
    expect(res.stop.kind).toBe('final');
    // sem o config, NENHUM reforço entra no histórico:
    expect(countReanchor(model)).toBe(0);
  });

  it('ONE-SHOT: várias leituras (várias iterações untrusted) ⇒ ainda 1 WARN e 1 reforço', async () => {
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });
    // 5 leituras seguidas + final ⇒ 5 iterações com untrusted no contexto.
    const script: ConstructorParameters<typeof ScriptedModelCaller>[0] = [
      { text: toolCallBlock('read_file', { path: 'a.txt' }) },
      { text: toolCallBlock('read_file', { path: 'a.txt' }) },
      { text: toolCallBlock('read_file', { path: 'a.txt' }) },
      { text: toolCallBlock('read_file', { path: 'a.txt' }) },
      { text: toolCallBlock('read_file', { path: 'a.txt' }) },
      { text: 'pronto.' },
    ];
    const model = new ScriptedModelCaller(script);
    const warnings: string[] = [];
    const loop = new AgentLoop({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      tools: registry(),
      ports,
      sessionId: 's',
      weakYoloGuardrail: { tier: () => 'custom', onWarn: (w) => warnings.push(w) },
    });
    await loop.run('leia a.txt várias vezes');
    expect(warnings).toHaveLength(1);
    expect(countReanchor(model)).toBe(1);
  });
});
