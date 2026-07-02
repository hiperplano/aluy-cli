// EST-1015 (UX do cockpit) — PROVA-VERMELHO do "texto embaralhado/sobreposto" no FRAME.
//
// Com a janela ANTIGA (por nº de blocos), uma conversa mais ALTA que a região estourava
// a Box fixa e o Ink MESCLAVA linhas: o rótulo `▌ você` e a fala da linha seguinte
// colavam na MESMA linha (`▌ objetivo 3: …`), idem `Λ aluy` + fala (`Λ Gerado o …`).
// Este teste monta o <Cockpit> REAL (ink-testing-library) com uma conversa alta e prova:
//   (a) NENHUMA linha mescla rótulo+fala (toda linha `▌ …` é exatamente `▌ você`);
//   (b) o frame cabe em `rows` (§5 — nada reflui);
//   (c) o indicador `↑N` aparece (há blocos escondidos ACIMA — a janela é honesta).
// FALHA-SEM/PASSA-COM: com o windowing por blocos, (a) e (c) quebram.

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

/** Conversa ALTA: 12 turnos you+aluy (~7 linhas cada par) ⇒ não cabe em 24 rows. */
function tallState(): SessionState {
  const blocks: SessionState['blocks'][number][] = [];
  for (let i = 0; i < 12; i += 1) {
    blocks.push({ kind: 'you', text: `objetivo ${i}: gere o componente ${i}` });
    blocks.push({
      kind: 'aluy',
      text: `Gerado o componente ${i}.\nA prop density controla o espaçamento.`,
      streaming: false,
    });
  }
  return {
    phase: 'idle',
    blocks,
    mode: 'normal',
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 10, windowPct: 1 },
  } as unknown as SessionState;
}

function renderCockpit(rows = 24, cols = 100) {
  const layout = resolveCockpitLayout(rows, cols);
  if (layout.kind !== 'cockpit') throw new Error('layout deveria caber');
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <I18nProvider value={makeI18n('pt-BR')}>
        <Cockpit
          state={tallState()}
          layout={layout}
          logSections={[]}
          focus="conversa"
          conversaScroll={0}
          logScroll={0}
          input=""
          cursorPos={0}
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

describe('cockpit conversa — janela por LINHAS VISUAIS (anti-mesclagem)', () => {
  it('conversa alta: nenhuma linha mescla rótulo+fala; frame ≤ rows; ↑N honesto', async () => {
    const { r } = renderCockpit();
    await flush();
    const frame = plain(r.lastFrame() ?? '');
    const lines = frame.split('\n');
    // (b) o frame cabe em rows (o grid não reflui — §5).
    expect(lines.length).toBeLessThanOrEqual(24);
    // (a) TODO rótulo de turno é uma linha "pura": `▌ você` (nada colado depois) e
    // `Λ aluy`. Com o bug, apareciam `▌ objetivo 3: …` / `Λ Gerado o …` (mesclados).
    for (const ln of lines) {
      const t = ln.trimEnd();
      if (t.startsWith('▌') && !t.startsWith('▌ conversa')) {
        expect(t).toBe('▌ você');
      }
      if (/^Λ /.test(t) && !t.startsWith('Λ Aluy Cli')) {
        expect(t).toBe('Λ aluy');
      }
    }
    // a fala em si está visível (indentada, não mesclada) — a cauda é o turno 11.
    expect(frame).toContain('Gerado o componente 11.');
    // (c) há blocos escondidos acima e o indicador diz isso.
    expect(frame).toMatch(/↑\d+/);
    r.unmount();
  });

  it('conversa curta segue SEM indicador (caso comum inalterado)', async () => {
    const layout = resolveCockpitLayout(24, 100);
    if (layout.kind !== 'cockpit') throw new Error('layout deveria caber');
    const theme = resolveTheme({ env: ENV });
    const st = {
      phase: 'idle',
      blocks: [{ kind: 'you', text: 'oi' }],
      mode: 'normal',
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 10, windowPct: 1 },
    } as unknown as SessionState;
    const r = render(
      <ThemeProvider theme={theme}>
        <I18nProvider value={makeI18n('pt-BR')}>
          <Cockpit
            state={st}
            layout={layout}
            logSections={[]}
            focus="conversa"
            conversaScroll={0}
            logScroll={0}
            input=""
            cursorPos={0}
            composerActive
            showCursor={false}
            hintState="idle"
            tierDisplay="Flux"
            isDefaultTier
            columns={100}
            frame={0}
            cwd="/proj"
          />
        </I18nProvider>
      </ThemeProvider>,
    );
    await flush();
    const frame = plain(r.lastFrame() ?? '');
    expect(frame).toContain('▌ você');
    expect(frame).toContain('oi');
    expect(frame).not.toMatch(/↑\d+/);
    r.unmount();
  });
});
