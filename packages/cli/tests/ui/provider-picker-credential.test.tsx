// F-PROV-CRED — render do passo de credencial do <ProviderPicker> (ink-testing-library).
// A prova que mais importa aqui (pedido explícito do dono, custou uma rotação de chave
// real na rc.135): o valor DIGITADO nunca aparece cru no frame renderizado — só `•`.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveThemeByName } from '../../src/ui/theme/themes.js';
import { ProviderPicker, maskValue } from '../../src/ui/components/ProviderPicker.js';
import { PROVIDERS } from '../../src/model/providers.js';

const TRUE_ENV = { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

function wrap(node: React.ReactElement, themeName = 'aluy-dark') {
  const theme = resolveThemeByName(themeName, { env: TRUE_ENV });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

describe('maskValue — pura', () => {
  it('devolve um • por caractere, nunca o texto', () => {
    expect(maskValue('sk-abc123')).toBe('•'.repeat('sk-abc123'.length));
  });

  it('string vazia ⇒ máscara vazia', () => {
    expect(maskValue('')).toBe('');
  });

  it('a máscara NUNCA contém o valor original, pra qualquer chave plausível', () => {
    const secrets = ['sk-ant-api03-XYZ', 'a', 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'];
    for (const s of secrets) {
      expect(maskValue(s)).not.toContain(s);
      expect(maskValue(s)).toMatch(/^•*$/);
      expect(maskValue(s).length).toBe(s.length);
    }
  });
});

describe('<ProviderPicker> — passo de credencial (render)', () => {
  it('NUNCA renderiza o valor digitado cru — só a máscara (•), mesmo caractere a caractere', () => {
    const SECRET = 'sk-live-super-secreta-999';
    const { lastFrame } = wrap(
      <ProviderPicker
        providers={PROVIDERS}
        selected={0}
        credentialStep="key"
        credentialProviderId="google"
        credentialDraft={SECRET}
        credentialError=""
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain(SECRET);
    // nenhum PREFIXO/SUFIXO parcial da chave escapa por engano (ex.: só os 3 primeiros chars).
    for (let i = 3; i <= SECRET.length; i++) {
      expect(out).not.toContain(SECRET.slice(0, i));
    }
    expect(out).toContain('•'.repeat(SECRET.length));
  });

  it('o NOME do provider aparece (dado público), mas nunca base_url/api_key (HG-2/CLI-SEC-7)', () => {
    const out = plain(
      wrap(
        <ProviderPicker
          providers={PROVIDERS}
          selected={0}
          credentialStep="key"
          credentialProviderId="google"
          credentialDraft="segredo"
          credentialError=""
        />,
      ).lastFrame() ?? '',
    );
    expect(out).toContain('google');
    expect(out.toLowerCase()).not.toContain('segredo');
    expect(out.toLowerCase()).not.toContain('api_key');
    expect(out.toLowerCase()).not.toContain('base_url');
  });

  it('campo VAZIO (rascunho ainda não digitado) ⇒ sem • nenhum (não finge conteúdo)', () => {
    const out = plain(
      wrap(
        <ProviderPicker
          providers={PROVIDERS}
          selected={0}
          credentialStep="key"
          credentialProviderId="google"
          credentialDraft=""
          credentialError=""
        />,
      ).lastFrame() ?? '',
    );
    expect(out).not.toContain('•');
  });

  it('SEM erro (1ª tentativa): não mostra o título de retry', () => {
    const out = plain(
      wrap(
        <ProviderPicker
          providers={PROVIDERS}
          selected={0}
          credentialStep="key"
          credentialProviderId="google"
          credentialDraft=""
          credentialError=""
        />,
      ).lastFrame() ?? '',
    );
    expect(out).not.toContain('não passou no teste');
  });

  it('COM erro (retry): mostra o motivo do teste anterior, mas NUNCA uma chave dentro dele', () => {
    const detail = 'provider "google" NÃO respondeu ao teste: 401 unauthorized';
    const out = plain(
      wrap(
        <ProviderPicker
          providers={PROVIDERS}
          selected={0}
          credentialStep="key"
          credentialProviderId="google"
          credentialDraft=""
          credentialError={detail}
        />,
      ).lastFrame() ?? '',
    );
    expect(out).toContain('não passou no teste');
    expect(out).toContain(detail);
  });

  it('credentialStep null/ausente ⇒ mostra a LISTA normal, não o campo', () => {
    const out = plain(
      wrap(<ProviderPicker providers={PROVIDERS} selected={0} credentialStep={null} />).lastFrame() ?? '',
    );
    expect(out).toContain('OpenRouter');
  });
});
