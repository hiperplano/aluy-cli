// EST-0979 · ADR-0053 §2.2 — LOADER CONFINADO dos comandos do PROJETO
// (`.claude/commands/*.md` + `.aluy/commands/*.md`, ADR-0113 carve-out) no
// workspace, espelhando `~/.aluy/commands/*.md`.
//
// MESMO MECANISMO, FONTE NOVA: cada `.md` vira o slash-command `/<nome>`; o corpo é um
// TEMPLATE de prompt expandido com os args e submetido como OBJETIVO do usuário —
// idêntico ao `UserCommandsLoader` (EST-0974). EST-0979 só amplia o LOCUS de
// descoberta (as pastas do projeto), reusando o parser PURO `parseUserCommand`.
//
// FRONTEIRA DE PROVENIÊNCIA (o que o `seguranca` reconfere):
//   • O `.md` é CONFIG DO DONO do repo (config de PROJETO = DADO confinado ao
//     workspace), como o AGENT.md/CLAUDE.md. Vira texto-do-usuário ao expandir, mas o
//     RESULTADO é só um OBJETIVO — as tools que ele dispara passam por `decide()`
//     normal (CLI-SEC-H1). O loader NÃO executa nada; só lê o DADO e estrutura.
//   • Config de projeto NÃO relaxa a catraca: um `/comando` vindo de `.claude/commands`
//     de um repo clonado NÃO ganha permissão extra — é o MESMO caminho do nativo.
//
// CONFINAMENTO (WorkspacePort/EST-0948): as pastas são resolvidas e
// canonicalizadas SÓ sob a raiz do workspace (um symlink p/ fora ⇒ rejeitado, nada
// lido). Lê SÓ `*.md` DIRETOS do dir (sem recursão; `isFile()` em dirent NÃO segue
// symlink de tipo — 1ª linha contra leitura fora). Basename normalizado vira o nome.
//
// FAIL-SAFE: dir ausente/ilegível/escapa-a-raiz ⇒ lista VAZIA, NUNCA lança. Um `.md`
// corrompido/grande é descartado (não derruba os demais). QoL não derruba o startup.

import { join } from 'node:path';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { parseUserCommand, type UserCommand } from '@hiperplano/aluy-cli-core';
import type { WorkspacePort } from './workspace.js';
import { classifyAttachPath } from '../attach/path-deny.js';

/**
 * Pastas (relativas à raiz do workspace) dos comandos do projeto.
 * Padrão Claude Code: `.claude/commands` + Aluy: `.aluy/commands` (ADR-0113 carve-out).
 *
 * Precedência: `.claude/commands/` antes de `.aluy/commands/` (ordem da lista);
 * colisão de `name` entre elas ⇒ 1ª pasta vence (estável).
 */
export const PROJECT_COMMANDS_DIRNAMES = ['.claude/commands', '.aluy/commands'] as const;

/** Teto defensivo de tamanho de um `.md` (anti-arquivo-gigante). */
const MAX_COMMAND_BYTES = 64 * 1024;

/** Teto defensivo de QUANTOS comandos carregar (anti-dir gigante). */
const MAX_COMMANDS = 256;

export interface ProjectCommandsLoaderOptions {
  /** Workspace confinado — a pasta `.claude/commands/` é resolvida SÓ sob a raiz. */
  readonly workspace: WorkspacePort;
}

/**
 * Carregador dos comandos do PROJETO (`.claude/commands/*.md` +
 * `.aluy/commands/*.md`, no workspace confinado). Config de PROJETO = DADO; lida
 * pela borda confinada. `load()` relê os dirs a cada chamada (sem cache).
 * Determinístico (ordenado por nome). Dirs ausentes ⇒ `[]`.
 */
export class ProjectCommandsLoader {
  private readonly workspace: WorkspacePort;

  constructor(opts: ProjectCommandsLoaderOptions) {
    this.workspace = opts.workspace;
  }

  /**
   * Lê todos os `*.md` DIRETOS das pastas de comandos do projeto (confinado à raiz)
   * e devolve os `UserCommand` parseados. Precedência entre as DUAS pastas de projeto:
   * `.claude/commands/` antes de `.aluy/commands/` (ordem da lista); colisão de
   * `name` entre elas ⇒ 1ª pasta vence (estável). Descarta inválidos (parser nulo),
   * colisões internas (1º por ordem alfabética vence) e qualquer erro de leitura
   * (sem derrubar os demais). Dir ausente/escapa-a-raiz ⇒ `[]` (fail-safe).
   */
  load(): readonly UserCommand[] {
    const seen = new Set<string>();
    const out: UserCommand[] = [];

    for (const dirname of PROJECT_COMMANDS_DIRNAMES) {
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
        continue; // dir ausente/ilegível ⇒ sem comandos desta pasta (fail-safe).
      }
      // Só arquivos `.md` DIRETOS (sem recursão). `isFile()` em dirent NÃO reporta `true`
      // p/ symlink — 1ª linha contra leitura fora do dir confinado.
      const mdNames = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));

      for (const name of mdNames) {
        if (out.length >= MAX_COMMANDS) break;
        const cmd = this.readOne(dirname, dir, name);
        if (!cmd) continue;
        if (seen.has(cmd.name)) continue; // colisão (intra-projeto): 1ª pasta vence.
        seen.add(cmd.name);
        out.push(cmd);
      }
    }
    return out;
  }

  /** Lê+parseia UM `.md`. Erro/tamanho/escape/path-deny/parse nulo ⇒ `null`. */
  private readOne(dirname: string, dir: string, filename: string): UserCommand | null {
    const rel = `${dirname}/${filename}`;
    // PATH-DENY explícito do arquivo (defesa-em-prof.; comandos `.md` são `allow`).
    if (classifyAttachPath(rel).kind !== 'allow') return null;
    const full = join(dir, filename);
    try {
      // CONFINAMENTO re-checado no arquivo (symlink interno p/ fora ⇒ rejeita).
      this.workspace.resolveInside(rel);
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_COMMAND_BYTES) return null;
      const raw = readFileSync(full, 'utf8');
      return parseUserCommand(filename, raw);
    } catch {
      return null;
    }
  }
}

/**
 * EST-0979 — MERGE de comandos de DUAS fontes com **projeto > global**: para nome
 * colidente, a definição do PROJETO (`.claude/commands`) sobrepõe a do GLOBAL
 * (`~/.aluy/commands`). Determinístico: ordem de 1ª aparição preservada; valor
 * vencedor (projeto) no lugar. PURO — só compõe `UserCommand` já-parseados.
 *
 * Passe `[global, project]` p/ que o projeto especialize o global (alinha EST-0964/
 * 0974: projeto > global). Não relaxa NADA — todo comando é só um OBJETIVO atrás da
 * catraca, venha de onde vier.
 */
export function mergeUserCommands(
  global: readonly UserCommand[],
  project: readonly UserCommand[],
): readonly UserCommand[] {
  const byName = new Map<string, UserCommand>();
  for (const c of global) byName.set(c.name, c);
  for (const c of project) byName.set(c.name, c); // projeto VENCE em colisão.
  return [...byName.values()];
}
