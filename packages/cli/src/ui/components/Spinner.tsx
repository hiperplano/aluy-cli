// EST-0948 · spec §3.6 — <Spinner>: spinner braille (boot/login/broker-retry).
//
// `⠋⠙⠹⠸…` (10 frames) em Unicode, `- \ | /` (4 frames) em ASCII. PURO: recebe
// `frame` e resolve `frames[frame % len]`. Fallback (a11y §6 / handoff §10.1):
//   - `theme.animate === false` ⇒ glifo `clock` (◷) estático;
//   - sem Unicode ⇒ usa os frames ASCII (já resolvidos em theme.spinnerFrames).
// É só ATIVIDADE — o texto ao lado (que o chamador põe) carrega o sentido.

import React from 'react';
import { Role, useTheme } from '../theme/index.js';
import type { TermRole } from '../theme/palette.js';

export interface SpinnerProps {
  /** Frame do tick central (puro). Default 0. */
  readonly frame?: number;
  /** Papel de cor do spinner. Default `accent`. */
  readonly role?: TermRole;
}

export function Spinner(props: SpinnerProps): React.ReactElement {
  const theme = useTheme();
  const role = props.role ?? 'accent';
  const frames = theme.spinnerFrames;
  // Reduced-motion: cai p/ o ◷ estático (sem girar). Sentido vive no texto ao lado.
  const ch = theme.animate ? frames[(props.frame ?? 0) % frames.length]! : theme.glyph('clock');
  return <Role name={role}>{ch}</Role>;
}
