// F197-LLM (pedido do dono, 21/09/2026: "quero que o next suggest seja dinâmico") — a
// sugestão de próximo prompt passa a poder vir do MODELO, em vez de sair de um menu fixo.
//
// POR QUE MUDOU. O `next-suggest.ts` escolhe um `NextSuggestionId` entre SETE, e a TUI o
// traduz por i18n. O menu inteiro:
//
//   run-tests · fix-failing · summarize · retry-different · implement · explain · next-step
//
// O dono reportou "coisas nonsense", com print: depois de um turno que auditou UX, rodou
// build e gerou relatório, a sugestão foi "rode os testes e me mostre o resultado". Não é
// frase malformada — é a frase CERTA para outro momento. Com sete opções fixas, a maioria
// dos turnos recebe uma que não encaixa, e o acerto é coincidência.
//
// O QUE ISTO CUSTA, e foi aceito explicitamente pelo dono. O cabeçalho do `next-suggest.ts`
// registra a decisão CONTRÁRIA (opção (c), heurística local) por três razões, e todas
// seguem verdadeiras — só deixaram de ser decisivas:
//   • CUSTO. Passa a gastar token do provider BYO a cada turno. Mitigado: o prompt leva um
//     DIGEST (recap + objetivo), nunca o histórico — a chamada é de dezenas de tokens, não
//     de milhares, e é o motivo de este módulo NÃO reusar `runSideQuery` (que injeta o
//     snapshot inteiro: numa sessão de 6.6M tokens isso seria absurdo para uma linha).
//   • DETERMINISMO. Some. Mitigado por cache do chamador: uma sugestão por turno.
//   • PORTABILIDADE. Preservada AQUI: este módulo é PURO + uma porta injetada. Sem rede,
//     sem Ink, sem Node. O concreto vive no `cli`, como o `JudgeEngine`.
//
// FALLBACK É OBRIGATÓRIO, e não é detalhe: falha, timeout ou resposta suja ⇒ o chamador cai
// nas sete frases. Elas são o incômodo que originou a mudança, mas sugestão enlatada é
// melhor que sugestão vazia quando a rede cai.
//
// SEGURANÇA. O texto sugerido entra no COMPOSER do dono (Tab aceita; o Enter ainda é dele —
// verificado: a TUI só sugere com composer e fila de type-ahead VAZIOS, então não há
// caminho de auto-submissão). Ainda assim, com o menu fechado não havia como conteúdo lido
// no turno propor uma ação; com texto livre, há. Por isso `sanitizeSuggestion` é o ponto
// único e obrigatório: uma linha, teto de chars, sem markdown/cerca/aspas envolventes.
// Ele NÃO julga a intenção do texto — julgar "sugestão perigosa" seria um classificador que
// não temos; o que temos é a garantia de que o dono LÊ antes de enviar.
import type { ChatMessage, ModelCallResult } from '../model/types.js';

/** Teto de caracteres da sugestão — ela vive numa linha do composer, não num parágrafo. */
export const MAX_SUGESTAO_CHARS = 120;

/**
 * O caller do modelo SEM tools (read-only). Mesma forma do `SideQueryCaller` de propósito:
 * é o contrato que o `cli` já sabe montar, e reusá-lo evita uma segunda porta equivalente.
 */
export interface SuggestCaller {
  call(args: {
    readonly messages: readonly ChatMessage[];
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ModelCallResult>;
}

/** O que o modelo precisa saber para sugerir — e nada além. */
export interface SuggestInput {
  /** O recap do turno (`editou X · rodou npm test · 1 falhou`), quando houver. */
  readonly recap?: string;
  /** O último objetivo que o dono pediu, já curto e saneado pelo chamador. */
  readonly lastGoal?: string;
  /** Idioma da sessão — a resposta sai nele (texto livre não passa pelo i18n). */
  readonly lang: string;
}

/** Porta: digest → uma linha, ou `undefined` quando não deu (o chamador cai no fallback). */
export interface SuggestEngine {
  suggest(input: SuggestInput, signal?: AbortSignal): Promise<string | undefined>;
}

const INSTRUCAO_PT = [
  'Você sugere o PRÓXIMO PEDIDO que a pessoa faria a um agente de terminal.',
  'Responda com UMA frase curta, no imperativo, como se fosse a pessoa falando com o agente.',
  'Sem aspas, sem markdown, sem explicação, sem alternativas — só a frase.',
  'Se não houver um próximo passo óbvio, responda exatamente: NADA',
].join(' ');

const INSTRUCAO_EN = [
  'You suggest the NEXT REQUEST a person would make to a terminal agent.',
  'Answer with ONE short imperative sentence, as if the person were talking to the agent.',
  'No quotes, no markdown, no explanation, no alternatives — just the sentence.',
  'If there is no obvious next step, answer exactly: NADA',
].join(' ');

/**
 * PURO — as mensagens da chamada. Deliberadamente minúsculo: recap + objetivo, nunca o
 * histórico. É o que torna a chamada barata o bastante para rodar a cada turno.
 */
export function buildSuggestMessages(input: SuggestInput): readonly ChatMessage[] {
  const en = input.lang.toLowerCase().startsWith('en');
  const contexto: string[] = [];
  if (input.lastGoal) contexto.push(`${en ? 'They asked' : 'A pessoa pediu'}: ${input.lastGoal}`);
  if (input.recap) contexto.push(`${en ? 'The agent did' : 'O agente fez'}: ${input.recap}`);
  if (contexto.length === 0) return [];
  return [
    { role: 'system', content: en ? INSTRUCAO_EN : INSTRUCAO_PT },
    { role: 'user', content: contexto.join('\n') },
  ];
}

/**
 * PURO — dobra a resposta do modelo numa linha usável, ou `undefined`.
 *
 * Ponto ÚNICO de saneamento (o módulo inteiro depende dele): o texto vai para o composer
 * do dono, e um modelo devolve o que quiser — cerca de código, várias linhas, um preâmbulo
 * ("Claro! Você poderia…"), aspas envolventes. Nada disso pode chegar ao campo de digitação.
 */
export function sanitizeSuggestion(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let s = raw.trim();
  if (s === '') return undefined;
  // Cerca de código inteira ⇒ fica só o miolo.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  // PRIMEIRA linha não-vazia: um modelo tagarela lista alternativas; queremos uma.
  const primeira = s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (primeira === undefined) return undefined;
  s = primeira;
  // Marcador de lista (`- `, `1. `, `• `) e aspas/crases envolventes.
  s = s.replace(/^([-*•]|\d+[.)])\s+/, '').trim();
  s = s.replace(/^["'`«]+/, '').replace(/["'`»]+$/, '').trim();
  if (s === '') return undefined;
  // O "sem próximo passo" combinado no prompt — em qualquer caixa, com ou sem pontuação.
  if (/^nada[.!]?$/i.test(s)) return undefined;
  return s.length <= MAX_SUGESTAO_CHARS ? s : `${s.slice(0, MAX_SUGESTAO_CHARS - 1)}…`;
}

/**
 * Cria o engine sobre um caller injetado. Fica no core porque NÃO faz I/O: quem sabe falar
 * com o provider é o caller, montado no `cli`. Qualquer erro vira `undefined` — este
 * caminho é ornamento, e ornamento jamais derruba nem atrasa o turno.
 */
export function createSuggestEngine(caller: SuggestCaller): SuggestEngine {
  return {
    async suggest(input, signal): Promise<string | undefined> {
      const messages = buildSuggestMessages(input);
      if (messages.length === 0) return undefined;
      try {
        const r = await caller.call({
          messages,
          idempotencyKey: `suggest-${Date.now()}`,
          ...(signal ? { signal } : {}),
        });
        return sanitizeSuggestion(typeof r.content === 'string' ? r.content : undefined);
      } catch {
        return undefined;
      }
    },
  };
}
