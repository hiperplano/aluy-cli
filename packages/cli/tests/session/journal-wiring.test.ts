// EST-0960a · ADR-0056 — INTEGRAÇÃO do journal no wiring da sessão.
//
// Prova que `buildSession` fia o journal de snapshot ao loop: o store vive em
// `~/.aluy/undo/<session>/` (tmp injetado, FORA do workspace), e a captura via a
// porta de tool (a face que a `edit_file` enxerga) grava o conteúdo-antes num
// blob 0600. Fecha o caminho end-to-end mecanismo↔I/O concreto.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSession } from '../../src/session/wiring.js';

describe('EST-0960a · journal fiado no buildSession', () => {
  let base: string;
  let workspaceRoot: string;
  let journalBaseDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-wiring-'));
    workspaceRoot = join(base, 'project');
    journalBaseDir = join(base, 'home', '.aluy');
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('expõe o journal e o store na sessão; o store aponta p/ ~/.aluy/ FORA do workspace', () => {
    const s = buildSession({
      workspaceRoot,
      journalBaseDir,
      sessionId: 'sess-test',
      env: {},
    });
    expect(s.journal).toBeDefined();
    expect(s.journalStore.sessionRoot).toBe(join(journalBaseDir, 'undo', 'sess-test'));
    // FORA do workspace.
    expect(s.journalStore.sessionRoot.startsWith(workspaceRoot)).toBe(false);
    // a restauração está confinada à raiz do workspace (R8).
    expect(s.journal.workspaceRoot).toBe(s.workspace.root);
  });

  it('a captura via a porta de tool grava o conteúdo-antes num blob 0600', async () => {
    const s = buildSession({
      workspaceRoot,
      journalBaseDir,
      sessionId: 'sess-cap',
      env: {},
    });
    // a `edit_file` chama exatamente isto (ports.journal.captureEdit) antes de
    // sobrescrever, reusando o `before` do diff.
    await s.journal.captureEdit({
      path: 'src/a.ts',
      before: 'SEGREDO_ANTES',
      after: 'depois',
      createdByEdit: false,
    });
    const entry = s.journal.top();
    expect(entry?.kind).toBe('edit');

    // o blob existe no journal da sessão, com modo 0600.
    const blobsDir = join(journalBaseDir, 'undo', 'sess-cap', 'blobs');
    expect(existsSync(blobsDir)).toBe(true);
    const stack = readFileSync(join(journalBaseDir, 'undo', 'sess-cap', 'stack.jsonl'), 'utf8');
    // a pilha guarda a ref, nunca o conteúdo (T7).
    expect(stack).not.toContain('SEGREDO_ANTES');
    if (entry?.kind === 'edit') {
      const blobPath = join(blobsDir, entry.targets[0]!.beforeRef);
      expect(statSync(blobPath).mode & 0o777).toBe(0o600);
    }
  });

  // EST-0960a · #1 (a TRAVA REAL) — prova END-TO-END pelo store REAL (`node:fs`):
  // o blob NO DISCO é ciphertext (um `cat` devolve lixo cifrado), e a restauração
  // decifra na sessão viva. É a contraprova de que a leitura do journal é
  // INOFENSIVA mesmo se o matcher de path furar.
  it('#1 — o blob NO DISCO é ciphertext (segredo ausente); restore decifra na sessão viva', async () => {
    const SECRET = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/EXAMPLEKEY-super-secreta';
    // arquivo real no workspace com o segredo (o `before` que a edição captura).
    writeFileSync(join(workspaceRoot, 'secrets.env'), SECRET);
    const s = buildSession({ workspaceRoot, journalBaseDir, sessionId: 'sess-cipher', env: {} });

    await s.journal.captureEdit({
      path: 'secrets.env',
      before: SECRET,
      after: 'REDACTED',
      createdByEdit: false,
    });

    // lê o blob CRU do disco (= o que um `cat ~/.aluy/.../blobs/*` devolveria).
    const blobsDir = join(journalBaseDir, 'undo', 'sess-cipher', 'blobs');
    const blobFiles = readdirSync(blobsDir);
    expect(blobFiles.length).toBe(1);
    const onDisk = readFileSync(join(blobsDir, blobFiles[0]!), 'utf8');

    // o segredo em claro NÃO aparece no blob em repouso (é ciphertext base64).
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).not.toContain('wJalrXUtnFEMI');
    expect(onDisk).not.toContain('AWS_SECRET');
    expect(/^[A-Za-z0-9+/=]+$/.test(onDisk.trim())).toBe(true);

    // a pilha (stack.jsonl) tampouco carrega o segredo (só a ref).
    const stack = readFileSync(join(journalBaseDir, 'undo', 'sess-cipher', 'stack.jsonl'), 'utf8');
    expect(stack).not.toContain('wJalrXUtnFEMI');

    // a sessão VIVA decifra e restaura o conteúdo-antes exato no workspace (R8).
    writeFileSync(join(workspaceRoot, 'secrets.env'), 'REDACTED');
    const out = await s.journal.restore(s.journal.top()!);
    expect(out.action).toBe('written');
    expect(readFileSync(join(workspaceRoot, 'secrets.env'), 'utf8')).toBe(SECRET);
  });
});
