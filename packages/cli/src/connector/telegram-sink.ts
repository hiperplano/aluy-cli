// ADR-0154 — o SINK do ingresso do Telegram: onde a mensagem já autorizada pela malha
// entra na sessão.
//
// Extraído do `run.tsx` (que é composição e fica fora da cobertura) porque a regra abaixo
// é a que estava ERRADA e precisava de teste próprio.
//
// O DEFEITO (dono, 01/09): ponte ATIVA, 1 chat autorizado, `0 sessão` de tokens — sessão
// recém-aberta em que ele nunca digitou nada. Mandou "ola" e não aconteceu NADA.
//
// A mensagem chegava e a malha classificava CERTO (`{kind:'instruction', text:'ola'}` —
// medido na cadeia real: getUpdates cru → parseGetUpdates → telegramUpdateToIncoming →
// classifyConnectorIngress). Ela morria no sink:
//
//     injectInstruction: (text) => { controller?.injectInput('root', text); }
//
// `injectInput` ENCAIXA numa conversa que já existe — a primeira linha dele é
// `if (!this.flowTree) return false`, e a `flowTree` só nasce em `beginTurn()`. Numa
// sessão que ainda não rodou turno nenhum ele devolve `false`, e o retorno era DESCARTADO
// aqui: o sumiço era MUDO.
//
// A assimetria que denunciou o caso: `injectData` usa a `monitorQueue`, que ACORDA a
// sessão parada. Mensagem de TERCEIRO (dado) entrava; a do DONO (instrução), não.
//
// A REGRA correta: sem turno aberto, a instrução do dono É o turno. `submit` é a MESMA via
// de quando ele digita no composer. Nada aqui amplia permissão — a malha já autorizou
// (allowlist + proveniência) e a catraca segue decidindo cada efeito.

import type { HistoryItem } from '@hiperplano/aluy-cli-core';
import type { IngressSink } from './telegram-bridge.js';

/** A fatia do `SessionController` que o sink precisa. Estreita de propósito (testável). */
export interface AlvoDeInjecao {
  /**
   * Há um turno RODANDO agora?
   *
   * Precisa ser consultado ANTES do `injectInput`, porque ele devolve `true` tanto para
   * "encaixei no turno vivo" quanto para "guardei para o PRÓXIMO turno". Ver o cabeçalho.
   */
  readonly turnoVivo: boolean;
  /** Encaixa numa conversa EM CURSO. `false` ⇒ não havia onde encaixar. */
  injectInput(nodeId: string, text: string): boolean;
  /** DADO não-confiável: já acorda a sessão parada por conta própria. */
  ingestExternalData(label: string, text: string): void;
  /** Abre um turno NOVO — a mesma via do composer. */
  submit(
    goal: string,
    attachments?: readonly HistoryItem[],
    opts?: { origem?: string },
  ): Promise<void>;
}

/** Rótulo do canal — é a ORIGEM visível do dado (CLI-SEC-9). */
const ROTULO_CANAL = 'canal';

/**
 * A DICA DE CANAL — o que faltava para o agente saber POR ONDE responder.
 *
 * O dono perguntou, em 01/09: "ele recebeu, mas não respondeu no canal, como ele sabe
 * quando tem que responder a msg via telegram?". Não sabia: a tool `telegram_send` já
 * existia e estava descrita, mas NADA dizia ao modelo que aquele turno tinha chegado
 * pelo Telegram. Do ponto de vista dele a mensagem era idêntica a algo digitado no
 * terminal — então respondia no terminal, o único lugar que ele sabia existir.
 *
 * O texto é NOSSO, não do usuário nem de terceiro: a malha já classificou a mensagem
 * como instrução do dono ANTES daqui, e nada deste conteúdo vem da rede. Ainda assim
 * entra pelo canal de DADO (observation), como toda a informação de contexto — a tool
 * de egresso continua passando pela catraca, e o alvo continua TRAVADO na conversa
 * corrente (o modelo não escolhe destinatário).
 */
const TEXTO_DICA_CANAL =
  'A mensagem deste turno chegou pelo TELEGRAM, não pelo terminal. O dono está no ' +
  'celular e NÃO está vendo esta tela: se a resposta é para ele, envie-a com a tool ' +
  '`telegram_send` — o destino já está travado na conversa dele. Responder só aqui ' +
  'equivale a não responder. Continue usando o terminal normalmente para o trabalho ' +
  '(ler/editar/rodar); o `telegram_send` é para o que ele precisa LER.';

/** A dica como item de histórico (canal `observation` — DADO, CLI-SEC-4). */
function dicaDeCanal(): HistoryItem {
  return { role: 'observation', toolName: ROTULO_CANAL, text: TEXTO_DICA_CANAL };
}

/**
 * Monta o sink. `obter` é DEFERIDO: o controller só existe depois do build da sessão, e a
 * ponte é construída antes — por isso um getter, e não o objeto.
 */
export function criarSinkTelegram(
  obter: () => AlvoDeInjecao | undefined,
  /**
   * DIÁRIO opcional (`~/.aluy/telegram.log`). O sink é o último ponto onde a mensagem
   * pode se perder depois de a malha já a ter AUTORIZADO, e até 01/09 ele não registrava
   * nada: dava para saber que o ingresso foi classificado como instrução e, mesmo assim,
   * nada aparecer na tela, sem um único rastro do porquê.
   */
  log: (linha: string) => void = () => undefined,
): IngressSink {
  return {
    // INSTRUÇÃO do dono ⇒ canal `user` (a MESMA via do "btw"; a catraca re-decide efeitos).
    injectInstruction: (text: string): void => {
      const alvo = obter();
      if (alvo === undefined) {
        // Acontece se uma mensagem chega ANTES de o controller existir (ref deferida).
        log('[telegram] sink: descartado — a sessão ainda não tem controller.');
        return;
      }
      // TURNO VIVO é a única situação em que ENCAIXAR entrega a mensagem AGORA.
      //
      // O `injectInput` sozinho não serve de teste: ele devolve `true` também quando
      // apenas GUARDA para o próximo turno (`pendingInjected`), e só o `submit` drena
      // essa fila. Tratando os dois como iguais, o que acontecia era: a mensagem ficava
      // guardada, a dica de canal (abaixo) ACORDAVA a sessão pelo monitor, e o turno
      // nascia com a dica e SEM a mensagem. O agente disse isso na tela do dono em 01/09
      // — "canal externo notificou que há uma sessão ativa, mas não há uma mensagem do
      // usuário com conteúdo específico... favor reenviar" — enquanto ele mandava
      // mensagem atrás de mensagem achando que a ponte tinha morrido.
      //
      // Fora do turno vivo vamos de `submit`, que leva a mensagem E drena o que por
      // acaso já estivesse guardado.
      log(`[telegram] sink: turnoVivo=${String(alvo.turnoVivo)}`);
      if (alvo.turnoVivo && alvo.injectInput('root', text)) {
        // Turno VIVO: a dica entra pelo canal de dado, que o loop drena mid-turn no
        // mesmo turno. (No caminho de `submit` ela vai como anexo — ver abaixo — em vez
        // de `ingestExternalData`, porque este ACORDA a sessão parada e abriria um turno
        // só com a dica, competindo com o `submit` que vem logo em seguida.)
        alvo.ingestExternalData(ROTULO_CANAL, TEXTO_DICA_CANAL);
        log('[telegram] sink: ENCAIXADO no turno vivo.');
        return;
      }
      log('[telegram] sink: abrindo turno novo (submit).');
      void alvo
        .submit(text, [dicaDeCanal()], { origem: 'telegram' })
        .then(() => log('[telegram] sink: submit CONCLUÍDO.'))
        .catch((e: unknown) => {
          // Um `submit` que REJEITA some sem rastro — e some junto com a mensagem do dono.
          log(`[telegram] sink: submit FALHOU — ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    // DADO não-confiável ⇒ canal `observation` (DADO_NAO_CONFIAVEL, CLI-SEC-4).
    injectData: (label: string, text: string): void => {
      obter()?.ingestExternalData(label, text);
    },
  };
}
