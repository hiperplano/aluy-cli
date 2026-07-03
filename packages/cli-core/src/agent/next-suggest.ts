// F197 — SUGESTÃO DE PRÓXIMO PROMPT (estilo "suggested next steps" do Claude).
//
// Quando um turno TERMINA (idle) e o composer está VAZIO, a TUI mostra UMA sugestão
// dim (ghost) do que o dono poderia pedir A SEGUIR; Tab a aceita no próprio composer.
// ESTE módulo é o CÉREBRO da sugestão — mas PORTÁVEL (cli-core, sem Ink, sem I/O de
// terminal) e, sobretudo, SEM MODELO: é 100% HEURÍSTICO LOCAL sobre um DIGEST do turno.
//
// Por que heurística local (opção (c) do dono, NÃO a (a) via marcador no protocolo):
//   • CUSTO ZERO DE TOKEN. O dono traz o próprio tokenrouter (BYO) — não gastamos a
//     credencial dele com uma chamada extra após CADA turno, nem inflamos o turno normal
//     pedindo ao modelo "3 próximos passos" (marcador no protocolo de saída). A opção (a)
//     existiria, mas paga tokens (o texto das sugestões conta na saída) e depende do
//     modelo cooperar/formatar — frágil e não-determinístico. A (c) é grátis e testável.
//   • DETERMINÍSTICA. Mesma entrada ⇒ mesma sugestão (anti-flicker EST-0965: a sugestão
//     é estado DERIVADO estável, não um redesenho por token).
//   • PORTÁVEL. Vive no core (fronteira modular do CLAUDE.md): nenhuma dependência de UI.
//
// Contrato: o módulo NÃO devolve TEXTO (isso é UI/i18n, mora no `packages/cli`) — devolve
// IDENTIFICADORES semânticos (`NextSuggestionId`). Quem tem o i18n (a TUI) mapeia o id p/
// a frase localizada que vira o texto do composer ao aceitar. Assim o core fica sem string
// de idioma e a TUI escolhe pt-BR/en. (Mesma disciplina do resto do i18n do CLI.)

/**
 * F197 — DIGEST do turno recém-terminado: os poucos FATOS de que a heurística precisa,
 * já extraídos dos blocos da sessão pela TUI (o core não conhece `SessionBlock` — isso
 * cruzaria a fronteira). Tudo opcional/boolean p/ o chamador montar o que souber; campos
 * ausentes contam como "não aconteceu". PURO (sem efeito, sem I/O).
 */
export interface TurnDigest {
  /** Houve conversa DE FATO (o usuário pediu algo E o agente respondeu)? Sem isto
   *  (ex.: boot, sessão fresca) não sugerimos nada — não há contexto p/ um próximo passo. */
  readonly hasConversation: boolean;
  /** O agente EDITOU/criou arquivos neste turno (tool `edit`/`write`/`create`)? */
  readonly editedFiles?: boolean;
  /** Rodou testes (bloco `testrun` ou um `run_tests`/bash de teste)? */
  readonly ranTests?: boolean;
  /** Os testes que rodaram FALHARAM (placar com `failed > 0`)? */
  readonly testsFailed?: boolean;
  /** O turno bateu em ERRO (broker-error, tool `err`, ou deny da catraca)? */
  readonly hadError?: boolean;
  /** Só EXPLOROU (leu/buscou) sem editar nada — read/grep/glob/list e nada de escrita? */
  readonly explorationOnly?: boolean;
}

/**
 * F197 — os IDs de sugestão que o core sabe propor. A TUI (i18n) traduz cada um p/ a
 * FRASE que vira o texto do composer. Nomes estáveis (chave i18n `suggest.<camelCase>`):
 *   • `run-tests`      — "rode os testes e me mostre o resultado"
 *   • `fix-failing`    — "investigue e corrija os testes que falharam"
 *   • `summarize`      — "resuma o que mudou neste turno"
 *   • `retry-different`— "tente outra abordagem para resolver isso"
 *   • `implement`      — "implemente a mudança que discutimos"
 *   • `explain`        — "explique o que você fez e por quê"
 *   • `next-step`      — "o que devo revisar ou fazer a seguir?" (fallback genérico)
 */
export type NextSuggestionId =
  | 'run-tests'
  | 'fix-failing'
  | 'summarize'
  | 'retry-different'
  | 'implement'
  | 'explain'
  | 'next-step';

/** Opções da geração. `max` capa quantos ids devolver (default 3, estilo "next steps"). */
export interface SuggestOptions {
  readonly max?: number;
}

/**
 * F197 — deriva uma LISTA ORDENADA (mais relevante primeiro) de próximos passos a partir
 * do digest. A TUI hoje mostra SÓ o 1º como ghost, mas devolvemos até `max` (a lista já
 * nasce priorizada p/ um futuro "suggested next steps" com várias). Deduplica preservando
 * a ordem e capa em `max`. Sem conversa ⇒ lista VAZIA (não há o que sugerir). PURO.
 *
 * Regras (a 1ª que casa DITA o topo; as demais entram como alternativas na cauda):
 *   1) testes FALHARAM              ⇒ corrigir as falhas (o passo óbvio) · depois explicar.
 *   2) editou E não rodou testes    ⇒ RODAR os testes (validar) · depois resumir.
 *   3) editou E testes PASSARAM      ⇒ resumir o que mudou · (rodar de novo como alt).
 *   4) ERRO sem edição              ⇒ tentar OUTRA abordagem · explicar o que houve.
 *   5) só explorou (leu/buscou)      ⇒ IMPLEMENTAR o que se discutiu · resumir o achado.
 *   6) fallback                     ⇒ próximo passo genérico · resumir.
 */
export function suggestNextPrompts(
  digest: TurnDigest,
  opts?: SuggestOptions,
): readonly NextSuggestionId[] {
  const max = Math.max(1, opts?.max ?? 3);
  if (!digest.hasConversation) return [];

  const edited = digest.editedFiles === true;
  const ranTests = digest.ranTests === true;
  const testsFailed = digest.testsFailed === true;
  const hadError = digest.hadError === true;
  const exploration = digest.explorationOnly === true;

  let ordered: NextSuggestionId[];
  if (ranTests && testsFailed) {
    // 1) O passo mais óbvio depois de um teste vermelho é consertar; explicar como alt.
    ordered = ['fix-failing', 'explain', 'summarize'];
  } else if (edited && !ranTests) {
    // 2) Editou mas não validou: propor RODAR os testes é o hábito que queremos reforçar.
    ordered = ['run-tests', 'summarize', 'explain'];
  } else if (edited && ranTests) {
    // 3) Editou e passou (verde): fechar com um resumo do que mudou; re-rodar como alt.
    ordered = ['summarize', 'run-tests', 'explain'];
  } else if (hadError) {
    // 4) Erro sem ter editado nada: sugerir outra abordagem; explicar o ocorrido.
    ordered = ['retry-different', 'explain', 'summarize'];
  } else if (exploration) {
    // 5) Só leu/buscou (levantamento): o próximo passo natural é APLICAR a mudança.
    ordered = ['implement', 'summarize', 'explain'];
  } else {
    // 6) Nada característico: um próximo passo genérico + um resumo.
    ordered = ['next-step', 'summarize'];
  }

  // Deduplica preservando a ordem (defensivo — as listas acima já são únicas) e capa.
  const seen = new Set<NextSuggestionId>();
  const out: NextSuggestionId[] = [];
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}
