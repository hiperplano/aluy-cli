// EST-0960a · ADR-0056 — MECÂNICA do journal (PORTÁVEL): captura do `antes`,
// pilha por sessão, fronteira do reversível (barreira run_command), detecção de
// concorrência, restauração confinada e teto de retenção (unlink real).
//
// Bateria do gate FORTE (parte portável): T1 (captura via edit_file), T4 (pilha
// na ordem), T5 (barreira run_command), T6 (before_hash diverge), restauração
// confinada (R8 — delega ao writer que resolve no momento da escrita) e teto com
// unlink REAL (T11/§3). A parte de I/O concreto (0600 atômico, fora do workspace,
// GC pós-crash, path-deny) está nos testes do @hiperplano/aluy-cli e da permissão.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  JournalCipher,
  SnapshotJournal,
  editFileTool,
  writeFileTool,
  runCommandTool,
  type BlobRef,
  type CurrentReaderPort,
  type JournalEntry,
  type JournalStorePort,
  type RestoreWriterPort,
} from '../../src/agent/index.js';
import type { WorkspacePort } from '../../src/agent/journal/workspace-port.js';
import { MemoryFs, RecordingShell, makePorts } from './helpers.js';

// EST-0960a · #1 — os blobs no store são CIFRADOS em repouso (a trava real). Estes
// testes da MECÂNICA precisam DECIFRAR p/ ver o conteúdo-antes (a sessão viva tem
// a chave). Injetamos uma cifra de chave fixa e deciframos com ela. (A prova da
// cifra-em-repouso em si — ciphertext no disco, chave não vaza, IV único — está em
// `journal-cipher.test.ts`.)
const TEST_CIPHER = new JournalCipher(randomBytes(32));
/** Constrói um journal com a cifra de teste compartilhada (p/ decifrar os blobs). */
function newJournal(opts: Omit<ConstructorParameters<typeof SnapshotJournal>[0], 'cipher'>) {
  return new SnapshotJournal({ ...opts, cipher: TEST_CIPHER });
}
/** Decifra o que o store guardou (ciphertext) p/ asserts de conteúdo-antes. */
function plain(sealed: string): string {
  return TEST_CIPHER.open(sealed);
}

/** Store em memória que GRAVA as operações p/ provar unlink real / sem-vazamento. */
class MemoryStore implements JournalStorePort {
  readonly blobs = new Map<BlobRef, string>();
  readonly entries: JournalEntry[] = [];
  readonly deleted: BlobRef[] = [];
  cleanedUp = false;
  gcRan = false;
  private seq = 0;

  hash(content: string): string {
    // hash simples e determinístico p/ teste (não-cripto; só precisa diferenciar).
    let h = 0;
    for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) | 0;
    return `h${h}:${content.length}`;
  }
  async putBlob(content: string): Promise<BlobRef> {
    const ref = `b${this.seq++}`;
    this.blobs.set(ref, content);
    return ref;
  }
  async getBlob(ref: BlobRef): Promise<string> {
    const v = this.blobs.get(ref);
    if (v === undefined) throw new Error(`blob ausente: ${ref}`);
    return v;
  }
  async appendEntry(entry: JournalEntry): Promise<void> {
    this.entries.push(entry);
  }
  async deleteBlob(ref: BlobRef): Promise<void> {
    this.deleted.push(ref);
    this.blobs.delete(ref);
  }
  async cleanup(): Promise<void> {
    this.cleanedUp = true;
    this.blobs.clear();
  }
  async gcOrphans(): Promise<void> {
    this.gcRan = true;
  }
}

/** Workspace fake (root fixo); resolveInside rejeita `..`/symlink simulado. */
function fakeWorkspace(root = '/ws'): WorkspacePort {
  return {
    root,
    resolveInside(requested: string): string {
      if (requested.includes('..') || requested.startsWith('/etc')) {
        throw new Error(`escape: ${requested}`);
      }
      return requested.startsWith('/') ? requested : `${root}/${requested}`;
    },
    contains(requested: string): boolean {
      try {
        this.resolveInside(requested);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Writer fake que registra escritas/remoções e re-confina no momento da escrita. */
class RecordingRestoreWriter implements RestoreWriterPort {
  readonly writes: { path: string; content: string }[] = [];
  readonly removes: string[] = [];
  constructor(private readonly ws: WorkspacePort) {}
  async writeConfined(requested: string, content: string): Promise<string> {
    const safe = this.ws.resolveInside(requested); // R8: resolve no momento da escrita
    this.writes.push({ path: safe, content });
    return safe;
  }
  async removeConfined(requested: string): Promise<string> {
    const safe = this.ws.resolveInside(requested);
    this.removes.push(safe);
    return safe;
  }
}

class MapCurrentReader implements CurrentReaderPort {
  constructor(
    private readonly files: Map<string, string>,
    private readonly ws: WorkspacePort,
  ) {}
  async readCurrent(requested: string): Promise<string | undefined> {
    // Mimetiza o NodeCurrentReader real: resolve+confina antes de ler.
    let safe: string;
    try {
      safe = this.ws.resolveInside(requested);
    } catch {
      return undefined;
    }
    return this.files.get(safe);
  }
}

describe('EST-0960a · SnapshotJournal — mecânica portável', () => {
  it('F162 — falha de persistência do store NÃO derruba a tool (toolPort degrada + marca)', async () => {
    const store = new MemoryStore();
    // Store quebrado (disco cheio / ~/.aluy/undo apagado além do auto-reparo).
    store.appendEntry = async () => {
      throw new Error('ENOENT: stack.jsonl');
    };
    store.putBlob = async () => {
      throw new Error('ENOENT: blobs');
    };
    const journal = newJournal({ store, workspace: fakeWorkspace() });
    expect(journal.degraded).toBe(false);
    // O seam da tool NUNCA propaga (era o que matava todo run_command na sessão real)…
    await expect(journal.toolPort.markBarrier('npm test')).resolves.toBeUndefined();
    await expect(
      journal.toolPort.captureEdit({ path: 'a.ts', before: 'x', after: 'y', createdByEdit: false }),
    ).resolves.toBeUndefined();
    // …e o journal se declara DEGRADADO (o chamador pode avisar 1×, honesto).
    expect(journal.degraded).toBe(true);
  });

  it('T1 — edit_file aprovado captura o conteúdo-antes (reusa o `before` do diff)', async () => {
    const store = new MemoryStore();
    const ws = fakeWorkspace();
    const journal = newJournal({ store, workspace: ws });
    // Arquivo já existente: o `before` que a edit_file lê p/ o diff é o capturado.
    const fs = new MemoryFs(new Map([['a.ts', 'ANTES']]));
    const { ports } = makePorts({ fs });
    const portsWithJournal = { ...ports, journal: journal.toolPort };

    const r = await editFileTool.run(
      { path: 'a.ts', old_string: 'ANTES', new_string: 'DEPOIS' },
      portsWithJournal,
    );
    expect(r.ok).toBe(true);
    // o conteúdo NOVO foi escrito…
    expect(fs.snapshot().get('a.ts')).toBe('DEPOIS');
    // …e o ANTES foi capturado no journal, associado à edição (CA-1).
    const entry = journal.top();
    expect(entry?.kind).toBe('edit');
    if (entry?.kind === 'edit') {
      // o blob no store é CIPHERTEXT (#1); o conteúdo-antes sai ao DECIFRAR.
      const blob = await store.getBlob(entry.targets[0]!.beforeRef);
      expect(blob).not.toBe('ANTES'); // em repouso é cifrado, não o claro
      expect(plain(blob)).toBe('ANTES'); // decifrado na sessão viva = o antes
      expect(entry.targets[0]!.beforeHash).toBe(store.hash('ANTES'));
      expect(entry.appliedHash).toBe(store.hash('DEPOIS'));
      expect(entry.targets[0]!.createdByEdit).toBe(false);
    }
  });

  it('T1b — write_file que CRIA arquivo marca createdByEdit (undo = remover)', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace() });
    const { ports } = makePorts({ fs: new MemoryFs() });
    await writeFileTool.run(
      { path: 'novo.ts', content: 'X' },
      { ...ports, journal: journal.toolPort },
    );
    const entry = journal.top();
    expect(entry?.kind === 'edit' && entry.targets[0]!.createdByEdit).toBe(true);
  });

  it('T4 — N edições em sequência ⇒ pilha registra as N na ORDEM, com snapshot de cada', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace() });
    const fs = new MemoryFs(new Map([['f.ts', 'v0']]));
    const ports = { ...makePorts({ fs }).ports, journal: journal.toolPort };

    await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports);
    await writeFileTool.run({ path: 'f.ts', content: 'v2', overwrite: true }, ports);
    await writeFileTool.run({ path: 'f.ts', content: 'v3', overwrite: true }, ports);

    const stack = journal.list();
    expect(stack.length).toBe(3);
    expect(stack.map((e) => e.seq)).toEqual([0, 1, 2]);
    // o snapshot do antes de cada edição é o estado IMEDIATAMENTE anterior.
    // (os blobs são cifrados em repouso — deciframos p/ comparar com o claro.)
    const befores = await Promise.all(
      stack.map(async (e) =>
        e.kind === 'edit' ? plain(await store.getBlob(e.targets[0]!.beforeRef)) : null,
      ),
    );
    expect(befores).toEqual(['v0', 'v1', 'v2']);
  });

  it('T5 — run_command na sequência MARCA a barreira não-reversível e NÃO captura snapshot', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace() });
    const fs = new MemoryFs(new Map([['f.ts', 'v0']]));
    const shell = new RecordingShell(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const ports = { ...makePorts({ fs, shell }).ports, journal: journal.toolPort };

    await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports);
    await runCommandTool.run({ command: 'npm publish' }, ports);
    await writeFileTool.run({ path: 'f.ts', content: 'v2', overwrite: true }, ports);

    const stack = journal.list();
    expect(stack.map((e) => e.kind)).toEqual(['edit', 'barrier', 'edit']);
    const barrier = stack[1];
    expect(barrier?.kind === 'barrier' && barrier.command).toBe('npm publish');
    // CA-3: nenhum blob/snapshot reversível foi gerado PARA o comando (só p/ os 2 edits).
    expect(store.blobs.size).toBe(2);
  });

  it('T6 — before_hash diverge (arquivo mudou desde o snapshot) ⇒ divergência detectada', async () => {
    const store = new MemoryStore();
    const current = new Map<string, string>();
    const ws = fakeWorkspace();
    const reader = new MapCurrentReader(current, ws);
    const journal = newJournal({
      store,
      workspace: ws,
      currentReader: reader,
    });
    const fs = new MemoryFs(new Map([['f.ts', 'v0']]));
    const ports = { ...makePorts({ fs }).ports, journal: journal.toolPort };
    await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports);
    const entry = journal.top()!;

    // estado atual == o aplicado ⇒ não divergente.
    current.set('/ws/f.ts', 'v1');
    expect((await journal.checkConcurrency(entry)).diverged).toBe(false);

    // alguém editou o arquivo fora do agente ⇒ DIVERGE (CA-4).
    current.set('/ws/f.ts', 'editado-por-fora');
    const check = await journal.checkConcurrency(entry);
    expect(check.diverged).toBe(true);
    expect(check.currentHash).not.toBe(check.expectedHash);
  });

  it('restauração CONFINADA: escreve de volta o antes via writer (resolve no momento da escrita)', async () => {
    const store = new MemoryStore();
    const ws = fakeWorkspace();
    const writer = new RecordingRestoreWriter(ws);
    const journal = newJournal({ store, workspace: ws, restoreWriter: writer });
    const fs = new MemoryFs(new Map([['f.ts', 'ORIGINAL']]));
    const ports = { ...makePorts({ fs }).ports, journal: journal.toolPort };
    await writeFileTool.run({ path: 'f.ts', content: 'MUTADO', overwrite: true }, ports);

    const out = await journal.restore(journal.top()!);
    expect(out.action).toBe('written');
    expect(writer.writes).toEqual([{ path: '/ws/f.ts', content: 'ORIGINAL' }]);
  });

  it('EST-0960b — appliedContent guarda o `after` por seq (fonte do /redo)', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace() });
    const fs = new MemoryFs(new Map([['f.ts', 'v0']]));
    const ports = { ...makePorts({ fs }).ports, journal: journal.toolPort };
    await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports);
    const entry = journal.top()!;
    expect(journal.appliedContent(entry.seq)).toEqual({ path: 'f.ts', after: 'v1' });
    expect(journal.appliedContent(999)).toBeUndefined();
  });

  it('EST-0960b — reapply reescreve o `after` CONFINADO (mesma disciplina R8 do undo)', async () => {
    const store = new MemoryStore();
    const ws = fakeWorkspace();
    const writer = new RecordingRestoreWriter(ws);
    const journal = newJournal({ store, workspace: ws, restoreWriter: writer });
    const at = await journal.reapply('f.ts', 'NOVO');
    expect(at).toBe('/ws/f.ts');
    expect(writer.writes).toEqual([{ path: '/ws/f.ts', content: 'NOVO' }]);
  });

  it('EST-0960b — reapply de alvo que ESCAPA é rejeitado (R8 — nada escrito)', async () => {
    const store = new MemoryStore();
    const ws = fakeWorkspace();
    const writer = new RecordingRestoreWriter(ws);
    const journal = newJournal({ store, workspace: ws, restoreWriter: writer });
    await expect(journal.reapply('../../etc/passwd', 'X')).rejects.toThrow(/escape/);
    expect(writer.writes).toEqual([]);
  });

  it('R8 — restauração de alvo que ESCAPA o workspace é rejeitada (writer lança)', async () => {
    const store = new MemoryStore();
    const ws = fakeWorkspace();
    const writer = new RecordingRestoreWriter(ws);
    const journal = newJournal({ store, workspace: ws, restoreWriter: writer });
    // Fabrica uma entrada cujo path-alvo escapa (simula symlink/`..` plantado).
    // O blob é selado com a cifra de teste (em repouso é ciphertext, como em prod).
    const ref = await store.putBlob(TEST_CIPHER.seal('SEGREDO'));
    const entry: JournalEntry = {
      kind: 'edit',
      seq: 0,
      ts: 0,
      tool: 'edit_file',
      targets: [
        { path: '../../etc/passwd', beforeRef: ref, beforeHash: 'h', createdByEdit: false },
      ],
      appliedHash: 'h2',
    };
    await expect(journal.restore(entry)).rejects.toThrow(/escape/);
    expect(writer.writes).toEqual([]); // nenhum byte escapou
  });

  it('restauração de arquivo CRIADO pela edição ⇒ REMOVE (confinado)', async () => {
    const store = new MemoryStore();
    const ws = fakeWorkspace();
    const writer = new RecordingRestoreWriter(ws);
    const journal = newJournal({ store, workspace: ws, restoreWriter: writer });
    const ports = { ...makePorts({ fs: new MemoryFs() }).ports, journal: journal.toolPort };
    await writeFileTool.run({ path: 'criado.ts', content: 'X' }, ports);

    const out = await journal.restore(journal.top()!);
    expect(out.action).toBe('removed');
    expect(writer.removes).toEqual(['/ws/criado.ts']);
  });

  it('restaurar uma BARREIRA lança (não há snapshot reversível p/ run_command)', async () => {
    const store = new MemoryStore();
    const journal = newJournal({
      store,
      workspace: fakeWorkspace(),
      restoreWriter: new RecordingRestoreWriter(fakeWorkspace()),
    });
    const barrier = await journal.markBarrier('rm -rf build');
    await expect(journal.restore(barrier)).rejects.toThrow(/barreira/);
  });

  it('teto de retenção: ao estourar, descarta o mais antigo com UNLINK REAL do blob', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace(), maxEntries: 2 });
    const fs = new MemoryFs(new Map([['f.ts', 'v0']]));
    const ports = { ...makePorts({ fs }).ports, journal: journal.toolPort };

    await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports); // edit#0 (before v0)
    await writeFileTool.run({ path: 'f.ts', content: 'v2', overwrite: true }, ports); // edit#1 (before v1)
    await writeFileTool.run({ path: 'f.ts', content: 'v3', overwrite: true }, ports); // edit#2 (before v2) ⇒ estoura

    // só 2 edições retidas; a mais antiga (before v0) foi DESCARTADA com unlink real.
    expect(journal.list().length).toBe(2);
    expect(store.deleted.length).toBe(1);
    expect(store.blobs.size).toBe(2); // o blob "v0" sumiu fisicamente do store
  });

  it('cleanup limpa a pilha e delega o unlink real ao store', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace() });
    const ports = {
      ...makePorts({ fs: new MemoryFs(new Map([['f.ts', 'v0']])) }).ports,
      journal: journal.toolPort,
    };
    await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports);
    await journal.cleanup();
    expect(store.cleanedUp).toBe(true);
    expect(journal.list().length).toBe(0);
  });

  it('checkConcurrency de uma BARREIRA ⇒ nunca diverge (não é reversível)', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace() });
    const barrier = await journal.markBarrier('git push');
    expect((await journal.checkConcurrency(barrier)).diverged).toBe(false);
  });

  it('checkConcurrency sem currentReader injetado ⇒ assume não-divergente (info)', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace() }); // sem reader
    const ports = {
      ...makePorts({ fs: new MemoryFs(new Map([['f.ts', 'v0']])) }).ports,
      journal: journal.toolPort,
    };
    await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports);
    expect((await journal.checkConcurrency(journal.top()!)).diverged).toBe(false);
  });

  it('restore sem restoreWriter injetado ⇒ lança (a 0960b sempre o injeta)', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace() }); // sem writer
    const ports = {
      ...makePorts({ fs: new MemoryFs(new Map([['f.ts', 'v0']])) }).ports,
      journal: journal.toolPort,
    };
    await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports);
    await expect(journal.restore(journal.top()!)).rejects.toThrow(/restoreWriter/);
  });

  it('workspaceRoot expõe a raiz à qual a restauração está confinada (R8)', () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace('/raiz') });
    expect(journal.workspaceRoot).toBe('/raiz');
  });

  it('NÃO-REGRESSÃO: sem journal injetado, edit_file/run_command funcionam idênticos', async () => {
    const fs = new MemoryFs(new Map([['f.ts', 'v0']]));
    const shell = new RecordingShell(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ fs, shell }); // sem `journal`
    const re = await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports);
    const rc = await runCommandTool.run({ command: 'ls' }, ports);
    expect(re.ok).toBe(true);
    expect(fs.snapshot().get('f.ts')).toBe('v1');
    expect(rc.ok).toBe(true);
    expect(shell.executed).toEqual(['ls']);
  });

  // ── HUNT-RESOURCE-CEILING (EST-1011) — acumuladores sem teto na retenção ──
  it('HUNT-RESOURCE: barreiras (run_command) NÃO acumulam sem teto numa sessão longa', async () => {
    const store = new MemoryStore();
    // maxEntries baixo p/ o teto total morder rápido (total = maxEntries + headroom).
    const journal = newJournal({ store, workspace: fakeWorkspace(), maxEntries: 5 });
    // Sessão de dogfooding: MUITOS run_command (barreiras), ZERO edição. Antes do fix,
    // o enforceRetention só olhava `edit` ⇒ as barreiras cresciam para SEMPRE.
    for (let i = 0; i < 1000; i++) {
      await journal.markBarrier(`cmd ${i}`);
    }
    // A pilha em memória é CERCADA (não cresce proporcional ao nº de comandos).
    expect(journal.list().length).toBeLessThanOrEqual(5 + 200);
    // E mantém a CAUDA recente (o último comando segue na pilha; o 1º foi podado).
    const cmds = journal.list().map((e) => (e.kind === 'barrier' ? e.command : ''));
    expect(cmds).toContain('cmd 999');
    expect(cmds).not.toContain('cmd 0');
  });

  it('HUNT-RESOURCE: appliedBySeq NÃO vaza — o `after` de uma edição evictada some do Map', async () => {
    const store = new MemoryStore();
    const journal = newJournal({ store, workspace: fakeWorkspace(), maxEntries: 2 });
    const fs = new MemoryFs(new Map([['f.ts', 'v0']]));
    const ports = { ...makePorts({ fs }).ports, journal: journal.toolPort };

    // 3 edições com maxEntries=2 ⇒ a edição #0 (seq 0) é evictada pela retenção.
    await writeFileTool.run({ path: 'f.ts', content: 'v1', overwrite: true }, ports); // seq 0
    await writeFileTool.run({ path: 'f.ts', content: 'v2', overwrite: true }, ports); // seq 1
    await writeFileTool.run({ path: 'f.ts', content: 'v3', overwrite: true }, ports); // seq 2 ⇒ estoura

    // O `after` da edição EVICTADA (seq 0) NÃO ficou retido no Map (antes vazava p/ sempre).
    expect(journal.appliedContent(0)).toBeUndefined();
    // As edições vivas mantêm o `after` (não regrediu nada do /redo).
    expect(journal.appliedContent(1)).toEqual({ path: 'f.ts', after: 'v2' });
    expect(journal.appliedContent(2)).toEqual({ path: 'f.ts', after: 'v3' });
  });
});
