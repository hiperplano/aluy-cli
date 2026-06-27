// EST-0977 · ADR-0061 · CLI-SEC-11 (reaplicado) — LOADER CONFINADO dos agentes de
// PROJETO (`.claude/agents/*.md` + `.aluy/agents/*.md`, ADR-0113 carve-out) no
// workspace. Espelha o `ProjectCommandsLoader` (EST-0979): MESMO mecanismo, fonte
// nova; reusa o parser PURO do core (`parseAgentProfile`) com `origin='project'`.
//
// FRONTEIRA DE PROVENIÊNCIA (o que o `seguranca` reconfere — gate FORTE):
//   • `.claude/agents/*.md` + `.aluy/agents/*.md` são config de PROJETO = DADO
//     confinado ao workspace (vinda de repo possivelmente clonado/terceiro). POR ISSO
//     `origin='project'`:
//       - NÃO entra na auto-seleção (R-S3-3/RES-MD-2 — description de terceiro = DADO,
//         nunca decide quem roda);
//       - NÃO herda tratamento-confiável por nome igual a um global (RES-MD-1 —
//         anti-spoofing; o conflito é decidido no registro, com origem visível);
//       - NÃO relaxa a catraca: `tools:` continua ⊆ pai (GS-MD1), `spawn_agent`
//         continua proibido (E-A1/GS-MD2), Plan/sempre-ask continuam valendo (GS-MD3).
//   • CONFINAMENTO (WorkspacePort): a pasta é resolvida/canonicalizada SÓ sob a raiz
//     do workspace (symlink p/ fora ⇒ rejeitado). Lê SÓ `*.md` DIRETOS (sem recursão).
//
// RES-MD-3 (FALHA FECHADA): `.md` malformado/`tools` ilegível ⇒ `AgentProfileError`
// coletado em `errors` (carga visível), NUNCA "agente sem restrição". Dir ausente/
// escapa-a-raiz ⇒ lista VAZIA, NUNCA lança.

import { join } from 'node:path';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import {
  parseAgentProfile,
  isAgentProfileError,
  type AgentProfile,
  type AgentProfileError,
} from '@aluy/cli-core';
import type { WorkspacePort } from './workspace.js';
import { classifyAttachPath } from '../attach/path-deny.js';
import type { AgentLoadResult } from './user-agents.js';

/**
 * Pastas (relativas à raiz) dos agentes de PROJETO.
 * Padrão Claude Code: `.claude/agents` + Aluy: `.aluy/agents` (ADR-0113 carve-out).
 *
 * Precedência: `.claude/agents/` antes de `.aluy/agents/` (ordem da lista);
 * colisão de `name` entre elas ⇒ 1ª pasta vence (estável).
 */
export const PROJECT_AGENTS_DIRNAMES = ['.claude/agents', '.aluy/agents'] as const;

/** Teto defensivo de tamanho de um `.md` (anti-arquivo-gigante). */
const MAX_AGENT_BYTES = 64 * 1024;

/** Teto defensivo de QUANTOS agentes carregar (anti-dir gigante). */
const MAX_AGENTS = 256;

export interface ProjectAgentsLoaderOptions {
  /** Workspace confinado — as pastas de agentes são resolvidas SÓ sob a raiz. */
  readonly workspace: WorkspacePort;
}

/**
 * Carregador dos agentes de PROJETO (`.claude/agents/*.md` + `.aluy/agents/*.md`, no
 * workspace confinado). Todos com `origin='project'` (DADO; fora da auto-seleção).
 * `load()` relê a cada chamada (sem cache). Determinístico. Dir ausente ⇒ vazio.
 */
export class ProjectAgentsLoader {
  private readonly workspace: WorkspacePort;

  constructor(opts: ProjectAgentsLoaderOptions) {
    this.workspace = opts.workspace;
  }

  /**
   * Lê os `*.md` DIRETOS de cada pasta de agentes do projeto (confinado à raiz) e
   * devolve os perfis + erros (RES-MD-3). Precedência entre as DUAS pastas de projeto:
   * `.claude/agents/` antes de `.aluy/agents/` (ordem da lista); colisão de `name`
   * entre elas ⇒ 1ª pasta vence (estável). Dir ausente/escapa-a-raiz ⇒ vazio.
   */
  load(): AgentLoadResult {
    const seen = new Set<string>();
    const profiles: AgentProfile[] = [];
    const errors: AgentProfileError[] = [];

    for (const dirname of PROJECT_AGENTS_DIRNAMES) {
      // CONFINAMENTO: resolve a PASTA contra a raiz; escapa ⇒ pula (nada lido).
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
        continue; // dir ausente/ilegível ⇒ sem agentes desta pasta (fail-safe).
      }
      const mdNames = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));

      for (const name of mdNames) {
        if (profiles.length >= MAX_AGENTS) break;
        const parsed = this.readOne(dirname, dir, name);
        if (parsed === null) continue;
        if (isAgentProfileError(parsed)) {
          errors.push(parsed); // RES-MD-3: carga visível, NÃO entra.
          continue;
        }
        if (seen.has(parsed.name)) continue; // colisão (intra-projeto): 1ª pasta vence.
        seen.add(parsed.name);
        profiles.push(parsed);
      }
    }
    return { profiles, errors };
  }

  /** Lê+parseia UM `.md` (origin='project'). Erro/tamanho/escape/path-deny ⇒ `null`. */
  private readOne(
    dirname: string,
    dir: string,
    filename: string,
  ): AgentProfile | AgentProfileError | null {
    const rel = `${dirname}/${filename}`;
    // PATH-DENY explícito do arquivo (defesa-em-prof.; agentes `.md` são `allow`).
    if (classifyAttachPath(rel).kind !== 'allow') return null;
    const full = join(dir, filename);
    try {
      // CONFINAMENTO re-checado no arquivo (symlink interno p/ fora ⇒ rejeita).
      this.workspace.resolveInside(rel);
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_AGENT_BYTES) return null;
      const raw = readFileSync(full, 'utf8');
      return parseAgentProfile(filename, raw, 'project');
    } catch {
      return null;
    }
  }
}
