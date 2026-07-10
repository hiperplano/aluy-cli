// FIX (dono) — <ShadowedWordmark>: componente compartilhado que renderiza a grade
// {role,char} de `composeShadowedWordmark` (wordmark-3d.ts) como <Text> do Ink,
// agrupando células consecutivas de mesmo papel via `rowSegments` (1 <Text> por
// segmento, não por célula). Extraído do <SplashScreen> (F198/F200c) — que o usava
// como função privada — para ser REUSADO, agora também pelo BANNER do <Header>: o
// dono pediu a MESMA arte 3D + cores do splash (marca âmbar + sombra âmbar) no
// header, porém ESTÁTICA (sem o shimmer — animar não faz sentido em chrome fixo).
//
// `animate` (prop opcional): por padrão segue `theme.animate` (comportamento
// herdado do splash — reduced-motion do usuário desliga o shimmer). O <Header>
// passa `animate={false}` EXPLICITAMENTE, sempre — o header nunca anima,
// independente da preferência do usuário (chrome estático, EST-0965/anti-flicker),
// então não pode depender de `theme.animate` (que só reflete a11y, não "sou
// chrome fixo"). Ver `composeShadowedWordmark(frame, animate)` p/ a semântica.

import React from 'react';
import { Box, Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import { composeShadowedWordmark, rowSegments } from './wordmark-3d.js';

export interface ShadowedWordmarkProps {
  /** Frame do tick central (splash-controller). Ignorado quando `animate=false`. */
  readonly frame: number;
  /**
   * Sobrepõe `theme.animate` quando presente. Ausente ⇒ segue o tema (uso no
   * splash). `false` ⇒ marca `accent` + sombra `shadowAmber` ESTÁTICAS, sem
   * shimmer (uso no header — sempre estático, não é opcional).
   */
  readonly animate?: boolean;
}

/**
 * O wordmark `Λluy` COM sombra 3D — opcionalmente com o brilho horizontal que varre
 * a marca (splash) ou totalmente ESTÁTICO (header, `animate=false`). Compõe a grade
 * {marca · sombra} pelo `frame` (PURO, em `wordmark-3d.ts`) e emite um <Text> por
 * segmento de papel em cada linha. Unicode-only: o caller decide cair no <Wordmark>
 * 2D (que já degrada p/ ASCII `/\`+`#`) quando `!theme.unicode` — este componente
 * não tem fallback ASCII próprio (a sombra `▒`/marca `█` exigem block-art).
 */
export function ShadowedWordmark(props: ShadowedWordmarkProps): React.ReactElement {
  const theme = useTheme();
  const animate = props.animate ?? theme.animate;
  const grid = composeShadowedWordmark(props.frame, animate);
  return (
    <Box flexDirection="column">
      {grid.map((row, r) => (
        <Box key={r}>
          {rowSegments(row).map((seg, i) =>
            seg.role === null ? (
              <Text key={i}>{seg.text}</Text>
            ) : (
              <Role key={i} name={seg.role}>
                {seg.text}
              </Role>
            ),
          )}
        </Box>
      ))}
    </Box>
  );
}
