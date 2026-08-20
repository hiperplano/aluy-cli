// F197 — RESOLVER da sugestão de próximo prompt: blocos + i18n → TEXTO do composer.
//
// Junta as três peças da feature:
//   1) `buildTurnDigest` (suggest-digest.ts) — blocos da sessão → fatos (TurnDigest);
//   2) `suggestNextPrompts` (core, portável)  — fatos → ids ordenados (NextSuggestionId);
//   3) o i18n (aqui)                          — id do topo → FRASE localizada (o texto que
//      vira o composer ao aceitar com Tab).
//
// A separação mantém o CÉREBRO (heurística) no core sem string de idioma, e o TEXTO na
// TUI (i18n). Este resolver é a cola fina e PURA (recebe o `t`; nada de React/Ink) — dá
// p/ testar o fluxo inteiro sem TTY.

import type { SessionBlock } from './model.js';
import type { NextSuggestionId } from '@hiperplano/aluy-cli-core';
import { suggestNextPrompts, suggestionParams } from '@hiperplano/aluy-cli-core';
import type { I18nKey, TFunction } from '../i18n/index.js';
import { buildTurnDigest } from './suggest-digest.js';

/**
 * F197 — mapa id do core → chave i18n GENÉRICA (fallback, sempre disponível). Fonte ÚNICA
 * da correspondência (o core não conhece chaves i18n; a TUI não conhece a heurística).
 * `Record` COMPLETO ⇒ o compilador exige uma chave p/ cada `NextSuggestionId` novo (não dá
 * p/ esquecer a tradução).
 */
const SUGGESTION_KEY: Readonly<Record<NextSuggestionId, I18nKey>> = {
  'run-tests': 'suggest.runTests',
  'fix-failing': 'suggest.fixFailing',
  summarize: 'suggest.summarize',
  'retry-different': 'suggest.retryDifferent',
  implement: 'suggest.implement',
  explain: 'suggest.explain',
  'next-step': 'suggest.nextStep',
};

/**
 * F199 — mapa id → chave i18n PARAMETRIZADA. PARCIAL de propósito: só os ids que o core
 * (`suggestionParams`) sabe alimentar com um FATO (arquivo/teste/comando/erro) têm uma
 * entrada aqui; os demais (`implement`/`explain`/`next-step`) seguem só na genérica acima.
 * Usada só quando `suggestionParams` devolve algo (senão cai na genérica — não regride).
 */
const SUGGESTION_KEY_NAMED: Readonly<Partial<Record<NextSuggestionId, I18nKey>>> = {
  'run-tests': 'suggest.runTestsNamed',
  'fix-failing': 'suggest.fixFailingNamed',
  summarize: 'suggest.summarizeNamed',
  'retry-different': 'suggest.retryDifferentNamed',
};

/**
 * F197/F199 — devolve o TEXTO da sugestão de TOPO p/ os blocos dados, já localizado, ou
 * `undefined` quando não há o que sugerir (sem conversa: boot/sessão fresca). É o que a
 * App grava no composer (ghost + Tab). Quando o digest tem o FATO específico do turno
 * (arquivo editado/teste que falhou/comando/erro), o texto vem da chave PARAMETRIZADA
 * (`suggest.*Named`) com o fato interpolado; sem fato, cai na frase genérica de sempre
 * (comportamento de hoje — não regride). PURO — determinístico p/ os mesmos blocos+idioma.
 */
export function resolveSuggestionText(
  blocks: readonly SessionBlock[],
  t: TFunction,
): string | undefined {
  const digest = buildTurnDigest(blocks);
  const ids = suggestNextPrompts(digest, { max: 1 });
  const top = ids[0];
  if (top === undefined) return undefined;
  const params = suggestionParams(top, digest);
  const namedKey = params !== undefined ? SUGGESTION_KEY_NAMED[top] : undefined;
  if (namedKey !== undefined) return t(namedKey, params);
  return t(SUGGESTION_KEY[top]);
}
