// EST-0957 · I/O concreto do ÍNDICE DE ARQUIVOS do workspace (efêmero, em memória).
//
// O picker `@arquivo` precisa de uma LISTA de caminhos do projeto p/ filtrar. Este
// port a monta a partir da RAIZ confinada (WorkspacePort), RESPEITANDO O `.gitignore`
// (CA-2 — "respeitando o .gitignore"):
//   - se a raiz é um repo git, usa `git ls-files` (rápido e FIEL: tracked +
//     untracked-not-ignored, honrando `.gitignore`/`.git/info/exclude`/excludes
//     globais) — arquivos ignorados pelo git (build custom, `*.log`, segredos
//     locais) NÃO entram no índice/picker;
//   - senão (não-git), cai p/ a varredura fs com a lista hardcoded de dirs
//     pesados/ruído (`node_modules`/`.git`/build) como fallback;
//   - TETO de arquivos em ambos os modos (anti-runaway — CA-2);
//   - symlinks NÃO seguidos (evita ciclos e escapes do workspace);
//   - confinamento: qualquer entrada que resolva p/ fora da raiz é pulada.
//
// Devolve caminhos RELATIVOS à raiz (o que o usuário vê no chip `@caminho`). O
// path-deny do canal (path-deny.ts, CLI-SEC-6) é aplicado por QUEM CONSOME o
// índice (o picker `useFilePicker.loadIndex` filtra por `isPickable`) — aqui só
// listamos. PORTÁVEL? NÃO — I/O concreto (Node fs/git), mora no @hiperplano/aluy-cli.

import { readdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { WorkspacePort } from './workspace.js';

/** Diretórios sempre ignorados (ruído/volume) — espelha o SearchPort. */
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
  '.venv',
  '__pycache__',
]);

export interface NodeFileIndexPortOptions {
  readonly workspace: WorkspacePort;
  /** Teto de arquivos indexados (anti-runaway). Default 5000 (CA-2). */
  readonly maxFiles?: number;
  /**
   * Usar `git ls-files` quando a raiz é um repo (respeita `.gitignore` — CA-2).
   * Default `true`; passe `false` p/ forçar a varredura fs (fallback não-git/teste).
   */
  readonly useGit?: boolean;
}

const DEFAULT_MAX_FILES = 5000;
/** Timeout do `git ls-files` (ms) — anti-trava; estoura ⇒ fallback fs. */
const GIT_TIMEOUT_MS = 5000;

/** Porta de índice de arquivos do workspace (lista efêmera de caminhos relativos). */
export interface FileIndexPort {
  /** Lista os caminhos RELATIVOS à raiz (ordenados), até o teto. Confinado. */
  list(): Promise<readonly string[]>;
}

export class NodeFileIndexPort implements FileIndexPort {
  private readonly workspace: WorkspacePort;
  private readonly maxFiles: number;
  private readonly useGit: boolean;

  constructor(opts: NodeFileIndexPortOptions) {
    this.workspace = opts.workspace;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.useGit = opts.useGit ?? true;
  }

  async list(): Promise<readonly string[]> {
    // CA-2: respeita o `.gitignore`. Se a raiz é repo git, `git ls-files` é a fonte
    // FIEL (não devolve arquivos ignorados). Em qualquer falha (sem git, repo
    // corrompido, timeout) ⇒ fallback p/ a varredura fs com a lista hardcoded.
    if (this.useGit && this.isGitRepo()) {
      const fromGit = await this.gitList();
      if (fromGit !== null) return fromGit;
    }
    const out: string[] = [];
    await this.walk(this.workspace.root, out);
    // Ordena p/ um índice estável (o picker fará o fuzzy por cima).
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  /** `true` se a raiz contém um `.git` (repo ou worktree — arquivo OU diretório). */
  private isGitRepo(): boolean {
    try {
      return existsSync(join(this.workspace.root, '.git'));
    } catch {
      return false;
    }
  }

  /**
   * Lista via `git ls-files` (tracked + untracked-NÃO-ignorados, respeitando
   * `.gitignore`). Confina cada caminho à raiz, pula symlinks, aplica o teto e
   * ordena. Devolve `null` em QUALQUER falha (caller cai p/ a varredura fs).
   */
  private async gitList(): Promise<readonly string[] | null> {
    const root = this.workspace.root;
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          'git',
          // tracked (--cached) + untracked NÃO-ignorados (--others --exclude-standard);
          // -z: separador NUL (caminhos com espaço/quebra não corrompem a lista).
          ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
          { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
          (err, out) => (err ? reject(err) : resolve(out)),
        );
      });
    } catch {
      return null; // sem git/erro/timeout ⇒ fallback fs.
    }
    const rels = stdout.split('\0').filter((p) => p !== '');
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of rels) {
      if (out.length >= this.maxFiles) break;
      const rel = raw.split(sep).join('/');
      if (seen.has(rel)) continue;
      const full = join(root, rel);
      // CONFINAMENTO: pula qualquer caminho que resolva p/ fora da raiz.
      if (!this.workspace.contains(full)) continue;
      // Symlinks NÃO entram no índice (não os seguimos — ciclos/escapes).
      try {
        const st = await lstat(full);
        if (st.isSymbolicLink() || !st.isFile()) continue;
      } catch {
        continue; // sumiu/ilegível — pula (fail-safe).
      }
      seen.add(rel);
      out.push(rel);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    if (out.length >= this.maxFiles) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir ilegível/sumiu — pula (fail-safe).
    }
    for (const entry of entries) {
      if (out.length >= this.maxFiles) return;
      if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await this.walk(full, out);
      } else if (entry.isFile()) {
        // CONFINAMENTO: pula qualquer arquivo que resolva p/ fora da raiz.
        if (!this.workspace.contains(full)) continue;
        // Symlinks NÃO entram no índice (não os seguimos — ciclos/escapes).
        try {
          const st = await lstat(full);
          if (st.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        const rel = relative(this.workspace.root, full).split(sep).join('/');
        out.push(rel);
      }
    }
  }
}
