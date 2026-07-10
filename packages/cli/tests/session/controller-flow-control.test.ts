// EST-0982 · ADR-0063 — CONTROLE/OBSERVABILIDADE no @hiperplano/aluy-cli: o SessionController
// liga a FlowTree/ControlAudit/injeção ao loop + sub-agentes. A bateria do gate MÉDIO
// (GS-C1..C5 + RES-C-1/2/3) na INTEGRAÇÃO real (pai + filhos paralelos, catraca, abort).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  REDACTED,
  INJECTED_INPUT_LABEL,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import type { SubAgentsBlock } from '../../src/session/model.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(): { ports: ToolPorts; ran: string[] } {
  const ran: string[] = [];
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
    async exec(c) {
      ran.push(c);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { ports: { fs, shell, search }, ran };
}

/** Roteia por sessionId (extraído da idempotency-key `sess:iter`). */
function routingModel(script: (sessionId: string, turn: number) => string): {
  model: ModelCaller;
  sessions: Set<string>;
} {
  const counts = new Map<string, number>();
  const sessions = new Set<string>();
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const lastColon = key.lastIndexOf(':');
      const sessionId = lastColon > 0 ? key.slice(0, lastColon) : key;
      sessions.add(sessionId);
      const turn = counts.get(sessionId) ?? 0;
      counts.set(sessionId, turn + 1);
      return {
        request_id: 'r',
        content: script(sessionId, turn),
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 40, tokens_out: 60 },
      };
    },
  };
  return { model, sessions };
}

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

/** Encontra o bloco `subagents` no estado (último com filhos). */
function subAgentsBlock(controller: SessionController): SubAgentsBlock | undefined {
  const blocks = controller.current.blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === 'subagents') return b;
  }
  return undefined;
}

describe('EST-0982 · CONTABILIDADE (tokens + tempo) — agente principal + por sub-agente', () => {
  it('o rodapé do turno (raiz) reporta tokens E tempo; o tempo vem do relógio injetado', async () => {
    const { ports } = fakePorts();
    // O pai roda 1 tool e conclui (2 turnos do modelo ⇒ 200 tokens).
    let parent: string | null = null;
    const { model } = routingModel((s, turn) => {
      if (parent === null) parent = s;
      return turn === 0 ? toolCall('read_file', { path: 'a' }) : 'pronto.';
    });
    // Relógio que avança 500ms a cada leitura — duração determinística do turno.
    let t = 10_000;
    const clock = () => {
      t += 500;
      return t;
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      clock,
    });

    await controller.submit('leia o arquivo e responda');

    const acc = controller.turnAccounting();
    expect(acc).toBeDefined();
    // 2 turnos × (40+60) = 200 tokens do PAI.
    expect(acc!.tokens).toBe(200);
    expect(acc!.toolCalls).toBe(1);
    // Tempo > 0 (mediu pelo menos a duração do trabalho) e o turno terminou (não-live).
    expect(acc!.durationMs).toBeGreaterThan(0);
    expect(acc!.live).toBe(false);
    // E o estado expõe o mesmo rodapé p/ a TUI.
    expect(controller.current.turnAccounting?.tokens).toBe(200);
  });

  it('o resumo de cada SUB-AGENTE inclui o TEMPO (estilo Claude Code: tokens·tools·Xs)', async () => {
    const { ports } = fakePorts();
    let parent: string | null = null;
    const { model } = routingModel((s, turn) => {
      if (parent === null) parent = s;
      if (s === parent) {
        return turn === 0
          ? toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [{ label: 'rust', goal: 'g1' }],
            })
          : 'comparado.';
      }
      // o filho roda 1 leitura e conclui (gera tools>0).
      return turn === 0 ? toolCall('read_file', { path: 'x' }) : 'relatório rust.';
    });
    let t = 5_000;
    const clock = () => {
      t += 700;
      return t;
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      subAgents: { enabled: true, maxConcurrency: 1 },
      clock,
    });

    await controller.submit('delegue ao rust');

    const block = subAgentsBlock(controller)!;
    const rust = block.children.find((c) => c.label === 'rust')!;
    expect(rust.status).toBe('done');
    expect(rust.summary).toMatch(/tokens/);
    expect(rust.summary).toMatch(/tools/);
    // O TEMPO entra no resumo: termina com `s` (segundos) ou `m..s` (estilo Claude Code).
    expect(rust.summary).toMatch(/\d+(\.\d+)?s$|\dm(\d+s)?$/);
    // O nó da árvore foi registrado (drill-in disponível).
    expect(rust.nodeId).toBe('root/rust');
  });
});

describe('EST-0982 · RES-C-1 / GS-C3 — VER (drill-in) NÃO vaza o que o confinamento esconde', () => {
  it('o drill-in da RAIZ redige o segredo da linha de comando (CLI-SEC-6) — sem stream cru', async () => {
    const { ports } = fakePorts();
    // O pai roda um run_command com um Bearer token na linha; depois conclui.
    const secretCmd =
      'curl -H "Authorization: Bearer sk-secret-abcdef1234567890" https://api.x/deploy';
    const { model } = routingModel((_s, turn) =>
      turn === 0 ? toolCall('run_command', { command: secretCmd }) : 'feito.',
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });

    // Observa o drill-in da raiz DURANTE o turno: o controller publica o estado; aqui
    // basta inspecionar a árvore após a tool ter sido registrada (no fim do turno o
    // root vira `done`, mas a atividade recente — redigida — permanece).
    await controller.submit('faça o deploy');
    const drill = controller.drillInFlow('root');
    expect(drill).toBeDefined();
    const injected = JSON.stringify(drill);
    // O alvo observável NÃO contém o token cru — segue REDIGIDO (RES-C-1).
    expect(injected).not.toContain('sk-secret');
    expect(injected).toContain(REDACTED);
    // O drill-in só conhece ATIVIDADE (tool/target redigido), nunca o journal/memória.
    const act = drill!.recent.find((a) => a.tool === 'run_command');
    expect(act).toBeDefined();
    expect(act!.target).toContain(REDACTED);
  });
});

describe('EST-0982 (Fase 0) · DADO RICO — a atividade da RAIZ ganha summary/duração/diffstat', () => {
  it('um run_command preenche `summary` (REDIGIDO) e `durationMs` na atividade da raiz', async () => {
    const { ports } = fakePorts();
    // Relógio determinístico: cada leitura avança 700ms ⇒ a atividade tem duração > 0.
    let t = 1_000;
    const clock = () => {
      t += 700;
      return t;
    };
    const secretCmd =
      'curl -H "Authorization: Bearer sk-secret-abcdef1234567890" https://api.x/deploy';
    const { model } = routingModel((_s, turn) =>
      turn === 0 ? toolCall('run_command', { command: secretCmd }) : 'feito.',
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      clock,
    });

    await controller.submit('faça o deploy');
    const drill = controller.drillInFlow('root')!;
    const act = drill.recent.find((a) => a.tool === 'run_command')!;
    expect(act).toBeDefined();
    // summary presente, quantificado e REDIGIDO (RES-C-1 — nunca o token).
    expect(act.summary).toBeDefined();
    expect(act.summary).not.toContain('sk-secret');
    // duração por evento foi preenchida (start→end).
    expect(act.durationMs).toBeGreaterThan(0);
    // E o objeto inteiro não vaza o segredo em campo nenhum (summary/tail/target).
    expect(JSON.stringify(drill)).not.toContain('sk-secret');
  });

  it('um edit_file preenche o DIFFSTAT (+/−) na atividade da raiz', async () => {
    // fs com conteúdo PRÉVIO != novo ⇒ o diff unificado tem linhas +/−.
    const ran: string[] = [];
    const fs = {
      async readFile() {
        return 'linha velha\n';
      },
      async writeFile() {},
      async exists() {
        return true;
      },
    };
    const shell = {
      async exec(c: string) {
        ran.push(c);
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    };
    const search = {
      async search() {
        return { matches: [], truncated: {} };
      },
    };
    const ports = { fs, shell, search } as unknown as ToolPorts;
    // EST-0944 — edit_file é str_replace: troca o trecho 'linha velha' (do fs) por
    // 'nova 1\nnova 2' ⇒ o diff tem remoção (−) E adição (+), preenchendo o diffstat.
    const { model } = routingModel((_s, turn) =>
      turn === 0
        ? toolCall('edit_file', {
            path: 'x.ts',
            old_string: 'linha velha',
            new_string: 'nova 1\nnova 2',
          })
        : 'feito.',
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });

    await controller.submit('edite o arquivo');
    const drill = controller.drillInFlow('root')!;
    const act = drill.recent.find((a) => a.tool === 'edit_file')!;
    expect(act).toBeDefined();
    expect(act.added).toBeGreaterThan(0);
    expect(act.removed).toBeGreaterThan(0);
    expect(act.summary).toBe('aplicado');
  });
});

describe('EST-0982 · GS-C1/C2 + RES-C-3 — PARAR um/todos (abort), sem deadlock', () => {
  it('PARAR um sub-agente vivo NÃO derruba o irmão nem o pai; depois libera e a sessão fecha', async () => {
    const { ports } = fakePorts();
    // Dois filhos: `slow` espera num gate antes de concluir; `fast` conclui logo.
    // Enquanto `slow` está pendurado, cancelamos `slow` — `fast`/pai não podem cair.
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    let parent: string | null = null;

    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        const sessionId = key.slice(0, key.lastIndexOf(':'));
        if (parent === null) parent = sessionId;
        const isParent = sessionId === parent;
        const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 };
        if (isParent) {
          // 1º turno: delega 2 filhos; 2º: conclui.
          const content = (await firstTurn(sessionId))
            ? toolCall(SPAWN_AGENT_TOOL_NAME, {
                agents: [
                  { label: 'slow', goal: 'g-slow' },
                  { label: 'fast', goal: 'g-fast' },
                ],
              })
            : 'consolidado.';
          return { request_id: 'r', content, finish_reason: 'stop', usage };
        }
        // filho: espera o gate OU o abort do SEU signal (o controller propaga o cancel
        // ao signal do nó-alvo). O `slow` cancelado destrava pelo abort; o `fast` pelo gate.
        await Promise.race([
          slowGate,
          new Promise<void>((res) => {
            if (args.signal?.aborted) return res();
            args.signal?.addEventListener('abort', () => res(), { once: true });
          }),
        ]);
        return { request_id: 'r', content: 'relatório do filho.', finish_reason: 'stop', usage };
      },
    };

    const turnSeen = new Map<string, number>();
    async function firstTurn(s: string): Promise<boolean> {
      const n = turnSeen.get(s) ?? 0;
      turnSeen.set(s, n + 1);
      return n === 0;
    }

    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 5_000 },
    });

    const done = controller.submit('delegue dois');
    // Espera os dois filhos aparecerem na árvore (registrados no onChildStart).
    await waitFor(() => controller.flowOverview().some((n) => n.label === 'slow'));
    await waitFor(() => controller.flowOverview().some((n) => n.label === 'fast'));

    const slow = controller.flowOverview().find((n) => n.label === 'slow')!;
    const fast = controller.flowOverview().find((n) => n.label === 'fast')!;

    // PARAR o `slow` (um nó específico). GS-C1: cessar≠agir.
    expect(controller.cancelFlow(slow.id)).toBe(true);

    // RES-C-3: o irmão `fast` e o PAI (raiz) NÃO foram abortados pelo cancel do slow.
    const fastNode = controller.drillInFlow(fast.id)!;
    expect(fastNode.phase).not.toBe('cancelled');
    expect(controller.drillInFlow('root')!.phase).not.toBe('cancelled');

    // Audita o cancel com actor_type=cli + nó-alvo (CLI-SEC-10).
    const cancelEvent = controller.controlLog().find((e) => e.verb === 'cancel');
    expect(cancelEvent).toMatchObject({ actorType: 'cli', targetId: slow.id, targetLabel: 'slow' });

    // Libera o gate p/ o `fast` (e o slow já-abortado) concluírem; a sessão fecha.
    releaseSlow();
    await done;
    expect(['done', 'budget']).toContain(controller.current.phase);
    // O `slow` ficou marcado como PARADO (cessar≠falha), o `fast` concluiu.
    const block = subAgentsBlock(controller)!;
    expect(block.children.find((c) => c.label === 'slow')!.status).toBe('cancelled');
  });

  it('ADR-0146 (D5) — PARAR um sub-agente PRESERVA o rótulo de tier/modelo daquela linha (não some no cancel)', async () => {
    // Bug: `cancelFlow` monta o filho de reposição SEM `model` (só label/status/stop/
    // summary) e `upsertSubAgentChild` SUBSTITUÍA o registro inteiro por label — o
    // rótulo `herdado (aluy-strata)` visível enquanto `slow` rodava SUMIA da linha
    // assim que o usuário parava aquele filho. Fix: `upsertSubAgentChild` faz MERGE
    // do `model` (preserva o anterior quando o novo registro não traz um).
    const { ports } = fakePorts();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    let parent: string | null = null;
    const turnSeen = new Map<string, number>();

    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        const sessionId = key.slice(0, key.lastIndexOf(':'));
        if (parent === null) parent = sessionId;
        const isParent = sessionId === parent;
        const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 };
        if (isParent) {
          const n = turnSeen.get(sessionId) ?? 0;
          turnSeen.set(sessionId, n + 1);
          const content =
            n === 0
              ? toolCall(SPAWN_AGENT_TOOL_NAME, { agents: [{ label: 'slow', goal: 'g-slow' }] })
              : 'consolidado.';
          return { request_id: 'r', content, finish_reason: 'stop', usage };
        }
        await Promise.race([
          slowGate,
          new Promise<void>((res) => {
            if (args.signal?.aborted) return res();
            args.signal?.addEventListener('abort', () => res(), { once: true });
          }),
        ]);
        return { request_id: 'r', content: 'relatório do filho.', finish_reason: 'stop', usage };
      },
    };

    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      subAgents: { enabled: true, maxConcurrency: 1, timeoutMs: 5_000 },
    });

    const done = controller.submit('delegue um');
    await waitFor(() => controller.flowOverview().some((n) => n.label === 'slow'));

    // ENQUANTO roda, o `model` já aparece (D5) — captura o valor PRÉ-cancel.
    const beforeCancel = subAgentsBlock(controller)!.children.find((c) => c.label === 'slow');
    expect(beforeCancel?.model).toBe('herdado (aluy-strata)');

    const slow = controller.flowOverview().find((n) => n.label === 'slow')!;
    expect(controller.cancelFlow(slow.id)).toBe(true);

    // Logo APÓS o cancel, o registro é `cancelled` — o `model` tem que SEGUIR lá.
    const afterCancel = subAgentsBlock(controller)!.children.find((c) => c.label === 'slow');
    expect(afterCancel?.status).toBe('cancelled');
    expect(afterCancel?.model).toBe('herdado (aluy-strata)');

    releaseSlow();
    await done;
  });

  it('PARAR TODOS (interrupt) aborta a raiz e a subárvore; o pai recebe estado coerente', async () => {
    const { ports } = fakePorts();
    let releaseAll!: () => void;
    const gate = new Promise<void>((r) => (releaseAll = r));
    let parent: string | null = null;
    const seen = new Map<string, number>();
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        const s = key.slice(0, key.lastIndexOf(':'));
        if (parent === null) parent = s;
        const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 };
        const n = seen.get(s) ?? 0;
        seen.set(s, n + 1);
        if (s === parent && n === 0) {
          return {
            request_id: 'r',
            content: toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [
                { label: 'a', goal: 'g' },
                { label: 'b', goal: 'g' },
              ],
            }),
            finish_reason: 'stop',
            usage,
          };
        }
        // filhos esperam o gate ou o abort.
        await Promise.race([
          gate,
          new Promise<void>((res) => {
            if (args.signal?.aborted) return res();
            args.signal?.addEventListener('abort', () => res(), { once: true });
          }),
        ]);
        return { request_id: 'r', content: 'fim.', finish_reason: 'stop', usage };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 5_000 },
    });

    const done = controller.submit('delegue dois e pare tudo');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    controller.cancelAllFlows(); // PARAR TODOS
    // A raiz e os filhos foram abortados (o signal de cada um disparou).
    expect(controller.drillInFlow('root')!.phase).toBe('cancelled');
    // Auditado o cancel-all (actor_type=cli).
    expect(
      controller.controlLog().some((e) => e.verb === 'cancel-all' && e.actorType === 'cli'),
    ).toBe(true);
    releaseAll();
    await done;
    // Estado coerente do pai: voltou ao composer (idle) após a interrupção.
    expect(['idle', 'done']).toContain(controller.current.phase);
  });
});

describe('EST-0982 · GS-C5 / RES-C-2 — INTERAGIR não amplia escopo nem contorna a catraca', () => {
  it('SEM turno vivo: o input injetado vai p/ o PRÓXIMO turno como INSTRUÇÃO do dono (user) — pela MESMA catraca', async () => {
    const { ports, ran } = fakePorts();
    // 1º submit: o pai roda e conclui (cria a raiz na árvore). Injetamos input.
    // 2º submit: capturamos as mensagens enviadas ao modelo p/ provar que o input
    // entrou como `user` (observação/dado), NÃO como `system` (instrução privilegiada).
    const captured: Array<{ role: string; content: string }> = [];
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        for (const m of args.messages) captured.push({ role: m.role, content: m.content });
        return {
          request_id: 'r',
          content: 'ok.',
          finish_reason: 'stop',
          usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
        };
      },
    };
    const engine = new PolicyPermissionEngine({ mode: 'normal' });
    const controller = new SessionController({
      model,
      permission: engine,
      ports,
      askResolver: approveAll,
      meta,
    });

    await controller.submit('primeira tarefa');
    // INTERAGIR com a raiz (agente principal).
    const ok = controller.injectInput('root', 'mude o foco para o módulo de auth');
    expect(ok).toBe(true);

    // 2º turno: o input injetado deve aparecer como `user` (DADO), nunca `system`.
    captured.length = 0;
    await controller.submit('segunda tarefa');

    const systemMsgs = captured.filter((m) => m.role === 'system');
    const userMsgs = captured.filter((m) => m.role === 'user');
    // O conteúdo injetado está num `user` (INSTRUÇÃO do dono) e o RÓTULO DE ORIGEM aparece.
    const injectedMsg = userMsgs.find((m) =>
      m.content.includes('mude o foco para o módulo de auth'),
    );
    expect(injectedMsg).toBeDefined();
    expect(injectedMsg!.content).toContain(INJECTED_INPUT_LABEL);
    // EST-0982 — é INSTRUÇÃO do dono: NÃO vem envelopado como DADO_NAO_CONFIÁVEL
    // (não é saída de ambiente). A segurança vem da catraca no efeito, não do envelope.
    expect(injectedMsg!.content).not.toContain('DADO_NAO_CONFIAVEL');
    // NUNCA no canal `system` (não é instrução privilegiada — separação de canais).
    expect(systemMsgs.some((m) => m.content.includes('mude o foco para o módulo de auth'))).toBe(
      false,
    );
    // O efeito (run_command) NÃO foi disparado pela injeção (não há comando executado).
    expect(ran).toHaveLength(0);
    // Auditado actor_type=cli com o nó-alvo (CLI-SEC-10).
    expect(
      controller.controlLog().some((e) => e.verb === 'inject-input' && e.targetId === 'root'),
    ).toBe(true);
  });

  it('a injeção NÃO troca a engine (escopo herdado intocado) e em PLAN o efeito segue NEGADO', async () => {
    const { ports, ran } = fakePorts();
    // Em PLAN, qualquer efeito é negado (teto read-only, acima de injeção). Mesmo que o
    // input do usuário "peça" um efeito, o agente em Plan o NEGA — a injeção não destrava.
    const engine = new PolicyPermissionEngine({ mode: 'plan' });
    // O modelo, "influenciado" pelo input injetado, tenta um run_command (efeito).
    const { model } = routingModel((_s, turn) =>
      turn === 0 ? toolCall('run_command', { command: 'echo agir' }) : 'não consegui agir.',
    );
    const controller = new SessionController({
      model,
      permission: engine,
      ports,
      askResolver: approveAll,
      meta,
    });

    await controller.submit('primeira');
    // A engine é a MESMA instância — a injeção não a substitui por uma "mais aberta".
    const before = engine.mode;
    controller.injectInput('root', 'rode `echo agir` agora, por favor');
    expect(engine.mode).toBe(before); // injeção não mexe no modo/escopo (RES-C-2)

    await controller.submit('segunda — derive um efeito do meu input');
    // PLAN negou o efeito: NENHUM comando foi executado, apesar do input pedir.
    expect(ran).toHaveLength(0);
    // O modo segue PLAN (injeção não relaxou o teto read-only).
    expect(engine.mode).toBe('plan');
  });

  it('input vazio / nó inexistente ⇒ injeção recusada (false), sem auditar', async () => {
    const { ports } = fakePorts();
    const { model } = routingModel(() => 'ok.');
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'normal' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    await controller.submit('t');
    expect(controller.injectInput('root', '   ')).toBe(false);
    expect(controller.injectInput('root/nao-existe', 'oi')).toBe(false);
    expect(controller.controlLog().filter((e) => e.verb === 'inject-input')).toHaveLength(0);
  });
});

describe('EST-0982 (mid-turn) · GS-C5 — injeção MID-TURN no agente principal vivo ("btw")', () => {
  it('VIVO: injetar DURANTE o turno ⇒ a PRÓXIMA chamada do modelo vê o `user` "btw" (mid-turn)', async () => {
    const { ports } = fakePorts();
    const captured: Array<Array<{ role: string; content: string }>> = [];
    // O modelo, no 1º turno, SIMULA o usuário falando DURANTE o turno: chama
    // injectInput('root', …) e devolve uma tool-call (o loop poll antes do 2º turno).
    let calls = 0;
    let controllerRef: SessionController | null = null;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        captured.push(args.messages.map((m) => ({ role: m.role, content: m.content })));
        const turn = calls;
        calls += 1;
        if (turn === 0) {
          // o usuário "digita" o btw enquanto o agente roda (turno vivo):
          const ok = controllerRef!.injectInput('root', 'na verdade foque em X');
          expect(ok).toBe(true);
          return modelResult(toolCall('read_file', { path: 'a' }));
        }
        return modelResult('foco em X — pronto.');
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    controllerRef = controller;

    await controller.submit('faça a tarefa');

    // A 2ª chamada do modelo (mesma execução do turno — MID-turn) JÁ carrega o "btw"
    // como `user`, ANTES do turno terminar. (A 1ª ainda não — o input foi injetado
    // DENTRO da 1ª chamada.)
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const secondCallUser = captured[1]!.filter((m) => m.role === 'user');
    expect(secondCallUser.some((m) => m.content.includes('na verdade foque em X'))).toBe(true);
    // INSTRUÇÃO do dono: NÃO `system`, NÃO envelopado como DADO.
    const secondCallSystem = captured[1]!.filter((m) => m.role === 'system');
    expect(secondCallSystem.some((m) => m.content.includes('na verdade foque em X'))).toBe(false);
    const injectedMsg = secondCallUser.find((m) => m.content.includes('na verdade foque em X'))!;
    expect(injectedMsg.content).not.toContain('DADO_NAO_CONFIAVEL');
    expect(injectedMsg.content).toContain(INJECTED_INPUT_LABEL);
  });

  it('VIVO: a UX "↳ encaixado" aparece quando o loop incorpora o btw (eco REDIGIDO)', async () => {
    const { ports } = fakePorts();
    let calls = 0;
    let controllerRef: SessionController | null = null;
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        const turn = calls;
        calls += 1;
        if (turn === 0) {
          controllerRef!.injectInput('root', 'foque no módulo de auth');
          return modelResult(toolCall('read_file', { path: 'a' }));
        }
        return modelResult('pronto.');
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    controllerRef = controller;
    await controller.submit('tarefa');

    const injectBlock = controller.current.blocks.find((b) => b.kind === 'inject');
    expect(injectBlock).toBeDefined();
    // O eco é o RESUMO REDIGIDO (CLI-SEC-6) — contém o texto do usuário (sem segredo aqui).
    expect(injectBlock!.kind === 'inject' && injectBlock.text).toContain('foque no módulo de auth');
  });

  it('PARADO: sem turno vivo ⇒ injeção cai no PRÓXIMO turno (comportamento atual), sem "↳ encaixado"', async () => {
    const { ports } = fakePorts();
    const captured: Array<Array<{ role: string; content: string }>> = [];
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        captured.push(args.messages.map((m) => ({ role: m.role, content: m.content })));
        return modelResult('ok.');
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'normal' }),
      ports,
      askResolver: approveAll,
      meta,
    });

    // 1º submit conclui (cria a raiz na árvore, depois fica TERMINAL — não há turno vivo).
    await controller.submit('primeira');
    // Injeta com o turno PARADO ⇒ vai p/ pendingInjected (próximo turno), NÃO mid-turn.
    expect(controller.injectInput('root', 'btw use TypeScript')).toBe(true);
    // Nenhuma nota "↳ encaixado" agora (não há turno vivo p/ incorporar):
    expect(controller.current.blocks.some((b) => b.kind === 'inject')).toBe(false);

    captured.length = 0;
    await controller.submit('segunda');
    // O input aparece no PRÓXIMO turno como `user` (comportamento atual preservado).
    const userMsgs = captured.flat().filter((m) => m.role === 'user');
    expect(userMsgs.some((m) => m.content.includes('btw use TypeScript'))).toBe(true);
  });

  it('VIVO: uma tool que o modelo dispara A PARTIR do btw AINDA passa pela catraca (Plan nega efeito)', async () => {
    const { ports, ran } = fakePorts();
    let calls = 0;
    let controllerRef: SessionController | null = null;
    // Em PLAN: efeito é negado. O modelo, após o btw, tenta um run_command (efeito).
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        const turn = calls;
        calls += 1;
        if (turn === 0) {
          controllerRef!.injectInput('root', 'rode `echo agir` agora');
          return modelResult(toolCall('read_file', { path: 'a' }));
        }
        if (turn === 1) return modelResult(toolCall('run_command', { command: 'echo agir' }));
        return modelResult('bloqueado — não agi.');
      },
    };
    const engine = new PolicyPermissionEngine({ mode: 'plan' });
    const controller = new SessionController({
      model,
      permission: engine,
      ports,
      askResolver: approveAll,
      meta,
    });
    controllerRef = controller;
    await controller.submit('tarefa em plan');
    // O btw entrou mid-turn, mas a catraca (Plan) NEGOU o efeito: nada executado.
    expect(ran).toHaveLength(0);
    expect(engine.mode).toBe('plan');
  });

  // ── EST-0982 (mid-turn UX) — indicador "encaixando…" (pendingInjects no estado) ──────
  it('VIVO: o inject PENDENTE aparece em `state.pendingInjects` ANTES do loop drenar e SOME ao incorporar', async () => {
    const { ports } = fakePorts();
    let calls = 0;
    let controllerRef: SessionController | null = null;
    // Snapshots do `pendingInjects` capturados DENTRO de cada chamada do modelo (o
    // instante VIVO entre o Enter e a drenagem do loop — invisível no fim do turno).
    const snapshots: Array<readonly string[]> = [];
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        const turn = calls;
        calls += 1;
        // No 1º turno: ANTES de injetar nada está pendente; DEPOIS de injetar, o eco
        // já está VISÍVEL no estado (indicador "encaixando…"), antes do loop drenar.
        if (turn === 0) {
          expect(controllerRef!.current.pendingInjects).toHaveLength(0);
          controllerRef!.injectInput('root', 'foque no módulo de auth');
          snapshots.push(controllerRef!.current.pendingInjects);
          return modelResult(toolCall('read_file', { path: 'a' }));
        }
        // No 2º turno (o loop JÁ drenou o btw e o incorporou): o pendente esvaziou.
        snapshots.push(controllerRef!.current.pendingInjects);
        return modelResult('pronto.');
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    controllerRef = controller;
    await controller.submit('tarefa');

    // ESPERANDO: logo após o inject (1º turno) o pendente está VISÍVEL com o eco.
    expect(snapshots[0]).toHaveLength(1);
    expect(snapshots[0]![0]).toContain('foque no módulo de auth');
    // DRENADO: no 2º turno (loop incorporou) o pendente esvaziou — não duplica.
    expect(snapshots[1]).toHaveLength(0);
    // ENCAIXADO: a nota imutável "↳ encaixado" (InjectBlock) está no histórico.
    const injectBlock = controller.current.blocks.find((b) => b.kind === 'inject');
    expect(injectBlock && injectBlock.kind === 'inject' && injectBlock.text).toContain(
      'foque no módulo de auth',
    );
    // FIM do turno: o indicador não ghosta (esvaziou).
    expect(controller.current.pendingInjects).toHaveLength(0);
  });

  it('VIVO: MÚLTIPLOS injects pendentes aparecem em ORDEM (FIFO) e drenam um a um', async () => {
    const { ports } = fakePorts();
    let calls = 0;
    let controllerRef: SessionController | null = null;
    const snapshots: Array<readonly string[]> = [];
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        const turn = calls;
        calls += 1;
        if (turn === 0) {
          controllerRef!.injectInput('root', 'primeiro btw');
          controllerRef!.injectInput('root', 'segundo btw');
          snapshots.push(controllerRef!.current.pendingInjects);
          return modelResult(toolCall('read_file', { path: 'a' }));
        }
        return modelResult('pronto.');
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    controllerRef = controller;
    await controller.submit('tarefa');

    // Os dois pendentes aparecem na ORDEM em que foram injetados (FIFO).
    expect(snapshots[0]).toHaveLength(2);
    expect(snapshots[0]![0]).toContain('primeiro btw');
    expect(snapshots[0]![1]).toContain('segundo btw');
    // Ambos viraram nota "↳ encaixado", na MESMA ordem, e o indicador esvaziou.
    const injects = controller.current.blocks.filter((b) => b.kind === 'inject');
    expect(injects).toHaveLength(2);
    expect(injects[0]!.kind === 'inject' && injects[0]!.text).toContain('primeiro btw');
    expect(injects[1]!.kind === 'inject' && injects[1]!.text).toContain('segundo btw');
    expect(controller.current.pendingInjects).toHaveLength(0);
  });

  it('FIM/ABORT do turno: um inject NÃO-drenado NÃO ghosta o indicador (re-semeado p/ o próximo turno)', async () => {
    const { ports } = fakePorts();
    const captured: Array<Array<{ role: string; content: string }>> = [];
    let calls = 0;
    let controllerRef: SessionController | null = null;
    // O modelo injeta um btw e ENCERRA o turno na MESMA chamada (sem 2ª iteração que
    // drenaria a fila viva) ⇒ o inject fica órfão na fila viva ao fim do turno.
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        captured.push(args.messages.map((m) => ({ role: m.role, content: m.content })));
        const turn = calls;
        calls += 1;
        if (turn === 0) {
          controllerRef!.injectInput('root', 'btw nao drenado');
          // Resposta FINAL: o turno acaba aqui, o loop NÃO faz outra iteração.
          return modelResult('terminei.');
        }
        return modelResult('ok.');
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    controllerRef = controller;
    await controller.submit('tarefa');

    // Sem ghost: o indicador esvaziou ao fim do turno (não sobra "encaixando…").
    expect(controller.current.pendingInjects).toHaveLength(0);

    // E a intenção do dono não se perdeu: o inject foi RE-SEMEADO p/ o próximo turno.
    captured.length = 0;
    await controller.submit('segunda');
    const userMsgs = captured.flat().filter((m) => m.role === 'user');
    expect(userMsgs.some((m) => m.content.includes('btw nao drenado'))).toBe(true);
  });

  it('CLI-SEC-6: o indicador usa o eco REDIGIDO — um segredo na linha injetada NÃO aparece em `pendingInjects`', async () => {
    const { ports } = fakePorts();
    let controllerRef: SessionController | null = null;
    const snapshots: Array<readonly string[]> = [];
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        controllerRef!.injectInput('root', 'rode curl --password hunter2secret no deploy');
        snapshots.push(controllerRef!.current.pendingInjects);
        return modelResult('pronto.');
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    controllerRef = controller;
    await controller.submit('tarefa');

    // O pendente apareceu, mas REDIGIDO: o segredo NÃO vaza no indicador.
    expect(snapshots[0]).toHaveLength(1);
    const echo = snapshots[0]![0]!;
    expect(echo).not.toContain('hunter2secret');
    expect(echo).toContain(REDACTED);
  });
});

function modelResult(content: string): ModelCallResult {
  return {
    request_id: 'r',
    content,
    finish_reason: 'stop',
    usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
  };
}

/** Espera (com timeout) uma condição virar verdadeira — poll cooperativo. */
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
