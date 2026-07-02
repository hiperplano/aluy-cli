// EST-0960a · ADR-0056 — A MECÂNICA do journal de snapshot-do-antes (PORTÁVEL).
//
// Responsabilidades (todas CÓDIGO, mudam só por release — §6 do ADR):
//   - captura do `antes` em cada `edit_file` aprovado (CA-1) — REUSA o `before`
//     que a catraca já calculou p/ o diff (CLI-SEC-9): a tool passa o `before`,
//     não relemos o arquivo;
//   - pilha undo/redo por sessão, na ordem (CA-2);
//   - fronteira do reversível: `edit_file` = entrada `edit` reversível;
//     `run_command` = BARREIRA não-reversível marcada na pilha (CA-3) — NUNCA
//     snapshot p/ comando, NUNCA finge desfazer;
//   - detecção de edição concorrente por hash (CA-4 / §4);
//   - API de restauração CONFINADA p/ a 0960b (R8/TOCTOU): resolve+escreve pelo
//     port de escrita no MOMENTO DA ESCRITA, não confia no path gravado;
//   - teto de retenção (§3): ao estourar, descarta o mais antigo com unlink real.
//
// NÃO toca o filesystem nem `~/.aluy/`: tudo via `JournalStorePort` (blobs/pilha)
// e `RestoreWriterPort`/`CurrentReaderPort` (workspace). PORTÁVEL: sem `node:*`.

import type {
  ConcurrencyCheck,
  CurrentReaderPort,
  JournalEntry,
  JournalStorePort,
  RestoreOutcome,
  RestoreWriterPort,
  SnapshotJournalOptions,
  SnapshotTarget,
} from './types.js';
import type { WorkspacePort } from './workspace-port.js';
import type { ToolJournalPort } from '../tools/types.js';
import { JournalCipher } from './cipher.js';

const DEFAULT_MAX_ENTRIES = 100;

/**
 * EST-1011 (HUNT-RESOURCE — barreiras de `run_command` SEM TETO) — teto do nº TOTAL de
 * entradas na pilha em memória. O `enforceRetention` original contava/evictava SÓ as
 * entradas `edit` (que custam blob); as `barrier` (`run_command`) NUNCA eram podadas —
 * `this.entries` acumulava uma barreira por comando PARA SEMPRE. Numa sessão de
 * dogfooding (centenas de `run_command`) a pilha cresce sem teto em RAM (e o
 * `stack.jsonl` no disco junto). Cercamos o total de entradas também (as barreiras mais
 * antigas saem; o histórico reversível — os `edit` — segue regido pelo `maxEntries`).
 * Generoso: o teto de edits + folga p/ as barreiras intercaladas. Sob o teto, no-op.
 */
const TOTAL_ENTRIES_HEADROOM = 200;

/** Dados de uma captura de `edit_file` (o que a tool fornece no ponto de efeito). */
export interface CaptureEditInput {
  /** Caminho-alvo como o agente pediu. */
  readonly path: string;
  /** Conteúdo ANTES (reusa o `before` já lido p/ o diff — CLI-SEC-9). */
  readonly before: string;
  /** Conteúdo aplicado (depois). */
  readonly after: string;
  /** `true` se o arquivo NÃO existia antes (criação ⇒ undo = remover). */
  readonly createdByEdit: boolean;
}

/**
 * Journal de snapshot-do-antes de UMA sessão. Mantém a pilha undo/redo, captura o
 * `antes` de cada edição, marca barreiras de `run_command`, detecta concorrência e
 * expõe a restauração confinada que a EST-0960b consome.
 */
export class SnapshotJournal {
  private readonly store: JournalStorePort;
  private readonly workspace: WorkspacePort;
  private readonly restoreWriter: RestoreWriterPort | undefined;
  private readonly currentReader: CurrentReaderPort | undefined;
  private readonly maxEntries: number;
  /**
   * Cifra de sessão dos blobs (#1 — a TRAVA REAL). Detém a chave EFÊMERA (só em
   * memória; nunca no disco/log/stack.jsonl) e sela/abre o conteúdo-antes com
   * AES-256-GCM. O store só vê BYTES OPACOS (ciphertext) — um `cat` do blob no
   * disco devolve lixo cifrado, não o segredo. A chave morre com o processo.
   */
  private readonly cipher: JournalCipher;
  /** A pilha da sessão, na ORDEM das ações (CA-2). Espelhada no store. */
  private readonly entries: JournalEntry[] = [];
  private seq = 0;
  /**
   * EST-0960b — o conteúdo APLICADO (`after`) de cada edição, por seq, em memória
   * da sessão (NÃO no store/disco — o store só guarda o `antes` cifrado). É a fonte
   * do `/redo` reaplicar (a 0960b lê via `appliedContent`). Efêmero como a sessão;
   * o `seq` é a chave canônica (atribuído aqui, único dono). Não vai a log (R7).
   */
  private readonly appliedBySeq = new Map<number, { path: string; after: string }>();

  constructor(opts: SnapshotJournalOptions) {
    this.store = opts.store;
    this.workspace = opts.workspace;
    this.restoreWriter = opts.restoreWriter;
    this.currentReader = opts.currentReader;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    // Chave de sessão gerada AQUI (`crypto.randomBytes(32)` por default), SÓ na
    // memória deste processo. Injetável apenas p/ teste determinístico (round-
    // trip/IV-único); em produção nasce aleatória e nunca toca o disco.
    this.cipher = opts.cipher ?? new JournalCipher();
  }

  /** A raiz do workspace ao qual a restauração está confinada (R8). */
  get workspaceRoot(): string {
    return this.workspace.root;
  }

  /**
   * A face ESTREITA (`ToolJournalPort`) que a `edit_file`/`run_command` enxergam:
   * só `captureEdit`/`markBarrier` (sem a pilha/restauração completas). É o que
   * entra em `ToolPorts.journal`. Explícito (em vez de passar `this`) p/ o
   * contrato da tool não ver a API completa do journal.
   */
  get toolPort(): ToolJournalPort {
    // F162 — o journal de undo é CONVENIÊNCIA, não gate: uma falha de persistência
    // (disco cheio, ~/.aluy/undo apagado além do auto-reparo do store) NÃO pode
    // derrubar a tool que ele só acompanha — na sessão real do dono, TODO
    // `run_command` passou a falhar com o ENOENT do stack.jsonl, inclusive o
    // comando que consertaria. Degrada: marca `degraded` (o /undo avisa que a
    // cobertura tem lacuna) e deixa a tool seguir. Nunca loga conteúdo (R7).
    return {
      captureEdit: async (input) => {
        try {
          await this.captureEdit(input);
        } catch {
          this.degradedFlag = true;
        }
      },
      markBarrier: async (command) => {
        try {
          await this.markBarrier(command);
        } catch {
          this.degradedFlag = true;
        }
      },
    };
  }

  /**
   * F162 — `true` se ALGUMA captura/barreira falhou nesta sessão (undo com lacuna).
   * O chamador pode avisar 1× ("undo indisponível p/ parte da sessão") — honesto
   * sem bloquear o trabalho.
   */
  get degraded(): boolean {
    return this.degradedFlag;
  }

  private degradedFlag = false;

  /**
   * Captura o `antes` de UMA edição aprovada (CA-1). Chamada pela `edit_file` no
   * ponto de efeito, ANTES de sobrescrever — reusando o `before` já lido p/ o
   * diff (não relê o arquivo). Persiste o blob (`0600` atômico no store) e
   * empilha a entrada `edit`. Aplica o teto de retenção (§3).
   */
  async captureEdit(input: CaptureEditInput): Promise<JournalEntry> {
    // #1 — CIFRA EM REPOUSO: sela o conteúdo-antes ANTES de entregar ao store.
    // O store grava CIPHERTEXT (IV+tag+dados, base64), nunca o plaintext. O hash
    // (detecção de concorrência) é do PLAINTEXT — comparável com o estado atual
    // do arquivo no disco (que é claro). A chave nunca sai desta sessão.
    const beforeRef = await this.store.putBlob(this.cipher.seal(input.before));
    const target: SnapshotTarget = {
      path: input.path,
      beforeRef,
      beforeHash: this.store.hash(input.before),
      createdByEdit: input.createdByEdit,
    };
    const entry: JournalEntry = {
      kind: 'edit',
      seq: this.seq++,
      ts: Date.now(),
      tool: 'edit_file',
      targets: [target],
      appliedHash: this.store.hash(input.after),
    };
    // EST-0960b — guarda o `after` por seq (memória da sessão) p/ o /redo reaplicar.
    this.appliedBySeq.set(entry.seq, { path: input.path, after: input.after });
    await this.push(entry);
    return entry;
  }

  /**
   * EST-0960b — o conteúdo APLICADO (`after`) de uma edição por seq, p/ o `/redo`
   * reaplicar. `undefined` se a seq não é de uma edição capturada nesta sessão.
   * Estado de sessão em memória (não toca disco/store); nunca logado (R7).
   */
  appliedContent(seq: number): { readonly path: string; readonly after: string } | undefined {
    return this.appliedBySeq.get(seq);
  }

  /**
   * Marca a BARREIRA não-reversível de um `run_command` na pilha (CA-3 / §2).
   * NÃO captura snapshot (efeito de shell é arbitrário e não-rastreável); só
   * registra a posição p/ a 0960b avisar "aqui rodou `<cmd>` — não desfeito".
   */
  async markBarrier(command: string): Promise<JournalEntry> {
    const entry: JournalEntry = {
      kind: 'barrier',
      seq: this.seq++,
      ts: Date.now(),
      tool: 'run_command',
      command,
    };
    await this.push(entry);
    return entry;
  }

  /** A pilha da sessão, na ordem (somente leitura — a 0960b consome). */
  list(): readonly JournalEntry[] {
    return this.entries;
  }

  /**
   * EST-XXXX (checkpoints) — o PRÓXIMO `seq` que uma captura usaria AGORA. É a
   * FRONTEIRA que o `CheckpointRegistry` grava no início de um turno: toda edição
   * com `seq >= nextSeq()` deste instante aconteceu DEPOIS do ponto e é revertida
   * no rewind de código. Só LÊ o contador interno (não muta nada).
   */
  nextSeq(): number {
    return this.seq;
  }

  /** O item do TOPO da pilha (o próximo a desfazer), ou `undefined` se vazia. */
  top(): JournalEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /**
   * Checa se um arquivo de uma entrada `edit` DIVERGIU desde o snapshot (CA-4 /
   * §4): compara o hash do estado ATUAL no disco com o `appliedHash` que a
   * edição deixou. A 0960b usa isto p/ pedir confirmação (não sobrescrever cego).
   * Sem `currentReader` injetado ⇒ assume não-divergente (fail-open só na
   * INFORMAÇÃO; a restauração em si segue confinada).
   */
  async checkConcurrency(entry: JournalEntry, targetIndex = 0): Promise<ConcurrencyCheck> {
    if (entry.kind !== 'edit') {
      return { diverged: false, expectedHash: '', currentHash: '' };
    }
    const target = entry.targets[targetIndex];
    if (!target) {
      return { diverged: false, expectedHash: entry.appliedHash, currentHash: '' };
    }
    const expectedHash = entry.appliedHash;
    if (!this.currentReader) {
      return { diverged: false, expectedHash, currentHash: expectedHash };
    }
    const current = await this.currentReader.readCurrent(target.path);
    // Se o arquivo foi criado pela edição e não existe mais, e a entrada não
    // esperava conteúdo (createdByEdit), tratamos divergência por ausência.
    const currentHash = current === undefined ? '' : this.store.hash(current);
    return { diverged: currentHash !== expectedHash, expectedHash, currentHash };
  }

  /**
   * RESTAURA o conteúdo-antes de um alvo de uma entrada `edit` (consumido pela
   * 0960b). CONFINADA (R8/TOCTOU): delega a escrita/remoção ao `restoreWriter`,
   * que resolve o alvo pelo `WorkspacePort` NO MOMENTO DA ESCRITA — um symlink/
   * `..`/absoluto-fora plantado depois da captura é rejeitado (lança). NÃO confia
   * no path gravado. Se o arquivo foi CRIADO pela edição, o undo = REMOVER.
   *
   * NÃO faz nova `ask` (a engine restaura um snapshot que ela mesma capturou de
   * um arquivo já no workspace — §4/E do ADR), MAS respeita o confinamento.
   */
  async restore(entry: JournalEntry, targetIndex = 0): Promise<RestoreOutcome> {
    if (entry.kind !== 'edit') {
      throw new Error('não há snapshot reversível para uma barreira (run_command).');
    }
    if (!this.restoreWriter) {
      throw new Error('restauração indisponível: restoreWriter não injetado.');
    }
    const target = entry.targets[targetIndex];
    if (!target) {
      throw new Error(`alvo ${targetIndex} inexistente na entrada seq=${entry.seq}.`);
    }
    if (target.createdByEdit) {
      // O arquivo não existia antes: desfazer a criação = REMOVER (confinado).
      const at = await this.restoreWriter.removeConfined(target.path);
      return { path: at, action: 'removed' };
    }
    // Restaura o conteúdo-antes: lê o CIPHERTEXT opaco do store e DECIFRA na
    // sessão viva (#1 — a chave em memória abre o blob; o auth tag do GCM rejeita
    // um blob adulterado). O byte claro só existe transitoriamente aqui, e só sai
    // pela escrita confinada ao workspace (R8).
    const before = this.cipher.open(await this.store.getBlob(target.beforeRef));
    const at = await this.restoreWriter.writeConfined(target.path, before);
    return { path: at, action: 'written' };
  }

  /**
   * REAPLICA um conteúdo (`after`) num alvo do workspace — a escrita do `/redo`
   * da EST-0960b. MESMA disciplina CONFINADA da `restore` (R8/TOCTOU): delega ao
   * `restoreWriter`, que resolve o alvo pelo `WorkspacePort` NO MOMENTO DA ESCRITA
   * e rejeita symlink/`..`/absoluto-fora plantado depois. NÃO faz nova `ask` (a
   * engine reescreve um conteúdo que ela mesma já capturou — §4/E do ADR), MAS
   * respeita o confinamento. NÃO toca o journal/store (o `after` é estado de UX da
   * 0960b; a mecânica só empresta a escrita confinada). Devolve o path seguro.
   */
  async reapply(requestedPath: string, content: string): Promise<string> {
    if (!this.restoreWriter) {
      throw new Error('reaplicação indisponível: restoreWriter não injetado.');
    }
    return this.restoreWriter.writeConfined(requestedPath, content);
  }

  /**
   * Limpeza de FIM de sessão (R6): unlink REAL dos blobs + dir-pai da sessão.
   * Idempotente. A 0960b/o ciclo de vida da sessão chama no encerramento.
   */
  async cleanup(): Promise<void> {
    await this.store.cleanup();
    this.entries.length = 0;
    this.appliedBySeq.clear();
  }

  // ── interno ──────────────────────────────────────────────────────────────────

  /** Empilha + persiste + aplica o teto de retenção (§3, unlink real). */
  private async push(entry: JournalEntry): Promise<void> {
    this.entries.push(entry);
    await this.store.appendEntry(entry);
    await this.enforceRetention();
  }

  /**
   * Teto de retenção (§3 / T11): conta só as entradas `edit` (reversíveis, que
   * custam blob). Ao estourar, descarta a MAIS ANTIGA com UNLINK REAL dos seus
   * blobs (`store.deleteBlob`) — não basta soltar a referência em memória; o
   * conteúdo-antes (possível segredo) some FISICAMENTE do journal (R6/CLI-SEC-6).
   * Conservador: nunca deixamos a pilha de edições crescer sem teto.
   */
  private async enforceRetention(): Promise<void> {
    // (1) Teto das EDIÇÕES (reversíveis, custam blob): descarta a mais ANTIGA com
    // UNLINK REAL do blob. EST-1011 — TAMBÉM remove o `appliedBySeq` da edição evictada:
    // antes, o `after` (conteúdo INTEIRO do arquivo) ficava no Map p/ sempre mesmo após
    // a edição sair da pilha — vazamento de RAM proporcional à sessão. Agora some junto.
    while (this.entries.filter((e) => e.kind === 'edit').length > this.maxEntries) {
      const idx = this.entries.findIndex((e) => e.kind === 'edit');
      if (idx < 0) break;
      const [evicted] = this.entries.splice(idx, 1);
      if (evicted && evicted.kind === 'edit') {
        this.appliedBySeq.delete(evicted.seq); // EST-1011 — libera o `after` retido.
        for (const t of evicted.targets) {
          await this.store.deleteBlob(t.beforeRef);
        }
      }
    }
    // (2) EST-1011 (HUNT-RESOURCE) — teto do TOTAL de entradas: as `barrier`
    // (`run_command`) não custam blob e antes NUNCA eram podadas — acumulavam sem teto
    // numa sessão longa (uma por comando). Acima do teto total, descarta as entradas
    // NÃO-edit mais ANTIGAS (barreiras): elas só marcam "aqui rodou um comando", a mais
    // antiga já não informa nada útil. NUNCA mexe nas `edit` aqui (o undo reversível é
    // governado só pelo passo (1) — preservamos todo conteúdo restaurável).
    const totalCap = this.maxEntries + TOTAL_ENTRIES_HEADROOM;
    while (this.entries.length > totalCap) {
      const idx = this.entries.findIndex((e) => e.kind !== 'edit');
      if (idx < 0) break; // só restam edições (já no seu próprio teto) — nada a podar.
      this.entries.splice(idx, 1);
    }
  }
}
