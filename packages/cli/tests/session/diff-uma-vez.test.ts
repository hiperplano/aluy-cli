// F22 — o diff do edit aparece UMA vez: na caixa de permissão (quando perguntou) ou no bloco da
// tool (quando auto-aprovado/yolo). E os marcadores são `+`/`-`.
import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';
import { SessionController, ehEcoDeAutoVerificacao } from '../../src/session/controller.js';
import { UNICODE_GLYPHS } from '../../src/ui/theme/glyphs.js';

function novo(): SessionController {
  return new SessionController({
    model: {
      async call() {
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    },
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: {} as never,
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

type Interno = {
  diffJaMostradoNoAsk: boolean;
  resolveToolLine(l: Record<string, unknown>): void;
};
const linha = {
  kind: 'tool',
  verb: 'editar',
  target: 'a.ts',
  result: '+1 -1',
  status: 'ok',
  added: 1,
  removed: 1,
  diff: '-a\n+b',
};

describe('F22 — diff uma vez', () => {
  it('auto-aprovado (sem caixa): o bloco da tool mostra o diff', () => {
    const c = novo();
    (c as unknown as Interno).resolveToolLine({ ...linha });
    const b = c.current.blocks.find((x) => x.kind === 'tool');
    expect(b && 'diff' in b ? b.diff : undefined).toBe('-a\n+b');
    c.dispose();
  });

  it('já mostrado na caixa de permissão: o bloco NÃO repete (mantém o +/−)', () => {
    const c = novo();
    (c as unknown as Interno).diffJaMostradoNoAsk = true;
    (c as unknown as Interno).resolveToolLine({ ...linha });
    const b = c.current.blocks.find((x) => x.kind === 'tool') as Record<string, unknown>;
    expect(b['diff']).toBeUndefined();
    expect(b['added']).toBe(1);
    expect((c as unknown as Interno).diffJaMostradoNoAsk).toBe(false);
    c.dispose();
  });

  it('marcadores do diff são + e -', () => {
    expect(UNICODE_GLYPHS.diffAdd).toBe('+');
    expect(UNICODE_GLYPHS.diffDel).toBe('-');
  });
});

describe('auto-verificação — nada do probe vaza como resposta', () => {
  it('reconhece o eco do probe', () => {
    expect(ehEcoDeAutoVerificacao('AUTO-VERIFICAÇÃO (passada 2/2) — confira…')).toBe(true);
    expect(ehEcoDeAutoVerificacao('  auto-verificacao antes de concluir')).toBe(true);
    expect(ehEcoDeAutoVerificacao('Pronto, ajustei o arquivo.')).toBe(false);
  });

  it('bloco de verificação que só ecoou o probe some ao ser promovido', () => {
    const c = novo();
    (c as unknown as { patch(p: object): void }).patch({
      blocks: [
        { kind: 'you', text: 'faça' },
        {
          kind: 'aluy',
          text: 'AUTO-VERIFICAÇÃO (passada 2/2) — …',
          streaming: true,
          selfCheck: true,
        },
      ],
    });
    (c as unknown as { demoteSelfCheckBlock(): void }).demoteSelfCheckBlock();
    expect(c.current.blocks.map((b) => b.kind)).toEqual(['you']);
    c.dispose();
  });
});
