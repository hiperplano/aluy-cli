// EST-0944 (refino #121) — VISIBILIDADE do self-check no controller (TUI).
//
// O bug visto em uso (Tiago): (1) a auto-verificação disparava até num "olá" (turno
// trivial, sem ação a conferir) e (2) o RACIOCÍNIO da verificação ("EVIDÊNCIA que você
// REALMENTE viu… está cumprido") VAZAVA pra tela como um bloco `Λ aluy`, como se fosse
// a resposta. Estas provas (broker mockado, sem rede, sem modelo real) cobrem o lado
// da TUI do fix:
//
//  1. turno CONVERSACIONAL puro (0 tools) com self-check ON ⇒ NÃO há nota de
//     self-check, NÃO há verificação, a resposta aparece como `aluy` normal e encerra;
//  2. turno COM tool ⇒ a verificação roda, MAS a tagarelice de verificação NÃO vira um
//     bloco `aluy` visível (no máximo a nota dim "✓ auto-verificado"); a RESPOSTA REAL
//     (a `final` anterior) permanece visível;
//  3. o gating/segurança do #121 segue intacto (o self-check só liga quando configurado).
//
// NÃO regride o streaming token-a-token (#121 mecânica), o btw (#100), o watchdog (0969).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type SelfCheckConfig,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

function fakePorts(files: Record<string, string> = {}): ToolPorts {
  const fs: FileSystemPort = {
    async readFile(p) {
      if (p in files) return files[p]!;
      throw new Error(`não existe: ${p}`);
    },
    async writeFile() {},
    async exists(p) {
      return p in files;
    },
  };
  const shell: ShellPort = {
    async exec(command) {
      return { stdout: `ran: ${command}`, stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

/** Caller scriptado: emite cada resposta como deltas no sink (simula o stream). */
function scriptedCaller(responses: readonly string[], sink: StreamSink): ModelCaller {
  let turn = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const content = responses[Math.min(turn, responses.length - 1)] ?? '';
      turn += 1;
      sink.onStart?.();
      for (const ch of content) sink.onDelta(ch);
      sink.onUsage?.({ request_id: 'r', tier: 'custom', tokens_in: 5, tokens_out: 5 });
      sink.onDone?.();
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
}

function build(opts: {
  responses: readonly string[];
  files?: Record<string, string>;
  selfCheck: SelfCheckConfig;
}): SessionController {
  const ports = fakePorts(opts.files);
  const engine = new PolicyPermissionEngine();
  let ctrlRef: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ctrlRef?.sink.onStart?.(),
    onDelta: (c) => ctrlRef?.sink.onDelta(c),
    onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
    onDone: () => ctrlRef?.sink.onDone?.(),
  };
  const model = scriptedCaller(opts.responses, sink);
  const controller = new SessionController({
    model,
    permission: engine,
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'custom', tokens: 0, windowPct: 0 },
    // desliga o watchdog de travamento (alguns scripts repetem finais de propósito).
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
    selfCheck: opts.selfCheck,
  });
  ctrlRef = controller;
  return controller;
}

const aluyBlocks = (c: SessionController): { text: string }[] =>
  c.current.blocks.filter(
    (b): b is { kind: 'aluy'; text: string; streaming: boolean } => b.kind === 'aluy',
  );
const selfCheckNotes = (c: SessionController): unknown[] =>
  c.current.blocks.filter((b) => b.kind === 'note' && b.title === 'self-check');

describe('EST-0944 (refino #121) · TUI — turno TRIVIAL não dispara verificação', () => {
  it('"olá" (0 tools) com self-check ON ⇒ sem verificação, sem nota, resposta visível', async () => {
    const c = build({
      responses: ['Olá! Como posso ajudar?'],
      selfCheck: { enabled: true, reanchorEveryK: 8, maxVerifications: 2 },
    });
    await c.submit('olá');
    // a saudação aparece como um bloco `aluy` NORMAL (a resposta de fato):
    const aluy = aluyBlocks(c);
    expect(aluy).toHaveLength(1);
    expect(aluy[0]!.text).toContain('Olá!');
    // NENHUMA nota de self-check (não houve verificação — nada a conferir):
    expect(selfCheckNotes(c)).toHaveLength(0);
    expect(c.current.phase).toBe('done');
  });
});

describe('EST-0944 (refino #121) · TUI — verificação NÃO vaza como bloco aluy', () => {
  it('turno COM tool: a tagarelice de verificação some; a resposta REAL fica visível', async () => {
    const c = build({
      files: { 'a.txt': 'conteúdo' },
      responses: [
        toolCall('read_file', { path: 'a.txt' }), // AÇÃO REAL
        'Pronto — li o arquivo e está tudo certo.', // final REAL (visível)
        'EVIDÊNCIA que eu REALMENTE vi: conferido, está cumprido.', // verificação (esconder)
      ],
      selfCheck: { enabled: true, reanchorEveryK: 1000, maxVerifications: 1 },
    });
    await c.submit('leia a.txt');
    const aluy = aluyBlocks(c);
    // SÓ a resposta REAL é um bloco `aluy` visível — a tagarelice de verificação NÃO:
    const texts = aluy.map((b) => b.text);
    expect(texts.some((t) => t.includes('Pronto — li o arquivo'))).toBe(true);
    expect(texts.some((t) => t.includes('EVIDÊNCIA que eu REALMENTE vi'))).toBe(false);
    expect(texts.some((t) => t.includes('está cumprido'))).toBe(false);
    // no MÁXIMO uma nota dim de self-check (rastro discreto):
    expect(selfCheckNotes(c).length).toBeLessThanOrEqual(1);
    expect(selfCheckNotes(c)).toHaveLength(1);
    expect(c.current.phase).toBe('done');
  });

  it('a RESPOSTA entregue (último bloco aluy) é a real, não a verificação', async () => {
    const c = build({
      files: { 'a.txt': 'x' },
      responses: [
        toolCall('read_file', { path: 'a.txt' }),
        'Feito: a tarefa está concluída.',
        'Confirmo que está tudo cumprido conforme a evidência.',
      ],
      selfCheck: { enabled: true, reanchorEveryK: 1000, maxVerifications: 1 },
    });
    await c.submit('faça');
    const aluy = aluyBlocks(c);
    // o ÚLTIMO bloco aluy visível é a resposta REAL — nunca a confirmação de verificação:
    expect(aluy[aluy.length - 1]!.text).toContain('Feito: a tarefa está concluída');
    expect(aluy.map((b) => b.text).join(' ')).not.toContain('Confirmo que está tudo cumprido');
  });
});

describe('EST-0944 (refino #121) · TUI — OFF por default não muda nada', () => {
  it('self-check OFF ⇒ a resposta conversacional aparece igual ao baseline', async () => {
    const c = build({
      responses: ['resposta normal.'],
      selfCheck: { enabled: false, reanchorEveryK: 8, maxVerifications: 2 },
    });
    await c.submit('oi');
    const aluy = aluyBlocks(c);
    expect(aluy).toHaveLength(1);
    expect(aluy[0]!.text).toContain('resposta normal');
    expect(selfCheckNotes(c)).toHaveLength(0);
  });
});
