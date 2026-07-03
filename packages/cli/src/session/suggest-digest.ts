// F197 — DIGEST do turno p/ a sugestão de próximo prompt (ponte blocos → heurística).
//
// A heurística de sugestão vive no core (`suggestNextPrompts`, PORTÁVEL, sem Ink) e
// consome um `TurnDigest` — poucos FATOS booleanos. O core NÃO conhece `SessionBlock`
// (isso cruzaria a fronteira modular do CLAUDE.md), então é AQUI (na TUI) que lemos os
// blocos da sessão e destilamos o digest. Função PURA e testável sem TTY: recebe os
// blocos, devolve o digest — nada de React/Ink.
//
// "Do turno" = varremos os blocos do ÚLTIMO turno: da ÚLTIMA fala do usuário (`you`) até
// o fim. Antes disso é história de turnos anteriores — não deve enviesar o próximo passo
// (ex.: um erro de 3 turnos atrás não deve sugerir "tente outra abordagem" agora).

import type { SessionBlock } from './model.js';
import type { TurnDigest } from '@hiperplano/aluy-cli-core';

/** Verbos de tool que contam como EDIÇÃO/escrita de arquivo (não leitura). */
const EDIT_VERBS: ReadonlySet<string> = new Set(['edit', 'write', 'create']);
/** Verbos de tool que são só LEITURA/exploração (não mudam nada). */
const READ_VERBS: ReadonlySet<string> = new Set(['read', 'grep', 'glob', 'list', 'search']);

/**
 * F197 — recorta os blocos do ÚLTIMO turno: do índice da ÚLTIMA fala do usuário (`you`)
 * em diante. Sem nenhuma fala do usuário ⇒ devolve tudo (degrada; o gate `hasConversation`
 * ainda barra o boot). PURO.
 */
function lastTurnBlocks(blocks: readonly SessionBlock[]): readonly SessionBlock[] {
  let start = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.kind === 'you') {
      start = i;
      break;
    }
  }
  return start >= 0 ? blocks.slice(start) : blocks;
}

/**
 * F197 — destila o `TurnDigest` a partir dos blocos da sessão. Olha SÓ o último turno
 * (ver `lastTurnBlocks`) p/ os sinais de edição/teste/erro/exploração, mas usa a sessão
 * INTEIRA p/ decidir `hasConversation` (houve um par pergunta→resposta em algum momento).
 * PURO — sem efeito, sem I/O; determinístico.
 */
export function buildTurnDigest(blocks: readonly SessionBlock[]): TurnDigest {
  // hasConversation: existe ao menos uma fala do usuário E uma do agente na sessão. Sem
  // isso (boot/sessão fresca) não há contexto p/ um "próximo passo" — não sugerimos nada.
  const hasUser = blocks.some((b) => b.kind === 'you');
  const hasAluy = blocks.some((b) => b.kind === 'aluy');
  const hasConversation = hasUser && hasAluy;

  const turn = lastTurnBlocks(blocks);

  let editedFiles = false;
  let ranTests = false;
  let testsFailed = false;
  let hadError = false;
  let sawRead = false;

  for (const b of turn) {
    switch (b.kind) {
      case 'tool': {
        const verb = b.verb.toLowerCase();
        if (EDIT_VERBS.has(verb) || b.added !== undefined || b.removed !== undefined) {
          editedFiles = true;
        }
        if (READ_VERBS.has(verb)) sawRead = true;
        // um `run_tests`/bash de teste conta como "rodou testes" (o bloco `testrun` é o
        // sinal forte, mas nem todo teste vira testrun — um bash `npm test` também vale).
        if (verb === 'test' || /\btest/.test(b.target.toLowerCase())) ranTests = true;
        if (b.status === 'err') hadError = true;
        break;
      }
      case 'testrun': {
        ranTests = true;
        // placar com falhas E formato reconhecido ⇒ testes falharam de fato.
        if (!b.score.unknownFormat && b.score.failed > 0) testsFailed = true;
        break;
      }
      case 'deny':
        // a catraca NEGOU um efeito — trata como "bateu num obstáculo" (erro de percurso).
        hadError = true;
        break;
      case 'broker-error':
        hadError = true;
        break;
      case 'bang': {
        // `!comando` de shell do usuário: `err`/`blocked` contam como tropeço.
        if (b.status === 'err' || b.status === 'blocked') hadError = true;
        break;
      }
      default:
        break;
    }
  }

  // Testes que falharam ALSO implicam erro (p/ a heurística não classificar como "verde").
  if (testsFailed) hadError = true;

  // explorationOnly: leu/buscou algo e NÃO editou nada (levantamento puro). Só faz sentido
  // como sinal quando de fato houve leitura — senão é um turno de conversa sem tools.
  const explorationOnly = sawRead && !editedFiles;

  return {
    hasConversation,
    editedFiles,
    ranTests,
    testsFailed,
    hadError,
    explorationOnly,
  };
}
