// BUG P2-C (auditoria fullscreen) — no MODO COCKPIT (alt-screen, EST-1000) o composer
// multi-linha era TRUNCADO à 1ª linha: o <Composer> vivia numa `Box height={composerRows}`
// CRAVADA em 1, então as linhas 2..N do input (bracketed-paste/`\n`) SUMIAM silenciosamente
// (regressão de paridade inline↔cockpit). O fix faz `composerRows` crescer (até
// COMPOSER_MAX_ROWS), descontando da CONVERSA, com a soma das regiões SEMPRE == rows (§5).
//
// Este arquivo prova no FRAME do componente (ink-testing-library) que:
//   (a) com 3 linhas de input as 3 APARECEM no composer do cockpit (não some conteúdo);
//   (b) o frame cabe em `rows` (não estoura/reflui ⇒ anti-flicker §5 intacto);
//   (c) input de 1 linha ⇒ INALTERADO (1 linha de composer, sem marcador);
//   (d) input que ESTOURA o teto ⇒ janela tail (linha do cursor visível) + marcador `↑N`.
// FALHA-SEM/PASSA-COM: com o bug (composerRows=1 fixo + Box clipando) a linha 2/3 não
// aparece no frame; com o fix elas aparecem.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Cockpit } from '../../src/session/Cockpit.js';
import { I18nProvider, i18n as makeI18n } from '../../src/i18n/index.js';
import { resolveCockpitLayout } from '../../src/session/cockpit-layout.js';
import type { SessionState } from '../../src/session/model.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function state(): SessionState {
  const blocks = Array.from({ length: 6 }, (_, i) => ({
    kind: 'you' as const,
    text: `conversa ${i}`,
  }));
  return {
    phase: 'idle',
    blocks,
    mode: 'normal',
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 10, windowPct: 1 },
  } as unknown as SessionState;
}

function renderCockpit(input: string, cursorPos: number, rows = 24, cols = 100) {
  // o caller (App) deriva composerLines do input; aqui replicamos p/ o layout.
  const composerLines = input.length === 0 ? 1 : input.split('\n').length;
  const layout = resolveCockpitLayout(rows, cols, composerLines);
  if (layout.kind !== 'cockpit') throw new Error('layout deveria caber');
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <I18nProvider value={makeI18n('pt-BR')}>
        <Cockpit
          state={state()}
          layout={layout}
          logSections={[]}
          focus="conversa"
          conversaScroll={0}
          logScroll={0}
          input={input}
          cursorPos={cursorPos}
          composerActive
          showCursor={false}
          hintState="idle"
          tierDisplay="Flux"
          isDefaultTier
          columns={cols}
          frame={0}
          cwd="/proj"
        />
      </I18nProvider>
    </ThemeProvider>,
  );
  return { r, layout };
}

describe('cockpit composer multi-linha (BUG P2-C)', () => {
  it('com 3 linhas as 3 APARECEM no frame e o frame cabe em rows (§5)', async () => {
    const input = 'LINHA_UM\nLINHA_DOIS\nLINHA_TRES';
    const { r, layout } = renderCockpit(input, input.length);
    await flush();
    const frame = plain(r.lastFrame() ?? '');
    // (a) o conteúdo das 3 linhas está visível — NADA some.
    expect(frame).toContain('LINHA_UM');
    expect(frame).toContain('LINHA_DOIS');
    expect(frame).toContain('LINHA_TRES');
    // o composer reservou 3 linhas (cresceu) — paridade com o inline.
    expect(layout.composerRows).toBe(3);
    // (b) o frame ainda cabe em rows (não estoura ⇒ sem reflow/clear).
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    expect(frame).not.toContain('\x1b[2J');
    r.unmount();
  });

  it('1 linha ⇒ INALTERADO: composer = 1 linha, sem marcador de "+linhas"', async () => {
    const { r, layout } = renderCockpit('uma linha só', 5);
    await flush();
    const frame = plain(r.lastFrame() ?? '');
    expect(layout.composerRows).toBe(1);
    expect(frame).toContain('uma linha só');
    // nenhuma seta de linhas escondidas no caso comum.
    expect(frame).not.toMatch(/↑\d|↓\d/);
    r.unmount();
  });

  it('input que ESTOURA o teto ⇒ janela mostra a cauda (linha do cursor) + marcador ↑N', async () => {
    // 9 linhas; o teto é 5 ⇒ janela de 4 linhas de texto + 1 de marcador.
    const lines = Array.from({ length: 9 }, (_, i) => `L${i}_marcada`);
    const input = lines.join('\n');
    const { r, layout } = renderCockpit(input, input.length); // cursor no FIM
    await flush();
    const frame = plain(r.lastFrame() ?? '');
    // a cauda (onde o cursor está) está visível: a última linha aparece.
    expect(frame).toContain('L8_marcada');
    // a 1ª linha foi janelada p/ fora (não cabe) — mas o usuário SABE via marcador.
    expect(frame).not.toContain('L0_marcada');
    expect(frame).toMatch(/↑\d/);
    // o composer saturou no teto e o frame cabe em rows (§5 preservado).
    expect(layout.composerRows).toBe(5);
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    r.unmount();
  });
});
