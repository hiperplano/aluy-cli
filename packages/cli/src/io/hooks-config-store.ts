// EST-0974 · ADR-0053 §2.2 / CLI-SEC-3 — LEITOR CONFINADO de `~/.aluy/hooks.json`.
//
// Lê a config de HOOKS de ciclo-de-vida (config do dono, FORA do workspace) e a
// parseia com `parseHooksConfig` (parser PURO no core). Este módulo é o
// kernel-de-cliente: o AGENTE não alcança `~/.aluy/` (a catraca nega read/write
// sobre ele — categories.ts). Editar `hooks.json` é ato do USUÁRIO, fora-de-banda.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ WRITE-DENY de `~/.aluy/hooks.json` (o `seguranca` reconfere):               ║
// ║  Este leitor NÃO escreve `hooks.json` — e a CATRACA NEGA (deny, não ask) que ║
// ║  o agente o escreva por qualquer canal (edit_file/run_command), categoria    ║
// ║  `aluy-config-write-deny`, acima até do `--unsafe`. Senão um README           ║
// ║  malicioso faria o agente plantar um hook que roda sempre.                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// FAIL-SAFE: arquivo ausente/ilegível/JSON inválido ⇒ config VAZIA (sem hooks),
// NUNCA lança. Um `hooks.json` corrompido NÃO derruba o startup nem aplica hooks
// "meio-válidos" (o parser descarta entradas inválidas).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import {
  parseHooksConfig,
  parseClaudeHooksSettings,
  mergeHooksConfigs,
  type HooksConfig,
} from '@hiperplano/aluy-cli-core';

/** Nome do arquivo de config de hooks (dentro de `~/.aluy/`). */
export const HOOKS_CONFIG_FILENAME = 'hooks.json';

/** EST-0980 — nome do arquivo de settings no estilo Claude Code (compat). */
export const CLAUDE_SETTINGS_FILENAME = 'settings.json';

/** Teto defensivo de tamanho de cada arquivo (anti-arquivo-gigante adulterado). */
const MAX_HOOKS_BYTES = 256 * 1024;

export interface HooksConfigStoreOptions {
  /**
   * Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir), sem
   * tocar o `~/.aluy/` real do dev. O `hooks.json` é resolvido sob ela.
   */
  readonly baseDir?: string;
  /**
   * EST-0980 — raiz do WORKSPACE (projeto), p/ descobrir `.claude/settings.json` no
   * estilo Claude Code (compat). Default: nenhum (só `~/.aluy/hooks.json`). Injetável
   * p/ teste. Os hooks de PROJETO são DADO não-confiável (CLI-SEC-4): só atravessam a
   * catraca como qualquer outro — um hook de gate de projeto, no pior caso, só BLOQUEIA
   * (nunca executa efeito fora da `decide()`).
   */
  readonly workspaceRoot?: string;
}

/**
 * Leitor de `~/.aluy/hooks.json`. SÓ-LEITURA: o agente nunca escreve aqui (a catraca
 * nega), e a edição é ato do usuário fora-de-banda. `load()` relê a cada chamada
 * (config é DADO; sem cache).
 */
export class HooksConfigStore {
  private readonly file: string;
  /** EST-0980 — `.claude/settings.json` do projeto (compat), se houver workspaceRoot. */
  private readonly claudeProjectFile?: string;

  constructor(opts: HooksConfigStoreOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.aluy');
    this.file = join(base, HOOKS_CONFIG_FILENAME);
    if (opts.workspaceRoot !== undefined) {
      this.claudeProjectFile = join(opts.workspaceRoot, '.claude', CLAUDE_SETTINGS_FILENAME);
    }
  }

  /** O caminho do `hooks.json` (p/ mensagens/teste). */
  get configPath(): string {
    return this.file;
  }

  /**
   * Lê + parseia o `~/.aluy/hooks.json` (formato NATIVO) E, se houver `workspaceRoot`,
   * o `.claude/settings.json` do projeto (formato CLAUDE, EST-0980), FUNDINDO os dois
   * (nativo PRIMEIRO, depois o de settings — ambos valem). Cada fonte é fail-safe:
   * ausente/ilegível/JSON inválido/grande demais ⇒ contribui VAZIO, NUNCA lança. NUNCA
   * derruba o boot e nunca aplica hook "meio-válido" (o parser puro descarta inválidos).
   *
   * SEGURANÇA: o hook de PROJETO (`.claude/settings.json`) é DADO não-confiável
   * (CLI-SEC-4) — ele NÃO ganha privilégio: atravessa a MESMA catraca; um hook de gate
   * de projeto, no pior caso, só BLOQUEIA uma tool (nunca executa efeito sem `decide()`).
   */
  load(): HooksConfig {
    const native = parseHooksConfig(this.readJson(this.file));
    if (this.claudeProjectFile === undefined) return native;
    const claude = parseClaudeHooksSettings(this.readJson(this.claudeProjectFile));
    return mergeHooksConfigs(native, claude);
  }

  /** Lê + `JSON.parse` de um arquivo, fail-safe (ausente/ilegível/grande/inválido ⇒ undefined). */
  private readJson(file: string): unknown {
    let raw: string;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > MAX_HOOKS_BYTES) return undefined;
      raw = readFileSync(file, 'utf8');
    } catch {
      return undefined; // ausente/ilegível ⇒ sem contribuição.
    }
    try {
      return JSON.parse(raw);
    } catch {
      return undefined; // JSON inválido ⇒ sem contribuição (não derruba o boot).
    }
  }
}
