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
