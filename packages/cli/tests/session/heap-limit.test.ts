// EST-1012 — ROBUSTEZ DE MEMÓRIA · HEAP-LIMIT EXPLÍCITO no launcher. Provas (sem
// spawnar de verdade — porta de re-exec mockada):
//
//  1. SEM teto no env ⇒ planeja re-exec com `--max-old-space-size=<teto>` anexado ao
//     NODE_OPTIONS, e a sentinela `ALUY_HEAP_LIMIT_APPLIED` no env do filho;
//  2. teto JÁ presente no NODE_OPTIONS (operador) ⇒ NÃO re-exec (respeita a escolha);
//  3. sentinela presente (já re-exec-amos) ⇒ NÃO re-exec (idempotente, sem loop);
//  4. `ALUY_MAX_HEAP_MB` controla o valor aplicado;
//  5. FAIL-OPEN: re-exec falho (porta devolve undefined / lança) ⇒ segue sem teto.

import { describe, expect, it } from 'vitest';
import {
  planHeapLimit,
  applyHeapLimit,
  existingMaxOldSpaceMb,
  HEAP_LIMIT_APPLIED_ENV,
  type HeapLimitPorts,
} from '../../src/bin/heap-limit.js';
import { DEFAULT_MAX_HEAP_MB } from '@aluy/cli-core';

describe('existingMaxOldSpaceMb', () => {
  it('extrai o teto JÁ posto no NODE_OPTIONS (forma =N)', () => {
    expect(existingMaxOldSpaceMb('--max-old-space-size=3000')).toBe(3000);
    expect(existingMaxOldSpaceMb('--foo --max-old-space-size=512 --bar')).toBe(512);
  });
  it('ausente/forma separada/inválido ⇒ undefined', () => {
    expect(existingMaxOldSpaceMb('')).toBeUndefined();
    expect(existingMaxOldSpaceMb(undefined)).toBeUndefined();
    expect(existingMaxOldSpaceMb('--max-old-space-size 4096')).toBeUndefined(); // espaço não conta
    expect(existingMaxOldSpaceMb('--other-flag')).toBeUndefined();
  });
});

describe('planHeapLimit', () => {
  it('SEM teto e SEM sentinela ⇒ re-exec com a flag anexada + teto default', () => {
    const plan = planHeapLimit({});
    expect(plan.shouldReexec).toBe(true);
    expect(plan.heapLimitMb).toBe(DEFAULT_MAX_HEAP_MB);
    expect(plan.nodeOptions).toBe(`--max-old-space-size=${DEFAULT_MAX_HEAP_MB}`);
  });

  it('preserva o NODE_OPTIONS existente ao anexar', () => {
    const plan = planHeapLimit({ NODE_OPTIONS: '--enable-source-maps' });
    expect(plan.shouldReexec).toBe(true);
    expect(plan.nodeOptions).toBe(
      `--enable-source-maps --max-old-space-size=${DEFAULT_MAX_HEAP_MB}`,
    );
  });

  it('ALUY_MAX_HEAP_MB controla o valor aplicado', () => {
    const plan = planHeapLimit({ ALUY_MAX_HEAP_MB: '2048' });
    expect(plan.heapLimitMb).toBe(2048);
    expect(plan.nodeOptions).toBe('--max-old-space-size=2048');
  });

  it('teto JÁ no NODE_OPTIONS (operador) ⇒ NÃO re-exec; usa o teto dele', () => {
    const plan = planHeapLimit({ NODE_OPTIONS: '--max-old-space-size=8000' });
    expect(plan.shouldReexec).toBe(false);
    expect(plan.heapLimitMb).toBe(8000);
  });

  it('sentinela presente (já re-exec-amos) ⇒ NÃO re-exec (idempotente)', () => {
    const plan = planHeapLimit({ [HEAP_LIMIT_APPLIED_ENV]: '1' });
    expect(plan.shouldReexec).toBe(false);
  });
});

describe('applyHeapLimit — efeito via porta mockada', () => {
  function ports(
    env: Record<string, string | undefined>,
    reexec: HeapLimitPorts['reexec'],
    extra: Partial<HeapLimitPorts> = {},
  ): HeapLimitPorts {
    return {
      env,
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/app/aluy.js', 'goal'],
      reexec,
      ...extra,
    };
  }

  it('re-exec dispara com a flag + sentinela, propaga argv e ENCERRA com o código do filho', async () => {
    let captured: {
      exec: string;
      args: readonly string[];
      env: Record<string, string | undefined>;
    } | null = null;
    let exitCode: number | null = null;
    const res = await applyHeapLimit(
      ports(
        {},
        (exec, args, e) => {
          captured = { exec, args, env: e };
          return 0; // filho saiu 0
        },
        { exit: (c) => (exitCode = c) },
      ),
    );
    expect(res.reexeced).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.exec).toBe('/usr/bin/node');
    // argv re-exec = [script, ...userArgs] (sem o execPath duplicado)
    expect(captured!.args).toEqual(['/app/aluy.js', 'goal']);
    expect(captured!.env.NODE_OPTIONS).toContain('--max-old-space-size=');
    expect(captured!.env[HEAP_LIMIT_APPLIED_ENV]).toBe('1');
    expect(exitCode).toBe(0); // encerrou o pai com o código do filho
  });

  it('async: aguarda o filho (Promise) antes de encerrar com o código', async () => {
    let exitCode: number | null = null;
    const res = await applyHeapLimit(ports({}, async () => 3, { exit: (c) => (exitCode = c) }));
    expect(res.reexeced).toBe(true);
    expect(exitCode).toBe(3);
  });

  it('PRESERVA os execArgv (--require) ANTES do script no re-exec', async () => {
    let captured: readonly string[] = [];
    await applyHeapLimit(
      ports(
        {},
        (_e, args) => {
          captured = args;
          return 0;
        },
        { execArgv: ['--require', '/preload.cjs'], exit: () => {} },
      ),
    );
    expect(captured).toEqual(['--require', '/preload.cjs', '/app/aluy.js', 'goal']);
  });

  it('nada a fazer (sentinela) ⇒ não chama a porta', async () => {
    let called = false;
    const res = await applyHeapLimit(
      ports({ [HEAP_LIMIT_APPLIED_ENV]: '1' }, () => {
        called = true;
        return 0;
      }),
    );
    expect(res.reexeced).toBe(false);
    expect(called).toBe(false);
  });

  it('FAIL-OPEN: porta devolve undefined (spawn falhou) ⇒ segue sem teto', async () => {
    const res = await applyHeapLimit(ports({}, () => undefined));
    expect(res.reexeced).toBe(false);
  });

  it('FAIL-OPEN: porta LANÇA ⇒ não derruba o boot (reexeced false)', async () => {
    const res = await applyHeapLimit(
      ports({}, () => {
        throw new Error('spawn boom');
      }),
    );
    expect(res.reexeced).toBe(false);
  });
});
