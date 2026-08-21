// F-WIN (embutido) — catálogo ESTÁTICO de janelas conhecidas por FAMÍLIA de slug.
// Bateria:
//   - casamento de família: com/sem vendor, com/sem sufixo de data (compacto e ISO),
//     case-insensitive — o mesmo modelo aparece nessas 3+ formas em providers reais;
//   - não-inventa versão: `gpt-4` não pode casar/perder dígito p/ virar outra família;
//   - slug fora do catálogo ⇒ `undefined` (fail-open — quem decide o fallback de 0 é
//     `resolveContextWindow`, este módulo só responde "conheço essa família?").

import { describe, expect, it } from 'vitest';
import {
  KNOWN_MODEL_CONTEXT_WINDOWS,
  normalizeModelFamily,
  builtinContextWindowForSlug,
} from '../../../src/model/local/known-context-windows.js';

describe('normalizeModelFamily', () => {
  it('remove o prefixo de vendor (até a última "/")', () => {
    expect(normalizeModelFamily('deepseek/deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(normalizeModelFamily('openrouter/deepseek/deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  it('remove sufixo de data compacto (4/6/8 dígitos) no fim', () => {
    expect(normalizeModelFamily('deepseek-v4-pro-0813')).toBe('deepseek-v4-pro'); // MMDD
    expect(normalizeModelFamily('deepseek-v4-pro-250813')).toBe('deepseek-v4-pro'); // AAMMDD
    expect(normalizeModelFamily('deepseek-v4-pro-20250813')).toBe('deepseek-v4-pro'); // AAAAMMDD
  });

  it('remove sufixo de data ISO com traço no fim', () => {
    expect(normalizeModelFamily('claude-sonnet-4-2025-08-13')).toBe('claude-sonnet-4');
  });

  it('lowercase — case-insensitive', () => {
    expect(normalizeModelFamily('DeepSeek/DeepSeek-V4-Pro-0813')).toBe('deepseek-v4-pro');
    expect(normalizeModelFamily('GPT-4O')).toBe('gpt-4o');
  });

  it('combina vendor + data + caixa ao mesmo tempo', () => {
    expect(normalizeModelFamily('DeepSeek/DEEPSEEK-v4-PRO-0813')).toBe('deepseek-v4-pro');
  });

  it('sem sufixo de data nem vendor — passa quase intocado (só lowercase)', () => {
    expect(normalizeModelFamily('deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  it('NÃO remove número de versão curto — "gpt-4" não vira "gpt"', () => {
    // Só sufixos de data (4/6/8 dígitos) são removidos; "-4" tem 1 dígito, fica.
    expect(normalizeModelFamily('gpt-4')).toBe('gpt-4');
    expect(normalizeModelFamily('gpt-4o')).toBe('gpt-4o');
    expect(normalizeModelFamily('qwen2.5')).toBe('qwen2.5');
  });
});

describe('builtinContextWindowForSlug — casamento por família (F-WIN embutido)', () => {
  it('o caso reportado: "deepseek/deepseek-v4-pro-0813" (vendor + data) ⇒ 128k', () => {
    expect(builtinContextWindowForSlug('deepseek/deepseek-v4-pro-0813')).toBe(128_000);
  });

  it('MESMA família em 4 grafias diferentes ⇒ MESMO número', () => {
    const variants = [
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-pro-0813',
      'deepseek-v4-pro',
      'DeepSeek/DeepSeek-V4-Pro-0813',
    ];
    for (const slug of variants) {
      expect(builtinContextWindowForSlug(slug)).toBe(128_000);
    }
  });

  it('deepseek-v4-flash (Flui) ⇒ 256k, distinto do v4-pro', () => {
    expect(builtinContextWindowForSlug('deepseek/deepseek-v4-flash')).toBe(256_000);
    expect(builtinContextWindowForSlug('deepseek/deepseek-v4-flash-0813')).toBe(256_000);
  });

  it('outras famílias prioritárias do dono: qwen, claude, gpt, gemini, llama', () => {
    expect(builtinContextWindowForSlug('qwen/qwen2.5-72b-instruct')).toBe(128_000);
    expect(builtinContextWindowForSlug('anthropic/claude-sonnet-4-5-20250929')).toBe(200_000);
    expect(builtinContextWindowForSlug('openai/gpt-4o-2024-11-20')).toBe(128_000);
    expect(builtinContextWindowForSlug('google/gemini-1.5-pro')).toBe(2_000_000);
    expect(builtinContextWindowForSlug('meta/llama-4-scout')).toBe(10_000_000);
  });

  it('slug DESCONHECIDO (fora do catálogo) ⇒ undefined — nunca chuta', () => {
    expect(builtinContextWindowForSlug('acme/modelo-inventado-xyz')).toBeUndefined();
    expect(builtinContextWindowForSlug('deepseek/deepseek-v99-ultra')).toBeUndefined();
  });

  it('vazio/undefined ⇒ undefined, nunca lança', () => {
    expect(builtinContextWindowForSlug(undefined)).toBeUndefined();
    expect(builtinContextWindowForSlug('')).toBeUndefined();
    expect(builtinContextWindowForSlug('   ')).toBeUndefined();
  });

  it('todo valor do catálogo é um inteiro positivo plausível', () => {
    for (const [family, window] of Object.entries(KNOWN_MODEL_CONTEXT_WINDOWS)) {
      expect(Number.isInteger(window), `família ${family}`).toBe(true);
      expect(window, `família ${family}`).toBeGreaterThan(0);
    }
  });
});
