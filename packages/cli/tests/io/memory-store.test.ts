// EST-0983 · ADR-0064 · CLI-SEC-15 — I/O CONCRETO da memória (gate FORTE).
//
// Bateria (parte concreta): porta ESTREITA (append/remove/update por escopo, sem
// path); 0600/0700 ATÔMICO (R5); GLOBAL em `~/.aluy/memory/` (FORA do workspace);
// PROJETO em `<workspace>/.aluy/memory/` (DENTRO, confinado); round-trip do `.md`
// humano-editável (id/proveniência/pin/texto). Tudo sobre tmpdir — a suíte NUNCA
// toca a memória real do dev.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeMemoryStore } from '../../src/io/memory-store.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import type { MemoryFact } from '@hiperplano/aluy-cli-core';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function fact(over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: over.id ?? 'aaa1111',
    text: over.text ?? 'o usuário prefere pnpm',
    scope: over.scope ?? 'global',
    provenance: over.provenance ?? 'usuario',
    pinned: over.pinned ?? false,
    ts: over.ts ?? 1000,
  };
}

describe('NodeMemoryStore — escopos, atomicidade e round-trip', () => {
  let base: string;
  let memBase: string; // ~/.aluy simulado
  let workspaceRoot: string;
  let store: NodeMemoryStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-mem-'));
    memBase = join(base, 'home', '.aluy');
    workspaceRoot = join(base, 'project');
    mkdirSync(workspaceRoot, { recursive: true });
    const workspace = new NodeWorkspace({ root: workspaceRoot });
    store = new NodeMemoryStore({ workspace, baseDir: memBase });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('GLOBAL escreve em ~/.aluy/memory/ (FORA do workspace) com 0700/0600 ATÔMICO', async () => {
    await store.append(fact({ scope: 'global', text: 'usa pnpm' }));
    const memDir = join(memBase, 'memory');
    expect(existsSync(memDir)).toBe(true);
    expect(mode(memDir)).toBe(0o700);
    expect(mode(store.paths.global)).toBe(0o600);
    // o arquivo NÃO está dentro do workspace (read/write-deny do agente cobre ~/.aluy/).
    expect(store.paths.global.startsWith(workspaceRoot)).toBe(false);
    // round-trip
    const all = await store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ scope: 'global', text: 'usa pnpm', provenance: 'usuario' });
  });

  it('PROJETO escreve em <workspace>/.aluy/memory/ (DENTRO do workspace)', async () => {
    await store.append(
      fact({ scope: 'projeto', text: 'testes com vitest', provenance: 'derivado' }),
    );
    expect(store.paths.project.startsWith(workspaceRoot)).toBe(true);
    expect(existsSync(store.paths.project)).toBe(true);
    expect(mode(store.paths.project)).toBe(0o600);
    const all = await store.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ scope: 'projeto', text: 'testes com vitest' });
  });

  it('os escopos são ISOLADOS — global e projeto em arquivos distintos', async () => {
    await store.append(fact({ id: 'g111111', scope: 'global', text: 'global fato' }));
    await store.append(fact({ id: 'p222222', scope: 'projeto', text: 'projeto fato' }));
    const all = await store.readAll();
    expect(all.map((f) => f.scope).sort()).toEqual(['global', 'projeto']);
    // o arquivo global NÃO contém o fato de projeto e vice-versa
    expect(readFileSync(store.paths.global, 'utf8')).toContain('global fato');
    expect(readFileSync(store.paths.global, 'utf8')).not.toContain('projeto fato');
    expect(readFileSync(store.paths.project, 'utf8')).toContain('projeto fato');
  });

  it('round-trip de proveniência + pin (o `.md` é humano-editável, a meta sobrevive)', async () => {
    await store.append(
      fact({ id: 'pin1111', text: 'rode deploy', provenance: 'derivado', pinned: true }),
    );
    const all = await store.readAll();
    expect(all[0]).toMatchObject({ provenance: 'derivado', pinned: true, text: 'rode deploy' });
    // o `.md` é legível e marca o pin visualmente
    const md = readFileSync(store.paths.global, 'utf8');
    expect(md).toContain('# Memória do Aluy Cli');
    expect(md).toContain('📌');
    expect(md).toContain('aluy-mem'); // o comentário de metadata
  });

  it('update troca texto/pin do mesmo id; remove apaga; idempotente', async () => {
    await store.append(fact({ id: 'upd1111', text: 'antigo', scope: 'global' }));
    await store.update(fact({ id: 'upd1111', text: 'novo', pinned: true, scope: 'global' }));
    let all = await store.readAll();
    expect(all[0]).toMatchObject({ text: 'novo', pinned: true });

    await store.remove('upd1111');
    all = await store.readAll();
    expect(all).toHaveLength(0);
    // remover de novo não lança (idempotente)
    await expect(store.remove('upd1111')).resolves.toBeUndefined();
  });

  it('arquivo ausente ⇒ readAll vazio (fail-safe), sem lançar', async () => {
    expect(await store.readAll()).toEqual([]);
  });

  // #7 — o `.md` é humano-editável (Q5): a meta `<!--aluy-mem {...}-->` pode vir
  // ADULTERADA. Antes, `meta` era castada `as {...; ts: number}` sem checar ⇒ um
  // `"ts":"abc"` propagava string no `MemoryFact.ts` (usado em ordenação/exibição).
  // Linha com meta inválida ⇒ DESCARTADA (não propaga sujo, não derruba o resto).
  describe('#7 — meta adulterada no .md é validada (descarta o fato sujo)', () => {
    // Escreve um global.md cru com fatos arbitrários (controla a meta byte a byte).
    function writeRawGlobal(lines: readonly string[]): void {
      const memDir = join(memBase, 'memory');
      mkdirSync(memDir, { recursive: true });
      const header = ['# Memória do Aluy Cli — global', '', '## Fatos', ''];
      writeFileSync(join(memDir, 'global.md'), [...header, ...lines, ''].join('\n'), 'utf8');
    }
    const goodMeta = (over: Record<string, unknown> = {}) =>
      JSON.stringify({ id: 'ok11111', p: 'usuario', pin: false, ts: 1000, ...over });

    it('ts NÃO-numérico ("abc") ⇒ fato descartado (não propaga string em .ts)', async () => {
      writeRawGlobal([
        `- fato bom <!--aluy-mem ${goodMeta()}-->`,
        `- fato sujo <!--aluy-mem ${goodMeta({ id: 'bad1111', ts: 'abc' })}-->`,
      ]);
      const all = await store.readAll();
      // só o bom sobrevive; o sujo (ts:"abc") sumiu.
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe('ok11111');
      expect(typeof all[0]!.ts).toBe('number');
      // nenhum fato carregado tem ts não-numérico.
      expect(all.every((f) => typeof f.ts === 'number' && Number.isFinite(f.ts))).toBe(true);
    });

    it('ts AUSENTE (undefined) ⇒ descartado', async () => {
      writeRawGlobal([`- sem ts <!--aluy-mem {"id":"noTs111","p":"usuario","pin":false}-->`]);
      expect(await store.readAll()).toHaveLength(0);
    });

    it('id ausente/não-string ⇒ descartado', async () => {
      writeRawGlobal([
        `- id numérico <!--aluy-mem ${goodMeta({ id: 42 })}-->`,
        `- sem id <!--aluy-mem {"p":"usuario","pin":false,"ts":5}-->`,
      ]);
      expect(await store.readAll()).toHaveLength(0);
    });

    it('uma linha suja NÃO derruba a leitura das demais (fail-safe por linha)', async () => {
      writeRawGlobal([
        `- bom 1 <!--aluy-mem ${goodMeta({ id: 'good001', ts: 1 })}-->`,
        `- sujo <!--aluy-mem {bad json-->`,
        `- bom 2 <!--aluy-mem ${goodMeta({ id: 'good002', ts: 2 })}-->`,
      ]);
      const all = await store.readAll();
      expect(all.map((f) => f.id).sort()).toEqual(['good001', 'good002']);
    });
  });

  // EST-0983 — `clearAll` (ação do USUÁRIO via `/clear full|memory`): apaga os fatos,
  // confinado a `memory/`, atômico, sem path arbitrário.
  describe('clearAll — `/clear full|memory` (ação do usuário, confinada)', () => {
    it('sem escopo apaga AMBOS (global + projeto), mantendo o .md vazio e 0600', async () => {
      await store.append(fact({ id: 'g0000001', scope: 'global', text: 'fato global' }));
      await store.append(fact({ id: 'p0000001', scope: 'projeto', text: 'fato projeto' }));
      expect(await store.readAll()).toHaveLength(2);

      await store.clearAll();
      expect(await store.readAll()).toHaveLength(0);
      // o `.md` continua existindo (artefato versionável), só sem fatos — e 0600 atômico.
      expect(existsSync(store.paths.global)).toBe(true);
      expect(mode(store.paths.global)).toBe(0o600);
      expect(readFileSync(store.paths.global, 'utf8')).toContain('_(vazio)_');
    });

    it('com escopo apaga SÓ aquele escopo (o outro fica intacto)', async () => {
      await store.append(fact({ id: 'g0000002', scope: 'global', text: 'global fica?' }));
      await store.append(fact({ id: 'p0000002', scope: 'projeto', text: 'projeto some' }));

      await store.clearAll('projeto');
      const all = await store.readAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ scope: 'global', text: 'global fica?' });
    });

    it('memória já vazia ⇒ idempotente, não lança', async () => {
      await expect(store.clearAll()).resolves.toBeUndefined();
      expect(await store.readAll()).toEqual([]);
    });

    it('toca SÓ os arquivos de memory/ — não escreve fora (confinamento GS-M1)', async () => {
      await store.append(fact({ id: 'g0000003', scope: 'global', text: 'x' }));
      await store.clearAll();
      // os únicos arquivos sob ~/.aluy são os de memory/ (nada criado fora — sem path arbitrário).
      const globalDir = join(memBase, 'memory');
      expect(store.paths.global.startsWith(globalDir)).toBe(true);
      // o projeto fica DENTRO do workspace (confinado), nunca fora.
      expect(store.paths.project.startsWith(workspaceRoot)).toBe(true);
    });
  });
});

// ── HUNT-PERSIST (round-trip infiel — fato CORROMPIDO/PERDIDO no write→read) ─────────
// O fato é UMA linha `.md`, mas o `text` pode conter `\n` (a tool `remember` só faz
// `.trim()`, que NÃO remove quebra interna) E pode conter o próprio marcador
// `<!--aluy-mem {...}-->`. Antes do fix:
//   · um `\n` virava 2+ linhas no disco ⇒ a releitura (split('\n') + regex por linha) só
//     casava a ÚLTIMA ⇒ o fato voltava com o texto TRUNCADO (linhas iniciais sumiam);
//   · um marcador literal no texto fazia o regex casar o FALSO marcador ⇒ id/ts errados
//     ⇒ fato descartado.
// O fix ESCAPA o texto numa linha segura e DESESCAPA na leitura (round-trip byte-a-byte).
describe('HUNT-PERSIST — memória round-trippa texto adversarial (newline/marcador/escape)', () => {
  let base: string;
  let store: NodeMemoryStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-mem-rt-'));
    const workspaceRoot = join(base, 'project');
    mkdirSync(workspaceRoot, { recursive: true });
    const workspace = new NodeWorkspace({ root: workspaceRoot });
    store = new NodeMemoryStore({ workspace, baseDir: join(base, 'home', '.aluy') });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  async function roundTrip(text: string): Promise<MemoryFact | undefined> {
    await store.append(fact({ id: 'rt-' + Math.random().toString(36).slice(2), text }));
    const all = await store.readAll();
    return all[all.length - 1];
  }

  it('fato MULTI-LINHA preserva TODO o texto (antes: só a última linha sobrevivia)', async () => {
    const text = 'preferência do usuário:\n- usar tabs\n- 2 espaços de indent';
    const back = await roundTrip(text);
    expect(back?.text).toBe(text);
  });

  it('fato com o MARCADOR literal no texto não corrompe id/ts (antes: fato descartado)', async () => {
    const text = 'lembre que <!--aluy-mem {"id":"FAKE","ts":0}--> é só um exemplo';
    await store.append(fact({ id: 'real-id', text, ts: 7777 }));
    const back = (await store.readAll()).find((f) => f.id === 'real-id');
    expect(back).toBeDefined();
    expect(back?.text).toBe(text);
    expect(back?.ts).toBe(7777); // a meta REAL, não a do marcador falso.
  });

  it('escape de backslash/aspas/CR + unicode round-trippa byte-a-byte', async () => {
    const text = 'aspas " barra \\ retorno \r e fim \\n literal';
    expect((await roundTrip(text))?.text).toBe(text);
    expect((await roundTrip('emoji 🎉 e CJK 日本語 combin é'))?.text).toBe(
      'emoji 🎉 e CJK 日本語 combin é',
    );
  });

  it('MÚLTIPLOS fatos com newline no meio: TODOS recuperados (sem linhas órfãs)', async () => {
    await store.append(fact({ id: 'a', text: 'linha1\nlinha2', ts: 1 }));
    await store.append(fact({ id: 'b', text: 'simples', ts: 2 }));
    await store.append(fact({ id: 'c', text: 'x\ny\nz', ts: 3 }));
    const all = await store.readAll();
    expect(all.map((f) => f.id).sort()).toEqual(['a', 'b', 'c']);
    expect(all.find((f) => f.id === 'a')?.text).toBe('linha1\nlinha2');
    expect(all.find((f) => f.id === 'c')?.text).toBe('x\ny\nz');
  });

  it('pinned + newline: o 📌 e o texto multi-linha sobrevivem', async () => {
    await store.append(fact({ id: 'p', text: 'regra:\n- sempre testar', pinned: true, ts: 9 }));
    const back = (await store.readAll()).find((f) => f.id === 'p');
    expect(back?.pinned).toBe(true);
    expect(back?.text).toBe('regra:\n- sempre testar');
  });
});
