// ADR-0158 §5 pt.4 (O CORAÇÃO DA FASE 3) — a máquina de ASK-ESPERA de
// `runServiceRunner` de ponta a ponta, com um processo-FILHO REAL (`fake-turn.mjs`)
// que de fato TERMINA um turno perguntando algo (`awaitsUserDecision`, cli-core).
// Antes desta suíte, o laço `while (outcome.kind === 'awaiting-owner')` (linhas
// ~725-783 de runner.ts) e os desfechos de `waitForOwnerReply` — respondida (retoma
// a MESMA atividade), timeout (encerra sem ação) — estavam com 0% de cobertura de
// verdade (só a mecânica PURA de `channel.ts` era testada, isoladamente, nunca
// através do runner completo).
//
// PR #74 (main, "channel: deixa de ser obrigatório") mudou o desfecho SEM CANAL: já
// não é mais fail-open (derrubar o runner) — agora cai na ESPERA LOCAL PURA
// (`waitForLocalAnswerOnly`, channel.ts) porque `runServiceRunner` SEMPRE fia o
// `localAnswer` (o attach). O 3º describe abaixo foi REESCRITO para provar o
// comportamento NOVO de ponta a ponta (o `channel-sem-canal-attach.test.ts`, que já
// chegou com o PR, só testa `waitForOwnerReply` isolado — nunca o `runServiceRunner`
// inteiro) — o `no-channel`/fail-open antigo só sobrevive quando NEM canal NEM
// attach existem, o que não acontece em produção (`runServiceRunner` sempre fia o
// attach).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';
import { runServiceRunner } from '../../src/service/runner.js';
import { connectAttachSocket } from '../../src/service/attach-client.js';
import { attachSocketPath } from '../../src/service/paths.js';
import { runnerPidPath } from '../../src/service/paths.js';
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
      // long-poll nunca traz nada — só a resposta LOCAL (attach) ou o timeout
      // decidem. UM ATRASO REAL aqui é ESSENCIAL (não um detalhe de estilo): o
      // `waitForOwnerReply` (channel.ts) corre este `poll()` contra a resposta
      // LOCAL num `while(!stop.aborted)` — um `poll()` que resolve na hora vira um
      // laço que nunca cede o event loop via um limite de MACROTASK de verdade
      // (só microtasks encadeadas), o que pode inanir a entrega do evento 'data'
      // do socket de attach (achado ao depurar um hang de verdade nesta suíte). O
      // Telegram REAL sempre tem latência de rede — este fake precisa imitar isso.
      await new Promise((r) => setTimeout(r, 25));
      return [];
    },
    safeForLog: (s) => s,
  };
}

describe('runServiceRunner — ASK-ESPERA respondida LOCALMENTE via "aluy service attach" ⇒ RETOMA e conclui', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-ask-local-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('pergunta ⇒ status "awaiting-owner" ⇒ "say" local retoma a MESMA atividade (goal carrega "[Retomando") ⇒ turno conclui 1/1', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    writeWorkflow(dir, 'turno', [{ id: 'decidir', goal: 'FAKE_MODE_ASK avalie o risco do dia.' }]);

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
    await waitFor(() => logs.some((l) => l.includes('AGUARDANDO DONO — enviando a pergunta')));

    const sockPath = attachSocketPath(dir);
    await waitFor(() => existsSync(sockPath));
    const conn = connectAttachSocket(sockPath, { onLine: () => {}, onClose: () => {} });
    conn.send('sim, pode aumentar até 2 lotes.');

    await waitFor(() => logs.some((l) => l.includes('resposta LOCAL recebida via "aluy service attach"')), 10_000);
    await waitFor(() => logs.some((l) => l.includes('dono respondeu pelo canal — retomando')), 10_000);
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);

    conn.close();
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    // fase ASK-ESPERA tratou o "say" como resposta LOCAL — nunca enfileirou (não é
    // "sleeping"/"running-turn", é "awaiting-owner" — decideSayRouting tem um 3º ramo).
    expect(logs).toContain('[attach] "say" recebido durante ASK-ESPERA — tratado como resposta LOCAL do dono.');
    expect(logs.some((l) => l.startsWith('turno encerrado — 1/1 atividades concluídas.'))).toBe(true);
    expect(client.sent.some((m) => m.text.includes('2/2 atividades') || m.text.includes('1/1 atividades'))).toBe(
      true,
    );
    const report = client.sent.find((m) => m.text.includes('1/1 atividades concluídas.'));
    expect(report).toBeDefined();
    expect(report!.text).not.toContain('ALERTA');
  }, 20_000);
});

describe('runServiceRunner — ASK-ESPERA expira (timeout) ⇒ turno encerra SEM AÇÃO (reporte, não alerta)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-ask-timeout-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('askTimeoutMs baixo, sem resposta nenhuma (nem local nem pelo canal) ⇒ "SEM RESPOSTA a tempo"', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    writeWorkflow(dir, 'turno', [{ id: 'decidir', goal: 'FAKE_MODE_ASK avalie o risco do dia.' }]);

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
        askTimeoutMs: 100,
      },
    });

    await waitFor(() => logs.some((l) => l.startsWith('acordou')));
    await waitFor(() => logs.some((l) => l.includes('ask-espera: TIMEOUT')), 10_000);
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('SEM RESPOSTA a tempo'))).toBe(true);
    const report = client.sent.find((m) => m.text.includes('SEM RESPOSTA a tempo'));
    expect(report).toBeDefined();
    expect(report!.text).not.toContain('ALERTA'); // parada neutra (critical:false) — reporte, não alerta.
  }, 20_000);
});

describe('runServiceRunner — ASK-ESPERA sem "channel:" ⇒ ESPERA LOCAL (PR #74): NUNCA derruba o runner, retoma via attach', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-ask-nochannel-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('sem "channel:" declarado + resposta via attach ⇒ o runner fica VIVO (nunca sai), retoma a atividade e conclui o turno', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno' }); // SEM channel:
    writeWorkflow(dir, 'turno', [{ id: 'decidir', goal: 'FAKE_MODE_ASK avalie o risco do dia.' }]);

    const logs: string[] = [];
    const externalStop = new AbortController();

    armCronNearMinuteBoundary();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
      execPath: process.execPath,
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
    });

    await waitFor(() => logs.some((l) => l.startsWith('acordou')));
    await waitFor(() => logs.some((l) => l.includes('AGUARDANDO DONO — enviando a pergunta')));
    // NUNCA sai sozinho — fica esperando o attach (log de `waitForLocalAnswerOnly`,
    // channel.ts). A janela dá tempo do teste provar que o processo AINDA está de
    // pé antes de qualquer resposta chegar.
    expect(logs.some((l) => l.includes('ESPERANDO o dono por "aluy service attach"'))).toBe(true);
    expect(existsSync(runnerPidPath(dir))).toBe(true);

    const sockPath = attachSocketPath(dir);
    await waitFor(() => existsSync(sockPath));
    const conn = connectAttachSocket(sockPath, { onLine: () => {}, onClose: () => {} });
    conn.send('pode aumentar, sim.');

    await waitFor(() => logs.some((l) => l.includes('resposta recebida via "aluy service attach"')), 10_000);
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);

    conn.close();
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith('turno encerrado — 1/1 atividades concluídas.'))).toBe(true);
    // Fail-open antigo (derrubar o runner) NUNCA acontece mais aqui — `localAnswer`
    // sempre está fiado por `runServiceRunner` (só sobra p/ quem chama
    // `waitForOwnerReply` isolado sem essa peça, ver `channel-sem-canal-attach.test.ts`).
    expect(logs.some((l) => l.includes('ask-espera não pôde ser feita'))).toBe(false);
    expect(logs).not.toContain('runner encerrado (aguardando dono, sem canal disponível).');
    // Encerrou via shutdown() GRACIOSO de verdade (`stopController` abortou) — pidfile
    // some SÓ depois do `externalStop.abort()`, não antes.
    expect(logs).toContain('runner encerrado.');
    expect(existsSync(runnerPidPath(dir))).toBe(false);
  }, 20_000);

  it('sem "channel:" declarado + askTimeoutMs baixo + ninguém entra no attach ⇒ timeout (nunca supõe, nunca sai sozinho antes da hora)', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno' }); // SEM channel:
    writeWorkflow(dir, 'turno', [{ id: 'decidir', goal: 'FAKE_MODE_ASK avalie o risco do dia.' }]);

    const logs: string[] = [];
    const externalStop = new AbortController();

    armCronNearMinuteBoundary();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
      execPath: process.execPath,
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
      channelDeps: { egressLimiter: new EgressRateLimiter(20, 60_000), askTimeoutMs: 100 },
    });

    await waitFor(() => logs.some((l) => l.startsWith('acordou')));
    await waitFor(
      () => logs.some((l) => l.includes('ask-espera (sem canal remoto): TIMEOUT')),
      10_000,
    );
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('SEM RESPOSTA a tempo'))).toBe(true);
    expect(logs.some((l) => l.includes('ask-espera não pôde ser feita'))).toBe(false);
  }, 20_000);
});
