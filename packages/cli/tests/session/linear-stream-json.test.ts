// EST-1007 — modo HEADLESS stream-json: EVENTOS AO VIVO como NDJSON no stdout.
//
// Testa que `runHeadlessStreamJson` emite um JSON válido por linha para cada
// transição relevante do estado da sessão (tool_call, tool_result, text, result),
// sem quebrar os formatos text/json existentes.

import { describe, expect, it } from 'vitest';
import { runHeadlessStreamJson, type LinearOut } from '../../src/session/linear.js';
import type { SessionController } from '../../src/session/controller.js';
import type { SessionBlock, SessionState } from '../../src/session/model.js';

/** Coletor de saída — guarda o que foi escrito p/ asserção. */
function makeOut(): { out: LinearOut; written: string[]; text(): string } {
  const written: string[] = [];
  return {
    out: { write: (c) => void written.push(c) },
    written,
    text: () => written.join(''),
  };
}

function makeState(blocks: readonly SessionBlock[], phase: SessionState['phase']): SessionState {
  return {
    blocks,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    phase,
  };
}

/**
 * Controller-fake: ao `submit`, dispara uma SEQUÊNCIA de snapshots de estado
 * (incremental, como o controller real publica). Só implementa `subscribe`/`submit`
 * (o que `runHeadlessStreamJson` usa).
 */
function fakeController(steps: readonly (readonly SessionBlock[])[]): SessionController {
  let observer: ((s: SessionState) => void) | null = null;
  const ctrl = {
    subscribe(obs: (s: SessionState) => void): () => void {
      observer = obs;
      // snapshot inicial (idle/boot — não emite evento de fase)
      obs(makeState([], 'idle'));
      return () => {
        observer = null;
      };
    },
    async submit(): Promise<void> {
      for (let i = 0; i < steps.length; i++) {
        const phase: SessionState['phase'] =
          i === 0 ? 'streaming' : i === steps.length - 1 ? 'done' : 'streaming';
        observer?.(makeState(steps[i]!, phase));
      }
    },
    get blocks(): readonly SessionBlock[] {
      return steps.length > 0 ? steps[steps.length - 1]! : [];
    },
  };
  return ctrl as unknown as SessionController;
}

describe('runHeadlessStreamJson — emite eventos NDJSON ao vivo', () => {
  it('emite tool_call + tool_result + text + result para 1 tool + 1 fala', async () => {
    const { out, text } = makeOut();

    // Sequência: [you] → [you + tool running] → [you + tool done + aluy texto]
    // (o bloco `you` não gera evento NDJSON — só tool/aluy/phase/result)
    const controller = fakeController([
      // snapshot 1: só o turno do usuário (you — não emite)
      [{ kind: 'you', text: 'leia o readme' }],
      // snapshot 2: tool iniciou (running)
      [
        { kind: 'you', text: 'leia o readme' },
        { kind: 'tool', verb: 'read', target: 'README.md', result: '', status: 'running' },
      ],
      // snapshot 3: tool concluiu + fala do assistente
      [
        { kind: 'you', text: 'leia o readme' },
        { kind: 'tool', verb: 'read', target: 'README.md', result: '3 linhas', status: 'ok' },
        { kind: 'aluy', text: 'O arquivo tem 3 linhas.', streaming: false },
      ],
    ]);

    const res = await runHeadlessStreamJson(controller, 'leia o readme', out);
    const stdout = text();

    // Cada linha deve ser JSON.parse válido
    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(4);

    const parsed = lines.map((l) => JSON.parse(l));

    // tool_call (verb 'read', status running)
    const toolCall = parsed.find((e: Record<string, unknown>) => e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall!.name).toBe('read');
    expect(toolCall!.status).toBe('running');

    // tool_result (verb 'read', status done)
    const toolResult = parsed.find((e: Record<string, unknown>) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult!.name).toBe('read');
    expect(toolResult!.status).toBe('done');

    // text (fala do assistente)
    const textEvent = parsed.find((e: Record<string, unknown>) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent!.text).toBe('O arquivo tem 3 linhas.');

    // result (final)
    const resultEvent = parsed.find((e: Record<string, unknown>) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.result).toBe('O arquivo tem 3 linhas.');
    expect(resultEvent!.ok).toBe(true);

    // O resultado da função também deve ser coerente
    expect(res.ok).toBe(true);
    expect(res.result).toBe('O arquivo tem 3 linhas.');
  });

  it('emite evento de fase quando o phase muda', async () => {
    const { out, text } = makeOut();

    // Um snapshot com phase 'thinking' antes do streaming
    let observer: ((s: SessionState) => void) | null = null;
    const ctrl = {
      subscribe(obs: (s: SessionState) => void): () => void {
        observer = obs;
        obs(makeState([], 'idle'));
        return () => {
          observer = null;
        };
      },
      async submit(): Promise<void> {
        observer?.(makeState([], 'thinking'));
        observer?.(
          makeState(
            [
              { kind: 'you', text: 'teste' },
              { kind: 'aluy', text: 'ok.', streaming: false },
            ],
            'done',
          ),
        );
      },
      get blocks(): readonly SessionBlock[] {
        return [
          { kind: 'you', text: 'teste' },
          { kind: 'aluy', text: 'ok.', streaming: false },
        ];
      },
    };

    const res = await runHeadlessStreamJson(ctrl as unknown as SessionController, 'teste', out);
    const stdout = text();
    const lines = stdout.trim().split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));

    const phaseEvents = parsed.filter((e: Record<string, unknown>) => e.type === 'phase');
    expect(phaseEvents.length).toBeGreaterThanOrEqual(1);
    // 'idle' e 'boot' NÃO emitem phase; 'thinking' sim
    expect(phaseEvents.some((e: Record<string, unknown>) => e.phase === 'thinking')).toBe(true);

    expect(res.ok).toBe(true);
  });

  it('emite resultado vazio + ok=false em caso de broker-error', async () => {
    const { out, text } = makeOut();

    let observer: ((s: SessionState) => void) | null = null;
    const ctrl = {
      subscribe(obs: (s: SessionState) => void): () => void {
        observer = obs;
        obs(makeState([], 'idle'));
        return () => {
          observer = null;
        };
      },
      async submit(): Promise<void> {
        observer?.(
          makeState([{ kind: 'broker-error', message: 'broker fora', status: 502 }], 'error'),
        );
      },
      get blocks(): readonly SessionBlock[] {
        return [{ kind: 'broker-error', message: 'broker fora', status: 502 }];
      },
    };

    const res = await runHeadlessStreamJson(ctrl as unknown as SessionController, 'teste', out);
    const stdout = text();
    const lines = stdout.trim().split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));

    const errorEvent = parsed.find((e: Record<string, unknown>) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toContain('broker fora');

    const resultEvent = parsed.find((e: Record<string, unknown>) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.ok).toBe(false);
    expect(resultEvent!.result).toBe('');

    expect(res.ok).toBe(false);
    expect(res.diagnostic).toContain('broker fora');
  });

  it('não emite texto para blocos you (só tool/aluy/phase/result)', async () => {
    const { out, text } = makeOut();

    const controller = fakeController([
      [{ kind: 'you', text: 'comando' }],
      [
        { kind: 'you', text: 'comando' },
        { kind: 'aluy', text: 'feito.', streaming: false },
      ],
    ]);

    const res = await runHeadlessStreamJson(controller, 'comando', out);
    const stdout = text();
    const lines = stdout.trim().split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));

    // NENHUM evento com type 'text' contendo "comando" (você)
    const youTexts = parsed.filter(
      (e: Record<string, unknown>) =>
        e.type === 'text' && typeof e.text === 'string' && e.text.includes('comando'),
    );
    expect(youTexts).toHaveLength(0);

    // O texto do assistente deve aparecer
    const texts = parsed.filter((e: Record<string, unknown>) => e.type === 'text');
    expect(texts.some((e: Record<string, unknown>) => e.text === 'feito.')).toBe(true);

    expect(res.ok).toBe(true);
  });
});
