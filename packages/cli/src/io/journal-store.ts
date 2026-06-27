// EST-0960a · ADR-0056 — I/O CONCRETO do journal de snapshot (o "locus concreto").
//
// Implementa `JournalStorePort` do core (mecânica portável) com `node:fs` real,
// guardando o conteúdo-ANTES de cada edição em `~/.aluy/undo/<session>/` — FORA do
// workspace (§3/D do ADR: não vaza p/ commit nem o agente alcança). Honra as
// RESSALVAS do gate FORTE do `seguranca` (AG-0008):
//
//   - R5 — `0600`/`0700` ATÔMICO: o dir-pai `~/.aluy/`/`undo/`/`<session>/` nasce
//     com `mkdir(mode 0700)`; cada blob nasce com `open(O_CREAT|O_EXCL, 0o600)` —
//     NUNCA `0644`+`chmod` depois (sem janela de corrida). `umask` neutralizado
//     no momento da criação (mode efetivo = mode pedido).
//   - R6 — GC/pós-crash/teto: `gcOrphans` no start remove sessões órfãs (crash
//     sem cleanup) com unlink REAL; `cleanup` de fim remove blobs E o dir-pai da
//     sessão; `deleteBlob` faz unlink real (teto de retenção do core).
//   - R7 — `~/.aluy/` NUNCA é lido por tool do agente (a path-deny do core nega
//     read_file/grep/edit_file E run_command/cat). Este store é o ÚNICO leitor —
//     uso interno da mecânica de undo (kernel-de-cliente), não um canal do agente.
//   - sem log/telemetria do conteúdo: este módulo NUNCA imprime/loga o conteúdo
//     dos blobs nem o caminho-com-conteúdo (CLI-SEC-6).

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  openSync,
  writeSync,
  readSync,
  closeSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync,
  unlinkSync,
  existsSync,
  appendFileSync,
  statSync,
  constants as fsConstants,
} from 'node:fs';
import type { BlobRef, JournalEntry, JournalStorePort } from '@hiperplano/aluy-cli-core';

/** Permissões restritas (R5): dir `0700`, blob `0600`. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * EST-1011 (Bug 6 do bug-hunt — `stack.jsonl` sem rotação + load sem fail-safe).
 *
 * O `appendEntry` SÓ apendava: o `enforceRetention` do core poda blobs/memória mas
 * NUNCA reescrevia o arquivo ⇒ `stack.jsonl` crescia sem limite numa sessão longa
 * (cada edição = +1 linha, para sempre). E o `loadEntries` lia o arquivo INTEIRO sem
 * teto e dava `JSON.parse(line)` SEM try/catch — UMA linha corrompida (crash no meio
 * de um append, disco cheio) derrubava TODO o undo da sessão.
 *
 * Fix (I/O-layer, self-contained — não toca o contrato do core):
 *   - `loadEntries`: try/catch POR LINHA (pula a inválida, não derruba) + CAP de bytes
 *     no read (arquivo gigante adulterado não vai inteiro p/ a memória — lê a CAUDA,
 *     que carrega as entradas RECENTES, e descarta a 1ª linha possivelmente partida).
 *   - `appendEntry`: ROTAÇÃO — ao passar do teto de linhas, reescreve o arquivo
 *     compactado (atômico, mesmas permissões `0600`) mantendo só as `KEEP` entradas
 *     mais recentes. A pilha de undo é recência-primeiro; entradas muito antigas já
 *     não são reversíveis (blob podado pelo core). O arquivo deixa de crescer sem teto.
 */

/** Teto de linhas no `stack.jsonl` antes da rotação compactada. */
const STACK_MAX_LINES = 2000;
/** Quantas entradas (mais recentes) sobrevivem a uma rotação. */
const STACK_KEEP_LINES = 1000;
/** Teto de bytes lidos do `stack.jsonl` (lê a CAUDA — entradas recentes — se exceder). */
const STACK_MAX_READ_BYTES = 16 * 1024 * 1024; // 16 MiB

export interface NodeJournalStoreOptions {
  /** Id da sessão (subdir do journal). Obrigatório — isola a pilha por sessão. */
  readonly sessionId: string;
  /**
   * Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir),
   * sem nunca tocar o `~/.aluy/` real do dev na suíte.
   */
  readonly baseDir?: string;
  /** "Agora" em ms p/ a idade de sessões órfãs no GC. Injetável (teste). */
  readonly now?: () => number;
  /**
   * Idade (ms) acima da qual uma sessão é considerada ÓRFÃ no GC de start (crash
   * sem cleanup). Default 24h. A sessão ATUAL nunca é coletada.
   */
  readonly orphanMaxAgeMs?: number;
}

const DEFAULT_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Store concreto do journal em `~/.aluy/undo/<session>/`. Cria os dirs com
 * `0700` atômico e os blobs com `0600` atômico (R5). Mantém um índice de refs
 * p/ unlink real (R6). NÃO loga conteúdo (CLI-SEC-6).
 */
export class NodeJournalStore implements JournalStorePort {
  private readonly base: string; // ~/.aluy
  private readonly undoRoot: string; // ~/.aluy/undo
  private readonly sessionDir: string; // ~/.aluy/undo/<session>
  private readonly blobsDir: string; // ~/.aluy/undo/<session>/blobs
  private readonly stackFile: string; // ~/.aluy/undo/<session>/stack.jsonl
  private readonly now: () => number;
  private readonly orphanMaxAgeMs: number;
  private blobSeq = 0;
  private sessionReady = false;
  /**
   * EST-1011 — nº de linhas vivas no `stack.jsonl` (p/ disparar a rotação). `-1` =
   * ainda não contado; conta-se preguiçosamente do disco na 1ª escrita (cobre o
   * arquivo herdado de uma sessão anterior que já estava grande).
   */
  private stackLineCount = -1;

  constructor(opts: NodeJournalStoreOptions) {
    this.base = opts.baseDir ?? join(homedir(), '.aluy');
    this.undoRoot = join(this.base, 'undo');
    this.sessionDir = join(this.undoRoot, opts.sessionId);
    this.blobsDir = join(this.sessionDir, 'blobs');
    this.stackFile = join(this.sessionDir, 'stack.jsonl');
    this.now = opts.now ?? (() => Date.now());
    this.orphanMaxAgeMs = opts.orphanMaxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS;
  }

  /** Raiz do journal da sessão (p/ asserts de "fora do workspace" em teste). */
  get sessionRoot(): string {
    return this.sessionDir;
  }

  hash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  async putBlob(content: string): Promise<BlobRef> {
    this.ensureSession();
    const ref = `b${(this.blobSeq++).toString(36)}-${this.now().toString(36)}`;
    const abs = join(this.blobsDir, ref);
    // R5 — ATÔMICO: O_CREAT|O_EXCL|O_WRONLY com mode 0600. O arquivo NASCE 0600;
    // não há instante em que exista com permissão larga. O_EXCL garante que não
    // sobrescrevemos um blob plantado (ref é único por construção).
    const fd = openSync(
      abs,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      FILE_MODE,
    );
    try {
      writeSync(fd, content, 0, 'utf8');
    } finally {
      closeSync(fd);
    }
    return ref;
  }

  async getBlob(ref: BlobRef): Promise<string> {
    // Uso EXCLUSIVO da mecânica de restauração — NÃO é um canal do agente (R7).
    return readFileSync(join(this.blobsDir, ref), 'utf8');
  }

  async appendEntry(entry: JournalEntry): Promise<void> {
    this.ensureSession();
    // F136 (HUNT-JOURNAL) — se o stack JÁ existe e NÃO termina em '\n', a última linha
    // está TORTA: um append de uma sessão ANTERIOR crashou no meio (bytes parciais sem
    // '\n') e `--continue`/`--resume` reabriu o MESMO stack. Um append cego COLARIA o
    // lixo parcial com a nova linha (`{torn{new}`) e o `loadEntries` (try/catch por
    // linha) PULARIA a merged ⇒ a entrada nova se PERDERIA silenciosamente. Prefixar
    // '\n' separa a torta na PRÓPRIA linha (que o loadEntries já pula sem dó) e a nova
    // entra ÍNTEGRA. Auto-cura: a rotação descarta a torta depois. (Complementa o
    // fail-safe de LEITURA do EST-1011 com a ESCRITA — mesma assimetria do F135.)
    const sep = this.stackHasTornTail() ? '\n' : '';
    // Append-log da pilha (JSONL). O arquivo já nasce 0600 (criado no ensure);
    // appendFileSync com mode preserva (não relaxa). NUNCA logamos isto em stdout.
    appendFileSync(this.stackFile, sep + JSON.stringify(entry) + '\n', { mode: FILE_MODE });
    // EST-1011 (rotação) — conta a 1ª vez do disco (cobre stack herdado já grande),
    // depois incrementa em memória. Ao passar do teto, reescreve compactado.
    if (this.stackLineCount < 0) this.stackLineCount = this.countStackLines();
    else this.stackLineCount += 1;
    if (this.stackLineCount > STACK_MAX_LINES) this.rotateStack();
  }

  async loadEntries(): Promise<readonly JournalEntry[]> {
    if (!existsSync(this.stackFile)) return [];
    // EST-1011 — leitura FAIL-SAFE + CAP. Lê no máximo `STACK_MAX_READ_BYTES`; se o
    // arquivo é maior (adulterado/sessão monstra), lê só a CAUDA (entradas recentes)
    // e DESCARTA a 1ª linha (provavelmente partida pela janela de leitura).
    const raw = this.readStackCapped();
    const lines = raw.text.split('\n');
    const out: JournalEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Ao ler só a cauda, a 1ª linha pode estar truncada no meio — pula sem dó.
      if (raw.truncatedHead && i === 0) continue;
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as JournalEntry);
      } catch {
        // EST-1011 (Bug 6) — UMA linha corrompida (crash no meio de um append, disco
        // cheio) NÃO derruba mais o undo inteiro: pula a linha e segue. Sem log do
        // conteúdo (CLI-SEC-6).
        continue;
      }
    }
    return out;
  }

  /**
   * EST-1011 — lê o `stack.jsonl` com CAP de bytes. Sob o teto: read inteiro. Acima:
   * lê só os últimos `STACK_MAX_READ_BYTES` (a CAUDA — as entradas mais recentes da
   * pilha de undo) e sinaliza `truncatedHead` (a 1ª linha lida pode estar partida).
   */
  private readStackCapped(): { text: string; truncatedHead: boolean } {
    const size = statSync(this.stackFile).size;
    if (size <= STACK_MAX_READ_BYTES) {
      return { text: readFileSync(this.stackFile, 'utf8'), truncatedHead: false };
    }
    const start = size - STACK_MAX_READ_BYTES;
    const buf = Buffer.allocUnsafe(STACK_MAX_READ_BYTES);
    const fd = openSync(this.stackFile, 'r');
    try {
      readSync(fd, buf, 0, STACK_MAX_READ_BYTES, start);
    } finally {
      closeSync(fd);
    }
    return { text: buf.toString('utf8'), truncatedHead: true };
  }

  /**
   * F136 — `true` se o `stack.jsonl` existe e NÃO termina em '\n' (última linha torta:
   * append de sessão anterior crashou no meio). Lê só o ÚLTIMO byte (O(1)). Arquivo
   * ausente/vazio ⇒ `false` (sem cauda torta). Erro ao checar ⇒ `false` (fail-open:
   * segue no append normal — um append que falharia falharia igual).
   */
  private stackHasTornTail(): boolean {
    let fd: number | undefined;
    try {
      const size = statSync(this.stackFile).size;
      if (size === 0) return false;
      fd = openSync(this.stackFile, 'r');
      const buf = Buffer.allocUnsafe(1);
      readSync(fd, buf, 0, 1, size - 1);
      return buf[0] !== 0x0a; // não termina em '\n' ⇒ cauda torta
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** EST-1011 — conta linhas não-vazias do `stack.jsonl` (p/ o gatilho de rotação). */
  private countStackLines(): number {
    if (!existsSync(this.stackFile)) return 0;
    try {
      const raw = this.readStackCapped().text;
      let n = 0;
      for (const line of raw.split('\n')) if (line.trim() !== '') n++;
      return n;
    } catch {
      return 0;
    }
  }

  /**
   * EST-1011 (Bug 6 — rotação) — reescreve o `stack.jsonl` compactado: mantém só as
   * `STACK_KEEP_LINES` entradas VÁLIDAS mais recentes (recência-primeiro — a cauda da
   * pilha de undo). ATÔMICO (temp `O_CREAT|O_EXCL` `0600` + rename), mesmas permissões
   * — sem janela `0644`. Linha corrompida é descartada na compactação (auto-cura).
   * Best-effort: se a reescrita falhar, mantém o arquivo como está (não derruba undo).
   */
  private rotateStack(): void {
    let kept: string[];
    try {
      const raw = this.readStackCapped();
      const lines = raw.text.split('\n');
      const valid: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (raw.truncatedHead && i === 0) continue;
        if (line.trim() === '') continue;
        try {
          JSON.parse(line); // mantém só linhas íntegras (compacta + auto-cura).
          valid.push(line);
        } catch {
          continue;
        }
      }
      kept = valid.slice(-STACK_KEEP_LINES);
    } catch {
      return; // não conseguiu ler p/ compactar — deixa como está (best-effort).
    }
    const tmp = `${this.stackFile}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(
        tmp,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        FILE_MODE,
      );
      writeSync(fd, kept.length > 0 ? kept.join('\n') + '\n' : '', 0, 'utf8');
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.stackFile); // atômico no mesmo filesystem.
      this.stackLineCount = kept.length;
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* temp pode não existir */
      }
      // best-effort: rotação falhou, segue com o arquivo atual (não derruba a sessão).
    }
  }

  async deleteBlob(ref: BlobRef): Promise<void> {
    // Unlink REAL (R6/§3): o conteúdo-antes some fisicamente. Idempotente.
    try {
      unlinkSync(join(this.blobsDir, ref));
    } catch {
      /* já removido — idempotente */
    }
  }

  async cleanup(): Promise<void> {
    // R6 — fim de sessão: unlink REAL de blobs + dir-pai da sessão (recursivo).
    try {
      rmSync(this.sessionDir, { recursive: true, force: true });
    } catch {
      /* idempotente */
    }
    this.sessionReady = false;
    this.stackLineCount = -1; // EST-1011 — recontado do disco na próxima escrita.
  }

  async gcOrphans(): Promise<void> {
    // R6 — GC pós-crash no start: remove sessões ÓRFÃS (terminaram sem cleanup).
    // A sessão ATUAL nunca é coletada (mesma id). Sessões com mtime mais velho que
    // o teto são removidas com unlink REAL (rmSync recursivo).
    if (!existsSync(this.undoRoot)) return;
    let names: string[];
    try {
      names = readdirSync(this.undoRoot);
    } catch {
      return;
    }
    const cutoff = this.now() - this.orphanMaxAgeMs;
    for (const name of names) {
      const dir = join(this.undoRoot, name);
      // Nunca coleta a sessão atual.
      if (dir === this.sessionDir) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /**
   * Cria a hierarquia `~/.aluy/`→`undo/`→`<session>/`→`blobs/` com `0700` ATÔMICO
   * (R5/R6 dir-pai): cada `mkdir` nasce com mode `0700` (não herda permissão larga
   * de um `mkdir -p` permissivo). Idempotente. `recursive:true` aplica o mode aos
   * níveis criados. Reforço defensivo: se algum nível JÁ existia com permissão
   * mais larga (criado por outra coisa), apertamos p/ 0700 (sem corrida — é o
   * dono que aperta antes de escrever blob).
   */
  private ensureSession(): void {
    if (this.sessionReady) return;
    // O ANCESTRAL de `~/.aluy` (a HOME do usuário, ou o tmpdir em teste) já existe
    // em produção; criamos o que faltar com mode default (não é dir NOSSO a
    // travar). Só a partir de `.aluy` aplicamos o 0700 restrito.
    const homeParent = dirname(this.base);
    if (!existsSync(homeParent)) {
      mkdirSync(homeParent, { recursive: true });
    }
    // Cria CADA nível NOSSO com `mkdir(mode 0700)` ATÔMICO (R5/R6 dir-pai):
    // `~/.aluy/`, `undo/`, `<session>/`, `blobs/` nascem 0700 — não `mkdir -p`
    // que poderia deixar um nível com permissão default larga. 0700 é umask-safe
    // (umask só REMOVE bits; 0700 não tem bits de grupo/outros a remover).
    // Idempotente: se o nível já existe, `mkdir` lança EEXIST e seguimos (não
    // relaxamos modo de um dir pré-existente — o GC/cleanup é o dono do ciclo).
    for (const dir of [this.base, this.undoRoot, this.sessionDir, this.blobsDir]) {
      try {
        mkdirSync(dir, { mode: DIR_MODE });
      } catch (e) {
        // EEXIST: o nível já existe — segue (idempotente). Qualquer outro erro
        // (EACCES, etc.) propaga: fail-safe, não escrevemos blob sem dir seguro.
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    this.sessionReady = true;
  }
}
