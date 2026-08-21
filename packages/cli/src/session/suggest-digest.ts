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
//
// F199 (pedido do dono — autocompletar "inteligente", não frase padrão) — além dos
// booleanos, destilamos os FATOS que o core parametriza na frase (arquivo editado, nome
// do teste que falhou, comando que rodou, texto curto do erro). CLI-SEC-4/6: um fato vem
// de DADO do ambiente (target/output de tool, já redigido/truncado pelo PRODUTOR — ver
// model.ts) — mesmo assim `sanitizeFact` colapsa quebra de linha, REDIGE de novo (defesa
// em camada, idempotente) e capa o tamanho ANTES de entrar no digest; o core ainda aplica
// seu próprio clamp final (largura de composer) — nunca a saída crua de um comando vaza
// inteira numa sugestão.

import type { SessionBlock } from './model.js';
import type { TurnDigest } from '@hiperplano/aluy-cli-core';
import { redactOutputSecrets } from '@hiperplano/aluy-cli-core';

/** Verbos de tool que contam como EDIÇÃO/escrita de arquivo (não leitura). */
const EDIT_VERBS: ReadonlySet<string> = new Set(['edit', 'write', 'create']);
/** Verbos de tool que são só LEITURA/exploração (não mudam nada). */
const READ_VERBS: ReadonlySet<string> = new Set(['read', 'grep', 'glob', 'list', 'search']);

/** Teto de caracteres de um FATO ao entrar no digest — generoso (o core reclampa p/ a
 *  largura do composer); existe só p/ nunca guardar um blob inteiro de saída. */
const MAX_DIGEST_FACT_CHARS = 200;
/** Quantos nomes de arquivo editado o digest guarda no máximo (o core só mostra 2). */
const MAX_EDITED_NAMES_KEPT = 8;

/**
 * F199 — sane UM fato livre (nome de arquivo/comando/texto de erro) ANTES de entrar no
 * digest: colapsa quebra de linha (o composer é 1 linha), REDIGE segredo de novo
 * (`redactOutputSecrets`, CLI-SEC-6 — defesa em camada, idempotente: o produtor do bloco
 * já redige, isto não desfaz nem duplica o vazamento) e trunca. Vazio após trim ⇒ `''`
 * (o chamador decide se ignora). Pura.
 */
function sanitizeFact(raw: string): string {
  const oneLine = redactOutputSecrets(raw).replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DIGEST_FACT_CHARS
    ? `${oneLine.slice(0, MAX_DIGEST_FACT_CHARS - 1)}…`
    : oneLine;
}

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

  // F199 — FATOS (ver header). `editedNames` dedup preservando ordem; os demais são
  // "1º que aparece vence" (não sobrescreve depois de achado — o 1º é o mais relevante
  // p/ o passo seguinte).
  const editedNames: string[] = [];
  const seenEditedNames = new Set<string>();
  let testCommand: string | undefined;
  let failingTestName: string | undefined;
  let errorSummary: string | undefined;

  for (const b of turn) {
    switch (b.kind) {
      case 'tool': {
        const verb = b.verb.toLowerCase();
        if (EDIT_VERBS.has(verb) || b.added !== undefined || b.removed !== undefined) {
          editedFiles = true;
          const name = sanitizeFact(b.target);
          const isNew = name !== '' && !seenEditedNames.has(name);
          if (isNew && editedNames.length < MAX_EDITED_NAMES_KEPT) {
            seenEditedNames.add(name);
            editedNames.push(name);
          }
        }
        if (READ_VERBS.has(verb)) sawRead = true;
        // um `run_tests`/bash de teste conta como "rodou testes" (o bloco `testrun` é o
        // sinal forte, mas nem todo teste vira testrun — um bash `npm test` também vale).
        if (verb === 'test' || /\btest/.test(b.target.toLowerCase())) {
          ranTests = true;
          if (testCommand === undefined) testCommand = sanitizeFact(b.target);
        }
        if (b.status === 'err') {
          hadError = true;
          if (errorSummary === undefined) {
            const fact = sanitizeFact(b.output ?? b.result);
            if (fact !== '') errorSummary = fact;
          }
        }
        break;
      }
      case 'testrun': {
        ranTests = true;
        // placar com falhas E formato reconhecido ⇒ testes falharam de fato.
        if (!b.score.unknownFormat && b.score.failed > 0) {
          testsFailed = true;
          const first = b.score.failures[0]?.name;
          if (failingTestName === undefined && first !== undefined && first.trim() !== '') {
            failingTestName = sanitizeFact(first);
          }
        }
        break;
      }
      case 'deny':
        // a catraca NEGOU um efeito — trata como "bateu num obstáculo" (erro de percurso).
        // `errorSummary` guarda só o ALVO negado (dado, não frase — CLI-SEC-9: sem palavra
        // hardcoded aqui, a chave i18n do resolver já monta a frase em pt-BR/en).
        hadError = true;
        if (errorSummary === undefined && b.exact.trim() !== '') {
          errorSummary = sanitizeFact(b.exact);
        }
        break;
      case 'broker-error':
        hadError = true;
        if (errorSummary === undefined) {
          const fact = sanitizeFact(b.message);
          if (fact !== '') errorSummary = fact;
        }
        break;
      case 'bang': {
        // `!comando` de shell do usuário: `err`/`blocked` contam como tropeço. Só vira
        // fato quando há SAÍDA (dado); sem saída não inventamos texto (fallback genérico).
        if (b.status === 'err' || b.status === 'blocked') {
          hadError = true;
          if (errorSummary === undefined && b.output !== undefined && b.output.trim() !== '') {
            errorSummary = sanitizeFact(b.output);
          }
        }
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
    ...(editedNames.length > 0 ? { editedFileNames: editedNames } : {}),
    ...(testCommand !== undefined ? { testCommand } : {}),
    ...(failingTestName !== undefined ? { failingTestName } : {}),
    ...(errorSummary !== undefined ? { errorSummary } : {}),
  };
}
