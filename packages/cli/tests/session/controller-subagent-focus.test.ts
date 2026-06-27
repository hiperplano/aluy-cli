// ADR-0126(A·PR2) — `/subagent <nome>`: sub-sessão FOCADA 1:1 contínua. Testa a máquina de
// estado (entra/sai/indicador), a resolução por nome, a guarda de já-em-foco, e o ISOLAMENTO
// (o histórico do foco não polui o principal). A segurança do escopo ⊆ pai é do childEngineOf
// (F118/F119) — aqui só provamos que o foco é montado e roteia.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  AgentRegistry,
  type AgentProfile,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};
const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

/** Modelo que ECOA o system-prompt recebido (p/ provar que a persona do .md chegou ao loop). */
function echoModel(seen: { system: string[] }): ModelCaller {
  return {
    async call(req): Promise<ModelCallResult> {
      const sys = req.messages.find((m) => m.role === 'system');
      if (sys) seen.system.push(sys.content);
      return { request_id: 'r', content: 'ok do sub-agente.', finish_reason: 'stop' };
    },
  };
}

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: 'revisor',
    description: 'revisa diffs',
    systemPrompt: 'Você é o REVISOR. Persona única e inconfundível: PERSONA_REVISOR_XYZ.',
    origin: 'global',
    ...over,
  };
}

function makeController(
  seen: { system: string[] },
  profiles: AgentProfile[],
  limits?: { maxIterations: number; maxToolCalls: number; maxTokens: number },
): SessionController {
  return new SessionController({
    model: echoModel(seen),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
    agentRegistry: new AgentRegistry(profiles, []),
    ...(limits !== undefined ? { limits } : {}),
  });
}

function notesText(c: SessionController): string {
  return JSON.stringify(c.current.blocks.filter((b) => b.kind === 'note'));
}

describe('ADR-0126(A·PR2) — /subagent foco 1:1', () => {
  it('enterSubagentFocus(<nome conhecido>) ⇒ foco ativo + indicador meta.focus + nota', () => {
    const seen = { system: [] as string[] };
    const c = makeController(seen, [profile()]);
    c.enterSubagentFocus('revisor');
    expect(c.focusLabel).toBe('revisor');
    expect(c.current.meta.focus).toBe('revisor');
    expect(notesText(c)).toContain('você agora fala SÓ com o sub-agente');
  });

  it('nome DESCONHECIDO ⇒ nota "não encontrado", SEM foco', () => {
    const seen = { system: [] as string[] };
    const c = makeController(seen, [profile()]);
    c.enterSubagentFocus('fantasma');
    expect(c.focusLabel).toBeUndefined();
    expect(notesText(c)).toContain('não encontrado');
  });

  it('JÁ em foco ⇒ recusa trocar sem /back (nota)', () => {
    const seen = { system: [] as string[] };
    const c = makeController(seen, [profile(), profile({ name: 'outro' })]);
    c.enterSubagentFocus('revisor');
    c.enterSubagentFocus('outro');
    expect(c.focusLabel).toBe('revisor'); // não trocou
    expect(notesText(c)).toContain('Use `/back` antes de trocar');
  });

  it('exitFocus ⇒ limpa o foco + indicador, volta ao principal', () => {
    const seen = { system: [] as string[] };
    const c = makeController(seen, [profile()]);
    c.enterSubagentFocus('revisor');
    c.exitFocus();
    expect(c.focusLabel).toBeUndefined();
    expect(c.current.meta.focus).toBeUndefined();
    expect(notesText(c)).toContain('de volta ao agente principal');
  });

  it('exitFocus sem foco ⇒ nota "você já está no principal" (idempotente)', () => {
    const seen = { system: [] as string[] };
    const c = makeController(seen, [profile()]);
    c.exitFocus();
    expect(notesText(c)).toContain('você já está no principal');
  });

  it('EM FOCO, submit roteia p/ o loop FOCADO: a PERSONA do .md chega ao system-prompt', async () => {
    const seen = { system: [] as string[] };
    const c = makeController(seen, [profile()]);
    c.enterSubagentFocus('revisor');
    await c.submit('revise isto');
    // o modelo do loop focado viu a persona do .md no canal system (não o prompt do principal).
    expect(seen.system.some((s) => s.includes('PERSONA_REVISOR_XYZ'))).toBe(true);
    expect(c.focusLabel).toBe('revisor'); // segue em foco (contínuo)
  });

  // REGRESSÃO (self-review do PR2) — o `[c] continuar` pós-budget-limit retomava no loop
  // PRINCIPAL, não no foco: um turno do /subagent que estoura o teto e o usuário dá `[c]`
  // voltaria ao agente principal com o histórico do foco (persona/escopo perdidos). Fix:
  // continueAfterBudget retoma no loop ATIVO (foco vence). Aqui provamos que a PERSONA do
  // foco aparece NO RESUME (⇒ retomou na sub-sessão), não o prompt do principal.
  it('[c] continuar EM FOCO retoma na SUB-SESSÃO (persona do foco), não no principal', async () => {
    const seen = { system: [] as string[] };
    // maxIterations:0 ⇒ o turno estoura no gate ANTES de chamar o modelo (folga de tokens).
    const c = makeController(seen, [profile()], {
      maxIterations: 0,
      maxToolCalls: 50,
      maxTokens: 1_000_000,
    });
    c.enterSubagentFocus('revisor');
    await c.submit('revise isto'); // estoura ⇒ phase=budget
    expect(c.current.phase).toBe('budget');
    seen.system.length = 0; // isola o RESUME (limpa o que o submit viu)
    await c.continueAfterBudget(); // estende +retoma — DEVE ser no loop do FOCO
    expect(seen.system.some((s) => s.includes('PERSONA_REVISOR_XYZ'))).toBe(true);
    expect(c.focusLabel).toBe('revisor'); // segue em foco
  });
});
