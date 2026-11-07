// F-WIN (embutido) — degrau NOVO de `resolveContextWindow`: quando o dono não declarou
// NADA (env/config.context.window/contextByModel) e a descoberta ao vivo não achou
// nada (o caso medido em campo: gateway que responde `/models` sem `context_length`
// nenhum), o CATÁLOGO EMBUTIDO (`@hiperplano/aluy-cli-core`, casado por FAMÍLIA de
// slug) preenche a janela p/ modelos PUBLICAMENTE conhecidos — em vez de ficar 0/inerte.
//
// Bateria:
//   - casamento de família chega até `resolveContextWindow` (com/sem vendor, com/sem
//     sufixo de data, case-insensitive — o slug exato do relato do dono);
//   - PRECEDÊNCIA: declarado (config/env/contextByModel) NUNCA perde p/ o embutido;
//   - NÃO-REGRESSÃO do F134: slug DESCONHECIDO em `custom` continua 0 (size-aware do
//     Compactor OFF) — o embutido não ressuscita o chute de 200k que o F134 proibiu.

import { describe, expect, it } from 'vitest';
import { resolveContextWindow, CONTEXT_WINDOW_ENV } from '../../src/model/catalog.js';

describe('resolveContextWindow — degrau EMBUTIDO (F-WIN)', () => {
  it('o caso reportado: "deepseek/deepseek-v4-pro-0813" em custom, sem NADA declarado ⇒ 128k (não mais 0)', () => {
    expect(
      resolveContextWindow('custom', {}, undefined, undefined, undefined, 'deepseek/deepseek-v4-pro-0813'),
    ).toBe(128_000);
  });

  it('MESMA família casa com/sem vendor, com/sem sufixo de data, case-insensitive', () => {
    const variants = [
      'deepseek/deepseek-v4-pro',
      'deepseek-v4-pro',
      'deepseek/deepseek-v4-pro-0813',
      'DeepSeek/DeepSeek-V4-Pro-0813',
      'DEEPSEEK-V4-PRO',
    ];
    for (const slug of variants) {
      expect(resolveContextWindow('custom', {}, undefined, undefined, undefined, slug)).toBe(
        128_000,
      );
    }
  });

  it('outras famílias prioritárias (qwen/claude/gpt/gemini/llama) resolvem pelo embutido', () => {
    expect(
      resolveContextWindow('custom', {}, undefined, undefined, undefined, 'qwen/qwen2.5-72b-instruct'),
    ).toBe(128_000);
    expect(
      resolveContextWindow(
        'custom',
        {},
        undefined,
        undefined,
        undefined,
        'anthropic/claude-sonnet-4-5-20250929',
      ),
    ).toBe(200_000);
    expect(
      resolveContextWindow('custom', {}, undefined, undefined, undefined, 'openai/gpt-4o-2024-11-20'),
    ).toBe(128_000);
  });

  // ── PRECEDÊNCIA: declarado/descoberto/env NUNCA perdem p/ o embutido ─────────────

  it('janela DECLARADA por modelo (contextByModel/descoberta) VENCE o embutido', () => {
    // O dono (ou a descoberta ao vivo) declarou 64k p/ este slug — mesmo tendo família
    // conhecida (128k), o número do dono manda (ele pode ter um motivo: provider que
    // corta a janela).
    expect(
      resolveContextWindow('custom', {}, undefined, undefined, 64_000, 'deepseek/deepseek-v4-pro'),
    ).toBe(64_000);
  });

  it('`config.context.window` VENCE o embutido', () => {
    expect(
      resolveContextWindow('custom', {}, undefined, 50_000, undefined, 'deepseek/deepseek-v4-pro'),
    ).toBe(50_000);
  });

  it('`ALUY_CONTEXT_WINDOW` (env) VENCE o embutido — precedência intacta com o degrau novo', () => {
    expect(
      resolveContextWindow(
        'custom',
        { [CONTEXT_WINDOW_ENV]: '32k' },
        undefined,
        undefined,
        undefined,
        'deepseek/deepseek-v4-pro',
      ),
    ).toBe(32_000);
  });

  it('tier CANÔNICO conhecido VENCE o embutido (broker é a fonte da verdade)', () => {
    // aluy-strata resolve 128k pelo fallback do tier, INDEPENDENTE do slug/embutido.
    expect(
      resolveContextWindow('aluy-strata', {}, undefined, undefined, undefined, 'gpt-4o'),
    ).toBe(128_000);
  });

  // ── NÃO-REGRESSÃO F134: slug DESCONHECIDO continua 0/inerte ──────────────────────

  it('F134 preservado — slug DESCONHECIDO em custom continua 0 (size-aware do Compactor OFF)', () => {
    expect(
      resolveContextWindow('custom', {}, undefined, undefined, undefined, 'acme/modelo-inventado-xyz'),
    ).toBe(0);
  });

  it('F134 preservado — SEM slug nenhum (undefined), comportamento IDÊNTICO a antes deste degrau', () => {
    expect(resolveContextWindow('custom', {}, undefined, undefined, undefined, undefined)).toBe(0);
    // Chamada com a assinatura ANTIGA (sem o 6º parâmetro) — zero regressão de call sites.
    expect(resolveContextWindow('custom', {}, undefined, undefined, undefined)).toBe(0);
    expect(resolveContextWindow('custom')).toBe(0);
  });

  it('F134 preservado — custom SEM env/config/modelWindow e SEM slug reconhecido: mesma cadeia de antes', () => {
    expect(
      resolveContextWindow('custom', { [CONTEXT_WINDOW_ENV]: 'lixo' }, undefined, -5, undefined, 'x/y-z'),
    ).toBe(0);
  });
});
