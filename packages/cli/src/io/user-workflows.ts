// EST-1105 · ADR-workflows — LOADER CONFINADO dos workflows GLOBAIS do
// usuário (`~/.aluy/workflows/*.md`). Espelha o `UserAgentsLoader`: lê o dir
// confinado (0700), parseia cada `.md` com o parser PURO do core
// (`parseWorkflow`) e devolve os workflows GLOBAIS (origin='global').
//
// FRONTEIRA: `~/.aluy/workflows/*.md` é CONFIG DO DONO (confiável). Dir
// ausente/ilegível ⇒ lista VAZIA, NUNCA lança. RES-MD-3: `.md` malformado ⇒
// `WorkflowError` coletado em `errors` (carga visível).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync, mkdirSync, statSync, type Dirent } from 'node:fs';
import {
  parseWorkflow,
  isWorkflowError,
  type WorkflowDef,
  type WorkflowError,
} from '@hiperplano/aluy-cli-core';

/** Permissão restrita do dir `~/.aluy/workflows/`. */
const DIR_MODE = 0o700;

/** Subdir (dentro de `~/.aluy/`) onde moram os workflows globais do usuário. */
export const WORKFLOWS_DIRNAME = 'workflows';

/** Teto defensivo de tamanho de um `.md` (anti-arquivo-gigante). */
const MAX_WORKFLOW_BYTES = 64 * 1024;

/** Teto defensivo de QUANTOS workflows carregar (anti-dir gigante). */
const MAX_WORKFLOWS = 256;

/** Resultado de uma carga: os workflows VÁLIDOS + os ERROS visíveis (RES-MD-3). */
export interface WorkflowLoadResult {
  readonly workflows: readonly WorkflowDef[];
  /** Rejeitados (malformados) — carga visível, NÃO entram. */
  readonly errors: readonly WorkflowError[];
}

export interface UserWorkflowsLoaderOptions {
  /** Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir). */
  readonly baseDir?: string;
}

/**
 * Carregador dos workflows GLOBAIS de `~/.aluy/workflows/*.md`. Idempotente:
 * `load()` relê o dir a cada chamada. Todos com `origin='global'`.
 */
export class UserWorkflowsLoader {
  private readonly dir: string;

  constructor(opts: UserWorkflowsLoaderOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.aluy');
    this.dir = join(base, WORKFLOWS_DIRNAME);
  }

  /** O caminho do dir de workflows (p/ mensagens/teste). */
  get workflowsDir(): string {
    return this.dir;
  }

  /** Garante `~/.aluy/workflows/` com mode 0700 (idempotente, best-effort). */
  ensureDir(): void {
    try {
      mkdirSync(this.dir, { mode: DIR_MODE, recursive: true });
    } catch {
      /* best-effort — fail-safe */
    }
  }

  /**
   * Lê todos os `*.md` DIRETOS de `~/.aluy/workflows/` e devolve os workflows
   * parseados + os erros (RES-MD-3). Determinístico (ordenado por nome de arquivo).
   * Colisão de `name` ⇒ 1º (ordem alfabética) vence. Dir ausente ⇒ vazio.
   */
  load(): WorkflowLoadResult {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return { workflows: [], errors: [] };
    }
    const mdNames = entries
      .filter(
        // F154 — symlink p/ .md TAMBÉM entra: `Dirent.isFile()` não segue o link e
        // os perfis do projeto (symlinks p/ o specs) sumiam do discovery. O readOne
        // re-checa confinamento (resolveInside/HOME) e o statSync (segue o link)
        // exige isFile() + teto de bytes — symlink p/ fora/dir/loop segue rejeitado.
        (e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith('.md'),
      )
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const seen = new Set<string>();
    const workflows: WorkflowDef[] = [];
    const errors: WorkflowError[] = [];
    for (const name of mdNames) {
      if (workflows.length >= MAX_WORKFLOWS) break;
      const parsed = this.readOne(name);
      if (parsed === null) continue;
      if (isWorkflowError(parsed)) {
        errors.push(parsed);
        continue;
      }
      if (seen.has(parsed.name)) continue;
      seen.add(parsed.name);
      workflows.push(parsed);
    }
    return { workflows, errors };
  }

  /** Lê+parseia UM `.md` (origin='global'). Erro de I/O/tamanho ⇒ `null`. */
  private readOne(filename: string): WorkflowDef | WorkflowError | null {
    const full = join(this.dir, filename);
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_WORKFLOW_BYTES) return null;
      const raw = readFileSync(full, 'utf8');
      return parseWorkflow(filename, raw, 'global');
    } catch {
      return null;
    }
  }
}
