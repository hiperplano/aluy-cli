// EST-1108 — I/O CONCRETO do backlog/TODO (locus concreto). Implementa
// `TodoStorePort` do core (mecânica portável) com `node:fs` real.
// Persiste em `~/.aluy/todos.json` (0600 atômico, fail-safe).
//
// Espelha o memory-store (EST-0983) mas com estrutura mais simples: um
// arquivo JSON único, sem escopos, sem `.md` humano-editável.
//
//   • `0700`/`0600` ATÔMICO: o dir `~/.aluy/` nasce `0700`; o arquivo
//     nasce/reescreve via tmp `O_CREAT|O_EXCL 0600` + `rename` atômico.
//   • A PORTA é ESTREITA (espelha GS-M1): `add(text)`/`done(id)`/`list()` —
//     NUNCA `write(path, bytes)`. A tool `add_todo` recebe `{ item }`, e a
//     MECÂNICA decide o arquivo.
//   • read-deny: este store é o ÚNICO leitor; a path-deny do core nega
//     read_file/run_command em `~/.aluy/todos.json`.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  existsSync,
  constants as fsConstants,
} from 'node:fs';
import type { TodoItem, TodoStorePort } from '@hiperplano/aluy-cli-core';
import { withFileLock } from './file-lock.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Nome do arquivo dentro de `~/.aluy/`. */
const TODO_FILE = 'todos.json';

/** Teto de itens no arquivo (anti-runaway; generoso). */
const MAX_ITEMS = 500;

export interface NodeTodoStoreOptions {
  /**
   * Raiz do `~/.aluy/` (default `<home>/.aluy`). Injetável p/ teste (tmpdir), p/ a
   * suíte nunca tocar o backlog real do dev.
   */
  readonly baseDir?: string;
  /**
   * BUG-0029 — id da SESSÃO/CONVERSA. Quando presente, o backlog é ESCOPADO por
   * conversa (`~/.aluy/todos/<sessionId>.json`) ⇒ uma sessão NOVA não "retoma"
   * tarefas de OUTRA conversa (fim do vazamento); `--continue`/`--resume` reusam o
   * id e o backlog persiste na MESMA conversa. AUSENTE ⇒ arquivo GLOBAL legado
   * (`~/.aluy/todos.json`) — não-regressão p/ testes/uso sem sessão.
   */
  readonly sessionId?: string;
}

/** Gera um id curto determinístico (FNV-1a sobre texto+ts) — sem `crypto`. */
function itemId(text: string, ts: number): string {
  let h = 0x811c9dc5;
  const s = `${ts}\0${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}

/** BUG-0029 — sanitiza o sessionId p/ nome de arquivo seguro (anti path-traversal:
 *  só `[a-zA-Z0-9_-]`; clamp de tamanho). Vazio/lixo ⇒ `default`. */
function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
}

/**
 * Store concreto do backlog/TODO. Sem cache: relê o arquivo a cada operação.
 * Idempotente/fail-safe: arquivo ausente ⇒ lista vazia, NUNCA lança na leitura.
 */
export class NodeTodoStore implements TodoStorePort {
  private readonly file: string;

  constructor(opts: NodeTodoStoreOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.aluy');
    // BUG-0029 — ESCOPO POR CONVERSA: com `sessionId`, cada conversa tem seu
    // próprio `~/.aluy/todos/<sessionId>.json` (uma sessão nova NÃO herda tarefas de
    // outra ⇒ fim do "retome" cross-conversa). Sem `sessionId`, arquivo global
    // legado `~/.aluy/todos.json` (não-regressão). Emenda ao F71 (shared-backlog).
    this.file = opts.sessionId
      ? join(base, 'todos', `${sanitizeSessionId(opts.sessionId)}.json`)
      : join(base, TODO_FILE);
  }

  /** Caminho do arquivo (p/ mensagens/teste). */
  get path(): string {
    return this.file;
  }

  // F71 — `~/.aluy/todos.json` é COMPARTILHADO entre TODAS as CLIs; o read-modify-
  // write era racy (lost-update se 2 CLIs gravam ao mesmo tempo). Os mutadores rodam
  // SOB LOCK cross-process: a leitura acontece DENTRO do lock. `ensureDir` ANTES do
  // lock (o lockfile mora no dir do arquivo). O write segue atômico (tmp+rename).
  private lockPath(): string {
    return `${this.file}.lock`;
  }

  async add(text: string): Promise<string> {
    this.ensureDir(dirname(this.file));
    return withFileLock(this.lockPath(), () => {
      const items = this.readAll();
      const ts = Date.now();
      let id = itemId(text, ts);
      // Desambigua colisões (mesmo texto no mesmo ms).
      const taken = new Set(items.map((t) => t.id));
      if (taken.has(id)) {
        for (let n = 2; ; n++) {
          const candidate = `${id}-${n}`;
          if (!taken.has(candidate)) {
            id = candidate;
            break;
          }
        }
      }
      const item: TodoItem = { id, text, createdAt: ts, done: false };
      items.push(item);
      // Evicta os itens mais antigos JÁ FEITOS se estourar o teto.
      while (items.length > MAX_ITEMS) {
        const doneIdx = items.findIndex((t) => t.done);
        if (doneIdx < 0) {
          // Todos pendentes — evicta o mais antigo.
          items.shift();
        } else {
          items.splice(doneIdx, 1);
        }
      }
      this.writeAll(items);
      return id;
    });
  }

  async list(): Promise<readonly TodoItem[]> {
    return this.readAll();
  }

  async done(id: string): Promise<boolean> {
    this.ensureDir(dirname(this.file));
    return withFileLock(this.lockPath(), () => {
      const items = this.readAll();
      const idx = items.findIndex((t) => t.id === id);
      if (idx < 0) return false;
      items[idx] = { ...items[idx]!, done: true };
      this.writeAll(items);
      return true;
    });
  }

  async clearDone(): Promise<number> {
    this.ensureDir(dirname(this.file));
    return withFileLock(this.lockPath(), () => {
      const items = this.readAll();
      const before = items.length;
      const pending = items.filter((t) => !t.done);
      if (pending.length === before) return 0;
      this.writeAll(pending);
      return before - pending.length;
    });
  }

  // ── interno ──────────────────────────────────────────────────────────────────

  private readAll(): TodoItem[] {
    if (!existsSync(this.file)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    if (raw.trim() === '') return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is TodoItem =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as TodoItem).id === 'string' &&
          typeof (e as TodoItem).text === 'string' &&
          typeof (e as TodoItem).createdAt === 'number' &&
          typeof (e as TodoItem).done === 'boolean',
      );
    } catch {
      return [];
    }
  }

  private writeAll(items: readonly TodoItem[]): void {
    const dir = dirname(this.file);
    this.ensureDir(dir);
    const body = JSON.stringify(items, null, 2) + '\n';
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    const fd = openSync(
      tmp,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      FILE_MODE,
    );
    try {
      writeSync(fd, body, 0, 'utf8');
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.file); // atômico — substitui o anterior sem janela 0644.
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
      throw e;
    }
  }

  private ensureDir(dir: string): void {
    const aluy = dirname(dir); // ~/.aluy
    const homeParent = dirname(aluy); // ~
    if (!existsSync(homeParent)) mkdirSync(homeParent, { recursive: true });
    for (const d of [aluy, dir]) {
      try {
        mkdirSync(d, { mode: DIR_MODE });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  }
}
