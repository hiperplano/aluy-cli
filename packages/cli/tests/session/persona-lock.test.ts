// ADR-0158 §4.1 (FUNIL — fecha o DEGRADE #3 da rc.113) — `SessionController.
// lockPersonaForTurn`: o mecanismo que faz o TURNO PRINCIPAL nascer JÁ TRAVADO numa
// persona (usado pelo BOOT headless de uma atividade `[agente]` de serviço, via
// `run.tsx`). MESMA mecânica do `/subagent` (`childEngineOf` ⊆ pai + persona no
// canal `system`), mas aplicada ANTES do primeiro `submit()` — aqui provamos:
//   1. a tool FORA do `tools:` da persona é RECUSADA na catraca (nunca executa);
//   2. o corpo da persona chega ao canal `system`, e o preâmbulo/AGENT.md do
//      orquestrador (`projectInstructions` do loop principal) NÃO aparece — a
//      atividade É da persona, o orquestrador não participa deste turno;
//   3. a tool DENTRO do escopo segue funcionando normalmente (não é fail-closed
//      contra tudo — só contra o que a persona não declarou).
// A prova de que `childEngineOf` nega corretamente ⊆pai já mora em
// `permission/agent-toolscope.test.ts` (cli-core) — aqui a prova é de WIRING: que
// `lockPersonaForTurn` liga a persona resolvida a essa mecânica ANTES do turno.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

function fakePorts(): { ports: ToolPorts; writeFileCalls: { path: string; content: string }[] } {
  const writeFileCalls: { path: string; content: string }[] = [];
  const fs: FileSystemPort = {
    async readFile() {
      return 'conteúdo lido.';
    },
    async writeFile(path, content) {
      writeFileCalls.push({ path, content });
    },
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
  return { ports: { fs, shell, search }, writeFileCalls };
}

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};
const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

/** Modelo ROTEIRIZADO: 1ª chamada tenta uma tool-call NATIVA; 2ª devolve texto final. ECOA
 * o system-prompt + o conteúdo de CADA mensagem `tool` (resultado da tool-call) recebidas. */
function scriptedModel(
  seen: { system: string[]; toolResults: string[] },
  toolCall: { id: string; name: string; input: Record<string, unknown> },
): ModelCaller {
  let call = 0;
  return {
    async call(req): Promise<ModelCallResult> {
      const sys = req.messages.find((m) => m.role === 'system');
      if (sys) seen.system.push(sys.content);
      for (const m of req.messages) {
        if (m.role === 'tool') seen.toolResults.push(m.content);
      }
      call += 1;
      if (call === 1) {
        return {
          request_id: `r${call}`,
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [toolCall],
        };
      }
      return { request_id: `r${call}`, content: 'terminei a atividade.', finish_reason: 'stop' };
    },
  };
}

function makeController(opts: {
  seen: { system: string[]; toolResults: string[] };
  toolCall: { id: string; name: string; input: Record<string, unknown> };
  ports: ToolPorts;
  projectInstructions?: string;
}): SessionController {
  return new SessionController({
    model: scriptedModel(opts.seen, opts.toolCall),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: opts.ports,
    askResolver: approveAll,
    meta,
    ...(opts.projectInstructions !== undefined ? { projectInstructions: opts.projectInstructions } : {}),
  });
}

describe('ADR-0158 §4.1 — controller.lockPersonaForTurn (funil, fecha o DEGRADE #3)', () => {
  it('tool FORA do tools: da persona ⇒ RECUSADA na catraca — o efeito NUNCA ocorre', async () => {
    const seen = { system: [] as string[], toolResults: [] as string[] };
    const { ports, writeFileCalls } = fakePorts();
    const c = makeController({
      seen,
      toolCall: { id: 'c1', name: 'write_file', input: { path: 'ordem.txt', content: 'EXECUTE AGORA' } },
      ports,
      projectInstructions: 'CORPO-DO-ORQUESTRADOR-SERVICE-MD — rege, não opera.',
    });
    // Persona "estudo": SÓ read_file no tools: — write_file (a "ferramenta de
    // executar") não está no mundo dela (ADR-0158 §4.1, exemplo do funil).
    c.lockPersonaForTurn({
      name: 'estudo-momentum',
      systemPrompt: 'Você é o ESTUDO-MOMENTUM. PERSONA_ESTUDO_XYZ. Você NUNCA executa ordens.',
      toolScope: new Set(['read_file']),
    });

    await c.submit('analise o mercado e, se convencido, execute a ordem');

    // O EFEITO REAL nunca aconteceu — a tool foi negada ANTES de qualquer I/O.
    expect(writeFileCalls).toHaveLength(0);
    // O modelo FOI informado da recusa (não silêncio, não erro técnico opaco).
    expect(seen.toolResults.some((t) => /negad|deny|GS-MD1|fora do toolset/i.test(t))).toBe(true);
  });

  it('persona no canal system + o preâmbulo do orquestrador NÃO aparece (a atividade é da persona)', async () => {
    const seen = { system: [] as string[], toolResults: [] as string[] };
    const { ports } = fakePorts();
    const c = makeController({
      seen,
      toolCall: { id: 'c1', name: 'read_file', input: { path: 'a.txt' } },
      ports,
      // Simula o AGENT.md/preâmbulo do orquestrador que `run.tsx` passaria por
      // `opts.projectInstructions` no loop PRINCIPAL — deve ser SUBSTITUÍDO.
      projectInstructions: 'CORPO-DO-ORQUESTRADOR-SERVICE-MD — rege, não opera.',
    });
    c.lockPersonaForTurn({
      name: 'estudo-momentum',
      systemPrompt: 'PERSONA_ESTUDO_XYZ — corpo do agents/estudo-momentum.md.',
      toolScope: new Set(['read_file']),
    });

    await c.submit('analise o mercado');

    expect(seen.system.some((s) => s.includes('PERSONA_ESTUDO_XYZ'))).toBe(true);
    expect(seen.system.some((s) => s.includes('CORPO-DO-ORQUESTRADOR-SERVICE-MD'))).toBe(false);
  });

  it('tool DENTRO do escopo segue funcionando (não é fail-closed contra tudo)', async () => {
    const seen = { system: [] as string[], toolResults: [] as string[] };
    const { ports } = fakePorts();
    const c = makeController({
      seen,
      toolCall: { id: 'c1', name: 'read_file', input: { path: 'mercado.csv' } },
      ports,
    });
    c.lockPersonaForTurn({
      name: 'estudo-momentum',
      systemPrompt: 'PERSONA_ESTUDO_XYZ.',
      toolScope: new Set(['read_file']),
    });

    await c.submit('leia os dados do mercado');

    // read_file ∈ tools: da persona ⇒ NÃO foi bloqueada (resultado real, não "negada").
    expect(seen.toolResults.some((t) => /negad|GS-MD1|fora do toolset/i.test(t))).toBe(false);
    expect(seen.toolResults.some((t) => t.includes('conteúdo lido'))).toBe(true);
  });

  it('persona SEM toolScope declarado (tools: ausente no .md) ⇒ herda o toolset completo (GS-MD1: ausência ≠ restrição)', async () => {
    const seen = { system: [] as string[], toolResults: [] as string[] };
    const { ports, writeFileCalls } = fakePorts();
    const c = makeController({
      seen,
      toolCall: { id: 'c1', name: 'write_file', input: { path: 'a.txt', content: 'x', overwrite: true } },
      ports,
    });
    c.lockPersonaForTurn({ name: 'risco', systemPrompt: 'PERSONA_RISCO_XYZ.' }); // sem toolScope.

    await c.submit('grave o resultado');

    expect(writeFileCalls).toHaveLength(1); // permitido — sem tools: no .md, herda o toolset do pai.
  });
});
