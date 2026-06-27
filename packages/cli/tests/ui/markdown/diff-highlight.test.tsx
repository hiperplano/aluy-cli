// EST · acabamento TUI — o diff do AskDialog ganha syntax highlight MANTENDO os
// sinais de direção `‹/›` e as cores danger/success (CLI-SEC-9 intacto: o efeito
// EXATO continua exibido). Em NO_COLOR a direção sobrevive via glifo.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { AskRequest } from '@aluy/cli-core';
import { ThemeProvider } from '../../../src/ui/theme/context.js';
import { resolveTheme } from '../../../src/ui/theme/theme.js';
import { AskDialog } from '../../../src/ui/components/AskDialog.js';

function diffAsk(): AskRequest {
  return {
    call: { name: 'edit_file', input: { path: 'src/auth/session.ts', content: 'x' } },
    effect: {
      kind: 'diff',
      tool: 'edit_file',
      path: 'src/auth/session.ts',
      exact: [
        '--- src/auth/session.ts',
        '-import { httpClient } from "../net/http"',
        '+import { broker } from "@aluy/cli-core"',
      ].join('\n'),
    },
    category: 'default',
    reason: 'edit_file = ask com diff',
    alwaysAsk: false,
  };
}

function frame(env: NodeJS.ProcessEnv): string {
  const theme = resolveTheme({ env });
  const { lastFrame } = render(
    <ThemeProvider theme={theme}>
      <AskDialog request={diffAsk()} />
    </ThemeProvider>,
  );
  return lastFrame() ?? '';
}

describe('AskDialog diff — highlight sem perder ‹/› nem cores do sinal', () => {
  it('truecolor: mantém ‹/›, realça keyword e exibe o efeito EXATO', () => {
    const out = frame({ LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    // direção do diff preservada
    expect(out).toContain('‹');
    expect(out).toContain('›');
    // efeito EXATO continua visível (CLI-SEC-9)
    expect(out).toContain('httpClient');
    expect(out).toContain('@aluy/cli-core');
    // sinal de remoção em danger (#E5897C) e adição em success (#82CF9E)
    expect(out).toContain('229;137;124');
    expect(out).toContain('130;207;158');
    // keyword `import` realçada em accent (#DDA13F) no conteúdo
    expect(out).toContain('221;161;63');
  });

  it('NO_COLOR: direção sobrevive via glifo ‹/›, sem cor', () => {
    const out = frame({ LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' });
    expect(out).toContain('‹');
    expect(out).toContain('›');
    expect(out).not.toMatch(/\[38;2;/);
    expect(out).toContain('httpClient');
  });
});
