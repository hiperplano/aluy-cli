// BUGFIX (dogfooding, fix-usage-trailer-openai) — regressão do rodapé da TUI no backend
// LOCAL/BYO mostrando `local · <modelo> · <modelo>` em vez de `local · <provider> ·
// <modelo>`. CAUSA RAIZ: `buildSession` (wiring.ts) só copiava `opts.provider` p/
// `meta.provider` via `bootProvider`, uma variável gateada por `bootModel !== undefined`
// (i.e. `tier === 'custom'` + slug) — trava que faz sentido p/ o CALLER (o par
// `--provider`/`--model` do Custom só cabe no corpo da chamada colado a um slug Custom,
// HG-2) mas NUNCA deveria valer p/ o DISPLAY: no backend local comum (tier default,
// FORA de `custom`), `run.tsx` manda `opts.provider = localProviderForMeta` (o provider
// BYO resolvido, ex. `tokenrouter`) DE QUALQUER FORMA — e essa trava o descartava,
// deixando `meta.provider` sempre `undefined`. A StatusBar (`App.tsx`) então caía no
// fallback e só sobrava o MODELO (via `meta.activeModel`, populado após o 1º turno) —
// dando a impressão de duplicação onde devia aparecer o provider.
//
// Prova, direto no `buildSession` (sem subir toda a TUI): `opts.provider` chega em
// `controller.provider`/`state.meta.provider` já no BOOT, mesmo com o tier CANÔNICO
// (não-custom) — o caso do BYO comum. E confirma a NÃO-REGRESSÃO do par Custom
// (`tier:'custom'` + `--provider`/`--model`), que já funcionava.

import { describe, expect, it } from 'vitest';
import type { ModelClient } from '@hiperplano/aluy-cli-core';
import { buildSession, DEFAULT_TIER } from '../../src/session/wiring.js';

/** Broker/local-client stub mínimo — só precisa existir p/ o boot montar o caller. */
function stubClient(): ModelClient {
  return {
    async *stream() {
      yield { type: 'start' as const, id: 'r' };
      yield { type: 'delta' as const, content: 'ok.' };
      yield { type: 'usage' as const, input_tokens: 1, output_tokens: 1 };
      yield { type: 'done' as const, id: 'r' };
    },
    async call() {
      return {
        request_id: 'r',
        content: 'ok.',
        finish_reason: 'stop' as const,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}

describe('backend local — meta.provider nasce certo no BOOT (fix rodapé duplicado)', () => {
  it('tier CANÔNICO (default, fora de custom) + backend local: meta.provider = o provider BYO', () => {
    const s = buildSession({
      effectiveBackend: 'local',
      // tier ausente ⇒ DEFAULT_TIER (canônico) — o cenário BYO comum, SEM `--tier custom`.
      provider: 'tokenrouter',
      brokerClient: stubClient(),
    });
    expect(s.controller.tier).toBe(DEFAULT_TIER);
    // ANTES do fix: undefined (o `bootProvider` gateado descartava `opts.provider` aqui).
    expect(s.controller.provider).toBe('tokenrouter');
  });

  it('sem `opts.provider` (broker default): meta.provider segue undefined (não-regressão)', () => {
    const s = buildSession({
      effectiveBackend: 'broker',
      brokerClient: stubClient(),
    });
    expect(s.controller.provider).toBeUndefined();
  });

  it('via Custom (`tier:custom` + `--provider`/`--model` pareados): meta.provider segue saindo (não-regressão)', () => {
    const s = buildSession({
      effectiveBackend: 'broker',
      tier: 'custom',
      model: 'deepseek/deepseek-v4-pro',
      provider: 'deepseek',
      brokerClient: stubClient(),
    });
    expect(s.controller.tier).toBe('custom');
    expect(s.controller.model).toBe('deepseek/deepseek-v4-pro');
    expect(s.controller.provider).toBe('deepseek');
  });
});
