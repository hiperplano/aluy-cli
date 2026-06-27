// EST-0960a · ADR-0056 — I/O CONCRETO do journal (gate FORTE do `seguranca`).
//
// Bateria (parte concreta): T2 (0600/0700 ATÔMICO), T3 (FORA do workspace), T7
// (sem segredo em log/telemetria — conteúdo nunca em stdout/entries), T10 (GC
// pós-crash + cleanup de fim com unlink REAL de blobs E dir-pai), T11 (restauração
// resiste a TOCTOU/symlink: alvo confinado ao workspace NO MOMENTO DA ESCRITA).
//
// Tudo sobre um tmpdir (baseDir injetado) — a suíte NUNCA toca o `~/.aluy/` real.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeJournalStore } from '../../src/io/journal-store.js';
import { NodeRestoreWriter, NodeCurrentReader } from '../../src/io/journal-restore.js';
import { NodeWorkspace, WorkspaceEscapeError } from '../../src/io/workspace.js';

/** Modo de permissão (últimos 3 octais) de um path. */
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('NodeJournalStore — proteção do journal (R5/R6/R7)', () => {
  let base: string; // raiz tmp da suíte
  let journalBase: string; // ~/.aluy simulado (tmp)
  let workspaceRoot: string; // raiz do workspace (separado!)

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-journal-'));
    journalBase = join(base, 'home', '.aluy');
    workspaceRoot = join(base, 'project');
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('T2 — blob nasce 0600 e os dirs 0700 ATÔMICO (assert logo após criação)', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    const ref = await store.putBlob('SEGREDO=abc123');

    // o blob existe e tem modo 0600 — verificado IMEDIATAMENTE (sem janela larga).
    const blobPath = join(journalBase, 'undo', 's1', 'blobs', ref);
    expect(existsSync(blobPath)).toBe(true);
    expect(mode(blobPath)).toBe(0o600);

    // toda a hierarquia de dirs nasceu 0700 (R5/R6 dir-pai inclusive).
    expect(mode(journalBase)).toBe(0o700);
    expect(mode(join(journalBase, 'undo'))).toBe(0o700);
    expect(mode(join(journalBase, 'undo', 's1'))).toBe(0o700);
    expect(mode(join(journalBase, 'undo', 's1', 'blobs'))).toBe(0o700);
  });

  it('T3 — journal fica FORA do workspace (em ~/.aluy/, nunca no repo)', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    await store.putBlob('conteudo');
    // o blob está sob journalBase, e journalBase NÃO está sob o workspace.
    expect(store.sessionRoot.startsWith(journalBase)).toBe(true);
    expect(store.sessionRoot.startsWith(workspaceRoot)).toBe(false);
    // o workspace não ganhou nenhum `.aluy/` (não vaza p/ commit/contexto).
    expect(existsSync(join(workspaceRoot, '.aluy'))).toBe(false);
  });

  it('T7 — conteúdo-antes (segredo) NUNCA aparece no append-log da pilha (sem telemetria)', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    const secret = 'AWS_SECRET_ACCESS_KEY=zzz-very-secret';
    const ref = await store.putBlob(secret);
    await store.appendEntry({
      kind: 'edit',
      seq: 0,
      ts: 1,
      tool: 'edit_file',
      targets: [
        { path: '.env', beforeRef: ref, beforeHash: store.hash(secret), createdByEdit: false },
      ],
      appliedHash: 'h2',
    });
    // a pilha (stack.jsonl) guarda só a REF (ponteiro), nunca o conteúdo.
    const stackRaw = readFileSync(join(journalBase, 'undo', 's1', 'stack.jsonl'), 'utf8');
    expect(stackRaw).toContain(ref);
    expect(stackRaw).not.toContain('zzz-very-secret');
    // o conteúdo só vive no blob (0600), recuperável só pela mecânica interna.
    expect(await store.getBlob(ref)).toBe(secret);
  });

  it('T10a — cleanup de FIM remove blobs E o dir-pai da sessão (unlink real)', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    await store.putBlob('x');
    expect(existsSync(store.sessionRoot)).toBe(true);
    await store.cleanup();
    // o dir da sessão (e os blobs dentro) sumiu fisicamente.
    expect(existsSync(store.sessionRoot)).toBe(false);
    // idempotente: 2º cleanup não falha.
    await expect(store.cleanup()).resolves.toBeUndefined();
  });

  it('T10b — GC no start coleta sessão ÓRFÃ (crash sem cleanup) com unlink real', async () => {
    // simula uma sessão antiga que terminou abruptamente (dir existe, sem cleanup).
    const orphanDir = join(journalBase, 'undo', 'old-crashed');
    mkdirSync(join(orphanDir, 'blobs'), { recursive: true, mode: 0o700 });
    writeFileSync(join(orphanDir, 'blobs', 'b0'), 'segredo-orfao', { mode: 0o600 });

    // a sessão NOVA roda o GC no start; o `now` avança além do teto de órfã.
    const futureNow = Date.now() + 48 * 60 * 60 * 1000;
    const store = new NodeJournalStore({
      sessionId: 's2',
      baseDir: journalBase,
      now: () => futureNow,
    });
    await store.gcOrphans();

    // a órfã foi coletada (unlink real); a sessão atual permanece intocada.
    expect(existsSync(orphanDir)).toBe(false);
  });

  it('T10c — GC NÃO coleta a sessão ATUAL nem sessões recentes', async () => {
    const store = new NodeJournalStore({ sessionId: 's-current', baseDir: journalBase });
    await store.putBlob('vivo'); // cria a sessão atual
    await store.gcOrphans();
    expect(existsSync(store.sessionRoot)).toBe(true);
  });

  it('teto de retenção: deleteBlob faz unlink REAL do blob descartado', async () => {
    const store = new NodeJournalStore({ sessionId: 's1', baseDir: journalBase });
    const ref = await store.putBlob('descartavel');
    const blobPath = join(journalBase, 'undo', 's1', 'blobs', ref);
    expect(existsSync(blobPath)).toBe(true);
    await store.deleteBlob(ref);
    expect(existsSync(blobPath)).toBe(false);
    // idempotente.
    await expect(store.deleteBlob(ref)).resolves.toBeUndefined();
  });

  it('loadEntries reconstrói a pilha persistida (API que a 0960b consome)', async () => {
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
    await store.appendEntry({
      kind: 'barrier',
      seq: 1,
      ts: 2,
      tool: 'run_command',
      command: 'npm test',
    });
    const entries = await store.loadEntries();
    expect(entries.map((e) => e.kind)).toEqual(['edit', 'barrier']);
    expect(entries[1]!.kind === 'barrier' && entries[1]!.command).toBe('npm test');
  });

  it('loadEntries de sessão sem pilha ⇒ vazio (nada a desfazer)', async () => {
    const store = new NodeJournalStore({ sessionId: 'vazia', baseDir: journalBase });
    expect(await store.loadEntries()).toEqual([]);
  });
});

describe('NodeRestoreWriter — restauração confinada + TOCTOU (R8/T11)', () => {
  let base: string;
  let workspaceRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-restore-'));
    workspaceRoot = join(base, 'project');
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('escreve de volta DENTRO do workspace (resolve no momento da escrita)', async () => {
    writeFileSync(join(workspaceRoot, 'f.ts'), 'MUTADO');
    const writer = new NodeRestoreWriter({ workspace: new NodeWorkspace({ root: workspaceRoot }) });
    const at = await writer.writeConfined('f.ts', 'ORIGINAL');
    expect(readFileSync(at, 'utf8')).toBe('ORIGINAL');
    expect(at.startsWith(workspaceRoot)).toBe(true);
  });

  it('T11 — alvo `..` que escapa o workspace ⇒ REJEITADO (nenhum byte fora)', async () => {
    writeFileSync(join(base, 'outside.txt'), 'OUT');
    const writer = new NodeRestoreWriter({ workspace: new NodeWorkspace({ root: workspaceRoot }) });
    await expect(writer.writeConfined('../outside.txt', 'PWNED')).rejects.toThrow(
      WorkspaceEscapeError,
    );
    // o arquivo de fora NÃO foi tocado.
    expect(readFileSync(join(base, 'outside.txt'), 'utf8')).toBe('OUT');
  });

  it('T11 — SYMLINK plantado p/ fora do workspace ⇒ restauração resolve e REJEITA', async () => {
    // alguém troca `f.ts` por um symlink p/ um arquivo FORA do workspace DEPOIS da
    // captura. A restauração resolve o symlink NO MOMENTO DA ESCRITA e rejeita —
    // a escrita NÃO desvia p/ fora (R8/TOCTOU).
    const outside = join(base, 'secret-outside.txt');
    writeFileSync(outside, 'INTACTO');
    symlinkSync(outside, join(workspaceRoot, 'f.ts'));

    const writer = new NodeRestoreWriter({ workspace: new NodeWorkspace({ root: workspaceRoot }) });
    await expect(writer.writeConfined('f.ts', 'RESTAURADO')).rejects.toThrow(WorkspaceEscapeError);
    // o alvo do symlink (fora do workspace) ficou INTACTO.
    expect(readFileSync(outside, 'utf8')).toBe('INTACTO');
  });

  it('removeConfined desfaz uma criação DENTRO do workspace; rejeita escape', async () => {
    const created = join(workspaceRoot, 'criado.ts');
    writeFileSync(created, 'NOVO');
    const writer = new NodeRestoreWriter({ workspace: new NodeWorkspace({ root: workspaceRoot }) });
    await writer.removeConfined('criado.ts');
    expect(existsSync(created)).toBe(false);
    // escape rejeitado.
    await expect(writer.removeConfined('../../etc/hosts')).rejects.toThrow(WorkspaceEscapeError);
  });

  it('NodeCurrentReader lê o estado atual confinado; fora do workspace ⇒ undefined', async () => {
    writeFileSync(join(workspaceRoot, 'f.ts'), 'ATUAL');
    const reader = new NodeCurrentReader({ workspace: new NodeWorkspace({ root: workspaceRoot }) });
    expect(await reader.readCurrent('f.ts')).toBe('ATUAL');
    expect(await reader.readCurrent('../escape.txt')).toBeUndefined();
    expect(await reader.readCurrent('inexistente.ts')).toBeUndefined();
  });
});
