// EST-0965 (FLICKER) · spec §3.6 — POLÍTICA dos DOIS ticks da TUI, em funções PURAS.
//
// A causa-raiz do flicker (MEDIDA num PTY real: streaming COM animação ≈ 210KB de
// redraw vs SEM ≈ 76KB, 2.75× mais) é o tick de ANIMAÇÃO de 120ms (~8fps): ele
// re-renderiza a região VIVA inteira (fala + chrome), e como o Ink redesenha TODA a
// área viva a cada render, a chrome PISCAVA durante o streaming. Por isso separamos:
//
//   • tick de ANIMAÇÃO (120ms) — o VÁCUO pré-progresso (`thinking`/`boot`) anima SEMPRE;
//     no progresso visível (`streaming`/`retrying`) anima SE o synchronized-output
//     (#76, Mode 2026) estiver ATIVO. Ver abaixo o porquê do `syncActive`.
//   • tick de ELAPSED (1s) — INFORMATIVO: o relógio do turno avança 1×/seg enquanto
//     OCUPADO (`thinking`/`streaming`/`retrying`), mesmo SEM token novo, p/ a tela não
//     parecer congelada. Independe de `animate` (roda com `ALUY_NO_ANIM`).
//
// POR QUE `syncActive` (EST-0965, religando a animação no streaming): o fix #75 matou a
// animação no streaming/retrying p/ NÃO redesenhar 8×/seg (era o flicker — o terminal
// pintava o estado intermediário do erase+redraw do log-update do Ink). Duas camadas no
// fio do stdout resolveram a CAUSA pela RAIZ e tornam o frame FLICKER-FREE:
//   · OVERWRITE-IN-PLACE — transforma o erase do Ink em SOBRESCREVE-no-lugar (zero
//     `\x1b[2K`), então NÃO há mais estado branco intermediário em terminal NENHUM
//     (não depende do Mode 2026). É o que mata o flicker de verdade.
//   · SYNCHRONIZED OUTPUT (`?2026`) — envelopa o frame em BSU…ESU; atômico onde há
//     suporte (belt-and-suspenders).
// `syncActive` = ALGUMA delas ligada (default ON). Com o frame flicker-free, a animação
// VOLTA no streaming (bolinhas/spinner pulsam, sem tremor). Só quando AMBAS desligadas
// (`ALUY_OVERWRITE_RENDER=0` E `ALUY_SYNC_OUTPUT=0`) mantemos o #75 (animação OFF no
// streaming) p/ NÃO regredir o flicker no caminho cru. O `thinking`/`boot` animam dos
// dois jeitos: lá o vácuo é pré-token e o ganho de "vida" supera o custo (e era o
// caminho que #75 já preservava).
//
// Isolar a decisão aqui (puro) dá um teste DETERMINÍSTICO do DoD sem depender do loop
// de efeitos do Ink (que o harness de teste não dispara) — a App só liga `useTick` a
// estes predicados.

import type { SessionState } from './model.js';

type Phase = SessionState['phase'];

/**
 * Fases em que a ANIMAÇÃO de 120ms faz sentido:
 *  · `thinking` (esperando o 1º token) e `boot` (a marca Λ desenha+respira no splash)
 *    ⇒ SEMPRE animam (o vácuo pré-progresso precisa de vida; #75 já preservava isto).
 *  · `streaming`/`retrying` ⇒ animam SOMENTE quando `syncActive` (o synchronized-output
 *    #76 envelopa cada frame em BSU…ESU ⇒ frame atômico ⇒ animar não treme). Sem sync,
 *    ficam DESLIGADOS — preserva o anti-flicker #75 no caminho sem-sync (NÃO redesenha
 *    8×/seg num terminal que pintaria o frame intermediário).
 *
 * `syncActive` default `true` (sync LIGADO por padrão, igual ao `syncOutputEnabled`):
 * chamador sem o flag ⇒ a animação volta no streaming, como esperado.
 */
export function animTickEnabled(phase: Phase, syncActive = true): boolean {
  if (phase === 'thinking' || phase === 'boot') return true;
  // EST-0973 — `compacting` é um VÁCUO de progresso (1 chamada ao broker, sem token a
  // exibir, como `thinking`): o spinner do <ProgressBar> precisa girar SEMPRE p/ a tela
  // não parecer travada. É 1 célula numa linha pequena ⇒ não reintroduz flicker.
  if (phase === 'compacting') return true;
  if (phase === 'streaming' || phase === 'retrying') return syncActive;
  return false;
}

/**
 * Fases OCUPADAS em que o tick LENTO de 1s do elapsed corre (indicador de atividade):
 * `thinking`/`streaming`/`retrying` e — EST-0973 — `compacting` (o elapsed `M:SS` do
 * <ProgressBar> indeterminado precisa avançar 1×/seg, mesmo sem token, como nas demais).
 * Idle/ask/budget/done/error/boot não armam timer.
 */
export function elapsedTickEnabled(phase: Phase): boolean {
  return (
    phase === 'thinking' || phase === 'streaming' || phase === 'retrying' || phase === 'compacting'
  );
}
