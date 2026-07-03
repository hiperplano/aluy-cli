// EST-0948 · spec §4.3 — <FooterHints>: linha dim de atalhos por estado.
//
// Uma linha dim opcional abaixo do composer/status que muda conforme o estado e
// ensina o teclado sem poluir (§4.3). NÃO compete com o conteúdo — é a "cola" de
// descoberta. Ligável/desligável (`hints`, default on em confortável, off em
// compacto). O texto por estado é DADO (tabela §4.3), não espalhado.

import React from 'react';
import { Role } from '../theme/index.js';
import { useI18n, type I18nKey } from '../../i18n/index.js';

/** Estados que mudam o footer (§4.3). */
export type HintState =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'ask'
  | 'ask-destructive'
  | 'slash'
  | 'palette'
  | 'budget'
  | 'error'
  // EST-0982 (semântica do esc) — com SUB-AGENTES VIVOS a parada tem dois níveis:
  // esc para SÓ o pai (os filhos seguem); F8 para TUDO. Os dois estados ensinam isso
  // no footer — durante o trabalho e pós-esc (filhos desacoplados em segundo plano).
  | 'work-subagents'
  | 'idle-subagents';

// EST-0989 (i18n) — cada estado mapeia p/ uma CHAVE i18n; o texto vem do catálogo no
// idioma ativo (`t()`), com fallback en→pt-BR. Os atalhos de tecla (`enter`, `esc`,
// `ctrl-c`, `↑↓`, `F8`) não se traduzem — só o verbo ao redor (ver catálogo).
const HINT_KEYS: Readonly<Record<HintState, I18nKey>> = {
  idle: 'hints.idle',
  thinking: 'hints.thinking',
  streaming: 'hints.streaming',
  ask: 'hints.ask',
  'ask-destructive': 'hints.askDestructive',
  slash: 'hints.slash',
  // EST-0961 — paleta de comandos (Ctrl+P): mesma mecânica do slash/picker.
  palette: 'hints.palette',
  budget: 'hints.budget',
  error: 'hints.error',
  // EST-0982 (semântica do esc) — parada em dois níveis com sub-agentes vivos.
  'work-subagents': 'hints.workSubagents',
  'idle-subagents': 'hints.idleSubagents',
};

/** Estados OCUPADOS — onde o relógio de elapsed faz sentido (EST-0965). */
const BUSY_HINTS: ReadonlySet<HintState> = new Set<HintState>([
  'thinking',
  'streaming',
  'work-subagents',
]);

export interface FooterHintsProps {
  readonly state: HintState;
  /**
   * EST-0965 — INDICADOR DE ATIVIDADE: o elapsed do turno em curso (`0:12`, `M:SS`),
   * anexado à dica nos estados OCUPADOS (`esc interromper · 0:12`). Avança 1×/seg (o
   * tick lento de 1s da App) — mesmo sem token novo, o número subindo = VIVO (não
   * parece congelado durante args de um `edit_file` grande). `undefined`/vazio ou fora
   * de fase ocupada ⇒ só a dica base (não suja o footer de idle/ask/etc.).
   */
  readonly elapsed?: string | undefined;
  /**
   * EST-1015 (dono, dogfooding) — duplo Ctrl+C p/ sair: o 1º Ctrl+C no composer vazio
   * NÃO encerra mais; ARMA a saída e o footer mostra "pressione Ctrl+C de novo para
   * sair" (em destaque). O 2º (dentro da janela) sai; senão DESARMA sozinho. `true`
   * enquanto armado ⇒ a dica de saída SUBSTITUI a do estado. Evita matar a app sem querer.
   */
  readonly armedExit?: boolean;
  /**
   * F197 — há uma SUGESTÃO DE PRÓXIMO PROMPT pendente (ghost no composer)? Quando `true`
   * E o estado é `idle`, o footer anexa a cola `tab aceita a sugestão` (afordância do Tab).
   * Fora do idle / sem sugestão ⇒ ignorado (a dica base do estado vale). Não compete com o
   * `armedExit` (a confirmação de saída sempre vence).
   */
  readonly suggesting?: boolean;
}

export function FooterHints(props: FooterHintsProps): React.ReactElement {
  const { t } = useI18n();
  // ARMADO p/ sair (1º Ctrl+C): a dica de confirmação VENCE a do estado, em destaque.
  if (props.armedExit === true) {
    return <Role name="accent">{t('hints.ctrlcAgain')}</Role>;
  }
  const base = t(HINT_KEYS[props.state]);
  const showElapsed =
    props.elapsed !== undefined && props.elapsed !== '' && BUSY_HINTS.has(props.state);
  // F197 — no idle com sugestão pendente, anexa a afordância do Tab (`tab aceita a
  // sugestão`). Só no idle (é lá que o ghost aparece) e nunca junto do elapsed (idle não
  // tem relógio) — sem conflito de sufixos.
  if (props.suggesting === true && props.state === 'idle') {
    return <Role name="fgDim">{`${base} · ${t('hints.suggest')}`}</Role>;
  }
  return <Role name="fgDim">{showElapsed ? `${base} · ${props.elapsed}` : base}</Role>;
}
