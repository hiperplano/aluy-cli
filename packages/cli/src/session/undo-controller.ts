// EST-0960b · ADR-0056 — UX de `/undo` `/redo` (empilhável). A MECÂNICA (journal,
// captura do `antes`, fronteira `edit_file`↔`run_command`, detecção de concorrência,
// restauração CONFINADA no momento da escrita) é da EST-0960a (`@hiperplano/aluy-cli-core`
// `SnapshotJournal`). Aqui mora SÓ a UX: o cursor undo/redo da sessão, a decisão de
// quando pedir confirmação, o aviso de barreira REDIGIDO (R9) e as notas de feedback.
//
// Por que o cursor vive aqui (e não no journal)? O journal é o registro IMUTÁVEL na
// ORDEM das ações (`list()`/`top()`); `/undo`/`/redo` são uma NAVEGAÇÃO sobre ele —
// estado de interação (qual a posição corrente, o que já foi desfeito p/ refazer). A
// ficha cravou: "consome a pilha/restauração da 0960a"; a navegação é da 0960b.
//
// MODELO do cursor:
//   `entries = journal.list()` é a pilha na ordem (índice 0 = mais antigo).
//   `cursor` aponta p/ o PRÓXIMO índice a desfazer (começa em entries.length).
//   /undo: anda o cursor p/ trás até achar um `edit` reversível; ao cruzar uma
//          `barrier` (run_command), AVISA (R9 redige o comando) e segue — não finge
//          desfazer (ADR §2). O `edit` revertido fica disponível p/ /redo.
//   /redo: anda o cursor p/ a frente, reaplicando o `edit` (re-escreve o `after`)…
//          mas o journal só guarda o `antes`. v1: /redo restaura via re-captura —
//          ver `redo()` (reaplica o snapshot inverso guardado no passo do /undo).

import { redactCommandSecrets, type JournalEntry, type RestoreOutcome } from '@hiperplano/aluy-cli-core';
import type { SnapshotJournal } from '@hiperplano/aluy-cli-core';

/** Uma nota a empurrar na conversa (mesma forma do SlashNote dos handlers). */
export interface UndoNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * O resultado de um `/undo`/`/redo`: ou uma NOTA pronta p/ exibir, ou um pedido de
 * CONFIRMAÇÃO (edição concorrente — CA-3) que o caller resolve perguntando ao
 * usuário e re-invocando com `confirm: true`. Nunca sobrescreve cego.
 */
export type UndoOutcome =
  | { readonly kind: 'note'; readonly note: UndoNote }
  | {
      readonly kind: 'confirm';
      readonly note: UndoNote;
      /** A ação que confirma a reversão (re-invoca o controller forçando). */
      readonly proceed: () => Promise<UndoOutcome>;
    };

/** Um passo já desfeito, guardado p/ o `/redo` reaplicar (LIFO). */
interface RedoStep {
  /** A entrada `edit` original (p/ identificar/feedback). */
  readonly entry: Extract<JournalEntry, { kind: 'edit' }>;
  /** O alvo (path como o agente pediu — revalidado no momento da escrita). */
  readonly path: string;
  /** Era uma CRIAÇÃO? (redo de um undo-de-criação = re-criar). */
  readonly createdByEdit: boolean;
}

export interface UndoControllerOptions {
  readonly journal: SnapshotJournal;
}

/**
 * Controlador de `/undo`/`/redo` da sessão. Stateful (cursor + pilha de redo).
 * Não toca o filesystem — delega 100% à restauração CONFINADA do journal (R8). O
 * `after` p/ o /redo vem de `journal.appliedContent(seq)` (estado de sessão da
 * mecânica; o journal é o único dono do seq).
 */
export class UndoController {
  private readonly journal: SnapshotJournal;
  /** Pilha de passos desfeitos, prontos p/ o /redo reaplicar (LIFO). */
  private readonly redoStack: RedoStep[] = [];
  /** Cursor: índice do PRÓXIMO item a desfazer. `null` = ainda não inicializado. */
  private cursor: number | null = null;

  constructor(opts: UndoControllerOptions) {
    this.journal = opts.journal;
  }

  /** Sincroniza o cursor com o topo da pilha (uma nova edição invalida o redo). */
  private syncCursor(): JournalEntry[] {
    const entries = [...this.journal.list()];
    if (this.cursor === null) {
      this.cursor = entries.length;
    } else if (this.cursor > entries.length) {
      this.cursor = entries.length;
    }
    return entries;
  }

  /**
   * `/undo` — reverte a última edição rastreada (CA-1). Empilhável: cada chamada
   * anda o cursor p/ trás. Ao cruzar uma BARREIRA (`run_command`), AVISA com o
   * comando REDIGIDO (R9/CLI-SEC-6) e segue — não finge desfazer (CA-2/ADR §2). Em
   * EDIÇÃO CONCORRENTE (CA-3), devolve `confirm` em vez de sobrescrever cego.
   *
   * `force=true` é a re-entrada APÓS o usuário confirmar a concorrência.
   */
  async undo(force = false): Promise<UndoOutcome> {
    const entries = this.syncCursor();
    let cursor = this.cursor ?? entries.length;

    if (cursor <= 0) {
      return note('undo', ['nada para desfazer — a pilha de edições está vazia.']);
    }

    // Avisos de barreira acumulados ao descer até a próxima edição reversível.
    const barrierWarnings: string[] = [];
    while (cursor > 0) {
      const entry = entries[cursor - 1]!;
      if (entry.kind === 'barrier') {
        // R9 — o comando da barreira passa pela redação de CLI-SEC-6 ANTES de
        // exibir: um `curl -H "Authorization: Bearer …"` não vaza o token na TUI.
        barrierWarnings.push(
          `⚠ aqui rodou \`${redactCommandSecrets(entry.command)}\` — efeito de shell NÃO é reversível (não desfeito).`,
        );
        cursor -= 1;
        this.cursor = cursor;
        continue; // segue p/ a edição abaixo da barreira (revertemos o que dá).
      }

      // entry.kind === 'edit' — o alvo a reverter.
      const target = entry.targets[0];
      if (!target) {
        cursor -= 1;
        this.cursor = cursor;
        continue;
      }

      // CA-3 — edição concorrente: o arquivo no disco divergiu do snapshot?
      if (!force) {
        const check = await this.journal.checkConcurrency(entry);
        if (check.diverged) {
          const lines = [
            ...barrierWarnings,
            `o arquivo \`${target.path}\` mudou desde a edição do agente (hash divergiu).`,
            'desfazer agora SOBRESCREVE essas mudanças externas com o conteúdo anterior.',
            'rode /undo de novo p/ confirmar a reversão, ou deixe como está.',
          ];
          return {
            kind: 'confirm',
            note: { title: 'undo — confirmar', lines },
            proceed: () => this.undo(true),
          };
        }
      }

      // Restauração CONFINADA (R8/R4) — o journal resolve+escreve no workspace no
      // momento da escrita; rejeita symlink/`..`/absoluto-fora plantado depois.
      let outcome: RestoreOutcome;
      try {
        outcome = await this.journal.restore(entry);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'falha desconhecida';
        return note('undo — falhou', [
          ...barrierWarnings,
          `não foi possível reverter \`${target.path}\`: ${reason}`,
          'nada foi escrito (a reversão é confinada e fail-safe).',
        ]);
      }

      // Sucesso: empilha o passo p/ o /redo e recua o cursor.
      this.pushRedo(entry, target.path, target.createdByEdit);
      cursor -= 1;
      this.cursor = cursor;

      const what =
        outcome.action === 'removed'
          ? `revertido (arquivo removido — era novo): \`${target.path}\``
          : `revertido: \`${target.path}\``;
      const depth = this.undoDepth(entries, cursor);
      return note('undo', [
        ...barrierWarnings,
        what,
        `pilha: ${depth} edição(ões) ainda reversível(eis) · ${this.redoStack.length} para refazer.`,
      ]);
    }

    // Esgotou a pilha só com barreiras (nenhuma edição reversível abaixo).
    return note('undo', [
      ...barrierWarnings,
      barrierWarnings.length > 0
        ? 'não há mais edições de arquivo para reverter abaixo das barreiras.'
        : 'nada para desfazer.',
    ]);
  }

  /**
   * `/redo` — reaplica o último `/undo` (CA-1). Reaplica o conteúdo APLICADO
   * (depois) via a MESMA escrita confinada do journal (R8 — sem nova `ask`,
   * confinada ao workspace). Pilha vazia ⇒ aviso neutro.
   */
  async redo(): Promise<UndoOutcome> {
    const step = this.redoStack.pop();
    if (!step) {
      return note('redo', ['nada para refazer — não há undo recente.']);
    }

    const applied = this.journal.appliedContent(step.entry.seq);
    if (!applied) {
      // Sem o `after` guardado (mecânica não o tem): degradação honesta.
      this.redoStack.push(step);
      return note('redo', [
        'não foi possível refazer: o conteúdo aplicado não está disponível nesta sessão.',
      ]);
    }

    // Reaplica via a porta confinada do journal (mesma disciplina R8 do undo).
    let at: string;
    try {
      at = await this.journal.reapply(step.path, applied.after);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'falha desconhecida';
      this.redoStack.push(step); // não consome o passo se a escrita falhou.
      return note('redo — falhou', [
        `não foi possível reaplicar \`${step.path}\`: ${reason}`,
        'nada foi escrito (reaplicação confinada e fail-safe).',
      ]);
    }

    // O cursor volta a incluir esta edição (ela está "aplicada" de novo).
    if (this.cursor !== null) this.cursor += 1;

    return note('redo', [
      `reaplicado: \`${step.path}\` (${at ? 'reaplicado' : 'ok'})`,
      `pilha: ${this.redoStack.length} ainda para refazer.`,
    ]);
  }

  /** Profundidade de edições reversíveis restantes abaixo do cursor (feedback). */
  private undoDepth(entries: readonly JournalEntry[], cursor: number): number {
    let n = 0;
    for (let i = 0; i < cursor; i++) {
      if (entries[i]!.kind === 'edit') n += 1;
    }
    return n;
  }

  /** Empilha o passo desfeito p/ o /redo. */
  private pushRedo(
    entry: Extract<JournalEntry, { kind: 'edit' }>,
    path: string,
    createdByEdit: boolean,
  ): void {
    this.redoStack.push({ entry, path, createdByEdit });
  }
}

/** Açúcar p/ uma nota simples. */
function note(title: string, lines: readonly string[]): UndoOutcome {
  return { kind: 'note', note: { title, lines } };
}
