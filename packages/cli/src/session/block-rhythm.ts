// RITMO VERTICAL da conversa — o RESPIRO (1 linha em branco) ANTES do `Λ aluy`.
//
// O BUG (dogfooding do dono): o bloco de resposta COLAVA na linha de ferramenta anterior:
//
//     ⏺  bash    echo "=== POSIÇÕES ATUAIS ===" … 0 erros ✓
//   Λ aluy
//     Sim, isso é exatamente o que está faltando…
//
// A CAUSA é assimetria de responsabilidade: no `<BlockView>` o respiro entre turnos é
// pago SEMPRE pelo bloco de CIMA (`<Box paddingBottom={1}>`), nunca pelo de baixo. Mas a
// `<ToolLine>` (e a `<TestRunBlock>`/`deny`/`broker-error`) NÃO tem paddingBottom — é de
// propósito: duas tools seguidas formam uma LISTA compacta (`⏺ ler …` / `⏺ bash …`), e
// separá-las com linha em branco esfarelaria a leitura. Resultado: `você → aluy` respirava
// (o `you` paga), mas `ferramenta → aluy` colava (ninguém paga).
//
// O CONSERTO INGÊNUO (`paddingTop={1}` fixo no aluy) daria DUAS linhas em branco em
// `você → aluy` (o pad de baixo do `you` + o de cima do `aluy`) — o outro extremo. Por
// isso a regra é CONDICIONAL ao bloco ANTERIOR e mora aqui, PURA (sem React/Ink):
//
//   respiro antes do `aluy`  ⟺  há bloco anterior E ele NÃO termina com linha em branco.
//
// Uma fonte só, consumida por DOIS lados que TÊM de concordar (senão o orçamento
// anti-flicker fura por 1 linha e o Ink cai no `clearTerminal` — ver `live-budget.ts`):
//   · o RENDER  — `<BlockView prevKind=…>` (App.tsx), nos dois call-sites (Static + viva);
//   · a MEDIÇÃO — `liveOverheadLines` (live-budget.ts), que orça a altura da região viva.
//
// A FRONTEIRA Static×viva (onde este repo já teve "buraco no meio da tela" e gap crescente
// no resize) tem uma regra própria: o PRIMEIRO bloco do sufixo vivo NÃO recebe `prevKind`.
// O contêiner da região viva é um `<Box paddingY={1}>` — a linha em branco daquela
// fronteira JÁ existe (e já é orçada em `LIVE_CHROME_BASE_ROWS`); repeti-la daria DUAS
// (provado em PTY). O saldo fica ESTÁVEL no commit: `⏺ tool → Λ aluy` tem 1 linha antes
// (pad do contêiner) e 1 depois (paddingTop do próprio `aluy`, já no `<Static>`) — nada
// pula de altura quando o bloco desce p/ o scrollback.
//
// NOTA (escopo): o modo COCKPIT (Cockpit.tsx) NÃO passa `prevKind` — a região de conversa
// de lá tem altura FIXA e é medida 1:1 por `measureConversaBlock` (cockpit-conversa.ts).
// Mudar o ritmo lá exigiria mexer naquela medição espelho junto, sob pena de reintroduzir
// o mis-clip do Ink (F170). Sem `prevKind` a regra devolve `false` ⇒ cockpit intacto.

import type { SessionBlock } from './model.js';

/**
 * Tipos de bloco cujo RENDER já TERMINA com uma linha em branco (o `paddingBottom={1}`
 * do wrapper no `<BlockView>`, ou do próprio componente no caso do `inject`). Quem está
 * nesta lista JÁ paga o respiro de baixo ⇒ o bloco seguinte não deve pagar de novo.
 *
 * Quem NÃO está (e por quê):
 *   · `tool`         — `<ToolLine>` sem padding: tools seguidas formam lista compacta;
 *   · `testrun`      — idem (`<TestRunBlock>` fecha na linha `✓ todos passaram`);
 *   · `deny`         — linha única `[x] negado · …`, sem pad;
 *   · `broker-error` — fecha na BORDA `╰────` da caixa (traço, não linha em branco).
 */
const KINDS_WITH_TRAILING_BLANK: ReadonlySet<SessionBlock['kind']> = new Set([
  'you',
  'aluy',
  'note',
  'bang',
  'subagents',
  'doctor',
  'inject',
]);

/** `true` se o render de um bloco deste tipo termina com uma linha em BRANCO. */
export function blockEndsWithBlankLine(kind: SessionBlock['kind']): boolean {
  return KINDS_WITH_TRAILING_BLANK.has(kind);
}

/**
 * `true` se o bloco `aluy` precisa de um RESPIRO (paddingTop 1) por causa do bloco
 * ANTERIOR. `undefined` (não há anterior — 1º bloco da conversa — ou o chamador não
 * plumba o contexto, como o cockpit) ⇒ `false`: nunca abre a conversa com uma linha em
 * branco no topo nem muda quem não pediu.
 *
 * INVARIANTE: `respiroAntesDoAluy(k) === !blockEndsWithBlankLine(k)` p/ todo `k` definido
 * — ou seja, entre dois blocos quaisquer há SEMPRE exatamente 0 ou 1 linha em branco,
 * nunca 2 (o teste `block-rhythm` varre todos os `kind` e prova isso).
 */
export function aluyNeedsLeadingBlank(prevKind: SessionBlock['kind'] | undefined): boolean {
  if (prevKind === undefined) return false;
  return !blockEndsWithBlankLine(prevKind);
}
