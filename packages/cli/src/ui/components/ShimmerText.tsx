// SHIMMER — o brilho da cor Aluy VARRENDO um texto, para marcar "isto está VIVO".
//
// Pedido do dono: "nos agentes que estão trabalhando eu queria que o brilho da cor do Aluy
// passasse por eles; hoje é meio estático, só um relógio pequeno na frente". O mesmo efeito
// vale para o rótulo da linha de trabalho (`pensando…`).
//
// COMO: uma banda de células mais claras anda da esquerda p/ a direita sobre o texto. Os
// papéis são os do degradê da marca (`accent` pico · `accentMid` halo · `accentDim` repouso),
// os mesmos do wordmark do splash — nunca cor crua. A banda anda 1 coluna por `frame` do tick
// CENTRAL (useTick da App): este módulo NÃO tem timer próprio, é função pura de `frame`.
//
// DEGRADAÇÃO (a11y):
//   · `animate=false` (reduced-motion / ALUY_NO_ANIM) ou `ativo=false` ⇒ texto ESTÁTICO.
//   · mono (NO_COLOR/TERM=dumb) ⇒ texto PLANO, sem estilo nenhum.
//   · ansi16 ⇒ as 3 cores do degradê são todas `yellow`, não há como variar o brilho pela
//     cor; a banda vira alternância NEGRITO (na banda) / DIM (fora).
// LARGURA constante: só a cor muda, nenhuma célula aparece/some (anti-jitter EST-0956).

import React from 'react';
import { Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';

/** Colunas da banda de pico (`accent`) a cada lado da cabeça. */
export const SHIMMER_TEXT_PEAK = 1;
/** Colunas do halo (`accentMid`) a cada lado da cabeça. */
export const SHIMMER_TEXT_HALO = 3;
/** Pausa (colunas) com a cabeça fora do texto antes de a varredura recomeçar. */
export const SHIMMER_TEXT_TAIL = 6;

/** Nível por coluna: 2 pico · 1 halo · 0 repouso. PURO; a cabeça anda 1 coluna por frame. */
export function shimmerTextLevels(total: number, frame: number): readonly (0 | 1 | 2)[] {
  const n = Math.max(0, Math.trunc(total));
  const period = n + SHIMMER_TEXT_TAIL;
  const f = Number.isFinite(frame) ? Math.trunc(frame) : 0;
  const head = ((f % period) + period) % period;
  const out: (0 | 1 | 2)[] = [];
  for (let c = 0; c < n; c++) {
    const d = Math.abs(c - head);
    out.push(d <= SHIMMER_TEXT_PEAK ? 2 : d <= SHIMMER_TEXT_HALO ? 1 : 0);
  }
  return out;
}

export interface ShimmerTextProps {
  readonly text: string;
  /** Frame do tick central. */
  readonly frame?: number;
  /** `false` ⇒ estático (agente terminado/pausado/falho). Default true. */
  readonly ativo?: boolean;
  /** Papel do texto quando estático. Default `fgDim`. */
  readonly papelEstatico?: 'fg' | 'fgDim' | 'accent' | 'success' | 'danger';
  /**
   * Para um brilho CONTÍNUO sobre vários trechos: posição deste trecho dentro do conjunto e
   * a largura total do conjunto. Default: o próprio texto.
   */
  readonly offset?: number;
  readonly total?: number;
}

export function ShimmerText(props: ShimmerTextProps): React.ReactElement {
  const theme = useTheme();
  const estatico = props.papelEstatico ?? 'fgDim';
  const ativo = props.ativo !== false && theme.animate;
  if (theme.colorMode === 'mono') return <Text>{props.text}</Text>;
  if (!ativo) return <Role name={estatico}>{props.text}</Role>;

  const chars = [...props.text];
  const offset = props.offset ?? 0;
  const total = props.total ?? chars.length;
  const levels = shimmerTextLevels(total, props.frame ?? 0);

  // Agrupa células vizinhas de mesmo nível (menos nós Text por frame).
  const runs: { level: 0 | 1 | 2; text: string }[] = [];
  chars.forEach((ch, i) => {
    const level = levels[offset + i] ?? 0;
    const last = runs[runs.length - 1];
    if (last && last.level === level) last.text += ch;
    else runs.push({ level, text: ch });
  });

  if (theme.colorMode === 'ansi16') {
    return (
      <>
        {runs.map((r, i) =>
          r.level > 0 ? (
            <Text key={i} bold color="yellow">
              {r.text}
            </Text>
          ) : (
            <Text key={i} dimColor>
              {r.text}
            </Text>
          ),
        )}
      </>
    );
  }
  return (
    <>
      {runs.map((r, i) => (
        <Role key={i} name={r.level === 2 ? 'accent' : r.level === 1 ? 'accentMid' : 'accentDim'}>
          {r.text}
        </Role>
      ))}
    </>
  );
}
