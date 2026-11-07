// EST-0983 · ADR-0064 · CLI-SEC-15 — I/O CONCRETO da memória de agente (locus
// concreto). Implementa `MemoryStorePort` do core (mecânica portável) com `node:fs`
// real, em DOIS escopos:
//   • GLOBAL  → `~/.aluy/memory/global.md` (FORA do workspace — read/write-deny do
//     agente; só esta mecânica interna alcança, espelhando o journal-store EST-0960a).
//   • PROJETO → `<workspace>/.aluy/memory/project.md` (DENTRO do workspace, território
//     de escrita do agente; versionável pelo dono). Confinado pelo WorkspacePort.
//
// Honra as cravas do gate FORTE (espelha o NodeJournalStore):
//   • R5 — `0700`/`0600` ATÔMICO: o dir `~/.aluy/`/`memory/` nasce `mkdir(0700)`; o
//     arquivo nasce/reescreve via tmp `O_CREAT|O_EXCL 0600` + `rename` atômico —
//     nunca `0644`+chmod (sem janela de corrida). `umask`-safe (0700/0600 não têm
//     bits de grupo/outro a remover).
//   • A PORTA é ESTREITA (GS-M1): `append(fact)`/`remove(id)`/`update(fact)` por
//     ESCOPO — NUNCA `write(path, bytes)`. O modelo não fornece path: a tool
//     `remember` recebe `{ fact, scope }`, e a MECÂNICA decide o arquivo. Por isso
//     `edit_file`/`run_command` seguem DENY em todo `~/.aluy/` (incl. `memory/`).
//   • read-deny (GS-M4): este store é o ÚNICO leitor da memória GLOBAL — uso interno
//     do kernel-de-cliente, não um canal do agente (a path-deny do core nega
//     read_file/grep/run_command em `~/.aluy/memory/`).
//
// FORMATO (Q5): `.md` humano-editável — um fato por linha de lista, com a metadata
// (id/escopo/proveniência/pin/ts) num comentário HTML INLINE (invisível na
// renderização, parseável). Layout: índice no topo + a lista de fatos. Sem DB.

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
import type { MemoryFact, MemoryScope, MemoryStorePort } from '@hiperplano/aluy-cli-core';
import type { WorkspacePort } from './workspace.js';
import { withFileLock } from './file-lock.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Subdir (dentro de `~/.aluy/` e de `<workspace>/.aluy/`) da memória. */
export const MEMORY_DIRNAME = 'memory';
/** Arquivo da memória global (sobre o usuário). */
const GLOBAL_FILE = 'global.md';
/** Arquivo da memória de projeto (sobre o repo). */
const PROJECT_FILE = 'project.md';

export interface NodeMemoryStoreOptions {
  /** Confinamento do workspace — p/ resolver `.aluy/memory/` do PROJETO com segurança. */
  readonly workspace: WorkspacePort;
  /**
   * Raiz do `~/.aluy/` (default `<home>/.aluy`). Injetável p/ teste (tmpdir), p/ a
   * suíte nunca tocar a memória real do dev.
   */
  readonly baseDir?: string;
}

/**
 * HUNT-PERSIST (round-trip infiel — perda/corrupção SILENCIOSA de fato) — o fato é
 * UMA LINHA `.md`, mas o `text` pode conter `\n` (a tool `remember` só faz `.trim()`,
 * que NÃO remove quebra interna; `MAX_FACT_CHARS=2000` cabe parágrafos) E pode conter
 * o PRÓPRIO marcador `<!--aluy-mem {...}-->`. Ambos quebravam o `write→read`:
 *   - um `\n` no texto virava 2+ linhas no disco; ao reler (`split('\n')` + regex por
 *     linha) só a ÚLTIMA casava o marcador ⇒ o fato voltava com o texto TRUNCADO (as
 *     linhas iniciais sumiam, viravam itens `- …` órfãos descartados);
 *   - um marcador literal no texto fazia o `(.*?)`/`(\{.*\})` casar o FALSO marcador
 *     primeiro ⇒ id/ts errados ⇒ fato descartado por falha de shape.
 * Fix: ESCAPAR o texto numa única linha segura ao serializar (CR/LF/backslash + o
 * marcador), DESESCAPAR ao parsear, e ancorar o parse no ÚLTIMO marcador da linha (o
 * NOSSO; um marcador escapado no texto não é mais literal). Round-trip byte-a-byte.
 */
const MEM_OPEN = '<!--aluy-mem ';
const MEM_CLOSE = '-->';

/** Escapa o texto p/ uma linha `.md` segura: backslash, CR/LF e os marcadores. */
function escapeFactText(text: string): string {
  return text
    .replace(/\\/g, '\\\\') // backslash primeiro (senão duplica os escapes seguintes).
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/<!--aluy-mem /g, '\\<!--aluy-mem ') // marcador no texto não fecha o nosso.
    .replace(/-->/g, '\\-->');
}

/** Inverso de `escapeFactText` — restaura o texto original byte-a-byte. */
function unescapeFactText(esc: string): string {
  let out = '';
  for (let i = 0; i < esc.length; i++) {
    const ch = esc[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = esc[i + 1];
    if (next === '\\') {
      out += '\\';
      i++;
    } else if (next === 'r') {
      out += '\r';
      i++;
    } else if (next === 'n') {
      out += '\n';
      i++;
    } else if (next === '<' || next === '-') {
      // `\<!--aluy-mem ` / `\-->` — o backslash protegeu o marcador; remove só o `\`.
      out += next;
      i++;
    } else {
      // backslash solto (linha legada editada à mão) — preserva literal.
      out += '\\';
    }
  }
  return out;
}

/** Linha serializada de um fato (comentário HTML inline + texto humano ESCAPADO). */
function serializeFact(f: MemoryFact): string {
  const meta = JSON.stringify({ id: f.id, p: f.provenance, pin: f.pinned, ts: f.ts });
  const pin = f.pinned ? '📌 ' : '';
  // O texto humano (escapado p/ caber em 1 linha sem quebrar o marcador) vem ANTES do
  // comentário; o comentário some na renderização md.
  return `- ${pin}${escapeFactText(f.text)} ${MEM_OPEN}${meta}${MEM_CLOSE}`;
}

/** Parseia uma linha de fato (escopo vem do arquivo). `null` se não é fato. */
function parseFact(line: string, scope: MemoryScope): MemoryFact | null {
  // Ancora no ÚLTIMO marcador-aberto NÃO-escapado: o texto pode conter um `\<!--aluy-mem`
  // escapado, que NÃO é o nosso envelope. Busca o último `<!--aluy-mem ` cujo char
  // anterior não seja um backslash de escape.
  let open = -1;
  for (let i = line.lastIndexOf(MEM_OPEN); i >= 0; i = line.lastIndexOf(MEM_OPEN, i - 1)) {
    if (i === 0 || line[i - 1] !== '\\') {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  const close = line.lastIndexOf(MEM_CLOSE);
  if (close <= open) return null;
  // o prefixo é `- ` (+ pin opcional) + texto escapado; o miolo é o JSON da meta.
  const prefix = line.slice(0, open);
  const metaRaw = line.slice(open + MEM_OPEN.length, close);
  const pm = prefix.match(/^- (.*?)\s*$/);
  if (!pm) return null;
  let text = pm[1] ?? '';
  // remove o prefixo de pin visual se presente (a fonte da verdade é a meta).
  text = text.replace(/^📌\s*/, '');
  text = unescapeFactText(text);
  try {
    const meta = JSON.parse(metaRaw) as unknown;
    // O `.md` é humano-editável (Q5): a meta pode vir ADULTERADA. Valida o SHAPE
    // antes de confiar — `id` string e `ts` número são usados em recall/ordenação/
    // exibição; um `"ts":"abc"` propagaria string/undefined no `MemoryFact.ts`.
    // Dado sujo ⇒ descarta a linha (já no try/catch fail-safe — não derruba o resto).
    if (typeof meta !== 'object' || meta === null) return null;
    const mm = meta as Record<string, unknown>;
    if (typeof mm.id !== 'string' || mm.id.length === 0) return null;
    if (typeof mm.ts !== 'number' || !Number.isFinite(mm.ts)) return null;
    const provenance = mm.p === 'usuario' ? 'usuario' : 'derivado';
    return { id: mm.id, text, scope, provenance, pinned: !!mm.pin, ts: mm.ts };
  } catch {
    return null;
  }
}

/**
 * Store concreto da memória nos dois escopos. Sem cache: relê os arquivos a cada
 * operação (memória é DADO de config; uma edição manual via `/memory` ou no `.md`
 * é vista na hora). Idempotente/fail-safe: arquivo ausente ⇒ lista vazia.
 */
export class NodeMemoryStore implements MemoryStorePort {
  private readonly base: string; // ~/.aluy
  private readonly globalDir: string; // ~/.aluy/memory
  private readonly globalFile: string; // ~/.aluy/memory/global.md
  private readonly projectDir: string; // <workspace>/.aluy/memory
  private readonly projectFile: string; // <workspace>/.aluy/memory/project.md

  constructor(opts: NodeMemoryStoreOptions) {
    this.base = opts.baseDir ?? join(homedir(), '.aluy');
    this.globalDir = join(this.base, MEMORY_DIRNAME);
    this.globalFile = join(this.globalDir, GLOBAL_FILE);
    // PROJETO: confinado ao workspace (resolveInside lança se escapa — defesa).
    this.projectDir = opts.workspace.resolveInside(join('.aluy', MEMORY_DIRNAME));
    this.projectFile = join(this.projectDir, PROJECT_FILE);
  }

  /** Caminhos (p/ mensagens/teste). */
  get paths(): { readonly global: string; readonly project: string } {
    return { global: this.globalFile, project: this.projectFile };
  }

  async readAll(): Promise<readonly MemoryFact[]> {
    return [...this.readScope('global'), ...this.readScope('projeto')];
  }

  // F71 — `~/.aluy/memory/global.md` é COMPARTILHADO entre TODAS as CLIs; o read-
  // modify-write era racy (A lê, B lê, A grava, B grava ⇒ o fato de A some). Os
  // mutadores agora rodam SOB LOCK cross-process (por-escopo): a leitura acontece
  // DENTRO do lock, serializando a sequência entre processos. `ensureDir` ANTES do
  // lock (o lockfile mora no dir do escopo). O write segue atômico (tmp+rename).
  private lockFor(scope: MemoryScope): string {
    return `${this.fileFor(scope)}.lock`;
  }

  async append(fact: MemoryFact): Promise<void> {
    this.ensureDir(fact.scope, this.dirFor(fact.scope));
    await withFileLock(this.lockFor(fact.scope), () => {
      const facts = this.readScope(fact.scope);
      facts.push(fact);
      this.writeScope(fact.scope, facts);
    });
  }

  async remove(id: string): Promise<void> {
    for (const scope of ['global', 'projeto'] as const) {
      this.ensureDir(scope, this.dirFor(scope));
      await withFileLock(this.lockFor(scope), () => {
        const facts = this.readScope(scope);
        const kept = facts.filter((f) => f.id !== id);
        if (kept.length !== facts.length) this.writeScope(scope, kept);
      });
    }
  }

  async update(fact: MemoryFact): Promise<void> {
    this.ensureDir(fact.scope, this.dirFor(fact.scope));
    await withFileLock(this.lockFor(fact.scope), () => {
      const facts = this.readScope(fact.scope);
      const idx = facts.findIndex((f) => f.id === fact.id);
      if (idx < 0) return;
      facts[idx] = fact;
      this.writeScope(fact.scope, facts);
    });
  }

  /**
   * EST-0983 (`/clear full` / `/clear memory`) — APAGA TODOS os fatos do escopo dado
   * (ou de AMBOS quando `scope` é omitido). É AÇÃO DO USUÁRIO (slash) — NUNCA uma tool
   * do agente (a path-deny de `~/.aluy/memory/` segue valendo; a superfície da porta
   * não recebe path, o ESCOPO decide o arquivo: nenhuma chamada mira fora de `memory/`).
   * Reusa o `writeScope` ATÔMICO (R5): reescreve o `.md` VAZIO via tmp `0600` + rename —
   * preserva o cabeçalho humano "(vazio)" sem deixar resíduo nem janela 0644. NÃO faz
   * `unlink` do arquivo (mantém o `.md` como artefato versionável/legível do projeto, só
   * sem fatos). Idempotente: escopo sem arquivo ⇒ writeScope cria o vazio (fail-safe).
   */
  async clearAll(scope?: MemoryScope): Promise<void> {
    const scopes: readonly MemoryScope[] =
      scope === undefined ? (['global', 'projeto'] as const) : [scope];
    for (const s of scopes) {
      this.ensureDir(s, this.dirFor(s));
      await withFileLock(this.lockFor(s), () => this.writeScope(s, []));
    }
  }

  // ── interno ──────────────────────────────────────────────────────────────────

  private fileFor(scope: MemoryScope): string {
    return scope === 'global' ? this.globalFile : this.projectFile;
  }
  private dirFor(scope: MemoryScope): string {
    return scope === 'global' ? this.globalDir : this.projectDir;
  }

  /** Lê os fatos de UM escopo. Arquivo ausente/ilegível ⇒ []. NUNCA loga conteúdo. */
  private readScope(scope: MemoryScope): MemoryFact[] {
    const file = this.fileFor(scope);
    if (!existsSync(file)) return [];
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: MemoryFact[] = [];
    for (const line of raw.split('\n')) {
      const f = parseFact(line, scope);
      if (f) out.push(f);
    }
    return out;
  }

  /**
   * Reescreve o `.md` de UM escopo ATÔMICAMENTE (R5): escreve um tmp `0600` via
   * `O_CREAT|O_EXCL` e faz `rename` (atômico no mesmo dir). O dir nasce `0700`.
   * Reescrita completa (não append) p/ manter o índice + a ordenação coerentes.
   */
  private writeScope(scope: MemoryScope, facts: readonly MemoryFact[]): void {
    const dir = this.dirFor(scope);
    this.ensureDir(scope, dir);
    const body = this.render(scope, facts);
    const file = this.fileFor(scope);
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
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
      renameSync(tmp, file); // atômico — substitui o anterior sem janela 0644.
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
      throw e;
    }
  }

  /** Renderiza o `.md` humano-legível: cabeçalho/índice + a lista de fatos. */
  private render(scope: MemoryScope, facts: readonly MemoryFact[]): string {
    const title =
      scope === 'global'
        ? '# Memória do Aluy Cli — global (sobre você)'
        : '# Memória do Aluy Cli — projeto (sobre este repositório)';
    const header = [
      title,
      '',
      '> Fatos lembrados entre sessões. Os de origem `usuario` são suas preferências/instruções',
      '> (o agente as segue); os `derivado` são contexto de fundo. Efeitos passam pela catraca.',
      '> Edite à vontade (ou use `/memory`). Os comentários `<!--aluy-mem …-->` carregam',
      '> a metadata (id/proveniência/fixado) — não os remova.',
      '',
      `## Fatos (${facts.length})`,
      '',
    ];
    const lines = facts.length === 0 ? ['_(vazio)_'] : facts.map(serializeFact);
    return [...header, ...lines, ''].join('\n');
  }

  /** Cria o dir do escopo com `0700` ATÔMICO (R5). Idempotente, fail-safe. */
  private ensureDir(scope: MemoryScope, dir: string): void {
    if (scope === 'global') {
      // O ANCESTRAL de `~/.aluy` (a HOME do usuário, ou o tmpdir em teste) já existe
      // em produção; criamos o que faltar com mode default (não é dir NOSSO a travar).
      // Só a partir de `.aluy` aplicamos o 0700 restrito (espelha o NodeJournalStore).
      const aluy = dirname(dir); // ~/.aluy
      const homeParent = dirname(aluy); // ~  (ou tmp/home em teste)
      if (!existsSync(homeParent)) mkdirSync(homeParent, { recursive: true });
      for (const d of [aluy, dir]) {
        try {
          mkdirSync(d, { mode: DIR_MODE });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
    } else {
      // PROJETO: dentro do workspace (já confinado em resolveInside). `recursive`
      // cria `.aluy/` + `memory/` se faltarem (território de escrita do agente).
      mkdirSync(dir, { mode: DIR_MODE, recursive: true });
    }
  }
}
