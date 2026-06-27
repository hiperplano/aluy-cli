// FONTE ÚNICA das URLs de sidecar — env-configuráveis (paridade c/ broker/headroom),
// antes hardcodadas (literais :11435/:11434) espalhadas por engine+wiring+doctor.

import { describe, expect, it } from 'vitest';
import {
  resolveMem0Url,
  resolveOllamaUrl,
  resolveHeadroomProbeUrl,
} from '../../src/maestro/sidecar-urls.js';

describe('sidecar-urls — URLs env-configuráveis', () => {
  it('mem0: default loopback :11435; ALUY_MEM0_URL sobrepõe', () => {
    expect(resolveMem0Url({})).toBe('http://127.0.0.1:11435');
    expect(resolveMem0Url({ ALUY_MEM0_URL: 'http://10.0.0.5:9999' })).toBe('http://10.0.0.5:9999');
  });

  it('ollama: default loopback :11434; ALUY_OLLAMA_URL sobrepõe', () => {
    expect(resolveOllamaUrl({})).toBe('http://127.0.0.1:11434');
    expect(resolveOllamaUrl({ ALUY_OLLAMA_URL: 'http://host:1234' })).toBe('http://host:1234');
  });

  it('headroom (probe): default loopback :8787; ALUY_HEADROOM_URL sobrepõe', () => {
    expect(resolveHeadroomProbeUrl({})).toBe('http://127.0.0.1:8787');
    expect(resolveHeadroomProbeUrl({ ALUY_HEADROOM_URL: 'http://hr:7' })).toBe('http://hr:7');
  });

  it('vazio/whitespace ⇒ default (não aceita lixo)', () => {
    expect(resolveMem0Url({ ALUY_MEM0_URL: '' })).toBe('http://127.0.0.1:11435');
    expect(resolveMem0Url({ ALUY_MEM0_URL: '   ' })).toBe('http://127.0.0.1:11435');
    expect(resolveOllamaUrl({ ALUY_OLLAMA_URL: '  ' })).toBe('http://127.0.0.1:11434');
  });
});

describe('sidecar-urls — config único services (ADR-0136 §8): precedência URL>HOST/PORT>services>default', () => {
  it('services.ollama.port/host monta a URL quando não há env', () => {
    expect(resolveOllamaUrl({}, { ollama: { port: 11500 } })).toBe('http://127.0.0.1:11500');
    expect(resolveOllamaUrl({}, { ollama: { host: 'localhost', port: 11500 } })).toBe(
      'http://localhost:11500',
    );
  });

  it('env HOST/PORT vence services (config)', () => {
    expect(resolveOllamaUrl({ ALUY_OLLAMA_PORT: '12000' }, { ollama: { port: 11500 } })).toBe(
      'http://127.0.0.1:12000',
    );
    expect(resolveMem0Url({ ALUY_MEM0_HOST: '127.0.0.2' }, { mem0: { host: '127.0.0.9' } })).toBe(
      'http://127.0.0.2:11435',
    );
  });

  it('URL inteira (env) vence HOST/PORT e services (a mais específica)', () => {
    expect(
      resolveOllamaUrl(
        { ALUY_OLLAMA_URL: 'http://gpu:1', ALUY_OLLAMA_PORT: '12000' },
        { ollama: { port: 11500 } },
      ),
    ).toBe('http://gpu:1');
  });

  it('mem0/headroom também honram services', () => {
    expect(resolveMem0Url({}, { mem0: { port: 11600 } })).toBe('http://127.0.0.1:11600');
    expect(resolveHeadroomProbeUrl({}, { headroom: { port: 8888 } })).toBe('http://127.0.0.1:8888');
  });

  it('services ausente/parcial ⇒ default (sub-objeto só de host usa porta default)', () => {
    expect(resolveOllamaUrl({}, {})).toBe('http://127.0.0.1:11434');
    expect(resolveOllamaUrl({}, { ollama: { host: '127.0.0.5' } })).toBe('http://127.0.0.5:11434');
  });

  it('porta env inválida ⇒ ignora e cai p/ services depois default', () => {
    expect(resolveOllamaUrl({ ALUY_OLLAMA_PORT: 'abc' }, { ollama: { port: 11500 } })).toBe(
      'http://127.0.0.1:11500',
    );
    expect(resolveOllamaUrl({ ALUY_OLLAMA_PORT: '70000' }, {})).toBe('http://127.0.0.1:11434');
  });
});
