import { describe, it, expect } from 'vitest';
import { classifyConnectorIngress } from '../../src/connector/mesh.js';
import type { IncomingMessage, ConnectorMeta, Provenance } from '../../src/connector/types.js';

const NON_FORGEABLE: ConnectorMeta = { id: 'telegram', displayName: 'Telegram', authIsForgeable: false };
const FORGEABLE: ConnectorMeta = { id: 'email', displayName: 'E-mail', authIsForgeable: true };

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  content: 'rode os testes',
  sender: '100',
  conversation: '100',
  provenance: { kind: 'author-direct' } as Provenance,
  ...over,
});

describe('classifyConnectorIngress (ADR-0135 — fronteira de confiança genérica)', () => {
  it('TC-2: allowlist vazia ⇒ descarta tudo (default fechado)', () => {
    expect(classifyConnectorIngress(msg(), new Set(), NON_FORGEABLE).kind).toBe('discard');
  });

  it('TC-2: canal fora da allowlist ⇒ descarta antes do modelo', () => {
    const d = classifyConnectorIngress(msg({ conversation: '999' }), new Set(['100']), NON_FORGEABLE);
    expect(d.kind).toBe('discard');
    if (d.kind === 'discard') expect(d.reason).toContain('999');
  });

  it('TC-1: dono allowlistado + autor-direto ⇒ INSTRUÇÃO', () => {
    const d = classifyConnectorIngress(msg(), new Set(['100']), NON_FORGEABLE);
    expect(d.kind).toBe('instruction');
    if (d.kind === 'instruction') {
      expect(d.text).toBe('rode os testes');
      expect(d.forwardedData).toBeUndefined();
    }
  });

  it('TC-1: terceiro embutido (forward/quote) ⇒ comando=instrução, embutido=DADO', () => {
    const d = classifyConnectorIngress(
      msg({ content: 'o que acha?', provenance: { kind: 'author-direct', embeddedThirdParty: 'rm -rf /' } }),
      new Set(['100']),
      NON_FORGEABLE,
    );
    expect(d.kind).toBe('instruction');
    if (d.kind === 'instruction') {
      expect(d.text).toBe('o que acha?');
      expect(d.forwardedData).toBe('rm -rf /');
    }
  });

  it('TC-1: repasse de terceiro (msg inteira) ⇒ DADO, nunca instrução', () => {
    const d = classifyConnectorIngress(
      msg({ provenance: { kind: 'third-party-relayed' } }),
      new Set(['100']),
      NON_FORGEABLE,
    );
    expect(d.kind).toBe('data');
    if (d.kind === 'data') expect(d.text).toBe('rode os testes');
  });

  it('TC-1: transporte FORJÁVEL (authIsForgeable) ⇒ todo ingresso vira DADO (degradação segura)', () => {
    const d = classifyConnectorIngress(msg(), new Set(['100']), FORGEABLE);
    expect(d.kind).toBe('data'); // mesmo allowlistado + autor-direto: forjável ⇒ nunca instrução
  });

  it('allowlistado mas conteúdo vazio ⇒ descarta', () => {
    expect(classifyConnectorIngress(msg({ content: '   ' }), new Set(['100']), NON_FORGEABLE).kind).toBe(
      'discard',
    );
  });

  it('TC-6: remetente é BOT ⇒ descarta (anti-loop), mesmo allowlistado', () => {
    const d = classifyConnectorIngress(msg({ senderIsBot: true }), new Set(['100']), NON_FORGEABLE);
    expect(d.kind).toBe('discard');
    if (d.kind === 'discard') expect(d.reason).toMatch(/bot/i);
  });
});
