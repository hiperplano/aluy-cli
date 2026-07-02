// EST-1105 · ADR-workflows — LOADER CONFINADO dos workflows de PROJETO
// (`.claude/workflows/*.md` + `.aluy/workflows/*.md`, ADR-0113 carve-out) no
// workspace. Espelha o `ProjectAgentsLoader`: MESMO mecanismo, fonte nova; reusa
// o parser PURO do core (`parseWorkflow`) com `origin='project'`.
//
// FRONTEIRA: `.claude/workflows/*.md` + `.aluy/workflows/*.md` são config de
// PROJETO = DADO confinado ao workspace. Dir ausente/escapa-a-raiz ⇒ lista VAZIA,
// NUNCA lança. RES-MD-3: `.md` malformado ⇒ `WorkflowError` coletado em `errors`
// (carga visível).

import { join } from 'node:path';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import {
  parseWorkflow,
  isWorkflowError,
  type WorkflowDef,
  type WorkflowError,
} from '@hiperplano/aluy-cli-core';
import type { WorkspacePort } from './workspace.js';
import { classifyAttachPath } from '../attach/path-deny.js';
import type { WorkflowLoadResult } from './user-workflows.js';

/**
 * Pastas (relativas à raiz) dos workflows de PROJETO.
 * Padrão Claude Code: `.claude/workflows` + Aluy: `.aluy/workflows` (ADR-0113 carve-out).
 *
 * Precedência: `.claude/workflows/` antes de `.aluy/workflows/` (ordem da lista);
 * colisão de `name` entre elas ⇒ 1ª pasta vence (estável).
 */
export const PROJECT_WORKFLOWS_DIRNAMES = ['.claude/workflows', '.aluy/workflows'] as const;

/** Teto defensivo de tamanho de um `.md`. */
const MAX_WORKFLOW_BYTES = 64 * 1024;

/** Teto defensivo de QUANTOS workflows carregar. */
const MAX_WORKFLOWS = 256;

export interface ProjectWorkflowsLoaderOptions {
  /** Workspace confinado — a pasta `.claude/workflows/` é resolvida SÓ sob a raiz. */
  readonly workspace: WorkspacePort;
}

/**
 * Carregador dos workflows de PROJETO (`.claude/workflows/*.md` +
 * `.aluy/workflows/*.md`, no workspace confinado). Todos com `origin='project'`
 * (DADO). `load()` relê a cada chamada (sem cache). Determinístico. Dir ausente
 * ⇒ vazio.
 */
export class ProjectWorkflowsLoader {
  private readonly workspace: WorkspacePort;

  constructor(opts: ProjectWorkflowsLoaderOptions) {
    this.workspace = opts.workspace;
  }

  /**
   * Lê os `*.md` DIRETOS de cada pasta de workflows do projeto (confinado à raiz)
   * e devolve os workflows + erros (RES-MD-3). Precedência entre as DUAS pastas de
   * projeto: `.claude/workflows/` antes de `.aluy/workflows/` (ordem da lista);
   * colisão de `name` entre elas ⇒ 1ª pasta vence (estável). Dir ausente/escapa
   * ⇒ vazio.
   */
  load(): WorkflowLoadResult {
    const seen = new Set<string>();
    const workflows: WorkflowDef[] = [];
    const errors: WorkflowError[] = [];

    for (const dirname of PROJECT_WORKFLOWS_DIRNAMES) {
      // CONFINAMENTO: resolve a PASTA contra a raiz; escapa ⇒ pula.
      let dir: string;
      try {
        dir = this.workspace.resolveInside(dirname);
      } catch {
        continue;
      }

      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // dir ausente/ilegível ⇒ sem workflows desta pasta (fail-safe).
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

      for (const name of mdNames) {
        if (workflows.length >= MAX_WORKFLOWS) break;
        const parsed = this.readOne(dirname, dir, name);
        if (parsed === null) continue;
        if (isWorkflowError(parsed)) {
          errors.push(parsed);
          continue;
        }
        if (seen.has(parsed.name)) continue; // colisão (intra-projeto): 1ª pasta vence.
        seen.add(parsed.name);
        workflows.push(parsed);
      }
    }
    return { workflows, errors };
  }

  /** Lê+parseia UM `.md` (origin='project'). Erro/tamanho/escape/path-deny ⇒ `null`. */
  private readOne(
    dirname: string,
    dir: string,
    filename: string,
  ): WorkflowDef | WorkflowError | null {
    const rel = `${dirname}/${filename}`;
    if (classifyAttachPath(rel).kind !== 'allow') return null;
    const full = join(dir, filename);
    try {
      this.workspace.resolveInside(rel);
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_WORKFLOW_BYTES) return null;
      const raw = readFileSync(full, 'utf8');
      return parseWorkflow(filename, raw, 'project');
    } catch {
      return null;
    }
  }
}
