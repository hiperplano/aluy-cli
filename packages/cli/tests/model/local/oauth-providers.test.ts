// ADR-0120 / EST-1114 — catálogo OAuth (resolve client_id via env; recusa se faltar).
import { describe, expect, it } from 'vitest';
import {
  resolveOAuthProviderConfig,
  DEFAULT_REDIRECT_URI,
} from '../../../src/model/local/oauth-providers.js';

describe('resolveOAuthProviderConfig', () => {
  it('resolve anthropic com client_id da env', () => {
    const c = resolveOAuthProviderConfig('anthropic', { ALUY_OAUTH_ANTHROPIC_CLIENT_ID: 'cid' });
    expect(c.clientId).toBe('cid');
    expect(c.redirectUri).toBe(DEFAULT_REDIRECT_URI);
    expect(c.tokenUrl).toMatch(/^https:\/\//);
  });

  it('recusa quando o client_id não foi configurado (erro acionável)', () => {
    expect(() => resolveOAuthProviderConfig('anthropic', {})).toThrow(/client_id/i);
  });

  it('recusa provider sem via OAuth (openrouter ⇒ API key)', () => {
    expect(() => resolveOAuthProviderConfig('openrouter', {})).toThrow(/não tem via OAuth/i);
  });

  it('permite override do redirect_uri por env', () => {
    const c = resolveOAuthProviderConfig('openai', {
      ALUY_OAUTH_OPENAI_CLIENT_ID: 'oid',
      ALUY_OAUTH_REDIRECT_URI: 'http://127.0.0.1:55555/cb',
    });
    expect(c.redirectUri).toBe('http://127.0.0.1:55555/cb');
  });
});
