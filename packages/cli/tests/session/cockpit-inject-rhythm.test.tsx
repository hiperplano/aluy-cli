// Cockpit: o `↳ encaixado` não paga respiro de baixo; o bloco seguinte paga o de cima
// (`aposInject`), no MESMO número que `fitConversaWindow` mediu. Prova no <Cockpit> REAL.
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
const plain = (s: string): string => s.replace(new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g'), '');

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

async function quadro(blocks: SessionState['blocks']): Promise<string[]> {
  const layout = resolveCockpitLayout(30, 100);
  if (layout.kind !== 'cockpit') throw new Error('layout deveria caber');
  const state = {
    phase: 'idle',
    blocks,
    mode: 'normal',
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 1, windowPct: 1 },
  } as unknown as SessionState;
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } })}>
      <I18nProvider value={makeI18n('pt-BR')}>
        <Cockpit
          state={state}
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
  return plain(r.lastFrame() ?? '')
    .split('\n')
    .map((l) => l.trim());
}

describe('cockpit — respiro depois do `↳ encaixado`', () => {
  it('notas coladas entre si; UMA linha em branco antes do bloco seguinte', async () => {
    const l = await quadro([
      { kind: 'you', text: 'faça X' },
      { kind: 'inject', text: 'um' },
      { kind: 'inject', text: 'dois' },
      { kind: 'note', title: 'marco', lines: ['depois'] },
    ]);
    const i = l.findIndex((x) => x.includes('↳ encaixado: um'));
    expect(i).toBeGreaterThan(-1);
    expect(l[i + 1]).toContain('↳ encaixado: dois');
    expect(l[i + 2]).toBe('');
    expect(l[i + 3]).not.toBe('');
  });
});
