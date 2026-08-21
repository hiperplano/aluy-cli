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
//
// F199 (pedido do dono — "quero que o autocompletar seja inteligente, hoje me parece que
// são frases padrão") — ele tinha razão: as 7 frases eram FIXAS, a sugestão nunca sabia
// QUAIS arquivos foram tocados, QUAL teste falhou nem QUAL erro aconteceu. `TurnDigest`
// ganha FATOS opcionais (nomes de arquivo, comando, nome do teste, texto curto do erro) e
// `suggestionParams` (abaixo) extrai deles um mapa id→params PARA INTERPOLAR na frase i18n
// (`t(key, params)` já existe — `{test}`/`{command}`/`{files}`/`{error}`). O contrato acima
// SEGUE de pé: `suggestionParams` devolve DADO (nomes/comandos, já clampados/redigidos —
// nunca gramática de idioma tipo "e"/"and"), não frase. Sem o fato específico ⇒ `undefined`
// ⇒ o resolver (packages/cli) cai na frase genérica de sempre (não regride).

import { redactOutputSecrets } from './journal/redact.js';

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

  // ── F199 — FATOS do turno (o QUÊ, não só o SE). Todos opcionais/livres p/ o chamador
  //    montar o que souber; ausentes ⇒ a sugestão correspondente cai no genérico. O
  //    chamador (buildTurnDigest, packages/cli) já deve entregar STRINGS CURTAS e SANEADAS
  //    (sem quebra de linha, sem segredo) — `suggestionParams` ainda assim reclampa/redige
  //    em profundidade (defesa em camada, mesma filosofia de CLI-SEC-6 no resto do repo). ──

  /** Nomes dos arquivos EDITADOS/criados neste turno, na ordem em que apareceram, sem
   *  repetir. Alimenta "revise as mudanças em `<arquivo>`". */
  readonly editedFileNames?: readonly string[];
  /** Nome do teste/suite que FALHOU (a 1ª falha do placar). Alimenta "investigue por que
   *  `<teste>` falhou". */
  readonly failingTestName?: string;
  /** O comando que RODOU os testes neste turno (só existe quando `ranTests`). Alimenta
   *  "rode `<comando>` de novo". */
  readonly testCommand?: string;
  /** Texto CURTO do erro do turno (quando `hadError` sem edição) — já truncado pelo
   *  chamador; NUNCA a saída crua/inteira de um comando. Alimenta "tente outra abordagem
   *  — o erro foi `<erro>`". */
  readonly errorSummary?: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// F199 — PARAMETRIZAÇÃO: id + digest → params p/ interpolar na frase i18n (`t(key,
// params)`, que já resolve `{nome}` — ver packages/cli/src/i18n/translate.ts). O core
// devolve DADO (nomes/comandos já clampados p/ 1 linha, nunca frase/gramática de
// idioma); quem escolhe a chave i18n "nomeada" vs. a genérica é o resolver (packages/
// cli/src/session/suggest.ts), que só tem a chave nomeada p/ os 4 ids abaixo — os
// demais (`explain`/`implement`/`next-step`) seguem 100% genéricos.
// ─────────────────────────────────────────────────────────────────────────────

/** Params prontos p/ `t(key, params)` — sempre string (mesmo tipo de `I18nParams`). */
export type SuggestionParams = Readonly<Record<string, string>>;

/** Teto de caracteres de UM fato interpolado (nome/comando/erro) — o composer é UMA
 *  linha; um fato longo não pode estourar a frase inteira. */
const MAX_FACT_CHARS = 40;
/** Teto por NOME de arquivo quando há mais de um (a frase soma vários fatos). */
const MAX_FILE_CHARS = 24;
/** Quantos nomes de arquivo entram por extenso antes de parar de listar (sem "e mais
 *  N" — isso seria gramática/idioma; silenciosamente não enumera o resto). */
const MAX_FILES_SHOWN = 2;

/**
 * Sane um FATO livre (nome/comando/texto de erro) antes de virar param: colapsa
 * quebras de linha (o composer é 1 linha), redige segredo (`redactOutputSecrets`,
 * CLI-SEC-6 — defesa EM CAMADA: o produtor da saída já redige, mas um fato pode vir
 * de um chamador que não passou por lá) e trunca em `max` chars com reticências.
 * Pura, determinística, idempotente (chamar 2× não muda o resultado).
 */
function clampFact(raw: string, max: number = MAX_FACT_CHARS): string {
  const oneLine = redactOutputSecrets(raw).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Junta nomes de arquivo p/ a frase de review: até `MAX_FILES_SHOWN` por extenso,
 * separados por ", " (separador NEUTRO de lista, não palavra de idioma — por isso
 * pode viver aqui no core). Cada nome é clampado antes. Vazio ⇒ `undefined` (sem
 * fato, quem chama cai no genérico).
 */
function joinFileNames(names: readonly string[]): string | undefined {
  const nonEmpty = names.map((n) => n.trim()).filter((n) => n.length > 0);
  if (nonEmpty.length === 0) return undefined;
  return nonEmpty
    .slice(0, MAX_FILES_SHOWN)
    .map((n) => clampFact(n, MAX_FILE_CHARS))
    .join(', ');
}

/**
 * F199 — deriva os PARAMS de interpolação p/ a sugestão de TOPO `id`, a partir dos
 * FATOS do `digest`. `undefined` quando não há fato específico p/ aquele id (id sem
 * parametrização, ou fato ausente) — o resolver então usa a frase genérica de sempre
 * (não regride). PURA/determinística; não lança.
 */
export function suggestionParams(
  id: NextSuggestionId,
  digest: TurnDigest,
): SuggestionParams | undefined {
  switch (id) {
    case 'fix-failing': {
      const test = digest.failingTestName;
      return test !== undefined && test.trim() !== '' ? { test: clampFact(test) } : undefined;
    }
    case 'run-tests': {
      const command = digest.testCommand;
      return command !== undefined && command.trim() !== ''
        ? { command: clampFact(command) }
        : undefined;
    }
    case 'summarize': {
      const files = digest.editedFileNames;
      if (files === undefined) return undefined;
      const joined = joinFileNames(files);
      return joined !== undefined ? { files: joined } : undefined;
    }
    case 'retry-different': {
      const error = digest.errorSummary;
      return error !== undefined && error.trim() !== '' ? { error: clampFact(error) } : undefined;
    }
    default:
      return undefined;
  }
}
