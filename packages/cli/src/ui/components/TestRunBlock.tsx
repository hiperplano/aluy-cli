// ADR-0112 · EST-RT-3 — <TestRunBlock>: render AO VIVO do `run_tests`.
//
// Bloco DEDICADO (não o log que rola) que mostra o progresso de uma execução de
// testes: barra, placar, tempo decorrido e lista de falhas. Atualizado IN-PLACE a
// cada `onTestProgress`, coalescido por frame (anti-flicker).
//
// MODOS:
//   • FORMATO CONHECIDO (dialeto detectado): barra determinada (total > 0) ou
//     indeterminada (braille, total desconhecido) + `✓ N ✗ M (total)` + elapsed.
//     Lista de falhas em `danger` (vermelho/role do DS).
//   • FORMATO DESCONHECIDO (`unknownFormat`): braille indeterminado + "placar
//     indisponível" — honesto, não finge progresso.
//
// PURO / frame-driven: recebe `frame` do tick central e `elapsedMs` por prop
// (mesmo padrão do <ProgressBar>). SEM `setInterval` aqui.
//
// a11y: tudo tem glifo + palavra/contagem, nunca só cor. Cor por Role (tokens DS).

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role } from '../theme/index.js';
import { ProgressBar } from './ProgressBar.js';
import { formatElapsed } from '../../session/model.js';
import type { TestScore } from '@aluy/cli-core';

export interface TestRunBlockProps {
  /** Placar corrente (snapshot imutável do acumulador). */
  readonly score: TestScore;
  /** `true` enquanto a tool `run_tests` está rodando (mostra animação). */
  readonly running: boolean;
  /** Instante (epoch ms) em que a run começou — base do elapsed. */
  readonly startedAt: number;
  /** Relógio p/ o elapsed: `elapsedMs = now() - startedAt`. Default `Date.now`. */
  readonly now?: () => number;
  /** Frame do tick central (anima o braille/spinner). Puro. Default 0. */
  readonly frame?: number;
}

/** Máx. de falhas a exibir no bloco (anti-bloat da região viva). */
const MAX_VISIBLE_FAILURES = 10;

export function TestRunBlock(props: TestRunBlockProps): React.ReactElement {
  const { score, running, startedAt } = props;
  const now = props.now ?? Date.now;
  const elapsedMs = now() - startedAt;
  const elapsed = formatElapsed(elapsedMs);

  // ── Formato desconhecido ────────────────────────────────────────────────
  if (score.unknownFormat) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Glyph name="toolInflight" role="depth" />
          <Text> </Text>
          <Role name="fgDim">rodando testes… {elapsed}</Role>
        </Box>
        <Box paddingLeft={2}>
          <Role name="fgDim">formato não reconhecido — placar indisponível</Role>
        </Box>
      </Box>
    );
  }

  // ── Formato conhecido ───────────────────────────────────────────────────
  const totalKnown = score.total > 0;
  const done = score.passed + score.failed;
  const statusRole = score.failed > 0 ? 'danger' : 'success';

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* Barra de progresso ou spinner indeterminado */}
      <Box>
        {totalKnown ? (
          <ProgressBar
            label={`${done}/${score.total} testes`}
            value={done}
            max={score.total}
            role={score.failed > 0 ? 'danger' : 'accent'}
            frame={props.frame ?? 0}
          />
        ) : (
          <ProgressBar label="testes em andamento" elapsedMs={elapsedMs} frame={props.frame ?? 0} />
        )}
      </Box>

      {/* Placar: ✓ N ✗ M (total) · elapsed */}
      <Box paddingLeft={1}>
        <Role name="success">
          <Glyph name="ok" role="success" />
          <Text> {score.passed} passaram</Text>
        </Role>
        <Text> </Text>
        <Role name={statusRole}>
          <Glyph name={score.failed > 0 ? 'err' : 'ok'} role={statusRole} />
          <Text> {score.failed} falharam</Text>
        </Role>
        {score.total > 0 && (
          <Role name="fgDim">
            <Text> (total: {score.total})</Text>
          </Role>
        )}
        <Role name="fgDim">
          <Text> {elapsed}</Text>
        </Role>
      </Box>

      {/* Duração (se conhecida) */}
      {score.durationMs !== undefined && (
        <Box paddingLeft={1}>
          <Role name="fgDim">duração: {(score.durationMs / 1000).toFixed(2)}s</Role>
        </Box>
      )}

      {/* Lista de falhas */}
      {score.failures.length > 0 && (
        <Box flexDirection="column" paddingLeft={1} paddingTop={0}>
          <Role name="danger">falhas ({Math.min(score.failures.length, score.failed)}):</Role>
          {score.failures.slice(0, MAX_VISIBLE_FAILURES).map((f, i) => (
            <Box key={i} paddingLeft={2}>
              <Role name="danger">
                <Glyph name="err" role="danger" />
                <Text> {f.name}</Text>
              </Role>
              {f.message !== '' && (
                <Role name="fgDim">
                  <Text>: {f.message.split('\n')[0]?.slice(0, 120) ?? ''}</Text>
                </Role>
              )}
            </Box>
          ))}
          {score.failures.length > MAX_VISIBLE_FAILURES && (
            <Box paddingLeft={2}>
              <Role name="fgDim">
                … e mais {score.failures.length - MAX_VISIBLE_FAILURES} falhas
              </Role>
            </Box>
          )}
        </Box>
      )}

      {/* Estado final */}
      {!running && (
        <Box paddingLeft={1}>
          {score.failed === 0 ? (
            <Role name="success">
              <Glyph name="ok" role="success" />
              <Text> todos passaram</Text>
            </Role>
          ) : (
            <Role name="danger">
              <Glyph name="err" role="danger" />
              <Text> {score.failed} falharam</Text>
            </Role>
          )}
        </Box>
      )}
    </Box>
  );
}
