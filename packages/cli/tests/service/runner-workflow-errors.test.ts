// ADR-0158 §5/§8.1 — caminhos de ERRO/DEGRADE de `runOneWorkflow`/`runActivityTurn`
// que a auditoria apontou como os mais fracamente cobertos do arquivo: workflow
// que SOME do disco bem no meio da corrida entre a REVALIDAÇÃO (`UserServicesStore.
// get`, que JÁ recusa um serviço cujo `workflow:` não existe — tanto no boot quanto
// em cada despertar, ver `services-store.ts`) e o instante em que `runOneWorkflow`
// de fato lê o arquivo (TOCTOU — a única forma real de alcançar o `!existsSync`
// PRÓPRIO de `runOneWorkflow`, já que o `store` normalmente barra isso antes),
// workflow com frontmatter inválido, e as TRÊS formas de "o turno-filho não
// terminou bem" (saída ilegível/não-JSON, `ok:false` explícito, crash sem stdout
// nenhum) — todas devem virar ALERTA crítico (§8.1), nunca silêncio. Processo-FILHO
// REAL via `fixtures/fake-turn.mjs`.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';
import { runServiceRunner } from '../../src/service/runner.js';
import type { ServiceChannelClient } from '../../src/service/channel.js';
import {
  FAKE_TURN_ENTRYPOINT,
  writeServiceManifest,
  writeWorkflow,
  newBase,
  removeBase,
  armCronNearMinuteBoundary,
  disarmFakeClock,
  waitFor,
} from './fixtures/workflow-harness.js';

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

function fakeClient(): ServiceChannelClient & { readonly sent: { chatId: number; text: string }[] } {
  const sent: { chatId: number; text: string }[] = [];
  return {
    sent,
    async send(chatId, text) {
      sent.push({ chatId, text });
      return true;
    },
    async poll() {
      return [];
    },
    safeForLog: (s) => s,
  };
}

async function runTurnAndWaitClose(
  base: string,
  logs: string[],
  client: ReturnType<typeof fakeClient>,
  onWake?: () => void,
): Promise<number> {
  const externalStop = new AbortController();
  armCronNearMinuteBoundary();
  const promise = runServiceRunner('trader', {
    aluyBaseDir: base,
    log: (l) => {
      logs.push(l);
      if (onWake !== undefined && l.startsWith('acordou')) onWake();
    },
    externalStop: externalStop.signal,
    execPath: process.execPath,
    aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
    channelDeps: {
      egressLimiter: new EgressRateLimiter(20, 60_000),
      secretStore: { get: async () => TOKEN },
      clientFactory: () => client,
    },
  });
  await waitFor(() => logs.some((l) => l.startsWith('acordou')));
  await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);
  externalStop.abort();
  return promise;
}

describe('runOneWorkflow — o arquivo do workflow SOME do disco entre a revalidação e a leitura (TOCTOU)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-wf-missing-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('⇒ turno "stopped"/critical, ALERTA no canal com o nome do workflow ausente', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    // Existe no MOMENTO em que `UserServicesStore.get()` valida (boot + cada
    // despertar) — senão o `store` já recusaria o serviço inteiro antes de chegar
    // perto de `runOneWorkflow` (ver `services-store.ts` linha ~211). O `log`
    // abaixo apaga o arquivo no INSTANTE em que vê "acordou" — o próprio callback
    // roda SÍNCRONO dentro de `runServiceRunner` (bloqueia a continuação), e entre
    // esse log e o `existsSync` de `runOneWorkflow` não há nenhum `await` no meio
    // (`startDaemons`/`setStatus` são síncronos) — garante que a exclusão acontece
    // ANTES da leitura, sem depender de sorte de timing.
    writeWorkflow(dir, 'turno', [{ id: 'abrir', goal: 'FAKE_MODE_OK nunca deveria rodar.' }]);

    const client = fakeClient();
    const logs: string[] = [];
    const code = await runTurnAndWaitClose(base, logs, client, () => {
      rmSync(join(dir, 'workflows', 'turno.md'), { force: true });
    });

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('workflows/turno.md não encontrado'))).toBe(true);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain('ALERTA');
    expect(client.sent[0]!.text).toContain('workflow "turno" não encontrado.');
  }, 20_000);
});

describe('runOneWorkflow — workflow com frontmatter inválido (sem "name")', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-wf-invalid-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('⇒ turno "stopped"/critical, ALERTA com o motivo de `isWorkflowError`', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'workflows', 'turno.md'), ['---', '---', '1. x — faça x.'].join('\n')); // sem "name:"

    const client = fakeClient();
    const logs: string[] = [];
    const code = await runTurnAndWaitClose(base, logs, client);

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('FATAL do turno: workflow "turno" inválido'))).toBe(true);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain('ALERTA');
    expect(client.sent[0]!.text).toContain('workflow inválido');
  }, 20_000);
});

describe.each([
  {
    mode: 'FAKE_MODE_GARBAGE',
    label: 'saída ilegível (não-JSON)',
    logNeedle: 'saída ilegível',
  },
  {
    mode: 'FAKE_MODE_ERROR',
    label: 'ok:false explícito',
    logNeedle: 'turno terminou com erro',
  },
  {
    mode: 'FAKE_MODE_CRASH',
    label: 'crash (exit != 0, sem stdout)',
    logNeedle: 'saída ilegível',
  },
])('runActivityTurn — atividade termina em $label', ({ mode, logNeedle }) => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-activity-fail-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it(`⇒ outcome "error" (crítico) — parou em 1/1 (a atividade que falhou CONTA como rodada), ALERTA enviado (${mode})`, async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    writeWorkflow(dir, 'turno', [{ id: 'unica', goal: `${mode} tente algo.` }]);

    const client = fakeClient();
    const logs: string[] = [];
    const code = await runTurnAndWaitClose(base, logs, client);

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes(logNeedle))).toBe(true);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain('ALERTA');
    expect(client.sent[0]!.text).toContain('parou em 1/1 atividades (error).');
  }, 20_000);
});
