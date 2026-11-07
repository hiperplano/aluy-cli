// ADR 0005 — a caixa da catraca diz QUANDO o comando usa um segredo do `/secret`
// (`⚠ usa o segredo $NOME`): só o NOME, nunca o valor, em todo caminho (default, rede).
// Antes o dono via um `ask ─ bash` sem pista, ou só `rede · ask · destino fora da allowlist`.

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { secretVault, type AskRequest } from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { AskDialog } from '../../src/ui/components/AskDialog.js';

const ESC = String.fromCharCode(27);
const plain = (s: string | undefined): string =>
  (s ?? '').replace(new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g'), '');
const VALOR = 'valor-ultra-secreto-9f3a';

function ask(exact: string, category: AskRequest['category']): AskRequest {
  return {
    call: { name: 'run_command', input: { command: exact } },
    effect: { kind: 'command', tool: 'run_command', exact },
    category,
    reason: 'x',
    alwaysAsk: true,
  } as AskRequest;
}

function mount(
  req: AskRequest,
  extra: { egressOutsideAllowlist?: boolean; egressTarget?: string } = {},
): string {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  const r = render(
    <ThemeProvider theme={theme}>
      <AskDialog request={req} {...extra} />
    </ThemeProvider>,
  );
  const out = plain(r.lastFrame());
  r.unmount();
  return out;
}

afterEach(() => secretVault.clear());

describe('<AskDialog> sinaliza o uso de segredo', () => {
  it('comando comum que cita $API_KEY ⇒ linha "usa o segredo $API_KEY", sem o valor', () => {
    secretVault.set('API_KEY', VALOR);
    const out = mount(ask('test -n "$API_KEY" && echo definida', 'always-ask:secret-use'));
    expect(out).toContain('usa o segredo $API_KEY');
    expect(out).not.toContain(VALOR);
  });

  it('caminho de REDE (curl + destino fora da allowlist) mostra as DUAS pistas', () => {
    secretVault.set('API_KEY', VALOR);
    const out = mount(ask('curl -H "k: $API_KEY" http://127.0.0.1:9/', 'always-ask:secret-use'), {
      egressOutsideAllowlist: true,
      egressTarget: '127.0.0.1:9',
    });
    expect(out).toContain('usa o segredo $API_KEY');
    expect(out).toContain('destino fora da allowlist');
    expect(out).not.toContain(VALOR);
  });

  it('sem segredo citado ⇒ nenhuma linha de segredo', () => {
    secretVault.set('API_KEY', VALOR);
    expect(mount(ask('echo oi', 'default'))).not.toContain('usa o segredo');
  });
});
