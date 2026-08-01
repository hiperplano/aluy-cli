// ADR-0158 §11 (FASE 4 — attach) — "em ASK-ESPERA ⇒ a resposta do dono LOCALMENTE
// (mesmo efeito da resposta via Telegram — reuse o caminho da fase 3)".
//
// `LocalAnswerChannel` é a ponte in-process entre o socket de attach
// (`attach-server.ts`, que recebe o evento `say` do cliente) e `waitForOwnerReply`
// (`channel.ts`, FASE 3): quando o runner está em ASK-ESPERA, uma fala recebida pelo
// attach é entregue aqui e `waitForOwnerReply` a corre (`Promise.race`) contra o
// long-poll do Telegram — quem responder primeiro (dono no Telegram OU dono no
// terminal via attach) encerra a espera. MESMA autoridade dos dois canais: dono
// autenticado (posse da máquina/socket OU allowlist do chat) ⇒ instrução (§11).
//
// PURO o bastante (nenhum I/O de fs/rede aqui) mas mora no `cli` porque implementa
// o contrato `LocalAnswerSource` que `channel.ts` (I/O) consome — não é formatação
// de protocolo (isso é `attach-protocol.ts`, cli-core); é sincronização entre dois
// objetos do MESMO processo.

/** Contrato que `waitForOwnerReply` (`channel.ts`) consome — devolve a PRÓXIMA
 * resposta local, ou nunca resolve se `stop` abortar antes (o caller faz a corrida
 * com `Promise.race` e descarta o perdedor). */
export interface LocalAnswerSource {
  waitForAnswer(stop: AbortSignal): Promise<string>;
}

export class LocalAnswerChannel implements LocalAnswerSource {
  private readonly pendingResolvers: Array<(text: string) => void> = [];
  private readonly queuedAnswers: string[] = [];

  /** Chamado pelo socket de attach (`onSay`) quando o runner está em ask-espera. Se
   * já há alguém esperando (`waitForAnswer` em voo), resolve na hora; senão ENFILEIRA
   * (best-effort — cobre a corrida rara "say chegou um instante antes de o loop
   * começar a esperar de novo"). */
  submit(text: string): void {
    const resolve = this.pendingResolvers.shift();
    if (resolve) {
      resolve(text);
      return;
    }
    this.queuedAnswers.push(text);
  }

  waitForAnswer(stop: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      const queued = this.queuedAnswers.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      if (stop.aborted) return; // nunca resolve — o caller descarta esta promise.
      const wrapped = (text: string): void => {
        stop.removeEventListener('abort', onAbort);
        resolve(text);
      };
      const onAbort = (): void => {
        const idx = this.pendingResolvers.indexOf(wrapped);
        if (idx >= 0) this.pendingResolvers.splice(idx, 1);
        // nunca resolve — o caller (Promise.race em `waitForOwnerReply`) descarta.
      };
      this.pendingResolvers.push(wrapped);
      stop.addEventListener('abort', onAbort, { once: true });
    });
  }
}
