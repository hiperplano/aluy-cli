// EST-0984 · marca Λ do Aluy no terminal — <AluyLoader>.
//
// Espelha o FEEL do loader web do DS (`chat/AluyLoader.tsx` + `chat/chat.css`): o
// Λ do logo (duas pernas que se encontram no topo, SEM base) "desenha" e "respira"
// em loop (`aluy-loader-draw` + `aluy-loader-breathe`, ~1.4s, perna direita com
// atraso). No terminal não há SVG/stroke-dash — replicamos a SENSAÇÃO por COR:
//   - “desenha/monta”: a perna ESQUERDA acende primeiro, depois a DIREITA (atraso),
//     evocando o lambda sendo traçado da base esquerda ao topo e descendo à direita.
//   - “respira”: as pernas pulsam `accent ↔ accentDim` (o MESMO pulso calmo que o
//     ◇ tinha, agora na marca Λ).
//
// RENDER por capacidade do terminal (theme.aluyMark):
//   - Unicode capaz ⇒ `Λ` (U+039B), 1 célula. As "duas pernas" viram DUAS FASES de
//     cor no mesmo glifo (não dá p/ colorir meia célula): respira accent↔accentDim.
//   - Fallback ASCII ⇒ `/\` (2 células): `/` = perna esquerda, `\` = direita —
//     cada uma com sua própria fase ⇒ o "monta esquerda→direita" fica LITERAL.
//
// ANTI-JITTER (EST-0956): a marca tem LARGURA/ALTURA CONSTANTES entre frames. NUNCA
// aparece/some célula — só a COR muda. Cadência baixa: deriva de `frame` (tick
// central useTick, ~8fps); reduced-motion (`theme.animate=false`) ⇒ marca SÓLIDA
// (accent), sem movimento (o verbo vivo ao lado, se houver, carrega o sentido).
//
// PURO (handoff §10.1): recebe `frame` por prop; sem setInterval aqui.

import React from 'react';
import { Box, Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import type { TermRole } from '../theme/palette.js';

/**
 * Comprimento do ciclo de "respiro/desenho" em frames. ~8 frames a ~120ms ≈ 1s,
 * próximo dos 1.4s do DS — calmo, sem flicker (spec §3.6 regra 1).
 */
export const ALUY_LOADER_CYCLE = 8;
/** Atraso (frames) da perna DIREITA — espelha o `animation-delay: 0.18s` do DS. */
export const ALUY_LOADER_RIGHT_DELAY = 2;

/**
 * Fase de uma perna do Λ em função do frame: `accent` no "aceso" (cabeça do
 * desenho/pico do respiro) e `accentDim` no "apagado" (vale). PURO. `delay`
 * desloca a fase (perna direita "monta depois"). A perna está ACESA na 1ª metade
 * do ciclo (sobe e fica) e DIM na 2ª (relaxa) — evoca draw(0→45%) + breathe.
 */
export function legRole(frame: number, delay: number): TermRole {
  const phase = (((frame - delay) % ALUY_LOADER_CYCLE) + ALUY_LOADER_CYCLE) % ALUY_LOADER_CYCLE;
  return phase < ALUY_LOADER_CYCLE / 2 ? 'accent' : 'accentDim';
}

/**
 * As CÉLULAS do wordmark, na ordem em que o brilho corre. A marca em ASCII são duas
 * células (`/` e `\\`), então o wordmark tem 5 lá e 4 em Unicode — o que importa é que o
 * número é CONSTANTE dentro de um terminal, nunca entre frames.
 */
export function wordmarkCells(mark: string): readonly string[] {
  return [...mark, 'l', 'u', 'y'];
}

/**
 * Qual célula está ACESA no frame — a "cabeça" que corre Λ→l→u→y. PURA, e exportada
 * porque é o único jeito de PROVAR o movimento: o brilho é COR, e no harness de teste o
 * Ink não emite código de cor nenhum (stdout não é TTY), então comparar quadros
 * renderizados não distingue um wordmark que corre de um parado.
 */
export function wordmarkHeadIndex(frame: number, total: number): number {
  if (total <= 0) return 0;
  return ((frame % total) + total) % total;
}

export interface AluyLoaderProps {
  /** Frame do tick central (puro). Default 0 (estático/“montado”). */
  readonly frame?: number;
  /**
   * WORDMARK — desenha `Λluy` inteiro em vez de só a inicial, com o brilho CORRENDO de
   * letra em letra. Pedido do dono: "eu colocaria todos os caracteres do aluy aparecendo e
   * desaparecendo um apos o outro... ao vines somente do inicial".
   *
   * Ele disse "aparecendo e desaparecendo", e é aí que esta implementação diverge de
   * propósito: célula que SOME muda a largura da linha a cada frame, e a largura constante
   * é o anti-jitter do EST-0956 (o cabeçalho deste arquivo). As quatro letras ficam SEMPRE
   * na tela; o que corre é a COR (`accent` numa, `accentDim` nas outras). O olho lê
   * "acendendo uma após a outra" — que é o efeito pedido — sem a linha nunca mudar de
   * tamanho.
   */
  readonly wordmark?: boolean;
}

/**
 * A marca Λ do Aluy animada (loader/“pensando”). Em Unicode é um `Λ` que respira;
 * em ASCII são duas pernas `/\` que montam esquerda→direita. Largura constante.
 */
export function AluyLoader(props: AluyLoaderProps): React.ReactElement {
  const theme = useTheme();
  const frame = props.frame ?? 0;
  const animate = theme.animate;

  const celulas = wordmarkCells(theme.aluyMark);

  // Reduced-motion / não-TTY: marca SÓLIDA (accent), sem pulso (sentido preservado).
  if (!animate) {
    return <Role name="accent">{props.wordmark === true ? celulas.join('') : theme.aluyMark}</Role>;
  }

  // WORDMARK: o brilho corre Λ→l→u→y. Uma célula `accent`, o resto `accentDim` — a mesma
  // gramática da cabeça da onda que este modo veio SUBSTITUIR (o dono achou a banda `～～～`
  // poluída, e o nome do produto faz o mesmo trabalho ocupando a mesma largura).
  if (props.wordmark === true) {
    const cabeca = wordmarkHeadIndex(frame, celulas.length);
    // FRAGMENTO, não `<Box>`. O cabeçalho da caixa da conversa desenha o nome DENTRO de um
    // `<Text>` (é ele que pinta o fundo da faixa), e um `<Box>` ali dentro quebra o layout
    // do Ink — o efeito não foi um erro de tipo, foi meia dúzia de testes de render caindo
    // com o texto reflowado. O fragmento compõe nos dois contextos (dentro de `<Text>` e
    // solto numa `<Box>`), que é o que este componente precisa ser.
    return (
      <>
        {celulas.map((ch, i) => (
          <Role key={i} name={i === cabeca ? 'accent' : 'accentDim'}>
            {ch}
          </Role>
        ))}
      </>
    );
  }

  // ASCII `/\`: duas pernas independentes ⇒ o "monta esquerda→direita" é literal.
  if (!theme.unicode) {
    const leftRole = legRole(frame, 0);
    const rightRole = legRole(frame, ALUY_LOADER_RIGHT_DELAY);
    return (
      <Box>
        <Role name={leftRole}>/</Role>
        <Role name={rightRole}>\</Role>
      </Box>
    );
  }

  // Unicode `Λ` (1 célula): respira accent↔accentDim. A célula é SEMPRE a mesma
  // (largura/altura estável) — só a cor alterna (anti-jitter EST-0956).
  const role = legRole(frame, 0);
  return <Role name={role}>{theme.aluyMark}</Role>;
}

/**
 * Loader de BOOT: a marca Λ animada + um verbo de status ao lado (ex.: "conectando").
 * Usado após o splash enquanto liga login/broker (não o wordmark parado). O texto
 * carrega o sentido; o Λ carrega a marca + a sensação de "vivo".
 */
export function AluyBootLoader(props: {
  readonly frame?: number;
  readonly label: string;
}): React.ReactElement {
  return (
    <Box>
      <AluyLoader {...(props.frame !== undefined ? { frame: props.frame } : {})} />
      <Text> </Text>
      <Role name="fgDim">{props.label}…</Role>
    </Box>
  );
}
