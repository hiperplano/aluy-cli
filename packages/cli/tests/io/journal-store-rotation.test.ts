// EST-1011 (Bug 6 do bug-hunt — `stack.jsonl` sem rotação + load sem fail-safe).
//
// Antes: `appendEntry` SÓ apendava (crescia sem teto numa sessão longa) e `loadEntries`
// fazia `JSON.parse(line)` SEM try/catch ⇒ UMA linha corrompida derrubava TODO o undo.
// Agora: try/catch POR LINHA (pula a inválida), CAP de bytes no read (lê a cauda),
// e ROTAÇÃO compactada ao passar do teto de linhas — o arquivo deixa de crescer.
//
// Não regride o journal/undo da 0960a/0960b (round-trip, blobs, 0600/0700).
// Tudo sobre tmpdir (baseDir injetado) — a suíte NUNCA toca o `~/.aluy/` real.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeJournalStore } from '../../src/io/journal-store.js';
import type { JournalEntry } from '@hiperplano/aluy-cli-core';

/** Uma entrada `barrier` mínima (não custa blob) — barata p/ encher a pilha. */
function barrier(seq: number): JournalEntry {
  return { kind: 'barrier', seq, ts: seq, tool: 'run_command', command: `cmd-${seq}` };
}

describe('EST-1011 · NodeJournalStore — rotação + load fail-safe (Bug 6)', () => {
  let base: string;
  let journalBase: string;
  let stackPath: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-journal-rot-'));
    journalBase = join(base, 'home', '.aluy');
    mkdirSync(journalBase, { recursive: true });
    stackPath = join(journalBase, 'undo', 's1', 'stack.jsonl');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('loadEntries PULA uma linha corrompida (não derruba o undo inteiro)', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    await store.appendEntry(barrier(0));
    await store.appendEntry(barrier(1));
    // Injeta uma linha LIXO no meio (crash no meio de um append / disco cheio).
    appendFileSync(stackPath, '{ isto não é json válido \n');
    await store.appendEntry(barrier(2));

    const entries = await store.loadEntries();
    // As 3 válidas voltam; a corrompida foi PULADA (antes: JSON.parse lançava ⇒ undo morto).
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('F136 — appendEntry APÓS cauda TORTA (sem \\n) NÃO cola nem perde a entrada nova', async () => {
    // Sessão anterior crashou mid-append: bytes parciais SEM '\n'. `--continue`/`--resume`
    // reabre o MESMO stack e apenda. ANTES: o append colava (`{torn{new}`) e o loadEntries
    // pulava a merged ⇒ a entrada NOVA se PERDIA. Agora appendEntry prefixa '\n' (separa
    // a torta na própria linha, que o loadEntries já pula) e a nova entra íntegra.
    const store1 = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    await store1.appendEntry(barrier(0));
    // crash mid-append: linha parcial SEM '\n' no fim.
    appendFileSync(stackPath, '{"kind":"barrier","seq":99,"ts":99,"tool":"run_command","comm');

    // nova sessão (mesma id, via --resume) reabre e apenda a entrada nova.
    const store2 = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    await store2.appendEntry(barrier(1));

    const entries = await store2.loadEntries();
    // a barrier(1) SOBREVIVE (não foi colada/perdida); a torta-99 foi pulada.
    expect(entries.map((e) => e.seq)).toContain(1);
    expect(entries.map((e) => e.seq)).not.toContain(99); // a parcial nunca completou
    // e o arquivo ficou íntegro: cada linha não-vazia válida parseia (a torta é pulada).
    const raw = readFileSync(stackPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    // a nova entrada NÃO colou com a torta (não há linha contendo as DUAS).
    expect(raw.split('\n').some((l) => l.includes('"comm{'))).toBe(false);
  });

  it('F136 — append sobre arquivo BEM-formado (termina em \\n) NÃO insere linha vazia espúria', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    await store.appendEntry(barrier(0));
    await store.appendEntry(barrier(1)); // arquivo já termina em '\n' ⇒ sem prefixo
    const raw = readFileSync(stackPath, 'utf8');
    expect(raw).not.toContain('\n\n'); // nenhuma linha vazia inserida à toa
    const entries = await store.loadEntries();
    expect(entries.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('loadEntries com TODA linha corrompida ⇒ vazio, sem lançar', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    await store.appendEntry(barrier(0)); // cria o dir/arquivo 0600
    writeFileSync(stackPath, 'lixo1\n{nope\nlixo2\n');
    await expect(store.loadEntries()).resolves.toEqual([]);
  });

  it('ROTAÇÃO — o stack.jsonl deixa de crescer sem teto (compacta p/ a cauda recente)', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    // Muito além do teto (STACK_MAX_LINES=2000): 10000 entradas. Sem a rotação, o
    // arquivo teria 10000 linhas; com ela, fica SEMPRE cercado abaixo do teto.
    for (let i = 0; i < 10_000; i++) {
      await store.appendEntry(barrier(i));
    }
    const linesOnDisk = readFileSync(stackPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '').length;
    // INVARIANTE central do Bug 6: o arquivo NUNCA passa do teto (o crescimento sem
    // teto parou) — apesar das 10000 apendadas, o disco fica ≤ STACK_MAX_LINES.
    expect(linesOnDisk).toBeLessThanOrEqual(2_000);
    expect(linesOnDisk).toBeGreaterThanOrEqual(1_000); // pós-rotação, ≥ KEEP.
    // E o que sobrevive é a CAUDA recente (as últimas entradas, não as primeiras).
    const entries = await store.loadEntries();
    const seqs = entries.map((e) => e.seq);
    expect(seqs[seqs.length - 1]).toBe(9_999); // a última apendada está lá.
    expect(seqs[0]).toBeGreaterThan(0); // as mais antigas foram podadas.
  });

  it('CAP no read — arquivo gigante adulterado não vai inteiro à memória (lê a cauda)', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    await store.appendEntry(barrier(0)); // cria o arquivo
    // Planta um arquivo > 16 MiB (STACK_MAX_READ_BYTES): preâmbulo gigante de lixo +
    // a cauda com entradas VÁLIDAS recentes. O load deve ler só a cauda, sem OOM.
    const tailEntries = [barrier(9001), barrier(9002), barrier(9003)]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const giantHead = 'x'.repeat(17 * 1024 * 1024); // 17 MiB de lixo (1 "linha" enorme)
    writeFileSync(stackPath, giantHead + '\n' + tailEntries + '\n');
    expect(statSync(stackPath).size).toBeGreaterThan(16 * 1024 * 1024);

    const entries = await store.loadEntries();
    // A cabeça (lixo gigante) ficou de fora; as entradas válidas da CAUDA voltaram.
    expect(entries.map((e) => e.seq)).toEqual([9001, 9002, 9003]);
  });

  it('round-trip normal NÃO regride (0960a) — abaixo do teto, nada é compactado', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    const ref = await store.putBlob('antes');
    await store.appendEntry({
      kind: 'edit',
      seq: 0,
      ts: 1,
      tool: 'edit_file',
      targets: [{ path: 'a.ts', beforeRef: ref, beforeHash: 'h', createdByEdit: false }],
      appliedHash: 'h2',
    });
    await store.appendEntry(barrier(1));
    const entries = await store.loadEntries();
    expect(entries.map((e) => e.kind)).toEqual(['edit', 'barrier']);
    // o blob continua restaurável (rotação só toca o stack.jsonl, não os blobs).
    expect(await store.getBlob(ref)).toBe('antes');
  });
});
