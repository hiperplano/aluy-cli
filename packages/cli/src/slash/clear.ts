// EST-0983 · CLI-SEC-15 — o comando `/clear` e seus subcomandos.
//
// O pedido do Tiago: "/clear não deveria limpar toda a memória, só a sessão atual;
// um /clear full sim". Então:
//   /clear            → SESSÃO: zera o contexto da conversa (controller.clear) — a
//                       memória fica INTACTA. É o comportamento certo, INALTERADO.
//   /clear memory     → MEMÓRIA: apaga os fatos da memória (global + projeto), sem
//                       mexer no contexto da sessão. DESTRUTIVO ⇒ confirmação.
//   /clear full       → SESSÃO + MEMÓRIA: o "limpar tudo" — zera o contexto E apaga a
//                       memória (global + projeto). DESTRUTIVO ⇒ confirmação.
//
// ESCOPO DECIDIDO (documentado p/ o usuário, ver `confirmLines`): `full`/`memory`
// apagam SÓ a MEMÓRIA de agente (`~/.aluy/memory/` + `<ws>/.aluy/memory/`). NÃO
// tocam as SESSÕES SALVAS (`~/.aluy/sessions/`) nem o journal de UNDO (`~/.aluy/undo/`)
// — esses são histórico RECUPERÁVEL e ficam de fora de propósito (apagar a memória já
// é o "full" pedido). O `/clear` puro segue sem confirmação (não destrói nada
// permanente — só o contexto vivo).
//
// CONFIRMAÇÃO (destrutivo + IRREVERSÍVEL, CA): a 1ª invocação de `/clear full|memory`
// não apaga nada — ARMA a confirmação e mostra "isto APAGA N fatos… confirme repetindo
// `/clear full`". A 2ª invocação CONSECUTIVA (com a confirmação armada) executa. Reusa a
// MESMA mecânica do `/undo` (2ª invocação confirma — provada, testável sem key-prompt,
// funciona no TTY e no não-TTY). `/clear cancelar` (ou qualquer outro comando) desarma.
//
// O `clearAll` da memória é AÇÃO DO USUÁRIO (via este slash) — NUNCA uma tool: o agente
// não tem caminho até aqui (slash não é tool; a path-deny de `~/.aluy/memory/` é mantida).

import type { AgentMemory } from '@aluy/cli-core';
import type { SlashNote } from './handlers.js';

/** O subcomando parseado de `/clear <args>`. */
export type ClearCommand =
  | { readonly kind: 'session' } // `/clear` puro — só a sessão (NÃO destrutivo).
  | { readonly kind: 'memory' } // `/clear memory` — só a memória (destrutivo).
  | { readonly kind: 'full' } // `/clear full` — sessão + memória (destrutivo).
  | { readonly kind: 'cancel' } // `/clear cancelar` — desarma uma confirmação pendente.
  | { readonly kind: 'help'; readonly reason: string };

/** `true` se o subcomando APAGA a memória (⇒ exige confirmação). */
export function isDestructiveClear(cmd: ClearCommand): boolean {
  return cmd.kind === 'memory' || cmd.kind === 'full';
}

/** Qual verbo destrutivo de `/clear` está ARMADO p/ confirmar na próxima invocação. */
export type ClearArmedVerb = 'full' | 'memory' | undefined;

/**
 * HUNT-SLASH — decide a transição da CONFIRMAÇÃO de 2 passos do `/clear` destrutivo,
 * dado o verbo ATUALMENTE armado (de uma invocação anterior) e o comando corrente. A
 * confirmação de `/clear full|memory` só vale p/ a invocação SEGUINTE do MESMO verbo.
 *
 * O caller (run.tsx) guardava só um BOOLEANO `armed`, sem checar QUAL verbo armou. Com
 * isso, armar `/clear memory` e repetir `/clear full` executava o `full` (mais amplo: o
 * `full` também zera a SESSÃO) com a confirmação que o usuário deu p/ o `memory` — um
 * bypass da confirmação de uma ação destrutiva mais ampla. Esta função torna a regra
 * explícita e testável:
 *
 *  - `armed`: `true` SÓ se o comando atual é destrutivo E o verbo armado é EXATAMENTE
 *    ele. É o valor a passar p/ `runClearCommand` (a 2ª invocação consecutiva confirma).
 *  - `nextArmed`: o novo verbo pendente APÓS rodar. Não-destrutivo (ou já confirmado)
 *    ⇒ `undefined` (desarma). Destrutivo NÃO confirmado nesta vez ⇒ ele mesmo (re-arma).
 *
 * Repetir um destrutivo DIFERENTE do armado NÃO confirma: `armed=false` (só pede a
 * confirmação do novo verbo) e `nextArmed` passa a ser o novo verbo.
 */
export function clearArmTransition(
  currentArmed: ClearArmedVerb,
  cmd: ClearCommand,
): { readonly armed: boolean; readonly nextArmed: ClearArmedVerb } {
  if (cmd.kind !== 'full' && cmd.kind !== 'memory') {
    // Não-destrutivo (session/cancel/help) ⇒ nunca confirma, sempre DESARMA.
    return { armed: false, nextArmed: undefined };
  }
  const armed = currentArmed === cmd.kind;
  // Se já estava armado p/ ESTE verbo ⇒ esta invocação CONFIRMA e executa ⇒ desarma.
  // Senão ⇒ esta invocação PEDE a confirmação deste verbo ⇒ arma este verbo.
  return { armed, nextArmed: armed ? undefined : cmd.kind };
}

/**
 * Roteia `/clear <args>`. PURO/determinístico, sem I/O. Args vazio ⇒ `session` (o
 * comportamento histórico INALTERADO). `full`/`memory` ⇒ os destrutivos. `cancelar`/
 * `cancel` ⇒ desarma. Subcomando desconhecido ⇒ `help` (sem apagar nada — seguro).
 */
export function parseClearCommand(args: string): ClearCommand {
  const verb = args.trim().toLowerCase();
  if (verb === '') return { kind: 'session' };
  if (verb === 'full' || verb === 'tudo') return { kind: 'full' };
  if (verb === 'memory' || verb === 'memória' || verb === 'memoria') return { kind: 'memory' };
  if (verb === 'cancelar' || verb === 'cancel') return { kind: 'cancel' };
  return { kind: 'help', reason: `subcomando desconhecido: "${verb}".` };
}

const HELP_LINES: readonly string[] = [
  'uso:',
  '  /clear           limpa SÓ a sessão (contexto da conversa) — a memória fica intacta',
  '  /clear memory    APAGA a memória do agente (global + projeto) — pede confirmação',
  '  /clear full      limpa a sessão E APAGA a memória (global + projeto) — pede confirmação',
  '',
  'memory/full são IRREVERSÍVEIS e NÃO tocam as sessões salvas nem o /undo (recuperáveis).',
];

/**
 * Linhas de AVISO da confirmação de um clear destrutivo. Diz EXATAMENTE o que apaga
 * (N fatos da memória global+projeto), o que PRESERVA (sessões salvas + undo) e como
 * confirmar. `n` = quantos fatos serão apagados (0 ⇒ o caller nem chega aqui).
 */
function confirmLines(cmd: 'full' | 'memory', n: number): readonly string[] {
  const fatos = `${n} fato${n === 1 ? '' : 's'}`;
  const head =
    cmd === 'full'
      ? 'isto LIMPA a sessão (contexto da conversa) E APAGA PERMANENTEMENTE a memória do agente:'
      : 'isto APAGA PERMANENTEMENTE a memória do agente:';
  return [
    `⚠ ${head}`,
    `  • ${fatos} da memória (global + projeto) — IRREVERSÍVEL.`,
    'NÃO apaga: as sessões salvas (/history) nem o /undo — esses continuam recuperáveis.',
    `confirme repetindo \`/clear ${cmd}\` · cancele com \`/clear cancelar\` (ou qualquer outro comando).`,
  ];
}

/**
 * O resultado de rotear `/clear` destrutivo: ou PEDE confirmação (1ª vez), ou EXECUTOU
 * (2ª vez, confirmação armada). O `note` é o que se empurra na conversa; `armed` é o
 * novo estado da confirmação pendente que o caller passa a guardar. Quando `cleared`
 * é `true`, o caller faz a limpeza VISUAL do terminal (clearScreen) — a sessão zerou.
 */
export interface ClearOutcome {
  readonly note: SlashNote;
  /** A confirmação fica ARMADA p/ a próxima invocação? (true só após pedir confirmação.) */
  readonly armed: boolean;
  /** A SESSÃO foi limpa agora? (⇒ o caller faz o clearScreen do terminal.) */
  readonly cleared: boolean;
}

export interface ClearDeps {
  /** Zera o contexto da sessão (controller.clear) — usado por `session` e `full`. */
  readonly clearSession: () => void;
  /** A memória de agente (o `clearAll` apaga os fatos por escopo). */
  readonly memory: AgentMemory;
}

/**
 * Executa `/clear <cmd>` contra a sessão + memória, gerindo a confirmação de 2 passos
 * dos destrutivos. `armed` = a confirmação JÁ estava pendente (a invocação ANTERIOR foi
 * o MESMO destrutivo)?
 *
 *   - `session` ⇒ limpa a sessão na hora (não destrói nada permanente, sem confirmação)
 *     e DESARMA qualquer confirmação pendente.
 *   - `cancel`/`help` ⇒ não apaga nada; desarma.
 *   - `memory`/`full`:
 *       · memória já VAZIA ⇒ "nada a apagar" (e, no `full`, ainda limpa a sessão), sem
 *         exigir confirmação (não há o que confirmar);
 *       · `armed === false` ⇒ PEDE confirmação (conta os fatos, mostra o aviso), arma;
 *       · `armed === true`  ⇒ EXECUTA: `full` limpa a sessão + apaga a memória; `memory`
 *         só apaga a memória. Desarma.
 *
 * Devolve a nota + o novo estado `armed` + se a sessão foi limpa (p/ o clearScreen).
 */
export async function runClearCommand(
  cmd: ClearCommand,
  deps: ClearDeps,
  armed: boolean,
): Promise<ClearOutcome> {
  if (cmd.kind === 'session') {
    deps.clearSession();
    // Sem nota: o `/clear` puro deixa a tela LIMPA (qualquer nota seria ruído). A App
    // remonta o <Static> + clearScreen; o controller já empurra o estado idle.
    return { note: { title: 'clear', lines: [] }, armed: false, cleared: true };
  }
  if (cmd.kind === 'cancel') {
    return {
      note: {
        title: 'clear',
        lines: [armed ? 'confirmação cancelada — nada foi apagado.' : 'nada pendente a cancelar.'],
      },
      armed: false,
      cleared: false,
    };
  }
  if (cmd.kind === 'help') {
    return {
      note: { title: 'clear', lines: [cmd.reason, '', ...HELP_LINES] },
      armed: false,
      cleared: false,
    };
  }

  // Destrutivo (`memory` | `full`). Conta os fatos a apagar ANTES de tocar nada.
  const verb = cmd.kind; // 'memory' | 'full'
  const facts = await deps.memory.list();
  const total = facts.length;

  if (total === 0) {
    // Nada a apagar ⇒ não há confirmação a pedir. No `full`, ainda limpa a SESSÃO
    // (que é a outra metade do "tudo"); no `memory`, é um no-op honesto.
    const cleared = verb === 'full';
    if (cleared) deps.clearSession();
    return {
      note: {
        title: 'clear',
        lines:
          verb === 'full'
            ? ['sessão limpa. memória já estava vazia — nada a apagar.']
            : ['memória já estava vazia — nada a apagar.'],
      },
      armed: false,
      cleared,
    };
  }

  if (!armed) {
    // 1ª invocação: PEDE confirmação (não apaga nada). Arma p/ a próxima.
    return {
      note: { title: 'clear', lines: confirmLines(verb, total) },
      armed: true,
      cleared: false,
    };
  }

  // 2ª invocação CONSECUTIVA (confirmada): EXECUTA.
  await deps.memory.clearAll(); // ambos os escopos (global + projeto).
  const cleared = verb === 'full';
  if (cleared) deps.clearSession();
  const fatos = `${total} fato${total === 1 ? '' : 's'}`;
  return {
    note: {
      title: 'clear',
      lines:
        verb === 'full'
          ? [`sessão limpa e memória apagada: ${fatos} (global + projeto) removidos.`]
          : [`memória apagada: ${fatos} (global + projeto) removidos. a sessão segue.`],
    },
    armed: false,
    cleared,
  };
}
