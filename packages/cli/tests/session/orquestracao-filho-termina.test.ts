import { describe, expect, it } from 'vitest';
import {
  BrokerTransportError,
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import type { NoteBlock } from '../../src/session/model.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

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

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function notesText(controller: SessionController): string {
  return controller.current.blocks
    .filter((b): b is NoteBlock => b.kind === 'note')
    .map((n) => `${n.title}: ${n.lines.join(' ')}`)
    .join('\n');
}

function buildController(
  model: ModelCaller,
  env?: Record<string, string | undefined>,
): SessionController {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
    subAgents: {
      enabled: true,
      maxConcurrency: 2,
      timeoutMs: 60_000,
      ...(env ? { env } : {}),
    },
  });
}

// Relato do dono (22/09/2026): "peço para ele fazer uma atividade e, em paralelo, disparar
// um agente para fazer outra. O agente terminou, mas eu tive que lembrá-lo de olhar."
//
// REPRODUÇÃO: o pai despacha um filho (`wait:false`), segue com a PRÓPRIA atividade, e o
// filho termina ENQUANTO a última chamada do pai está em voo. O pai entrega a resposta
// final. O resultado do filho tem de ser incorporado SEM o dono pedir.
function cenario() {
  let liberarFilho!: () => void;
  const filhoPode = new Promise<void>((r) => (liberarFilho = r));
  let liberarFinalDoPai!: () => void;
  const finalDoPai = new Promise<void>((r) => (liberarFinalDoPai = r));
  const chamadasDoPai: { role: string; content: string }[][] = [];
  let pai: string | null = null;
  let filhoTerminou = false;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const sessionId = key.slice(0, key.lastIndexOf(':'));
      if (pai === null) pai = sessionId;
      const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };
      if (sessionId === pai) {
        chamadasDoPai.push(args.messages.map((m) => ({ role: m.role, content: m.content })));
        const n = chamadasDoPai.length;
        if (n === 1) {
          return {
            request_id: 'r',
            content: toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [{ label: 'pesquisa', goal: 'g-pesquisa' }],
              wait: false,
            }),
            finish_reason: 'stop',
            usage,
          };
        }
        if (n === 2) {
          // A ÚLTIMA chamada do pai: ele ainda está "fazendo a própria atividade" quando o
          // filho termina. Só devolve a resposta final depois disso.
          await finalDoPai;
          return { request_id: 'r', content: 'terminei a minha parte.', finish_reason: 'stop', usage };
        }
        return { request_id: 'r', content: 'incorporei o resultado.', finish_reason: 'stop', usage };
      }
      await filhoPode;
      filhoTerminou = true;
      return { request_id: 'r', content: 'RELATORIO-DO-FILHO.', finish_reason: 'stop', usage };
    },
  };
  return {
    model,
    chamadasDoPai,
    liberarFilho,
    liberarFinalDoPai,
    filhoTerminou: () => filhoTerminou,
  };
}

describe('orquestração — o pai incorpora o filho que terminou SEM o dono pedir', () => {
  it('filho termina durante a última chamada do pai ⇒ nasce um turno de incorporação', async () => {
    const s = cenario();
    const controller = buildController(s.model);
    const done = controller.submit('faça X e, em paralelo, dispare um agente para Y');
    await waitFor(() => s.chamadasDoPai.length === 2);
    s.liberarFilho();
    await waitFor(() => s.filhoTerminou());
    await waitFor(() => notesText(controller).includes('sub-agentes concluíram'));
    s.liberarFinalDoPai();
    await done;
    // O pai tem de voltar ao modelo SOZINHO, vendo o relatório do filho.
    await waitFor(() => s.chamadasDoPai.length >= 3, 4000);
    const visto = s.chamadasDoPai[2]!.map((m) => m.content).join(' | ');
    expect(visto).toContain('RELATORIO-DO-FILHO');
  });

  it('filho termina DEPOIS que o pai encerrou ⇒ também nasce o turno de incorporação', async () => {
    const s = cenario();
    const controller = buildController(s.model);
    const done = controller.submit('faça X e, em paralelo, dispare um agente para Y');
    await waitFor(() => s.chamadasDoPai.length === 2);
    s.liberarFinalDoPai();
    await done;
    expect(s.chamadasDoPai).toHaveLength(2);
    s.liberarFilho();
    await waitFor(() => s.chamadasDoPai.length >= 3, 4000);
    const visto = s.chamadasDoPai[2]!.map((m) => m.content).join(' | ');
    expect(visto).toContain('RELATORIO-DO-FILHO');
    // O pai é acordado como ORQUESTRADOR (o filho é dele; conclua), não como "um monitor
    // disparou, relate o que mudou" — era isso que o fazia só relatar e esperar o dono.
    expect(visto).toContain('sub-agente que VOCÊ despachou terminou');
    expect(visto).toContain('conclua o que ficou pendente');
    expect(visto).not.toContain('Um monitor disparou');
  });
});

describe('orquestração — o resultado do filho NÃO pode sumir se o turno que o recebeu falhar', () => {
  // A SESSÃO REAL (22/09, blocos 206–226): o filho terminou com o turno do pai vivo; o
  // resultado entrou no turno; a chamada seguinte ao modelo bateu HTTP 429 e o turno morreu.
  // Depois do "retomar", o pai concluiu que o filho "morreu com as interrupções" e REFEZ o
  // trabalho dele — o resultado existia só na memória do turno que falhou.
  it('turno que drenou o resultado falha ⇒ o próximo turno ainda o vê', async () => {
    let liberarFilho!: () => void;
    const filhoPode = new Promise<void>((r) => (liberarFilho = r));
    let filhoTerminou = false;
    const chamadasDoPai: string[] = [];
    let pai: string | null = null;
    let n = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        const sessionId = key.slice(0, key.lastIndexOf(':'));
        if (pai === null) pai = sessionId;
        const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };
        if (sessionId === pai) {
          n += 1;
          chamadasDoPai.push(args.messages.map((m) => m.content).join(' | '));
          if (n === 1) {
            return {
              request_id: 'r',
              content: toolCall(SPAWN_AGENT_TOOL_NAME, {
                agents: [{ label: 'visual', goal: 'g-visual' }],
                wait: false,
              }),
              finish_reason: 'stop',
              usage,
            };
          }
          if (n === 2) {
            // O pai segue trabalhando; o filho termina AQUI, com o turno vivo.
            liberarFilho();
            await waitFor(() => filhoTerminou);
            await new Promise((r) => setTimeout(r, 30));
            return { request_id: 'r', content: toolCall('list_todos', {}), finish_reason: 'stop', usage };
          }
          if (n === 3) {
            // A chamada que JÁ recebeu o resultado do filho morre (o 429 da sessão real).
            throw new Error('HTTP 429 — muitas requisições');
          }
          return { request_id: 'r', content: 'retomei.', finish_reason: 'stop', usage };
        }
        await filhoPode;
        filhoTerminou = true;
        return { request_id: 'r', content: 'RELATORIO-VISUAL.', finish_reason: 'stop', usage };
      },
    };
    const controller = buildController(model);
    await controller.submit('faça a parte funcional e despache um agente para a visual');
    // O resultado chegou a entrar no turno que falhou.
    expect(chamadasDoPai[2]).toContain('RELATORIO-VISUAL');
    if (controller.current.phase === 'error') controller.dismissError();
    await controller.submit('retomar');
    const ultima = chamadasDoPai[chamadasDoPai.length - 1]!;
    expect(ultima, 'o turno de retomada não viu o resultado do filho').toContain('RELATORIO-VISUAL');
  });
});

describe('orquestração — auto-retry e agents_status', () => {
  /** Pai despacha `visual`; o filho termina com o turno vivo; a 3ª chamada do pai falha. */
  function cenarioQueFalhaDepoisDeDrenar(falha: () => never) {
    let liberarFilho!: () => void;
    const filhoPode = new Promise<void>((r) => (liberarFilho = r));
    let filhoTerminou = false;
    const chamadasDoPai: string[] = [];
    let pai: string | null = null;
    let n = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        const sessionId = key.slice(0, key.lastIndexOf(':'));
        if (pai === null) pai = sessionId;
        const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };
        if (sessionId === pai) {
          n += 1;
          chamadasDoPai.push(args.messages.map((m) => m.content).join(' | '));
          if (n === 1) {
            return {
              request_id: 'r',
              content: toolCall(SPAWN_AGENT_TOOL_NAME, {
                agents: [{ label: 'visual', goal: 'g-visual' }],
                wait: false,
              }),
              finish_reason: 'stop',
              usage,
            };
          }
          if (n === 2) {
            liberarFilho();
            await waitFor(() => filhoTerminou);
            await new Promise((r) => setTimeout(r, 30));
            return { request_id: 'r', content: toolCall('list_todos', {}), finish_reason: 'stop', usage };
          }
          if (n === 3) falha();
          return { request_id: 'r', content: 'segui.', finish_reason: 'stop', usage };
        }
        await filhoPode;
        filhoTerminou = true;
        return { request_id: 'r', content: 'RELATORIO-VISUAL.', finish_reason: 'stop', usage };
      },
    };
    return { model, chamadasDoPai };
  }

  // A sessão real teve 429 RETENTADO: a retentativa re-roda o turno a partir do histórico
  // ANTERIOR — e o resultado drenado na tentativa que falhou ficava para trás.
  it('falha RETRYABLE: a retentativa já vê o resultado do filho', async () => {
    const c = cenarioQueFalhaDepoisDeDrenar(() => {
      throw new BrokerTransportError('HTTP 429 — muitas requisições');
    });
    const controller = new SessionController({
      model: c.model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: approveAll,
      meta,
      subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 60_000 },
      retry: { maxAttempts: 3, sleep: async () => {}, rand: () => 0.5 },
    });
    await controller.submit('faça a parte funcional e despache um agente para a visual');
    const retentativa = c.chamadasDoPai[3]!;
    expect(retentativa, 'a retentativa não viu o resultado do filho').toContain('RELATORIO-VISUAL');
  });

  it('agents_status lista o filho que TERMINOU como concluído — não some', async () => {
    const c = cenarioQueFalhaDepoisDeDrenar(() => {
      throw new Error('não chega aqui');
    });
    const controller = buildController(c.model);
    await controller.submit('faça a parte funcional e despache um agente para a visual');
    // O "retomar" da sessão real: um turno SEGUINTE, com árvore de fluxo nova. É nele que o
    // filho concluído sumia (no mesmo turno ele ainda aparece pela árvore corrente).
    if (controller.current.phase === 'error') controller.dismissError();
    await controller.submit('retomar');
    const lista = (
      controller as unknown as { listaFilhosParaGestao(): { label: string; phase: string; note?: string }[] }
    ).listaFilhosParaGestao();
    const visual = lista.find((x) => x.label === 'visual');
    expect(visual, 'o filho concluído sumiu do agents_status').toBeDefined();
    expect(visual!.phase).toBe('concluído');
    expect(visual!.note).toContain('NÃO está morto');
  });
});
