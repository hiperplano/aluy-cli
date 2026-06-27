// EST-0974 · ADR-0053 §2.2 — LOADER CONFINADO dos comandos customizados do usuário.
//
// Lê `~/.aluy/commands/*.md` e os transforma em `UserCommand` (parser PURO no core:
// `parseUserCommand`). Cada `.md` vira o slash-command `/<nome>`; o corpo é um
// TEMPLATE de prompt expandido com os args e submetido como OBJETIVO do usuário.
//
// FRONTEIRA DE PROVENIÊNCIA (o que o `seguranca` reconfere — Parte 1):
//   • O `.md` é CONFIG DO DONO (como o AGENT.md): config local confiável, NÃO dado
//     externo. Por isso vira texto-do-usuário ao expandir. Mas o RESULTADO é só um
//     OBJETIVO — as tools que ele dispara passam por `decide()` normal (CLI-SEC-H1).
//     O loader NÃO executa nada; só lê o DADO e estrutura os comandos.
//   • Confinado a `~/.aluy/commands/` com mode `0700` no dir (espelha o
//     journal-store/user-config). Lê SÓ arquivos `*.md` DIRETOS do dir (sem recursão,
//     sem symlink-following p/ fora). Nome do comando = basename normalizado.
//
// FAIL-SAFE: dir ausente/ilegível ⇒ lista VAZIA (sem comandos do usuário), NUNCA
// lança. Um `.md` corrompido/vazio é descartado (não derruba os demais). QoL jamais
// derruba o startup.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync, mkdirSync, statSync, type Dirent } from 'node:fs';
import { parseUserCommand, type UserCommand } from '@aluy/cli-core';

/** Permissão restrita do dir `~/.aluy/commands/` (espelha o journal-store). */
const DIR_MODE = 0o700;

/** Subdir (dentro de `~/.aluy/`) onde moram os comandos customizados. */
export const COMMANDS_DIRNAME = 'commands';

/** Teto defensivo de tamanho de um `.md` (anti-arquivo-gigante). */
const MAX_COMMAND_BYTES = 64 * 1024;

/** Teto defensivo de QUANTOS comandos carregar (anti-dir gigante). */
const MAX_COMMANDS = 256;

export interface UserCommandsLoaderOptions {
  /**
   * Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir), sem
   * tocar o `~/.aluy/` real do dev. O subdir `commands/` é resolvido sob ela.
   */
  readonly baseDir?: string;
}

/**
 * Carregador dos comandos customizados de `~/.aluy/commands/*.md`. Idempotente:
 * `load()` relê o dir a cada chamada (o conjunto de comandos é DADO de config — sem
 * cache, p/ refletir um `.md` recém-criado numa próxima sessão).
 */
export class UserCommandsLoader {
  private readonly dir: string;

  constructor(opts: UserCommandsLoaderOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.aluy');
    this.dir = join(base, COMMANDS_DIRNAME);
  }

  /** O caminho do dir de comandos (p/ mensagens/teste). */
  get commandsDir(): string {
    return this.dir;
  }

  /**
   * Garante que `~/.aluy/commands/` existe com mode `0700` (idempotente). Best-effort:
   * falha de criação ⇒ silenciosa (o `load()` seguinte só não acha nada). Útil p/ o
   * usuário ter onde colocar os `.md` (o app pode chamar no boot).
   */
  ensureDir(): void {
    try {
      mkdirSync(this.dir, { mode: DIR_MODE, recursive: true });
    } catch {
      /* best-effort — fail-safe */
    }
  }

  /**
   * Lê todos os `*.md` DIRETOS de `~/.aluy/commands/` e devolve os `UserCommand`
   * parseados. Determinístico (ordenado por nome). Descarta entradas inválidas
   * (parser devolve `null`), colisões de nome (1º vence — estável) e qualquer erro
   * de leitura de um arquivo (sem derrubar os demais). Dir ausente ⇒ `[]`.
   */
  load(): readonly UserCommand[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return []; // dir ausente/ilegível ⇒ sem comandos do usuário (fail-safe).
    }
    // Só arquivos `.md` DIRETOS (sem recursão). `isFile()` exclui subdirs e — em
    // dirents — NÃO segue symlink de tipo (um symlink p/ fora não reporta `isFile`),
    // primeira linha contra leitura fora do dir confinado.
    const mdNames = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const seen = new Set<string>();
    const out: UserCommand[] = [];
    for (const name of mdNames) {
      if (out.length >= MAX_COMMANDS) break;
      const cmd = this.readOne(name);
      if (!cmd) continue;
      if (seen.has(cmd.name)) continue; // colisão: 1º (ordem alfabética) vence.
      seen.add(cmd.name);
      out.push(cmd);
    }
    return out;
  }

  /** Lê+parseia UM `.md`. Erro/tamanho excedido/parse nulo ⇒ `null` (descartado). */
  private readOne(filename: string): UserCommand | null {
    const full = join(this.dir, filename);
    try {
      // Teto de tamanho ANTES de ler tudo (anti-arquivo-gigante).
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_COMMAND_BYTES) return null;
      const raw = readFileSync(full, 'utf8');
      return parseUserCommand(filename, raw);
    } catch {
      return null;
    }
  }
}
