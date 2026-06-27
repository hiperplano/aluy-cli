// EST-0977 · ADR-0061 · CLI-SEC-11 (reaplicado) — LOADER CONFINADO dos agentes
// GLOBAIS do usuário (`~/.aluy/agents/*.md`). Espelha o `UserCommandsLoader`
// (EST-0974): lê o dir confinado (0700), parseia cada `.md` com o parser PURO do
// core (`parseAgentProfile`) e devolve os perfis GLOBAIS (origin='global').
//
// FRONTEIRA DE PROVENIÊNCIA (o que o `seguranca` reconfere):
//   • `~/.aluy/agents/*.md` é CONFIG DO DONO (como o AGENT.md/commands): confiável.
//     POR ISSO a `origin` é `global` — e SÓ globais entram na auto-seleção (R-S3-3).
//     Mas "confiável" ≠ "relaxa a catraca": o `tools:` continua ⊆ pai (GS-MD1) e o
//     filho continua INTEGRALMENTE sob `decide()` (CLI-SEC-11). O loader NÃO executa
//     nada — só lê o DADO e estrutura os perfis.
//   • Confinado a `~/.aluy/agents/` com mode 0700 no dir. Lê SÓ `*.md` DIRETOS (sem
//     recursão; `isFile()` em dirent NÃO segue symlink de tipo — 1ª linha contra
//     leitura fora do dir confinado).
//
// RES-MD-3 (FALHA FECHADA): um `.md` malformado/`tools` ilegível NÃO vira "agente sem
// restrição" — o parser devolve `AgentProfileError` e o loader o COLETA em `errors`
// (carga visível) em vez de registrá-lo. Dir ausente/ilegível ⇒ lista VAZIA, NUNCA
// lança. QoL jamais derruba o startup.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync, mkdirSync, statSync, type Dirent } from 'node:fs';
import {
  parseAgentProfile,
  isAgentProfileError,
  type AgentProfile,
  type AgentProfileError,
} from '@hiperplano/aluy-cli-core';

/** Permissão restrita do dir `~/.aluy/agents/` (espelha o journal-store/commands). */
const DIR_MODE = 0o700;

/** Subdir (dentro de `~/.aluy/`) onde moram os agentes globais do usuário. */
export const AGENTS_DIRNAME = 'agents';

/** Teto defensivo de tamanho de um `.md` (anti-arquivo-gigante). */
const MAX_AGENT_BYTES = 64 * 1024;

/** Teto defensivo de QUANTOS agentes carregar (anti-dir gigante). */
const MAX_AGENTS = 256;

/** Resultado de uma carga: os perfis VÁLIDOS + os ERROS visíveis (RES-MD-3). */
export interface AgentLoadResult {
  readonly profiles: readonly AgentProfile[];
  /** Perfis rejeitados (malformados / `tools` ilegível) — carga visível, NÃO entram. */
  readonly errors: readonly AgentProfileError[];
}

export interface UserAgentsLoaderOptions {
  /** Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir). */
  readonly baseDir?: string;
}

/**
 * Carregador dos agentes GLOBAIS de `~/.aluy/agents/*.md`. Idempotente: `load()` relê
 * o dir a cada chamada (perfis são DADO de config — sem cache). Todos com
 * `origin='global'` (dono=confiável; base da auto-seleção R-S3-3).
 */
export class UserAgentsLoader {
  private readonly dir: string;

  constructor(opts: UserAgentsLoaderOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.aluy');
    this.dir = join(base, AGENTS_DIRNAME);
  }

  /** O caminho do dir de agentes (p/ mensagens/teste). */
  get agentsDir(): string {
    return this.dir;
  }

  /** Garante `~/.aluy/agents/` com mode 0700 (idempotente, best-effort). */
  ensureDir(): void {
    try {
      mkdirSync(this.dir, { mode: DIR_MODE, recursive: true });
    } catch {
      /* best-effort — fail-safe */
    }
  }

  /**
   * Lê todos os `*.md` DIRETOS de `~/.aluy/agents/` e devolve os perfis parseados +
   * os erros (RES-MD-3). Determinístico (ordenado por nome de arquivo). Colisão de
   * `name` (após parse) ⇒ 1º (ordem alfabética) vence — estável. Dir ausente ⇒
   * `{ profiles: [], errors: [] }` (fail-safe).
   */
  load(): AgentLoadResult {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return { profiles: [], errors: [] }; // dir ausente/ilegível ⇒ sem agentes.
    }
    const mdNames = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const seen = new Set<string>();
    const profiles: AgentProfile[] = [];
    const errors: AgentProfileError[] = [];
    for (const name of mdNames) {
      if (profiles.length >= MAX_AGENTS) break;
      const parsed = this.readOne(name);
      if (parsed === null) continue; // erro de I/O puro (não é RES-MD-3 de conteúdo).
      if (isAgentProfileError(parsed)) {
        errors.push(parsed); // RES-MD-3: carga visível, NÃO entra no registro.
        continue;
      }
      if (seen.has(parsed.name)) continue; // colisão intra-camada: 1º (alfabético) vence.
      seen.add(parsed.name);
      profiles.push(parsed);
    }
    return { profiles, errors };
  }

  /**
   * Lê+parseia UM `.md` (origin='global'). Erro de I/O puro / tamanho excedido ⇒
   * `null` (descartado em silêncio — não é RES-MD-3). Conteúdo malformado ⇒
   * `AgentProfileError` (RES-MD-3, carga visível).
   */
  private readOne(filename: string): AgentProfile | AgentProfileError | null {
    const full = join(this.dir, filename);
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_AGENT_BYTES) return null;
      const raw = readFileSync(full, 'utf8');
      return parseAgentProfile(filename, raw, 'global');
    } catch {
      return null;
    }
  }
}
