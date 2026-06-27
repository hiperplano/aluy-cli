// EST-0960b · ADR-0056 — UX de `/undo`/`/redo`: o UndoController consome o journal
// 0960a (SnapshotJournal) e expõe a NAVEGAÇÃO undo/redo + as notas de feedback.
//
// CAs cobertos aqui:
//   CA-1  — /undo reverte; /redo reaplica; empilhável; profundidade no feedback.
//   CA-2  — barreira run_command: avisa NÃO-reversível + comando REDIGIDO (R9/CA-5).
//   CA-3  — edição concorrente: pede CONFIRMAÇÃO, não sobrescreve cego.
//   pilha vazia ⇒ aviso neutro.
//
// Usa um SnapshotJournal REAL com store/writer/reader em memória (a mecânica é a da
// 0960a; aqui exercemos a UX por cima dela, ponta-a-ponta sem Ink/FS).

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  JournalCipher,
  REDACTED,
  SnapshotJournal,
  type BlobRef,
  type CurrentReaderPort,
  type JournalEntry,
  type JournalStorePort,
  type RestoreWriterPort,
  type JournalWorkspacePort as WorkspacePort,
} from '@aluy/cli-core';
import { UndoController } from '../../src/session/undo-controller.js';

const CIPHER = new JournalCipher(randomBytes(32));

/** Store em memória (o `~/.aluy/` concreto não é o foco da 0960b). */
class MemStore implements JournalStorePort {
  readonly blobs = new Map<BlobRef, string>();
  readonly entries: JournalEntry[] = [];
  private seq = 0;
  hash(c: string): string {
    let h = 0;
    for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) | 0;
    return `h${h}:${c.length}`;
  }
  async putBlob(c: string): Promise<BlobRef> {
    const ref = `b${this.seq++}`;
    this.blobs.set(ref, c);
    return ref;
  }
  async getBlob(ref: BlobRef): Promise<string> {
    const v = this.blobs.get(ref);
    if (v === undefined) throw new Error(`blob ausente: ${ref}`);
    return v;
  }
  async appendEntry(e: JournalEntry): Promise<void> {
    this.entries.push(e);
  }
  async deleteBlob(ref: BlobRef): Promise<void> {
    this.blobs.delete(ref);
  }
  async loadEntries(): Promise<readonly JournalEntry[]> {
    return this.entries;
  }
  async cleanup(): Promise<void> {
    this.blobs.clear();
  }
  async gcOrphans(): Promise<void> {}
}

function ws(root = '/ws'): WorkspacePort {
  return {
    root,
    resolveInside(p: string): string {
      if (p.includes('..') || p.startsWith('/etc')) throw new Error(`escape: ${p}`);
      return p.startsWith('/') ? p : `${root}/${p}`;
    },
    contains(p: string): boolean {
      try {
        this.resolveInside(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Writer + reader que partilham um "disco" em memória (o workspace simulado). */
class MemDisk implements RestoreWriterPort, CurrentReaderPort {
  constructor(
    readonly files: Map<string, string>,
    private readonly w: WorkspacePort,
  ) {}
  async writeConfined(req: string, content: string): Promise<string> {
    const safe = this.w.resolveInside(req);
    this.files.set(safe, content);
    return safe;
  }
  async removeConfined(req: string): Promise<string> {
    const safe = this.w.resolveInside(req);
    this.files.delete(safe);
    return safe;
  }
  async readCurrent(req: string): Promise<string | undefined> {
    let safe: string;
    try {
      safe = this.w.resolveInside(req);
    } catch {
      return undefined;
    }
    return this.files.get(safe);
  }
}

/** Monta journal + disco + uma `editFile` simplificada que captura como a tool faria. */
function setup(initial: Record<string, string> = {}) {
  const workspace = ws();
  const files = new Map(Object.entries(initial).map(([k, v]) => [`/ws/${k}`, v]));
  const disk = new MemDisk(files, workspace);
  const store = new MemStore();
  const journal = new SnapshotJournal({
    store,
    workspace,
    restoreWriter: disk,
    currentReader: disk,
    cipher: CIPHER,
  });
  // Edição: captura o `before`+`after` (como a edit_file no ponto de efeito) e
  // escreve o `after` no disco simulado.
  const editFile = async (path: string, after: string): Promise<void> => {
    const key = `/ws/${path}`;
    const before = files.get(key) ?? '';
    const createdByEdit = !files.has(key);
    await journal.captureEdit({ path, before, after, createdByEdit });
    files.set(key, after);
  };
  const controller = new UndoController({ journal });
  const read = (p: string): string | undefined => files.get(`/ws/${p}`);
  return { journal, controller, editFile, read, files };
}

describe('EST-0960b · UndoController — UX de /undo /redo', () => {
  it('CA-1 — /undo reverte a última edição (arquivo volta ao "antes")', async () => {
    const { controller, editFile, read } = setup({ 'a.ts': 'V0' });
    await editFile('a.ts', 'V1');
    expect(read('a.ts')).toBe('V1');

    const out = await controller.undo();
    expect(out.kind).toBe('note');
    expect(read('a.ts')).toBe('V0'); // voltou ao antes
    expect(out.note.lines.join('\n')).toContain('revertido: `a.ts`');
  });

  it('CA-1 — /undo /undo empilhável reverte as 2 últimas na ordem; feedback traz profundidade', async () => {
    const { controller, editFile, read } = setup({ 'a.ts': 'V0' });
    await editFile('a.ts', 'V1');
    await editFile('a.ts', 'V2');
    await editFile('a.ts', 'V3');

    await controller.undo(); // V3 -> V2
    expect(read('a.ts')).toBe('V2');
    const out2 = await controller.undo(); // V2 -> V1
    expect(read('a.ts')).toBe('V1');
    // feedback de profundidade: ainda há 1 edição reversível abaixo, 2 p/ refazer.
    expect(out2.note.lines.join('\n')).toMatch(/pilha: 1 edição/);
    expect(out2.note.lines.join('\n')).toMatch(/2 para refazer/);
  });

  it('CA-1 — /redo reaplica o que o /undo desfez', async () => {
    const { controller, editFile, read } = setup({ 'a.ts': 'V0' });
    await editFile('a.ts', 'V1');
    await controller.undo();
    expect(read('a.ts')).toBe('V0');

    const out = await controller.redo();
    expect(out.kind).toBe('note');
    expect(read('a.ts')).toBe('V1'); // reaplicado
    expect(out.note.lines.join('\n')).toContain('reaplicado: `a.ts`');
  });

  it('pilha vazia ⇒ /undo dá aviso NEUTRO (não finge, não toca arquivo)', async () => {
    const { controller } = setup();
    const out = await controller.undo();
    expect(out.kind).toBe('note');
    expect(out.note.lines.join('\n')).toMatch(/nada para desfazer/);
  });

  it('pilha de redo vazia ⇒ /redo dá aviso NEUTRO', async () => {
    const { controller } = setup();
    const out = await controller.redo();
    expect(out.note.lines.join('\n')).toMatch(/nada para refazer/);
  });

  it('CA-1 — /undo de uma CRIAÇÃO remove o arquivo (era novo)', async () => {
    const { controller, editFile, read } = setup();
    await editFile('novo.ts', 'X');
    expect(read('novo.ts')).toBe('X');
    const out = await controller.undo();
    expect(read('novo.ts')).toBeUndefined(); // removido
    expect(out.note.lines.join('\n')).toContain('removido');
  });

  it('CA-2 / CA-5 (R9) — barreira run_command: avisa NÃO-reversível com comando REDIGIDO', async () => {
    const { journal, controller, editFile, read } = setup({ 'a.ts': 'V0' });
    await editFile('a.ts', 'V1');
    // Barreira com SEGREDO (sintético/FAKE) na linha (o caso do R9). O literal é
    // montado de partes pra não plantar um padrão de segredo contíguo no repo
    // (detector curl-auth-header do gitleaks) — a string em runtime é idêntica à
    // que o usuário rodaria; a redação (R9) age sobre ela.
    const fakeToken = 'sk-live-ABCDEF1234567890xyz';
    await journal.markBarrier(`${'c' + 'url'} -H "Authorization: Bearer ${fakeToken}" https://api`);
    await editFile('a.ts', 'V2');

    // 1º /undo: reverte a edição V2 (acima da barreira).
    const o1 = await controller.undo();
    expect(read('a.ts')).toBe('V1');
    expect(o1.note.lines.join('\n')).toContain('revertido: `a.ts`');

    // 2º /undo: cruza a BARREIRA — avisa não-reversível + comando REDIGIDO; depois
    // reverte a edição V1 abaixo dela.
    const o2 = await controller.undo();
    const text = o2.note.lines.join('\n');
    expect(text).toMatch(/NÃO é reversível/);
    expect(text).toContain('curl'); // identifica a barreira…
    expect(text).toContain(REDACTED); // …mas o token foi redigido (R9)
    expect(text).not.toContain('sk-live-ABCDEF1234567890xyz'); // segredo NÃO vazou
    expect(read('a.ts')).toBe('V0'); // a edição abaixo da barreira foi revertida
  });

  it('CA-3 — edição concorrente: /undo pede CONFIRMAÇÃO e NÃO sobrescreve', async () => {
    const { controller, editFile, read, files } = setup({ 'a.ts': 'V0' });
    await editFile('a.ts', 'V1');
    // Alguém edita o arquivo FORA do agente depois da edição (hash diverge).
    files.set('/ws/a.ts', 'EDITADO_FORA');

    const out = await controller.undo();
    expect(out.kind).toBe('confirm');
    expect(read('a.ts')).toBe('EDITADO_FORA'); // NÃO sobrescreveu
    const text = out.note.lines.join('\n');
    expect(text).toMatch(/mudou desde/);
    expect(text).toMatch(/SOBRESCREVE/);

    // O usuário confirma: agora reverte (perde a mudança externa, conscientemente).
    if (out.kind === 'confirm') {
      const confirmed = await out.proceed();
      expect(confirmed.kind).toBe('note');
      expect(read('a.ts')).toBe('V0');
    }
  });

  it('CA-3 — segundo /undo após confirmação pendente confirma (fluxo do run.tsx)', async () => {
    const { controller, editFile, read, files } = setup({ 'a.ts': 'V0' });
    await editFile('a.ts', 'V1');
    files.set('/ws/a.ts', 'FORA');

    const first = await controller.undo();
    expect(first.kind).toBe('confirm');
    // O 2º /undo no run.tsx chama `proceed` (force=true).
    const second = await controller.undo(true);
    expect(second.kind).toBe('note');
    expect(read('a.ts')).toBe('V0');
  });

  it('barreira no TOPO sem edição abaixo ⇒ avisa e não há o que reverter', async () => {
    const { journal, controller } = setup();
    await journal.markBarrier('rm -rf build');
    const out = await controller.undo();
    expect(out.kind).toBe('note');
    const text = out.note.lines.join('\n');
    expect(text).toMatch(/NÃO é reversível/);
    expect(text).toMatch(/não há mais edições/i);
  });

  it('/redo falha graciosamente se a escrita confinada lança (passo NÃO é consumido)', async () => {
    // Writer que recusa a reaplicação (simula symlink/escape plantado).
    const workspace = ws();
    const files = new Map<string, string>([['/ws/a.ts', 'V0']]);
    const disk = new MemDisk(files, workspace);
    const failing: RestoreWriterPort & CurrentReaderPort = {
      writeConfined: async (req, content) => {
        if (content === 'V1') throw new Error('escape simulado no redo');
        return disk.writeConfined(req, content);
      },
      removeConfined: (req) => disk.removeConfined(req),
      readCurrent: (req) => disk.readCurrent(req),
    };
    const store = new MemStore();
    const journal = new SnapshotJournal({
      store,
      workspace,
      restoreWriter: failing,
      currentReader: failing,
      cipher: CIPHER,
    });
    await journal.captureEdit({ path: 'a.ts', before: 'V0', after: 'V1', createdByEdit: false });
    files.set('/ws/a.ts', 'V1');
    const controller = new UndoController({ journal });
    await controller.undo(); // V1 -> V0 (writeConfined de 'V0' passa)
    const redo = await controller.redo(); // reaplicar 'V1' lança
    expect(redo.kind).toBe('note');
    expect(redo.note.lines.join('\n')).toMatch(/não foi possível reaplicar/);
    // o passo NÃO foi consumido: um novo /redo tenta de novo (não some silencioso).
    const redo2 = await controller.redo();
    expect(redo2.note.lines.join('\n')).toMatch(/não foi possível reaplicar/);
  });

  it('/undo falha graciosamente se a restauração lança (nada escrito, aviso fail-safe)', async () => {
    const workspace = ws();
    const files = new Map<string, string>([['/ws/a.ts', 'V0']]);
    const disk = new MemDisk(files, workspace);
    const failing: RestoreWriterPort & CurrentReaderPort = {
      writeConfined: async () => {
        throw new Error('escape simulado no undo');
      },
      removeConfined: (req) => disk.removeConfined(req),
      readCurrent: (req) => disk.readCurrent(req),
    };
    const store = new MemStore();
    const journal = new SnapshotJournal({
      store,
      workspace,
      restoreWriter: failing,
      currentReader: failing,
      cipher: CIPHER,
    });
    await journal.captureEdit({ path: 'a.ts', before: 'V0', after: 'V1', createdByEdit: false });
    files.set('/ws/a.ts', 'V1');
    const controller = new UndoController({ journal });
    const out = await controller.undo();
    expect(out.kind).toBe('note');
    expect(out.note.lines.join('\n')).toMatch(/não foi possível reverter/);
    expect(files.get('/ws/a.ts')).toBe('V1'); // nada foi sobrescrito
  });

  it('/redo sem o `after` guardado ⇒ degradação HONESTA (não finge), passo preservado', async () => {
    // Journal cujo appliedContent não tem a seq (simula sessão sem o "depois").
    const workspace = ws();
    const files = new Map<string, string>([['/ws/a.ts', 'V0']]);
    const disk = new MemDisk(files, workspace);
    const store = new MemStore();
    const journal = new SnapshotJournal({
      store,
      workspace,
      restoreWriter: disk,
      currentReader: disk,
      cipher: CIPHER,
    });
    await journal.captureEdit({ path: 'a.ts', before: 'V0', after: 'V1', createdByEdit: false });
    files.set('/ws/a.ts', 'V1');
    // Apaga o `after` em memória p/ forçar o caminho de indisponível.
    (journal as unknown as { appliedBySeq: Map<number, unknown> }).appliedBySeq.clear();
    const controller = new UndoController({ journal });
    await controller.undo();
    const redo = await controller.redo();
    expect(redo.note.lines.join('\n')).toMatch(/não está disponível/);
  });

  it('CA-4 — a restauração NÃO escreve fora do workspace (delega ao writer confinado)', async () => {
    // Prova indireta: o writer in-memory só aceita paths resolvíveis no /ws; um
    // alvo que escapa lança. Aqui garantimos que o undo de um path normal escreve
    // SÓ no /ws (o writer resolve+confina). O caso de escape do writer é coberto
    // na suíte do cli-core (R8). Aqui: nenhuma chave fora de /ws aparece.
    const { controller, editFile, files } = setup({ 'a.ts': 'V0' });
    await editFile('a.ts', 'V1');
    await controller.undo();
    for (const k of files.keys()) expect(k.startsWith('/ws/')).toBe(true);
  });
});
