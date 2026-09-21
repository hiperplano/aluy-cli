// A mensagem de "sem credencial" citava `undefined=...` como a env var a configurar, para
// TODO provider fora dos três originais (deepseek, groq, z.ai, qualquer custom). Medido em
// 21/09/2026 ao estrear a z.ai no catálogo:
//
//   backend local: sem credencial apikey p/ "zai-coding". configure a chave:
//   `undefined=...` (env) ou `aluy login --provider zai-coding`
//
// O resolvedor SEMPRE leu a env genérica (`ALUY_<PROVIDER>_API_KEY`); só a mensagem
// consultava o mapa dos três e imprimia o buraco. É a primeira tela de quem acabou de
// escolher um provider novo — e mandava configurar uma variável que não existe.
import { describe, expect, it } from 'vitest';
import {
  MissingLocalCredentialError,
  genericApiKeyEnvName,
} from '../../../src/model/local/credential-resolver.js';

describe('MissingLocalCredentialError — a env var citada existe de verdade', () => {
  it('provider fora dos três originais ⇒ cita a env GENÉRICA, nunca `undefined`', () => {
    for (const p of ['zai-coding', 'zai', 'deepseek', 'groq', 'meu-gateway']) {
      const msg = new MissingLocalCredentialError(p, 'apikey').message;
      expect(msg, p).not.toContain('undefined');
      expect(msg, p).toContain(`${genericApiKeyEnvName(p)}=...`);
    }
  });

  // A env citada tem de ser a que o resolvedor LÊ — senão a mensagem troca um erro por outro.
  it('o nome genérico da z.ai é o esperado', () => {
    expect(genericApiKeyEnvName('zai-coding')).toBe('ALUY_ZAI_CODING_API_KEY');
  });

  it('os três originais seguem citando a env dedicada (não-regressão)', () => {
    expect(new MissingLocalCredentialError('openrouter', 'apikey').message).toContain(
      'OPENROUTER_API_KEY=...',
    );
    expect(new MissingLocalCredentialError('anthropic', 'apikey').message).toContain(
      'ANTHROPIC_API_KEY=...',
    );
  });

  // O outro ramo da mensagem: keychain FALHOU (≠ nunca configurado). Mesmo buraco, mesmo conserto.
  it('no ramo de falha do keychain a env também é real', () => {
    const msg = new MissingLocalCredentialError('zai-coding', 'apikey', 'DBus fora').message;
    expect(msg).not.toContain('undefined');
    expect(msg).toContain('ALUY_ZAI_CODING_API_KEY=...');
  });
});
