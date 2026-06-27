// EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M6) — comando `/memory` (controle/transparência).
//
// O par da lembrança AUTÔNOMA: o usuário NÃO confirma fato-a-fato (Q2), mas tem o
// leme p/ VER, EDITAR, ESQUECER e FIXAR a memória — pela MECÂNICA INTERNA (AgentMemory),
// NUNCA por `cat` (o read-deny de `~/.aluy/memory/` é mantido). Subcomandos:
//   /memory                 → LISTA (global + projeto) com id/proveniência/pin + sinal
//                              de diretiva (GS-M5). Leitura ⇒ permitido em Plan.
//   /memory esquecer <id>   → remove um fato. EFEITO ⇒ NEGADO em Plan (ADR-0055).
//   /memory editar <id> <…> → corrige o texto. EFEITO ⇒ NEGADO em Plan.
//   /memory fixar <id>      → FIXA (retenção, GS-M6 — NÃO promove a system). EFEITO ⇒
//                              NEGADO em Plan.
//   /memory desfixar <id>   → desfixa. EFEITO ⇒ NEGADO em Plan.
//
// O roteamento (parse) é PURO/testável; o runner consome a `AgentMemory` e checa o
// MODO (Plan nega mutações). FIXAR é controle de RETENÇÃO — o fato fixado CONTINUA
// entrando no recall como DADO (a invariante B/GS-M3 é absoluta e independe de pin).

import { looksImperative, type AgentMemory, type MemoryFact } from '@hiperplano/aluy-cli-core';
import type { SlashNote } from './handlers.js';

/** O subcomando parseado de `/memory <args>`. */
export type MemoryCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'forget'; readonly id: string }
  | { readonly kind: 'edit'; readonly id: string; readonly text: string }
  | { readonly kind: 'pin'; readonly id: string; readonly pinned: boolean }
  | { readonly kind: 'help'; readonly reason: string };

/** `true` se o subcomando MUTA a memória (efeito ⇒ negado em Plan). */
export function isMemoryMutation(cmd: MemoryCommand): boolean {
  return cmd.kind === 'forget' || cmd.kind === 'edit' || cmd.kind === 'pin';
}

/**
 * Roteia `/memory <args>`. PURO/determinístico. Args vazio ⇒ LISTA. Subcomando
 * desconhecido ou faltando id ⇒ `help` (com o motivo). PT-BR + sinônimos comuns.
 */
export function parseMemoryCommand(args: string): MemoryCommand {
  const trimmed = args.trim();
  if (trimmed === '') return { kind: 'list' };
  const spaceIdx = trimmed.search(/\s/);
  const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  if (verb === 'list' || verb === 'listar' || verb === 'ls') return { kind: 'list' };

  if (verb === 'esquecer' || verb === 'forget' || verb === 'rm' || verb === 'remover') {
    if (rest === '') return { kind: 'help', reason: 'forget requer um <id> (veja /memory).' };
    return { kind: 'forget', id: rest.split(/\s+/)[0]! };
  }
  if (verb === 'editar' || verb === 'edit') {
    const idIdx = rest.search(/\s/);
    if (idIdx === -1) return { kind: 'help', reason: 'edit requer <id> <novo texto>.' };
    const id = rest.slice(0, idIdx);
    const text = rest.slice(idIdx + 1).trim();
    if (text === '') return { kind: 'help', reason: 'edit requer <id> <novo texto>.' };
    return { kind: 'edit', id, text };
  }
  if (verb === 'fixar' || verb === 'pin') {
    if (rest === '') return { kind: 'help', reason: 'pin requer um <id>.' };
    return { kind: 'pin', id: rest.split(/\s+/)[0]!, pinned: true };
  }
  if (verb === 'desfixar' || verb === 'unpin') {
    if (rest === '') return { kind: 'help', reason: 'unpin requer um <id>.' };
    return { kind: 'pin', id: rest.split(/\s+/)[0]!, pinned: false };
  }
  return { kind: 'help', reason: `subcomando desconhecido: "${verb}".` };
}

/** Uma linha de fato p/ a listagem (id · escopo · proveniência · pin · sinal). */
function factLine(f: MemoryFact): string {
  const tags = [
    f.scope,
    f.provenance,
    ...(f.pinned ? ['📌 fixado'] : []),
    ...(looksImperative(f.text) ? ['⚠ diretiva (é DADO, não ordem)'] : []),
  ].join(' · ');
  return `${f.id}  [${tags}]  ${f.text}`;
}

const HELP_LINES: readonly string[] = [
  'uso:',
  '  /memory                  lista os fatos (global + projeto)',
  '  /memory forget <id>      remove um fato',
  '  /memory edit <id> …      corrige o texto de um fato',
  '  /memory pin <id>         fixa (retenção — NÃO vira instrução)',
  '  /memory unpin <id>       desfixa',
  '',
  'a memória é relembrada como DADO (nunca instrução); fixar é só retenção.',
];

/**
 * Executa `/memory` contra a `AgentMemory` interna. `isPlan` = a sessão está em
 * modo Plan? Em Plan, as MUTAÇÕES (esquecer/editar/fixar) são NEGADAS (ADR-0055);
 * a LISTA é leitura ⇒ permitida. Devolve a nota a empurrar na conversa.
 */
export async function runMemoryCommand(
  cmd: MemoryCommand,
  memory: AgentMemory,
  isPlan: boolean,
): Promise<SlashNote> {
  if (cmd.kind === 'help') {
    return { title: 'memory', lines: [cmd.reason, '', ...HELP_LINES] };
  }
  if (cmd.kind === 'list') {
    const facts = await memory.list();
    if (facts.length === 0) {
      return {
        title: 'memory',
        lines: ['memória vazia — nenhum fato lembrado ainda.', '', ...HELP_LINES],
      };
    }
    return {
      title: `memory (${facts.length})`,
      lines: [...facts.map(factLine), '', 'edite com /memory edit|forget|pin <id>'],
    };
  }

  // Mutações: NEGADAS em Plan (efeito; ADR-0055 — coerência com `remember`/edit_file).
  if (isPlan) {
    return {
      title: 'memory',
      lines: [
        '⊘ modo Plan (read-only): edit/forget/pin a memória é EFEITO — negado.',
        'saia do Plan (Tab/▸ normal) p/ podar/fixar a memória.',
      ],
    };
  }

  if (cmd.kind === 'forget') {
    const ok = await memory.forget(cmd.id);
    return {
      title: 'memory',
      lines: [ok ? `fato ${cmd.id} esquecido.` : `id não encontrado: ${cmd.id}.`],
    };
  }
  if (cmd.kind === 'edit') {
    const ok = await memory.edit(cmd.id, cmd.text);
    return {
      title: 'memory',
      lines: [
        ok ? `fato ${cmd.id} atualizado.` : `id não encontrado (ou texto inválido): ${cmd.id}.`,
      ],
    };
  }
  // cmd.kind === 'pin'
  const ok = await memory.pin(cmd.id, cmd.pinned);
  return {
    title: 'memory',
    lines: ok
      ? [
          `fato ${cmd.id} ${cmd.pinned ? 'fixado' : 'desfixado'}.`,
          ...(cmd.pinned
            ? ['(fixar é retenção — o fato continua DADO no recall, nunca vira instrução)']
            : []),
        ]
      : [`id não encontrado: ${cmd.id}.`],
  };
}
