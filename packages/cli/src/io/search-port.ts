// EST-0948 · I/O concreto da SearchPort (grep + glob) — confinado ao workspace.
//
// Implementa `SearchPort.search` (grep) E `SearchPort.glob` (EST-0944) do core. Varre o
// filesystem a partir de um path BASE confinado (`WorkspacePort.resolveInside`). É
// efeito de LEITURA (grep/glob são `read` → default allow na 0945), mas ainda assim o
// BASE é confinado: não varremos fora da raiz, e symlinks que apontem p/ fora são
// pulados (não seguimos para fora do workspace).
//
// Implementação honesta e portável em puro Node (sem depender de `rg`/`grep` do SO):
// caminha o diretório, ignora `.git`/`node_modules`/binários. O grep casa substring
// LITERAL; o glob casa NOMES de arquivo contra um padrão (`compileGlob`, do core, PURO
// e anti-ReDoS) RESPEITANDO O `.gitignore` (via `git ls-files`, como o file-index/
// @arquivo) com fallback fs. Não é o mais rápido possível — é correto, confinado e
// sem dependência externa.

import { readdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  GlobOutcome,
  GlobTruncation,
  SearchMatch,
  SearchPort,
  SearchOutcome,
} from '@hiperplano/aluy-cli-core';
import { compileGlob } from '@hiperplano/aluy-cli-core';
import type { WorkspacePort } from './workspace.js';
import { readBounded } from './read-bounded.js';

/** Diretórios sempre ignorados na varredura (ruído/volume). */
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'coverage', '.cache']);

export interface NodeSearchPortOptions {
  readonly workspace: WorkspacePort;
  /** Máximo de acertos devolvidos (anti-flood do contexto). Default 200. */
  readonly maxMatches?: number;
  /** Máximo de arquivos varridos (anti-runaway). Default 5000. */
  readonly maxFiles?: number;
  /**
   * EST-1010 · ANTI-OOM — máximo de bytes lidos POR ARQUIVO na varredura. Um arquivo
   * maior é lido SÓ até este teto (stream parcial, nunca materializado inteiro) e o
   * scan dos primeiros `maxScanBytes` segue valendo. Default 5 MiB (mesmo limiar do
   * read_file). Antes, `readFile(file,'utf8')` materializava o arquivo INTEIRO — um
   * único dump de vários GB OOMava o processo.
   */
  readonly maxScanBytes?: number;
  /**
   * EST-0944 — usar `git ls-files` no `glob()` p/ respeitar o `.gitignore` (como o
   * file-index/@arquivo). Default `true`; `false` força a varredura fs (teste/não-git).
   */
  readonly useGit?: boolean;
}

const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_SCAN_BYTES = 5 * 1024 * 1024;
/** Timeout do `git ls-files` (ms) — anti-trava; estoura ⇒ fallback fs (espelha file-index). */
const GIT_TIMEOUT_MS = 5000;

/**
 * EST-1016 — ESTADO de varredura, mutado in-loco enquanto `walk`/`scanFile` rodam.
 * Acumula os acertos, o contador de arquivos e os SINAIS de truncamento (cada teto que
 * disparou). Os tetos em si (anti-OOM/anti-flood, EST-1010) PERMANECEM intocados — só
 * passamos a REGISTRAR quando cortam.
 */
interface ScanState {
  filesSeen: number;
  byMaxMatches: boolean;
  byMaxFiles: boolean;
  readonly byScanBytes: string[];
}

export class NodeSearchPort implements SearchPort {
  private readonly workspace: WorkspacePort;
  private readonly maxMatches: number;
  private readonly maxFiles: number;
  private readonly maxScanBytes: number;
  private readonly useGit: boolean;

  constructor(opts: NodeSearchPortOptions) {
    this.workspace = opts.workspace;
    this.maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxScanBytes = opts.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
    this.useGit = opts.useGit ?? true;
  }

  async search(pattern: string, path: string): Promise<SearchOutcome> {
    // CONFINAMENTO: o BASE da varredura é resolvido contra a raiz. Lança se escapa.
    const base = this.workspace.resolveInside(path === '' ? '.' : path);
    const matches: SearchMatch[] = [];
    const state: ScanState = {
      filesSeen: 0,
      byMaxMatches: false,
      byMaxFiles: false,
      byScanBytes: [],
    };
    // Base pode ser um ARQUIVO (grep num arquivo só) ou um DIRETÓRIO (varredura).
    let isDir = false;
    try {
      isDir = (await lstat(base)).isDirectory();
    } catch {
      return { matches, truncated: {} }; // base sumiu/ilegível ⇒ sem acertos (fail-safe).
    }
    if (isDir) {
      await this.walk(base, pattern, matches, state);
    } else {
      await this.scanFile(base, pattern, matches, state);
    }
    return { matches, truncated: this.toTruncation(state) };
  }

  /**
   * EST-0944 — `glob`: acha ARQUIVOS por PADRÃO sob `path` (confinado à raiz). Enumera
   * os arquivos do workspace RESPEITANDO O `.gitignore` (via `git ls-files`, como o
   * file-index/@arquivo; fallback fs-walk não-git), confina cada caminho à raiz, pula
   * symlinks, e testa o caminho RELATIVO (POSIX `/`) contra o matcher PURO (`compileGlob`,
   * anti-ReDoS). Tetos: `maxMatches` (resultados) e `maxFiles` (arquivos inspecionados) —
   * os MESMOS já configurados p/ o grep — com truncamento HONESTO quando estouram.
   *
   * `path` restringe a busca a uma subárvore (o padrão casa RELATIVO a `path`, igual ao
   * ergonômico do grep `path`). Lança `WorkspaceEscapeError` se `path` escapa a raiz, e
   * propaga `GlobSyntaxError` (do core) em padrão inválido — vira erro VISÍVEL no tool.
   */
  async glob(pattern: string, path: string): Promise<GlobOutcome> {
    // CONFINAMENTO: o BASE é resolvido contra a raiz (lança se escapa). Tudo abaixo é
    // RELATIVO a ele — o padrão casa caminhos relativos ao `path` pedido.
    const base = this.workspace.resolveInside(path === '' ? '.' : path);
    // `compileGlob` lança `GlobSyntaxError` em padrão inválido — propaga p/ o tool
    // (que o converte em erro VISÍVEL). Compila ANTES de varrer (não gasta I/O à toa).
    const matcher = compileGlob(pattern);

    // Enumera os caminhos relativos AO BASE, gitignore-aware + confinado + capado.
    const { rels, scannedAll } = await this.enumerate(base);

    const paths: string[] = [];
    let byMaxResults = false;
    for (const rel of rels) {
      if (paths.length >= this.maxMatches) {
        byMaxResults = true;
        break;
      }
      if (matcher(rel)) paths.push(rel);
    }
    paths.sort((a, b) => a.localeCompare(b));
    const truncated: GlobTruncation = {
      ...(byMaxResults ? { byMaxResults: true } : {}),
      ...(scannedAll ? {} : { byMaxScanned: true }),
    };
    return { paths, truncated };
  }

  /**
   * EST-0944 — lista os caminhos RELATIVOS ao `base` (POSIX `/`), respeitando o
   * `.gitignore`. Tenta `git ls-files` (FIEL: tracked + untracked-não-ignorados) e cai
   * p/ a varredura fs (`IGNORED_DIRS`) se não for repo/git falhar. Confina à raiz, pula
   * symlinks, aplica o teto `maxFiles` de INSPEÇÃO. `scannedAll=false` ⇒ bateu o teto.
   */
  private async enumerate(base: string): Promise<{ rels: string[]; scannedAll: boolean }> {
    if (this.useGit && existsSync(join(base, '.git'))) {
      const fromGit = await this.gitList(base);
      if (fromGit !== null) return fromGit;
    }
    const out: string[] = [];
    const scannedAll = await this.walkNames(base, base, out);
    return { rels: out, scannedAll };
  }

  /**
   * Lista via `git ls-files` a partir de `cwd=base` (respeita `.gitignore`). Confina à
   * raiz, pula symlinks, aplica o teto `maxFiles`. `null` em QUALQUER falha (caller cai
   * p/ a varredura fs). Espelha `NodeFileIndexPort.gitList`.
   */
  private async gitList(base: string): Promise<{ rels: string[]; scannedAll: boolean } | null> {
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          'git',
          ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
          { cwd: base, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
          (e, o) => (e ? reject(e) : resolve(o)),
        );
      });
    } catch {
      return null; // sem git/erro/timeout ⇒ fallback fs.
    }
    const raw = stdout.split('\0').filter((p) => p !== '');
    const rels: string[] = [];
    let scannedAll = true;
    for (const r of raw) {
      if (rels.length >= this.maxFiles) {
        scannedAll = false;
        break;
      }
      const rel = r.split(sep).join('/');
      const full = join(base, rel);
      // CONFINAMENTO: pula qualquer caminho que resolva p/ fora da raiz.
      if (!this.workspace.contains(full)) continue;
      // Symlinks NÃO entram (não os seguimos — ciclos/escapes do workspace).
      try {
        const st = await lstat(full);
        if (st.isSymbolicLink() || !st.isFile()) continue;
      } catch {
        continue; // sumiu/ilegível — pula (fail-safe).
      }
      rels.push(rel);
    }
    return { rels, scannedAll };
  }

  /**
   * Varredura fs (fallback não-git): caminhos RELATIVOS a `root` (POSIX `/`), ignorando
   * `IGNORED_DIRS`, confinada à raiz, sem seguir symlinks, capada em `maxFiles`. Devolve
   * `false` se bateu o teto (varredura PARCIAL). Espelha `NodeFileIndexPort.walk`.
   */
  private async walkNames(root: string, dir: string, out: string[]): Promise<boolean> {
    if (out.length >= this.maxFiles) return false;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return true; // dir ilegível/sumiu — pula (fail-safe, não corta a varredura toda).
    }
    for (const entry of entries) {
      if (out.length >= this.maxFiles) return false;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const ok = await this.walkNames(root, full, out);
        if (!ok) return false;
      } else if (entry.isFile()) {
        if (!this.workspace.contains(full)) continue;
        try {
          const st = await lstat(full);
          if (st.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
    return true;
  }

  /**
   * EST-1016 — converte o estado mutável de varredura no sinal de truncamento do
   * contrato. Inclui SÓ os ramos que dispararam (campo ausente = ramo limpo); um estado
   * sem corte vira `{}` (varredura completa, zero ruído no contrato).
   */
  private toTruncation(state: ScanState): SearchOutcome['truncated'] {
    return {
      ...(state.byScanBytes.length > 0 ? { byScanBytes: state.byScanBytes } : {}),
      ...(state.byMaxMatches ? { byMaxMatches: true } : {}),
      ...(state.byMaxFiles ? { byMaxFiles: true } : {}),
    };
  }

  private async walk(
    dir: string,
    pattern: string,
    out: SearchMatch[],
    state: ScanState,
  ): Promise<void> {
    if (out.length >= this.maxMatches || state.filesSeen >= this.maxFiles) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir ilegível/sumiu — pula (fail-safe, não derruba a busca)
    }
    for (const entry of entries) {
      // EST-1016 — registra QUAL teto cortou a varredura (anti-flood/anti-runaway). Os
      // limites em si (EST-1010) permanecem; só os tornamos VISÍVEIS aqui.
      if (out.length >= this.maxMatches) {
        state.byMaxMatches = true;
        return;
      }
      if (state.filesSeen >= this.maxFiles) {
        state.byMaxFiles = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await this.walk(full, pattern, out, state);
      } else if (entry.isFile()) {
        // CONFINAMENTO: pula qualquer arquivo (incl. via symlink) que resolva p/
        // fora da raiz — não seguimos symlinks que escapem o workspace.
        if (!this.workspace.contains(full)) continue;
        // Pula symlinks (não os seguimos na varredura — evita ciclos e escapes).
        try {
          const st = await lstat(full);
          if (st.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        state.filesSeen += 1;
        await this.scanFile(full, pattern, out, state);
      }
      // entradas que não são file/dir (symlink de dir, socket): ignoradas.
    }
    // Pós-loop: se a varredura encheu de acertos/arquivos, marca o teto que estourou
    // (cobre o caso de o limite ser atingido na ÚLTIMA entrada deste diretório).
    if (out.length >= this.maxMatches) state.byMaxMatches = true;
    if (state.filesSeen >= this.maxFiles) state.byMaxFiles = true;
  }

  private async scanFile(
    file: string,
    pattern: string,
    out: SearchMatch[],
    state: ScanState,
  ): Promise<void> {
    let content: string;
    let truncated: boolean;
    try {
      // EST-1010 · ANTI-OOM: `stat` ANTES de materializar — um arquivo > teto é lido
      // SÓ até `maxScanBytes` (stream parcial, nunca o todo). Antes, `readFile(file)`
      // alocava o arquivo INTEIRO: um único dump de vários GB OOMava o processo.
      ({ content, truncated } = await readBounded(file, this.maxScanBytes));
    } catch {
      return; // binário/ilegível/sumiu — pula
    }
    // EST-1016 — arquivo lido SÓ até o teto de bytes: registra o path (o resto NÃO foi
    // varrido ⇒ pode haver acertos invisíveis). Os tetos (EST-1010) permanecem.
    if (truncated) state.byScanBytes.push(file);
    // Heurística simples de "binário": NUL no conteúdo ⇒ pula.
    if (content.includes(String.fromCharCode(0))) return;
    const lines = content.split('\n');
    // Arquivo truncado: a ÚLTIMA linha pode ser um fragmento cortado no teto — não a
    // varremos como linha real (evita match espúrio numa metade de linha). As linhas
    // anteriores (íntegras, dentro do teto) seguem valendo. O resto do arquivo (além
    // do teto) NÃO é varrido — é o preço honesto de não materializar GBs.
    const scanLines = truncated && lines.length > 1 ? lines.slice(0, -1) : lines;
    for (let i = 0; i < scanLines.length; i++) {
      if (out.length >= this.maxMatches) {
        state.byMaxMatches = true;
        return;
      }
      const line = scanLines[i] ?? '';
      if (line.includes(pattern)) {
        out.push({ path: file, line: i + 1, text: line.slice(0, 300) });
      }
    }
  }
}
