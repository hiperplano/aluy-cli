// EST-0970 (ticks AO VIVO) — <Doctor>: a CHECKLIST PROGRESSIVA do `/doctor`.
//
// O pedido do Tiago: o `/doctor` não deve só "mostrar o estado" de uma vez — deve
// TESTAR e VALIDAR, com os ticks aparecendo AO VIVO (✓ progressivo, como o `[nome] ✓`
// do spawn_agent). Cada item nasce `pending` (spinner braille ⠋ girando) e "acende"
// para ✓/⚠/✗ quando o probe resolve aquele check. Bloco VIVO enquanto houver `pending`;
// quando todos resolvem, fica estável (sem jitter) e migra p/ o scrollback.
//
// a11y (§3.3): o estado vem SEMPRE com o GLIFO + a palavra/detalhe ao lado, nunca só
// pela cor. O spinner é 1 célula numa linha pequena — não redesenha a tela (anti-flicker
// EST-0965: anima no tick lento coalescido pelo sync-output, igual <SubAgents>/<Working>).
//
// PURO / frame-driven: recebe `frame` (do tick central) p/ animar o spinner do item
// `pending`. Sem `setInterval` aqui — o teste passa frame fixo, sem timers reais.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';

/** Espelha `DoctorCheckLine` do model (sem importar o tipo p/ manter o componente puro). */
export interface DoctorCheckView {
  readonly id: string;
  readonly label: string;
  readonly status: 'pending' | 'ok' | 'warn' | 'fail';
  readonly detail?: string;
  readonly fix?: string;
}

export interface DoctorProps {
  /** Os checks a exibir (status por item). */
  readonly checks: readonly DoctorCheckView[];
  /** Resumo final (`N ok · N aviso · N falha`) — só quando todos resolveram. */
  readonly summary?: string;
  /** Frame do tick central (puro) — anima o spinner dos itens `pending`. Default 0. */
  readonly frame?: number;
}

/** Palavra do estado (a11y): glifo NUNCA sozinho. */
function statusWord(status: DoctorCheckView['status']): string {
  switch (status) {
    case 'pending':
      return 'testando';
    case 'ok':
      return 'ok';
    case 'warn':
      return 'aviso';
    default:
      return 'falha';
  }
}

/** UMA linha de check: `  ⠋ credencial: testando…` → `  ✓ credencial: u · autenticado`. */
function CheckLine(props: {
  readonly check: DoctorCheckView;
  readonly frame: number;
}): React.ReactElement {
  const theme = useTheme();
  const c = props.check;
  const word = statusWord(c.status);

  // Spinner braille p/ pending (◷ estático em reduced-motion, como <ProgressBar>); glifos
  // do tema p/ os resolvidos (✓ success / ⚠ ask·warning / ✗ danger).
  let glyph: React.ReactElement;
  // ⚠ usa `accent` (a convenção do DS p/ ask/atenção — não há papel `warning` dedicado).
  let wordRole: 'fgDim' | 'success' | 'accent' | 'danger';
  if (c.status === 'pending') {
    const frames = theme.spinnerFrames;
    const spin = theme.animate ? frames[(props.frame ?? 0) % frames.length]! : theme.glyph('clock');
    glyph = <Role name="accent">{spin}</Role>;
    wordRole = 'fgDim';
  } else if (c.status === 'ok') {
    glyph = <Glyph name="ok" role="success" />;
    wordRole = 'success';
  } else if (c.status === 'warn') {
    glyph = <Glyph name="ask" role="accent" />;
    wordRole = 'accent';
  } else {
    glyph = <Glyph name="err" role="danger" />;
    wordRole = 'danger';
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text> </Text>
        {glyph}
        <Text> </Text>
        <Role name="fg">{c.label}:</Role>
        <Text> </Text>
        {c.detail !== undefined && c.detail !== '' ? (
          <Role name={wordRole}>{c.detail}</Role>
        ) : (
          <Role name={wordRole}>{word}…</Role>
        )}
      </Box>
      {/* a DICA de conserto só aparece em ⚠/✗ resolvidos (estilo /doctor do Claude Code). */}
      {c.status !== 'pending' && c.status !== 'ok' && c.fix !== undefined && (
        <Box paddingLeft={4}>
          <Role name="fgDim">→ {c.fix}</Role>
        </Box>
      )}
    </Box>
  );
}

export function Doctor(props: DoctorProps): React.ReactElement {
  const items = props.checks;
  const pending = items.filter((c) => c.status === 'pending').length;
  const headTail = pending > 0 ? ` (${pending} testando)` : '';
  const frame = props.frame ?? 0;
  return (
    <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
      <Box>
        <Glyph name="clock" role="accent" />
        <Role name="fg"> doctor — diagnóstico</Role>
        {headTail !== '' && <Role name="fgDim">{headTail}</Role>}
      </Box>
      {items.map((c) => (
        <CheckLine key={c.id} check={c} frame={frame} />
      ))}
      {props.summary !== undefined && (
        <Box paddingTop={1}>
          <Role name="fgDim">resumo: {props.summary}</Role>
        </Box>
      )}
    </Box>
  );
}
