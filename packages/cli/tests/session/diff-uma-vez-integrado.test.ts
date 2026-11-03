// Auditoria — F22 ponta a ponta: o diff do `edit_file` aparece UMA vez. O teste antigo ligava a
// flag privada na mão; aqui o fluxo é real: o edit pergunta (a caixa mostra o diff) ⇒ o bloco
// da tool NÃO repete o diff; negado ⇒ o próximo edit auto-aprovado volta a mostrar no bloco.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const edit = (): string =>
  `<<<ALUY_TOOL_CALL\n${JSON.stringify({
    name: 'edit_file',
    input: { path: 'a.txt', old_string: 'velho', new_string: 'novo' },
  })}\nALUY_TOOL_CALL>>>`;

function montar(opts: { unsafe?: boolean; respostas: string[] }) {
  let i = 0;
  const arquivos = new Map([['a.txt', 'linha velho aqui\n']]);
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      const content = opts.respostas[i] ?? 'pronto.';
      i += 1;
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
  const ports = {
    fs: {
      async readFile(p: string) {
        return arquivos.get(p) ?? '';
      },
      async writeFile(p: string, c: string) {
        arquivos.set(p, c);
      },
      async exists(p: string) {
        return arquivos.has(p);
      },
    },
    shell: {
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
  } as unknown as ToolPorts;
  const c = new SessionController({
    model,
    permission: new PolicyPermissionEngine({
      ...(opts.unsafe ? { mode: 'unsafe' as const } : {}),
      diffPreview: (p, novo, velho) => `${p}\n-${velho ?? ''}\n+${novo}`,
    }),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
    flush: { intervalMs: 0 },
  });
  return { c, arquivos };
}

async function esperarAsk(c: SessionController): Promise<void> {
  const fim = Date.now() + 3000;
  while (c.current.phase !== 'asking') {
    if (Date.now() > fim) throw new Error('a caixa não abriu');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tools = (c: SessionController) =>
  c.current.blocks.filter((b) => b.kind === 'tool') as Array<Record<string, unknown>>;

describe('F22 · diff uma vez (fluxo real)', () => {
  it('com caixa de permissão: a caixa traz o diff e o bloco da tool NÃO o repete (mantém +/−)', async () => {
    const { c, arquivos } = montar({ respostas: [edit(), 'feito.'] });
    const turno = c.submit('troque');
    await esperarAsk(c);
    expect(c.current.pendingAsk?.request.effect.kind).toBe('diff');
    c.resolveAsk({ kind: 'approve-once' });
    await turno;
    expect(arquivos.get('a.txt')).toContain('novo');
    const t = tools(c)[0]!;
    expect(t['diff']).toBeUndefined();
    expect(t['added']).toBeGreaterThan(0);
    c.dispose();
  });

  it('auto-aprovado (sem caixa): o bloco da tool é a ÚNICA vez e traz o diff', async () => {
    const { c } = montar({ unsafe: true, respostas: [edit(), 'feito.'] });
    await c.submit('troque');
    const t = tools(c)[0]!;
    expect(typeof t['diff']).toBe('string');
    expect(String(t['diff'])).toContain('novo');
    c.dispose();
  });

  it('negado na caixa: a flag não vaza — o próximo edit sem caixa volta a mostrar o diff no bloco', async () => {
    const { c } = montar({ respostas: [edit(), 'ok.'] });
    const turno = c.submit('troque');
    await esperarAsk(c);
    c.resolveAsk({ kind: 'deny', reason: 'não' });
    await turno;
    // um edit seguinte que NÃO passa pela caixa (resolve direto a linha da tool):
    (c as unknown as { resolveToolLine(l: Record<string, unknown>): void }).resolveToolLine({
      kind: 'tool',
      verb: 'editar',
      target: 'b.ts',
      result: '+1 -1',
      status: 'ok',
      added: 1,
      removed: 1,
      diff: '-a\n+b',
    });
    const ultimo = tools(c).at(-1)!;
    expect(ultimo['diff']).toBe('-a\n+b');
    c.dispose();
  });

  it('interromper na caixa (esc) e começar outro turno: a flag do turno anterior não vaza', async () => {
    const { c } = montar({ respostas: [edit(), 'ok.', 'segundo turno.'] });
    const turno = c.submit('troque');
    await esperarAsk(c);
    c.interruptFromPrompt(); // esc na caixa: a tool nunca chega a resolver a linha
    await turno;
    await c.submit('outro');
    (c as unknown as { resolveToolLine(l: Record<string, unknown>): void }).resolveToolLine({
      kind: 'tool',
      verb: 'editar',
      target: 'b.ts',
      result: '+1 -1',
      status: 'ok',
      added: 1,
      removed: 1,
      diff: '-a\n+b',
    });
    expect(tools(c).at(-1)!['diff']).toBe('-a\n+b');
    c.dispose();
  });
});
