// EST-XXXX — CHECKPOINTS / REWIND (a MECÂNICA portável). Paridade com o `/rewind`
// do Claude Code: um ponto de restauração por PROMPT do usuário, que permite voltar
// (a) o CÓDIGO editado pelo agente desde o ponto e (b) a CONVERSA (truncar turnos).
//
// FRONTEIRA (ADR-0053 §8): este módulo é CÓDIGO PORTÁVEL (sem Ink, sem `node:*`).
// Ele NÃO guarda arquivos nem toca o filesystem — ORQUESTRA o `SnapshotJournal`
// (EST-0960a/ADR-0056), que já detém o `before` cifrado de cada `edit_file` e a
// escrita CONFINADA (R8/TOCTOU). O rewind de CÓDIGO é, por construção, da SESSÃO
// VIVA (a chave de cifra do journal é efêmera — mesma limitação do `/undo` e do
// `/rewind` do Claude Code). O rewind de CONVERSA mora no @hiperplano/aluy-cli (truncar blocos
// + re-semear o contexto), que consome a contagem de blocos gravada aqui.
//
// MODELO: cada checkpoint marca, no INÍCIO de um turno do usuário, dois números:
//   - `journalSeq` — o `nextSeq` do journal naquele instante: a FRONTEIRA do
//     "depois". Toda edição com `seq >= journalSeq` aconteceu DEPOIS do ponto.
//   - `blockCount` — o tamanho da transcrição naquele instante: o ponto de corte
//     da conversa (o @hiperplano/aluy-cli trunca os blocos para este tamanho).
//
// RESTAURAR CÓDIGO ao checkpoint C: para cada arquivo editado em `seq >=
// C.journalSeq`, restaura o `before` da PRIMEIRA edição após o ponto — isso devolve
// o arquivo ao estado que tinha NO ponto (não ao de duas edições atrás). Arquivos
// CRIADOS depois do ponto são removidos (o journal já trata `createdByEdit`).
// Idempotente: restaurar 2× ao mesmo ponto reescreve o mesmo conteúdo.

import type { JournalEntry } from '../journal/types.js';
import type { SnapshotJournal } from '../journal/journal.js';
import { redactCommandSecrets } from '../journal/redact.js';

/** Teto default do nº de prompts (truncamento do label) p/ exibir no menu. */
const DEFAULT_LABEL_MAX = 80;

/** Idade default (ms) acima da qual um checkpoint é podado (`prune`). 24h. */
export const DEFAULT_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Um ponto de restauração — um PROMPT do usuário. Imutável depois de criado. */
export interface Checkpoint {
  /** Id estável e único na sessão (`cp1`, `cp2`, …). */
  readonly id: string;
  /** Ordinal 1-based (ordem de criação) — só p/ exibir. */
  readonly ordinal: number;
  /** Epoch ms da criação (início do turno). */
  readonly ts: number;
  /** O PROMPT do usuário (truncado) — rótulo do item no menu. */
  readonly label: string;
  /**
   * O `nextSeq` do journal no INÍCIO do turno: a fronteira do "depois". Edição com
   * `seq >= journalSeq` ocorreu após este ponto e é revertida no rewind de código.
   */
  readonly journalSeq: number;
  /**
   * O nº de blocos da transcrição no início do turno: o ponto de corte da CONVERSA.
   * O @hiperplano/aluy-cli trunca os blocos visíveis + o contexto do modelo a este tamanho.
   */
  readonly blockCount: number;
}

/** Resultado de uma restauração de CÓDIGO de um checkpoint. */
export interface CheckpointRestoreResult {
  /** Arquivos reescritos com o conteúdo-do-ponto (paths como o agente pediu). */
  readonly written: readonly string[];
  /** Arquivos removidos (foram CRIADOS depois do ponto). */
  readonly removed: readonly string[];
  /** Paths que falharam ao restaurar (escapou o confinamento / I/O) + motivo. */
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
  /** Avisos de barreira (`run_command`) entre o ponto e o agora — REDIGIDOS. */
  readonly barrierWarnings: readonly string[];
}

export interface CheckpointRegistryOptions {
  /** O journal da sessão (a mecânica de snapshot/restauração de arquivo). */
  readonly journal: Pick<SnapshotJournal, 'list' | 'restore' | 'nextSeq'>;
  /** Teto de caracteres do label exibível (default 80). */
  readonly labelMax?: number;
  /** "Agora" injetável (teste determinístico). Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Registro de checkpoints da SESSÃO (1 por prompt). Stateful (a lista de pontos),
 * mas PURO quanto a I/O: toda escrita de arquivo é delegada ao journal (confinada
 * R8). A lista vive em memória da sessão — o snapshot de arquivo de cada ponto JÁ
 * está no journal cifrado; aqui só guardamos as FRONTEIRAS (`seq`/`blockCount`).
 */
export class CheckpointRegistry {
  private readonly journal: Pick<SnapshotJournal, 'list' | 'restore' | 'nextSeq'>;
  private readonly labelMax: number;
  private readonly now: () => number;
  private readonly checkpoints: Checkpoint[] = [];
  private counter = 0;

  constructor(opts: CheckpointRegistryOptions) {
    this.journal = opts.journal;
    this.labelMax = opts.labelMax ?? DEFAULT_LABEL_MAX;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Marca um checkpoint no INÍCIO de um turno do usuário. `prompt` é a fala do
   * usuário (vira o label, truncado); `blockCount` é o tamanho da transcrição
   * ANTES de o turno acrescentar blocos. A fronteira de código (`journalSeq`) é o
   * `nextSeq` do journal NESTE instante (toda edição daqui pra frente é "depois").
   *
   * Idempotência defensiva: um prompt VAZIO (só espaços) NÃO cria checkpoint
   * (nada a ancorar). Devolve `undefined` nesse caso.
   */
  markPrompt(prompt: string, blockCount: number): Checkpoint | undefined {
    const label = normalizeLabel(prompt, this.labelMax);
    if (label === '') return undefined;
    const ordinal = this.counter + 1;
    const checkpoint: Checkpoint = {
      id: `cp${ordinal}`,
      ordinal,
      ts: this.now(),
      label,
      journalSeq: this.journal.nextSeq(),
      blockCount: Math.max(0, Math.floor(blockCount)),
    };
    this.counter = ordinal;
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /** Os checkpoints na ORDEM de criação (antigo→recente). Somente leitura. */
  list(): readonly Checkpoint[] {
    return this.checkpoints;
  }

  /** O checkpoint de um id, ou `undefined`. */
  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find((c) => c.id === id);
  }

  /**
   * Lista os AVISOS de barreira (`run_command`) entre o ponto e o agora — os
   * comandos REDIGIDOS (CLI-SEC-6) cujo efeito de shell NÃO é reversível. O menu
   * exibe isto p/ o usuário saber que voltar o código não desfaz esses efeitos.
   */
  barriersAfter(id: string): readonly string[] {
    const cp = this.get(id);
    if (!cp) return [];
    const out: string[] = [];
    for (const entry of this.journal.list()) {
      if (entry.seq < cp.journalSeq) continue;
      if (entry.kind === 'barrier') {
        out.push(redactCommandSecrets(entry.command));
      }
    }
    return out;
  }

  /**
   * RESTAURA o CÓDIGO ao estado do checkpoint `id`: reverte cada arquivo editado em
   * `seq >= journalSeq` ao conteúdo-do-ponto (o `before` da PRIMEIRA edição após o
   * ponto, por path). Arquivos criados depois do ponto são REMOVIDOS. Processa por
   * path uma única vez (idempotente). Delega a escrita ao journal (confinada R8 —
   * symlink/`..`/absoluto-fora plantado depois é rejeitado). Coleta falhas em vez
   * de abortar tudo (fail-safe por-arquivo): um path que escapa não impede os demais.
   *
   * A ORDEM: restaura na ordem CRESCENTE de path-primeira-edição (estável). Como
   * cada path é restaurado UMA vez (ao seu `before`-de-ponto), a ordem entre paths
   * não muda o resultado.
   */
  async restoreCode(id: string): Promise<CheckpointRestoreResult> {
    const cp = this.get(id);
    if (!cp) {
      return { written: [], removed: [], failed: [], barrierWarnings: [] };
    }
    // Agrupa as edições após o ponto por path; guarda a PRIMEIRA (seq mínimo) — é
    // ela que carrega o `before` = conteúdo no ponto. Mapa preserva a 1ª inserção.
    const firstByPath = new Map<string, { entry: JournalEntry; targetIndex: number }>();
    for (const entry of this.journal.list()) {
      if (entry.seq < cp.journalSeq) continue;
      if (entry.kind !== 'edit') continue;
      entry.targets.forEach((target, targetIndex) => {
        if (!firstByPath.has(target.path)) {
          firstByPath.set(target.path, { entry, targetIndex });
        }
      });
    }

    const written: string[] = [];
    const removed: string[] = [];
    const failed: { path: string; reason: string }[] = [];

    for (const [path, { entry, targetIndex }] of firstByPath) {
      try {
        const outcome = await this.journal.restore(entry, targetIndex);
        if (outcome.action === 'removed') removed.push(outcome.path);
        else written.push(outcome.path);
      } catch (err) {
        failed.push({ path, reason: err instanceof Error ? err.message : 'falha desconhecida' });
      }
    }

    return {
      written,
      removed,
      failed,
      barrierWarnings: this.barriersAfter(id),
    };
  }

  /**
   * PODA os checkpoints mais velhos que `maxAgeMs` (limpeza por idade configurável,
   * CA-7). Best-effort/PURO: só descarta a entrada da LISTA (o snapshot de arquivo
   * em si é regido pelo teto/GC do journal — não duplicamos blobs). Devolve quantos
   * foram podados. NÃO renumera ids/ordinais (estáveis na sessão).
   */
  prune(maxAgeMs: number = DEFAULT_CHECKPOINT_MAX_AGE_MS): number {
    const cutoff = this.now() - maxAgeMs;
    const before = this.checkpoints.length;
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      if (this.checkpoints[i]!.ts < cutoff) this.checkpoints.splice(i, 1);
    }
    return before - this.checkpoints.length;
  }

  /** Esvazia o registro (fim de sessão / `/clear`). Idempotente. */
  reset(): void {
    this.checkpoints.length = 0;
    this.counter = 0;
  }
}

/**
 * Normaliza o label de um prompt: colapsa espaços/controle, apara, trunca por code
 * point (não parte par surrogate). String vazia ⇒ '' (sem checkpoint). PURO.
 */
export function normalizeLabel(prompt: string, max: number): string {
  let out = '';
  for (const ch of prompt) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const trimmed = out.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return '';
  const cps = [...trimmed];
  return cps.length > max ? cps.slice(0, max - 1).join('') + '…' : trimmed;
}
