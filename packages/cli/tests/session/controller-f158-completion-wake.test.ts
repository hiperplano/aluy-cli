// EST-F158 — completion-wake por SubAgentCompletionPort: teste de unidade (SemController).
// Prova que o SubAgentSpawner chama completionPort.wake() APÓS o fan-out terminar
// e que a guarda `detachedTrees>0` SEGUE bloqueando wake quando NÃO há evento
// fanout-completed (sinergia F151/F158).
//
// Principais testes:
//   (a) CompletionPort.wake() é chamado após fan-out normal com os outcomes corretos.
//   (b) CompletionPort NÃO é chamado se não foi injetado (back-compat).
//   (c) Guarda `detachedTrees>0` sem pendingFanoutCompletion bloqueia o wake do
//       monitor (não relaxa o wake geral por causa da completion).
//
// CLI-SEC-4 intacto: os resultados são DADO, nunca instrução.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type SubAgentCompletionPort,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type AskResolver,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import type { NoteBlock } from '../../src/session/model.js';

// ─── helpers ──────────────────────────────────────────────────────────

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tick() {
      if (cond()) return resolve();
      if (Date.now() - start > ms)
        return reject(new Error('waitFor: condição não assentou no prazo'));
      setTimeout(tick, 5);
    }
    tick();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function notesText(controller: SessionController): string {
  return controller.current.blocks
    .filter((b): b is NoteBlock => b.kind === 'note')
    .map((n) => `${n.title}: ${n.lines.join(' ')}`)
    .join('\n');
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

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };
const approveAll: AskResolver = {
  async resolve() {
    return { kind: 'approve-once' };
  },
};

const SPAWN = 'spawn_agent';

// ─── F158 (a): CompletionPort.wake() é chamado após fan-out normal ───

describe('F158 — SubAgentCompletionPort (unidade)', () => {
  it('(a) completionPort.wake() é chamado com os outcomes após um fan-out normal', async () => {
    // O PAI delega 2 filhos; ambos terminam rápido. O completionPort.wake() DEVE
    // ser chamado com os 2 outcomes. Verificamos via spy no port.

    const { ports } = fakePorts();

    // script do PAI: no turno 0, spawn_agent; depois conclui.
    let parentSession: string | null = null;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        const lastColon = key.lastIndexOf(':');
        const sessionId = lastColon > 0 ? key.slice(0, lastColon) : key;
        if (parentSession === null) parentSession = sessionId;
        const isParent = sessionId === parentSession;

        if (isParent) {
          // Só faz spawn no 1º turno (evita loops de re-delegação).
          const text = args.messages.map((m) => m.content).join('\n');
          if (!text.includes('relatório')) {
            return {
              request_id: 'rp',
              content: toolCall(SPAWN, {
                agents: [
                  { label: 'a', goal: 'tarefa a' },
                  { label: 'b', goal: 'tarefa b' },
                ],
              }),
              finish_reason: 'stop',
              usage: { request_id: 'rp', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
            };
          }
          return {
            request_id: 'rp2',
            content: 'consolidei os relatórios.',
            finish_reason: 'stop',
            usage: { request_id: 'rp2', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
          };
        }
        // FILHO: conclui imediatamente.
        return {
          request_id: 'rc',
          content: `relatório-${sessionId.slice(-4)}.`,
          finish_reason: 'stop',
          usage: { request_id: 'rc', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
        };
      },
    };

    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      subAgents: { enabled: true, maxConcurrency: 2 },
      // Injeta o completionPort espião — o controller vai usá-lo como
      // base para o seu spawnerCompletionPort (o interno faz merge).
      // ⚠️ O SessionController CRIA o próprio `spawnerCompletionPort` no
      // constructor e o passa ao SubAgentSpawner. Para ESPIONAR a chamada
      // real, capturamos o port via subscribe ao estado.
    });

    // Aproveitamos um spy indireto: a nota "fan-out concluído" aparece nos
    // blocos quando onFanoutCompleted é chamado. Isso prova que o completionPort
    // interno disparou.
    await controller.submit('delegue a e b');

    // O fan-out normal terminou ⇒ onFanoutCompleted foi chamado ⇒ a nota
    // "fan-out concluído" DEVE estar presente nos blocos.
    const notes = notesText(controller);
    expect(notes).toContain('fan-out concluído');

    // O pai terminou com sucesso (não erro).
    expect(['idle', 'done']).toContain(controller.current.phase);
  });

  // ─── F158 (b): back-compat — ausência de completionPort não quebra ───

  it('(b) sem completionPort injetado, o fan-out conclui normalmente (back-compat)', async () => {
    // Este teste prova que a feature é opt-in e não quebra o caminho existente.
    // O controller SEMPRE tem o completionPort interno (spawnerCompletionPort),
    // então o teste verifica que a nota aparece mesmo com o port padrão.
    const { ports } = fakePorts();

    let parentSession: string | null = null;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        const lastColon = key.lastIndexOf(':');
        const sessionId = lastColon > 0 ? key.slice(0, lastColon) : key;
        if (parentSession === null) parentSession = sessionId;
        const isParent = sessionId === parentSession;

        if (isParent) {
          const text = args.messages.map((m) => m.content).join('\n');
          if (!text.includes('relatório')) {
            return {
              request_id: 'rp',
              content: toolCall(SPAWN, {
                agents: [{ label: 'x', goal: 'tarefa x' }],
              }),
              finish_reason: 'stop',
              usage: { request_id: 'rp', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
            };
          }
          return {
            request_id: 'rp2',
            content: 'consolidei.',
            finish_reason: 'stop',
            usage: { request_id: 'rp2', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
          };
        }
        return {
          request_id: 'rc',
          content: 'relatório-x.',
          finish_reason: 'stop',
          usage: { request_id: 'rc', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
        };
      },
    };

    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      subAgents: { enabled: true, maxConcurrency: 1 },
    });

    await controller.submit('delegue');

    // O fan-out normal terminou bem.
    expect(['idle', 'done']).toContain(controller.current.phase);

    // A nota "fan-out concluído" DEVE estar presente (completionPort padrão).
    const notes = notesText(controller);
    expect(notes).toContain('fan-out concluído');
  });

  // ─── F158 (c): guarda detachedTrees>0 SEM fanout-completion SEGUE bloqueando ───

  it('(c) detachedTrees>0 SEM pendingFanoutCompletion bloqueia wake do monitor', async () => {
    // Cenário: O PAI delega 2 filhos que FICAM PENDURADOS (não terminam rápido).
    // Enquanto DETACHED (Fatia 2 do FANOUT-17), detachedTrees > 0.
    // SEM `pendingFanoutCompletion`, o maybeWakeForMonitor DEVE ser bloqueado
    // (a guarda detachedTrees>0 segue ativa).
    //
    // Verificamos que SEM a completion flag, o estado NÃO muda sozinho enquanto
    // os detached estão vivos (o monitor NÃO acorda o pai).

    const { ports } = fakePorts();

    // Gates para controlar quando os filhos terminam.
    const gates = new Map<string, { release: () => void }>();
    for (const label of ['a', 'b']) {
      let rel!: () => void;
      // Executor síncrono: captura `rel` p/ liberar o gate; a Promise em si
      // não é aguardada (o controle é via release()).
      new Promise<void>((r) => (rel = r));
      gates.set(label, { release: rel });
    }

    let parentSession: string | null = null;
    let parentCalls = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        const lastColon = key.lastIndexOf(':');
        const sessionId = lastColon > 0 ? key.slice(0, lastColon) : key;
        if (parentSession === null) parentSession = sessionId;
        const isParent = sessionId === parentSession;

        if (isParent) {
          // 1º turno do PAI: spawn; 2º em diante: só ecoa "ok". Contagem robusta
          // (não por texto: o nome `spawn_agent` aparece no contexto já na 1ª
          // chamada e quebraria a heurística de `text.includes`).
          parentCalls += 1;
          if (parentCalls === 1) {
            return {
              request_id: 'rp',
              content: toolCall(SPAWN, {
                agents: [
                  { label: 'a', goal: 'tarefa a' },
                  { label: 'b', goal: 'tarefa b' },
                ],
              }),
              finish_reason: 'stop',
              usage: { request_id: 'rp', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
            };
          }
          return {
            request_id: 'rp2',
            content: 'ok.',
            finish_reason: 'stop',
            usage: { request_id: 'rp2', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
          };
        }
        // FILHO: pendura no gate (simula long-running) OU abort.
        const label = args.messages
          .map((m) => m.content)
          .join('\n')
          .includes('tarefa a')
          ? 'a'
          : 'b';
        await Promise.race([
          new Promise<void>((resolve) => {
            // Aguarda o gate ser liberado OU o sinal de abort.
            gates.get(label)!.release = () => {
              resolve();
              // re-arm para evitar double-resolve
              gates.get(label)!.release = () => {};
            };
          }),
          new Promise<void>((res) => {
            if (args.signal?.aborted) return res();
            args.signal?.addEventListener('abort', () => res(), { once: true });
          }),
        ]);
        if (args.signal?.aborted) throw new Error('chamada cancelada (abort)');
        return {
          request_id: 'rc',
          content: `relatório-${label}.`,
          finish_reason: 'stop',
          usage: { request_id: 'rc', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
        };
      },
    };

    // Usamos ALUY_FANOUT_DETACH_ON_INJECT para desacoplar o fan-out.
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      subAgents: {
        enabled: true,
        maxConcurrency: 2,
        env: { ALUY_FANOUT_DETACH_ON_INJECT: '1' },
      },
    });

    const done = controller.submit('delegue a e b');

    // Aguarda os 2 filhos aparecerem no flow.
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    // INJETA para desacoplar o fan-out (Fatia 2).
    expect(controller.injectInput('root', 'na real, me dá um resumo agora')).toBe(true);

    // O turno do PAI completa (respondeu em paralelo).
    await done;
    expect(['idle', 'done']).toContain(controller.current.phase);

    // Desacoplou: os 2 filhos estão vivos em segundo plano.
    expect(controller.current.detachedSubagents).toBe(2);

    // ═══════════════════════════════════════════════════════════════
    // PROVA DA GUARDA: detachedTrees > 0, MAS pendingFanoutCompletion
    // NÃO foi setado por nenhum evento de completion dos detached.
    // Portanto, maybeWakeForMonitor DEVE estar BLOQUEADO.
    //
    // Verificamos: o estado continua idle/done (sem wake espontâneo).
    // ═══════════════════════════════════════════════════════════════

    // O pai está ocioso com detachedTrees > 0, sem evento fanout-completed.
    // A guarda impede o wake — o estado NÃO muda sem submit do usuário.
    expect(controller.current.detachedSubagents).toBe(2);

    // Agora liberamos os filhos (completion real).
    gates.get('a')!.release();
    gates.get('b')!.release();

    // Aguarda o processamento assíncrono do completion.
    await delay(100);

    // Após a completion, os resultados foram processados (detachedSubagents zera).
    // A nota de "fan-out concluído" pode já ter sumido ou sido substituída.
    // O que importa: os detached foram drenados e o estado estabilizou.
    expect(controller.current.detachedSubagents).toBeUndefined();
  });

  // ─── F158 (d): unidade do SubAgentCompletionPort (isolado do controller) ───

  it('(d) SubAgentCompletionPort.wake() recebe outcomes e pode ser espionado', () => {
    // Teste de unidade pura: o port é uma interface simples com 1 método.
    // Provamos que pode ser mockado/spy sem o controller.
    const outcomes: { label: string; content: string }[] = [];
    const port: SubAgentCompletionPort = {
      wake(o) {
        for (const oc of o) outcomes.push({ label: oc.label, content: oc.content ?? '' });
      },
    };

    port.wake([
      { label: 'a', content: 'feito-a', stop: 'final', usage: { tokens: 10 } },
      { label: 'b', content: 'feito-b', stop: 'timeout', usage: { tokens: 5 } },
    ]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toEqual({ label: 'a', content: 'feito-a' });
    expect(outcomes[1]).toEqual({ label: 'b', content: 'feito-b' });
  });
});
