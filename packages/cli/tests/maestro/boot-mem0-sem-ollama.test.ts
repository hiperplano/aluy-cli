// O mem0 usa o Ollama como embedder. Com o Ollama fora, spawnar o mem0 só produz um servidor
// que falha — e (bug de rc.190) "curava" o store movendo-o. O supervisor agora PULA o mem0
// com motivo claro quando o Ollama do boot não subiu, e o aviso honesto é entregue UMA vez.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { PathLike } from 'node:fs';
import {
  NodeBootSupervisor,
  type BootFileSystem,
  type FetchFn,
  type SpawnFn,
  type TimerPort,
} from '../../src/maestro/boot-supervisor.js';
import {
  __resetSemanticMemoryNotice,
  noticeSemanticMemoryDown,
  onSemanticMemoryNotice,
  semanticMemoryDownLines,
} from '../../src/maestro/semantic-memory-notice.js';
import { MEM0_PORT, OLLAMA_PORT, type SidecarTarget } from '@hiperplano/aluy-cli-core';

const child = (pid: number): ChildProcess =>
  ({ pid, kill: vi.fn(), unref: vi.fn() }) as unknown as ChildProcess;
const timer: TimerPort = {
  setTimeout(fn) {
    void Promise.resolve().then(fn);
    return 0;
  },
  clearTimeout() {},
};
const fsAll: BootFileSystem = {
  existsSync: (p: PathLike) => String(p).length > 0,
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
};
const both = new Set<SidecarTarget>(['ollama', 'mem0']);

function boot(fetchFn: FetchFn, spawn: SpawnFn) {
  const sup = new NodeBootSupervisor({ spawn, fetchFn, uid: 1000, fs: fsAll, timer });
  return sup.boot('turbo', both, undefined, '/h/.aluy/ollama', '/h/.aluy/mem-venv');
}

afterEach(() => __resetSemanticMemoryNotice());

describe('boot: mem0 depende do Ollama', () => {
  it('Ollama não sobe ⇒ mem0 NÃO é spawnado e o motivo é explícito', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false }));
    const spawn = vi.fn<SpawnFn>(() => child(1));
    const r = await boot(fetchFn, spawn);
    const mem0 = r.states.find((s) => s.kind === 'mem0')!;
    expect(mem0.running).toBe(false);
    expect(mem0.error).toContain('ollama indisponível');
    expect(mem0.error).toContain('store intacto');
    const spawnedMem0 = spawn.mock.calls.some((c) =>
      String(c[1]?.[0] ?? '').includes('mem0-server'),
    );
    expect(spawnedMem0).toBe(false);
  });

  it('Ollama sobe ⇒ mem0 É spawnado (não-regressão)', async () => {
    const up = new Set<number>();
    const spawn = vi.fn<SpawnFn>((_bin: string, args: string[]) => {
      if (String(args[0] ?? '').includes('mem0-server')) up.add(MEM0_PORT);
      else up.add(OLLAMA_PORT);
      return child(2);
    });
    const fetchFn = vi.fn<FetchFn>(async (url: string) => {
      const port = Number(new URL(url).port);
      const ok = up.has(port);
      return { ok, text: async () => (port === OLLAMA_PORT ? '{"models":[]}' : '{"ok":true}') };
    });
    const r = await boot(fetchFn, spawn);
    expect(r.states.find((s) => s.kind === 'ollama')!.running).toBe(true);
    expect(r.states.find((s) => s.kind === 'mem0')!.running).toBe(true);
  });

  it('mem0 já de pé (processo anterior) mesmo com Ollama fora ⇒ não é derrubado nem pulado', async () => {
    const fetchFn = vi.fn<FetchFn>(async (url: string) => {
      const port = Number(new URL(url).port);
      return { ok: port === MEM0_PORT, text: async () => '{"ok":true}' };
    });
    const spawn = vi.fn<SpawnFn>(() => child(3));
    const r = await boot(fetchFn, spawn);
    expect(r.states.find((s) => s.kind === 'mem0')!.running).toBe(true);
  });
});

describe('aviso honesto de memória semântica indisponível', () => {
  it('diz o que houve, que os dados estão a salvo e como religar', () => {
    const t = semanticMemoryDownLines('o Ollama não respondeu').join(' ');
    expect(t).toContain('o Ollama não respondeu');
    expect(t).toContain('NÃO foram tocados');
    expect(t).toContain('/doctor fix');
  });

  it('entrega UMA vez só (sem spam), mesmo com várias notificações', () => {
    const got: string[][] = [];
    onSemanticMemoryNotice((l) => got.push([...l]));
    noticeSemanticMemoryDown('a');
    noticeSemanticMemoryDown('b');
    expect(got).toHaveLength(1);
  });

  it('aviso que chega ANTES da TUI se inscrever fica retido e é entregue na inscrição', () => {
    noticeSemanticMemoryDown('x');
    const got: string[][] = [];
    onSemanticMemoryNotice((l) => got.push([...l]));
    expect(got).toHaveLength(1);
  });

  it('headless escreve no stderr (único canal) e não retém', () => {
    const w = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    noticeSemanticMemoryDown('o Ollama não respondeu', { headless: true });
    expect(w).toHaveBeenCalledTimes(1);
    w.mockRestore();
  });
});
