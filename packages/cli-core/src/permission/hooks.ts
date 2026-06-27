// EST-0945 · CLI-SEC-3 (hooks) — pontos de intercepção PROGRAMÁVEIS de tool-calls.
//
// Modelo de design: os "PreToolUse hooks" do Claude Code (REFERÊNCIA de design,
// não cópia de código — Q9). Um hook é uma função que vê o tool-call ANTES da
// decisão e pode forçar `allow`/`ask`/`deny` (ou se omitir). É o ponto onde o
// usuário/operador pluga regras programáticas (ex.: "negue qualquer toque em
// `infra/`", "force ask em horário comercial") sem mudar a engine.
//
// FRONTEIRA (ADR-0053 §2.2): o MECANISMO de hook é CÓDIGO (aqui); as REGRAS são
// DADO/config do usuário (o locus concreto compõe os hooks a partir de settings).
// PORTÁVEL: o hook é uma função pura sobre o tool-call (sem I/O imposto pelo core).
//
// PRECEDÊNCIA DE SEGURANÇA (não-negociável): um hook PODE endurecer (deny/ask),
// NUNCA pode RELAXAR uma categoria sempre-ask de CLI-SEC-3. A engine aplica a
// ordem: hook-deny > categoria sempre-ask > hook-ask > política do usuário >
// default. Ou seja: um hook que diga "allow" sobre um `rm -rf` é IGNORADO — a
// categoria destrutiva ainda força ask. (Ver engine.ts p/ a ordem completa.)

import type { PermissionDecision, ToolCall } from './gate.js';

/** Veredito que um hook pode emitir (ou `undefined` = "não opino"). */
export interface HookOutcome {
  readonly decision: PermissionDecision;
  readonly reason: string;
}

/**
 * Um hook de pré-decisão. Recebe o tool-call e devolve um veredito ou
 * `undefined` (abstém-se). DEVE ser síncrono e puro (sem efeito) — é avaliado
 * dentro do `decide()` síncrono do seam. Hooks que precisem de I/O assíncrono
 * pertencem ao locus concreto, que os resolve ANTES e injeta o resultado.
 */
export type PreToolUseHook = (call: ToolCall) => HookOutcome | undefined;

/**
 * Avalia os hooks em ordem e agrega. Regras:
 *  - se QUALQUER hook disser `deny` ⇒ o resultado agregado é `deny` (o mais
 *    restritivo vence; o primeiro deny ganha o motivo).
 *  - senão, se qualquer hook disser `ask` ⇒ `ask`.
 *  - senão, se qualquer hook disser `allow` ⇒ `allow` (mas a ENGINE só honra
 *    esse allow se nenhuma categoria sempre-ask casar — ver engine.ts).
 *  - senão (todos abstêm) ⇒ `undefined`.
 */
export function runHooks(
  hooks: readonly PreToolUseHook[],
  call: ToolCall,
): HookOutcome | undefined {
  let ask: HookOutcome | undefined;
  let allow: HookOutcome | undefined;
  for (const hook of hooks) {
    const out = hook(call);
    if (!out) continue;
    if (out.decision === 'deny') return out; // mais restritivo vence imediatamente
    if (out.decision === 'ask' && !ask) ask = out;
    if (out.decision === 'allow' && !allow) allow = out;
  }
  return ask ?? allow;
}
