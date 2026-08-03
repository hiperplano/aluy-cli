// ADR-0158 §5 pt.4 — `resolveResumeSlice` (PURA, já coberta isoladamente em
// `runner-workflow-outcome.test.ts`) é chamada de dentro de `runOneWorkflow` numa
// RETOMADA pós ASK-ESPERA — mas nenhum teste existente disparava o caminho "NÃO
// ok" de PONTA A PONTA através do `runServiceRunner` real: o dono pode editar
// `workflows/<nome>.md` ENQUANTO o turno espera a resposta dele (o comentário do
// próprio código descreve exatamente esse cenário). Este teste EDITA o workflow
// de verdade, no meio da ASK-ESPERA, encolhendo-o de 2 p/ 1 atividade — a
// atividade pendente (índice 1) deixa de existir — e prova que o turno encerra
// como STOPPED CRÍTICO (ALERTA, não reporte), em vez de explodir ou de retomar
// silenciosamente o índice errado.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';
import { runServiceRunner } from '../../src/service/runner.js';
import { connectAttachSocket } from '../../src/service/attach-client.js';
import { attachSocketPath } from '../../src/service/paths.js';
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
      // UM ATRASO REAL é ESSENCIAL — ver o comentário equivalente em
      // `runner-ask-espera.test.ts`: um `poll()` que resolve na hora faz o laço de
      // `waitForOwnerReply` girar só em microtasks, sem nunca ceder o event loop
      // p/ o socket de attach entregar o "say" — um hang de verdade, não um bug de
      // produção (achado ao depurar esta suíte).
      await new Promise((r) => setTimeout(r, 25));
      return [];
    },
    safeForLog: (s) => s,
  };
}

describe('runOneWorkflow — workflow EDITADO (encolhido) durante a ASK-ESPERA ⇒ a retomada não acha mais a atividade pendente', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-resume-invalid-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('resumeSlice inválido ⇒ turno "stopped"/crítico, ALERTA (não reporte), nunca retoma o índice errado', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    writeWorkflow(dir, 'turno', [
      { id: 'abrir', goal: 'FAKE_MODE_OK abra o livro do dia.' },
      { id: 'decidir', goal: 'FAKE_MODE_ASK avalie o risco do dia.' },
    ]);

    const client = fakeClient();
    const logs: string[] = [];
    const externalStop = new AbortController();

    armCronNearMinuteBoundary();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
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
    await waitFor(() => logs.includes('atividade 1/2 "abrir": ok.'), 10_000);
    await waitFor(() => logs.some((l) => l.includes('AGUARDANDO DONO — enviando a pergunta')), 10_000);

    // O dono edita o workflow ENQUANTO pensa na resposta — a atividade "decidir"
    // (índice 1) deixa de existir; só sobra "abrir" (índice 0).
    writeWorkflow(dir, 'turno', [{ id: 'abrir', goal: 'FAKE_MODE_OK abra o livro do dia.' }]);

    const sockPath = attachSocketPath(dir);
    await waitFor(() => existsSync(sockPath));
    const conn = connectAttachSocket(sockPath, { onLine: () => {}, onClose: () => {} });
    conn.send('pode aumentar.');

    await waitFor(
      (): boolean =>
        logs.some((l) => l.includes('a atividade pendente não existe mais no workflow')),
      10_000,
    );
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);

    conn.close();
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(
      logs.some((l) =>
        l.includes(
          'retomada: a atividade pendente não existe mais no workflow (editado entre a pergunta e a resposta) — turno encerrado.',
        ),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes('a atividade da retomada não existe mais no workflow'))).toBe(true);

    // CRÍTICO ⇒ ALERTA (não reporte de fechamento neutro).
    expect(client.sent.some((m) => m.text.includes('ALERTA') && m.text.includes('editado entre a pergunta'))).toBe(
      true,
    );
    expect(client.sent.some((m) => m.text.includes('concluídas'))).toBe(false);
  }, 20_000);
});
