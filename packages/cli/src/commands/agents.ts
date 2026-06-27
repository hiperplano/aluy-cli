// EST-0977 · ADR-0061 · CLI-SEC-11 (reaplicado) — comando `aluy agents`.
//
// A face SHELL do `/agents`: lista os perfis de sub-agente `.md` que o aluy MAPEOU,
// das DUAS camadas CONFINADAS — GLOBAL (`~/.aluy/agents/*.md`, config do dono) e PROJETO
// (`.claude/agents/*.md` no cwd, dado do repo). Read-only, SEM modelo, SEM rede.
//
// REUSO (DoD): usa os MESMOS loaders do boot/`/doctor` — `UserAgentsLoader` (global) e
// `ProjectAgentsLoader` (projeto, confinado ao cwd via `NodeWorkspace`) — e o MESMO
// formatador PURO do core (`buildAgentsNote`). O `/agents` da sessão e este shell
// produzem a MESMA listagem (válidos ✓ + rejeitados ⚠ com o motivo RES-MD-3). Nada de
// parse/IO reimplementado aqui.
//
// EXIT 0 SEMPRE: é uma LISTAGEM (como `mcp list`), não um gate. Rejeitados são EXIBIDOS
// (carga visível), não fazem o comando "falhar" — a falha-fechada já agiu no loader (o
// perfil malformado NÃO entra no registro). Pasta ausente ⇒ "nenhum" (loader fail-safe).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildAgentsNote } from '@hiperplano/aluy-cli-core';
import { UserAgentsLoader, AGENTS_DIRNAME, type AgentLoadResult } from '../io/user-agents.js';
import { ProjectAgentsLoader } from '../io/project-agents.js';
import { NodeWorkspace } from '../io/workspace.js';

/** Carregadores das duas camadas — injetáveis p/ teste (tmpdir, sem tocar a home real). */
export interface AgentsRunnerDeps {
  /** Carrega os perfis GLOBAIS (`~/.aluy/agents/*.md`). Default: o real (home do SO). */
  readonly loadGlobal?: () => AgentLoadResult;
  /** Carrega os perfis de PROJETO (`.claude/agents/*.md`, confinado ao cwd). */
  readonly loadProject?: () => AgentLoadResult;
  /** Dir global (abreviado p/ exibição) — p/ a mensagem de estado vazio. */
  readonly globalDir?: string;
  /** Sink de saída (default: stdout). Injetável p/ capturar no teste. */
  readonly out?: (line: string) => void;
}

/** `~/.aluy/agents` abreviado (sem expandir a home) p/ a dica de "onde criar". */
function defaultGlobalDirLabel(): string {
  return join('~', '.aluy', AGENTS_DIRNAME);
}

/**
 * Executa `aluy agents`. Constrói os loaders reais (ou usa os injetados), agrega os
 * perfis VÁLIDOS + os ERROS das DUAS camadas, formata com o MESMO `buildAgentsNote` do
 * `/agents` da sessão e imprime. Read-only — nunca escreve config, nunca chama o modelo,
 * nunca toca a rede. Cada loader já é fail-safe (dir ausente/ilegível ⇒ vazio); por isso
 * o runner não tem caminho de erro. SEMPRE exit 0 (listagem).
 */
export function runAgents(deps: AgentsRunnerDeps = {}): number {
  const out = deps.out ?? ((line: string) => process.stdout.write(line + '\n'));

  const loadGlobal = deps.loadGlobal ?? (() => new UserAgentsLoader().load());
  const loadProject =
    deps.loadProject ?? (() => new ProjectAgentsLoader({ workspace: new NodeWorkspace() }).load());

  const global = loadGlobal();
  const project = loadProject();

  const note = buildAgentsNote({
    profiles: [...global.profiles, ...project.profiles],
    errors: [...global.errors, ...project.errors],
    globalDir: deps.globalDir ?? defaultGlobalDirLabel(),
  });

  out(note.title === 'agents' ? 'aluy agents — perfis .md mapeados' : note.title);
  for (const line of note.lines) out(line);
  // Listagem, não gate: rejeitados são EXIBIDOS, não derrubam o exit (a falha-fechada
  // já agiu no loader). Exit 0 sempre.
  return 0;
}

/** Re-export do default p/ a home real (usado quando nenhum dir é injetado). */
export function defaultUserAgentsDir(): string {
  return join(homedir(), '.aluy', AGENTS_DIRNAME);
}
