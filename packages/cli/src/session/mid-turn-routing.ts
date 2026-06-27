// EST-1015 — ROTEAMENTO mid-turn quando o PAI está BLOQUEADO esperando sub-agentes.
//
// Bug do dono (dogfood): "tenho agentes rodando e o orquestrador não tá fazendo nada, só
// esperando os agentes terminarem; eu nem precisaria usar o /ask, ele já deveria me responder
// sem enfileirar". Hoje uma linha de TEXTO PURO com Enter durante o trabalho é INJETADA no
// pai (`injectInput`) — mas o pai está BLOQUEADO no `spawn_agent` aguardando os filhos, então
// só DRENA o inject na PRÓXIMA iteração (= DEPOIS que os sub-agentes terminam). A pergunta
// "como está?" fica pendurada até lá (o "enfileirar" reportado).
//
// DECISÃO: com sub-agentes RODANDO, uma linha de TEXTO PURO (sem `@`-anexo) com ENTER vira
// RESPOSTA PARALELA (`askParallel` — read-only, com o estado VIVO dos sub-agentes, EST-1015/
// ADR-0080) — respondida JÁ, sem o usuário precisar do `/ask`. O Ctrl+Enter (injectInput
// EXPLÍCITO) segue disponível p/ INJETAR uma instrução no contexto do pai. Assim os dois
// casos coexistem: PERGUNTA (Enter ⇒ resposta paralela) vs INSTRUÇÃO (Ctrl+Enter ⇒ injeta).
//
// PURO/testável: recebe só SINAIS booleanos (não acopla à localização de `subAgentsRunning`
// nem ao `routeInput`/`parseAtMentions` — o caller no App os computa e passa o resultado).

/** Sinais p/ decidir o roteamento mid-turn de uma linha quando há sub-agentes rodando. */
export interface MidTurnRouteInputs {
  /** Há sub-agentes RODANDO agora? (o pai está bloqueado os aguardando) */
  readonly subagentsRunning: boolean;
  /** A linha é TEXTO PURO (rota `goal`), não `/slash` nem `!bang`? */
  readonly isPlainGoal: boolean;
  /** O texto (da rota `goal`) é NÃO-VAZIO? */
  readonly nonEmpty: boolean;
  /** Há anexo `@` PENDENTE — chip confirmado OU `@mention` literal no texto? */
  readonly hasPendingAttachment: boolean;
}

/**
 * `true` ⇒ a linha deve ser RESPONDIDA EM PARALELO (`askParallel`) em vez de injetada/
 * enfileirada. Só quando: há sub-agentes rodando E é texto puro não-vazio E SEM anexo `@`
 * pendente (anexo precisa viajar como DADO pelo `submit`, não cabe numa pergunta read-only).
 * `false` ⇒ o caller segue o caminho normal (encaixe mid-turn / enfileirar).
 */
export function answerInParallelWhileSubagents(args: MidTurnRouteInputs): boolean {
  return args.subagentsRunning && args.isPlainGoal && args.nonEmpty && !args.hasPendingAttachment;
}
