// ADR-0158 §5 pt.4/§8.1/§8.2 (FASE 3, "o CANAL do serviço") — FORMATADORES PUROS de
// tudo que o runner envia pro `channel:` do manifesto: o reporte de fechamento de
// turno (§8.2 — "todo turno termina prestando contas no canal"), o alerta de falha
// (§8.1 — "turno não aberto ⇒ ALERTA no canal, nunca silêncio"), e as duas pontas da
// ASK-ESPERA (§5 pt.4 — pergunta ao dono + retomada com a resposta dele).
//
// Só TEXTO — o I/O (TelegramClient/keychain/EgressRateLimiter) é do runner concreto,
// `@hiperplano/aluy-cli` (ADR-0053 §8). Nenhuma destas funções decide PRA ONDE vai o
// texto — isso é `parseServiceTelegramChatId` (`service-channel.ts`) + a trava TC-5.

/** Desfecho de UM turno já fechado (ok ou parado por motivo NÃO-`awaiting-owner` —
 * esse tem seu próprio par de mensagens, abaixo). Espelha o bastante de
 * `WorkflowOutcome`/`WorkflowRunResult` (runner.ts) pra formatar sem acoplar o tipo. */
export interface ServiceTurnClosure {
  readonly serviceName: string;
  /** `true` ⇒ turno concluiu normalmente (todas as atividades OK). */
  readonly ok: boolean;
  /**
   * `true` ⇒ falha que impediu o turno de completar de um jeito que MERECE alerta
   * (§8.1: "erro de spawn, manifesto inválido pós-edição, crash de atividade") —
   * distinto de uma parada NEUTRA (`until:`/teto atingido, cancelamento do dono via
   * `stop`, ou o agente concluindo cedo com sucesso — `stop: 'final'`), que é
   * reporte normal (§8.2), não alerta.
   */
  readonly critical: boolean;
  /** Resumo curto (já pronto pra exibição — `runner.ts` monta a partir do `WorkflowRunResult`). */
  readonly summary: string;
}

const REPORT_PREFIX = '📋';
const ALERT_PREFIX = '⚠';
const ASK_PREFIX = '❓';

/**
 * §8.2 — o REPORTE de fechamento (turno concluiu OU parou por motivo neutro). PURO.
 */
export function formatServiceTurnReport(input: ServiceTurnClosure): string {
  const status = input.ok ? 'turno concluído' : 'turno encerrado';
  return `${REPORT_PREFIX} [${input.serviceName}] ${status} — ${input.summary}`;
}

/**
 * §8.1 — o ALERTA de falha ("turno que não abriu no schedule... nunca silêncio").
 * Cobre tanto uma falha DENTRO do turno (`ServiceTurnClosure.critical`) quanto uma
 * falha que impediu o turno de sequer COMEÇAR (schedule inválido, manifesto inválido
 * pós-edição, workflow ausente) — para esse segundo caso não há `ServiceTurnClosure`
 * (não houve turno), por isso a sobrecarga com `reason` cru. PURO.
 */
export function formatServiceFailureAlert(serviceName: string, reason: string): string {
  return `${ALERT_PREFIX} [${serviceName}] ALERTA — ${reason}`;
}

/**
 * §5 pt.4 — a PERGUNTA enviada ao canal quando o turno fecha "aguardando dono"
 * (`awaitsUserDecision`, ADR-0157, estendido a serviço pelo ADR-0158 §5 pt.4). PURO.
 */
export function formatServiceAskMessage(serviceName: string, question: string): string {
  return (
    `${ASK_PREFIX} [${serviceName}] aguardando sua decisão para continuar:\n\n${question}\n\n` +
    `Responda esta conversa — a resposta retoma o turno de onde parou.`
  );
}

/**
 * §5 pt.4 — o CONTEXTO injetado no turno de RETOMADA: a atividade que perguntou
 * re-executa com pergunta+resposta anexadas ao `goal` original (`runner.ts` monta o
 * goal completo; isto é só o BLOCO de contexto). PURO.
 */
export function formatServiceResumeInstruction(question: string, ownerAnswer: string): string {
  return (
    `[Retomando após pergunta ao dono]\n` +
    `Pergunta que você fez: ${question}\n` +
    `Resposta do dono (via canal): ${ownerAnswer}\n` +
    `Prossiga a atividade com esta decisão — não pergunte de novo a mesma coisa.`
  );
}

/**
 * §5 pt.4 — o ALERTA de TIMEOUT da ASK-ESPERA ("timeout ⇒ loga, alerta no canal,
 * turno encerra sem ação"). PURO.
 */
export function formatServiceAskTimeoutAlert(
  serviceName: string,
  question: string,
  waitedMs: number,
): string {
  const hours = Math.round(waitedMs / 3_600_000);
  return (
    `${ALERT_PREFIX} [${serviceName}] SEM RESPOSTA após ${hours}h — o turno foi encerrado sem ` +
    `ação (nunca prossegue com suposição). Pergunta que ficou pendente:\n\n${question}`
  );
}

/**
 * Timeout DEFAULT da ASK-ESPERA (24h). ADR-0158 §5 pt.4 pede "timeout configurável"
 * mas a missão da FASE 3 é explícita: NÃO inventar um campo novo de frontmatter
 * (`ask-timeout:`) sem necessidade comprovada — um default sensato basta por ora.
 *
 * TODO(ADR-0158 fase futura): se o dogfood mostrar que 24h é errado pra algum
 * serviço (turno noturno vs. serviço que só opera em janela curta), promover isto a
 * um campo de frontmatter (`ask-timeout: "4h"`, reusando a gramática de `budget:`) —
 * NÃO decidir aqui, sem um caso real que o justifique (mesma doutrina anti-framework
 * do ADR-0158: campo novo só quando um caso real pede).
 */
export const DEFAULT_ASK_TIMEOUT_MS = 24 * 60 * 60_000;

/**
 * `true` quando a ASK-ESPERA que começou em `startedAtMs` já estourou o timeout em
 * `nowMs` (ambos injetados — PURO/testável sem relógio real). PURO.
 */
export function hasAskTimedOut(
  startedAtMs: number,
  nowMs: number,
  timeoutMs: number = DEFAULT_ASK_TIMEOUT_MS,
): boolean {
  return nowMs - startedAtMs >= timeoutMs;
}

/**
 * ADR-0158 §11 (FASE 4 — attach) — o CONTEXTO injetado na PRÓXIMA atividade do
 * workflow quando o dono digitou algo em `aluy service attach` (evento `say`,
 * `attach-protocol.ts`) enquanto o serviço estava DORMINDO ou com um TURNO EM
 * ANDAMENTO (não em ask-espera — essa tem seu próprio caminho, a resposta LOCAL via
 * `waitForOwnerReply`, `channel.ts`).
 *
 * DEGRADE DOCUMENTADO (missão da FASE 4, item 3): injeção mid-turno DE VERDADE
 * exigiria o processo-filho (`aluy -p` de uma atividade já em voo) consultar uma
 * fila externa entre chamadas de modelo — plumbing que não existe hoje no loop
 * headless. A via barata e honesta: a fala do dono é entregue à PRÓXIMA atividade
 * que abrir (a primeira do próximo turno, se o serviço estava dormindo; a atividade
 * seguinte do workflow, se um turno já estava em andamento) — nunca silenciosamente
 * descartada, nunca fingida como "já entregue" no meio da atividade corrente. PURO.
 */
export function formatOwnerSayInjection(sayings: readonly string[]): string {
  const body = sayings.map((s) => `- ${s}`).join('\n');
  return (
    `[Fala do dono recebida via "aluy service attach" — pode ter ` +
    `chegado enquanto outra atividade rodava; é entregue nesta, a PRÓXIMA a abrir:]\n` +
    `${body}`
  );
}

/**
 * §4 do item de missão "status/list mostram aguardando dono (pergunta enviada há
 * X)" — formata um `waitedMs` num rótulo humano curto (min/h/dia). PURO.
 */
export function formatElapsedSince(waitedMs: number): string {
  if (waitedMs < 0) return '0min';
  const minutes = Math.floor(waitedMs / 60_000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
