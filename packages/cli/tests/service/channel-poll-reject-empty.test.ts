// ADR-0158 §5 pt.4 — channel.ts: fecha um sobrevivente de MUTAÇÃO (Stryker, pass 3)
// em `waitForOwnerReply` que `channel-fail-open.test.ts` (alheio — NÃO editado aqui)
// não alcançava: quando `client.poll()` REJEITA, o `.catch(() => ({kind:'poll',
// updates: []}))` trata a rodada como VAZIA de verdade — um mutante que troca `[]`
// por um array com um item-fantasma (`["Stryker was here"]`) sobrevive porque esse
// teste só prova que o loop SEGUE rodando (não trava), sem provar que NADA foi
// processado a mais na rodada rejeitada. Aqui: poll SEMPRE rejeita, `stop` dispara
// logo em seguida — se o fantasma fosse processado, ele cairia em
// `classifyTelegramIngress` e geraria uma linha de log ("descartado"/"classificado
// como DADO"); a ausência dessas linhas prova que a rodada rejeitada não injetou
// nada. Arquivo SEPARADO — só ESTENDE a cobertura.
import { describe, expect, it } from 'vitest';
import { waitForOwnerReply, newServiceEgressLimiter, type ServiceChannelClient, type ServiceChannelDeps } from '../../src/service/channel.js';
import type { ServiceManifest } from '@hiperplano/aluy-cli-core';

function manifest(overrides: Partial<ServiceManifest> = {}): ServiceManifest {
  return { name: 'trader', tunables: [], ignoredFrontmatterKeys: [], orchestrator: 'Rege, não opera.', ...overrides };
}

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

function baseDeps(overrides: Partial<ServiceChannelDeps> = {}): ServiceChannelDeps {
  return { egressLimiter: newServiceEgressLimiter(), log: () => {}, ...overrides };
}

describe('waitForOwnerReply — client.poll SEMPRE rejeita: a rodada rejeitada é VAZIA de verdade (nenhum update fantasma processado)', () => {
  it('nenhuma linha de log de "descartado"/"classificado como DADO" aparece — só "stop" encerra a espera', async () => {
    const client: ServiceChannelClient = {
      send: async () => true,
      poll: async () => {
        // O `await` de um `setTimeout` real (não fake — ver topo do arquivo) força
        // uma volta de verdade pelo event loop A CADA rodada. Sem isso, um `poll()`
        // que rejeita QUASE síncrono (só microtasks, nenhum macrotask) faz o `while`
        // de `waitForOwnerReply` girar tão rápido que FAMINTA a fase de timers do
        // Node — o `setTimeout` do abort logo abaixo nunca chegaria a disparar
        // (achado ao rodar este teste: travava de verdade, não só "lento").
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('ECONNRESET no long-poll');
      },
      safeForLog: (s) => s,
    };
    const logs: string[] = [];
    const controller = new AbortController();
    // aborta logo após a 1ª rodada rejeitada ter tido chance de rodar — sem
    // depender de vários ciclos reais.
    setTimeout(() => controller.abort(), 40);

    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps({
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
        log: (l) => logs.push(l),
      }),
    });

    expect(result.kind).toBe('stopped');
    expect(logs.some((l) => l.includes('descartado'))).toBe(false);
    expect(logs.some((l) => l.includes('classificado como DADO'))).toBe(false);
  });
});
