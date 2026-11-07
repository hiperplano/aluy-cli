// ADR-0158 §5/§4.1/§11 — INTEGRAÇÃO de ponta a ponta: `runServiceRunner` completo,
// com um processo-FILHO REAL (`fixtures/fake-turn.mjs`, injetado via `execPath`/
// `aluyEntrypoint` — os pontos de injeção JÁ existentes em `RunServiceRunnerDeps`),
// rodando um WORKFLOW real de 2 atividades. Antes desta suíte, `runActivityTurn`
// (linhas ~384-521 de runner.ts) e `runOneWorkflow` (linhas ~889-1005) estavam
// praticamente 100% SEM cobertura — as suítes existentes só cobriam as funções
// PURAS extraídas de dentro deles (`resolveActivityTimeout`/`classifyActivityExit`/
// `parseActivityTurnOutput`/`buildWorkflowOutcome`/`resolveResumeSlice`), nunca o
// FIO que as conecta de verdade (spawn → env → parse do stdout → log → outcome).
//
// Prova, no MESMO turno: (a) `budget:` do manifesto vira `--max-tokens` no filho;
// (b) atividade com `[agente]` recebe `ALUY_SERVICE_PERSONA` e o log "TRAVADO na
// persona"; (c) uma fala do dono via `attach` chegada ENQUANTO o serviço dormia é
// entregue à PRÓXIMA atividade a abrir (a 1ª) e NUNCA duplicada na 2ª (a fila
// `pendingSay` é drenada por `splice`, não copiada) — a garantia explícita da
// missão "não pode duplicar entrega nem perder falas"; (d) o reporte de fechamento
// (§8.2) é enviado com o resumo "2/2 atividades concluídas.".
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      return [];
    },
    safeForLog: (s) => s,
  };
}

interface DebugRecord {
  readonly goal: string;
  readonly maxTokens: string | null;
  readonly aluyServiceHome: string | null;
  readonly aluyServicePersona: string | null;
  readonly isResume: boolean;
  readonly hasOwnerSay: boolean;
}

function readDebugRecords(path: string): DebugRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as DebugRecord);
}

describe('runServiceRunner — workflow feliz de ponta a ponta (processo-filho REAL via fixture)', () => {
  let base: string;
  let debugFile: string;
  beforeEach(() => {
    base = newBase('aluy-svc-workflow-happy-');
    debugFile = join(base, 'debug.jsonl');
    process.env.FAKE_TURN_DEBUG_FILE = debugFile;
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    delete process.env.FAKE_TURN_DEBUG_FILE;
    removeBase(base);
  });

  it('2 atividades OK (uma com [agente]) + budget→--max-tokens + say não duplicado + reporte de fechamento', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555', budget: '77k' });
    writeWorkflow(dir, 'turno', [
      { id: 'abrir', goal: 'FAKE_MODE_OK abra o livro do dia.' },
      { id: 'analisar', goal: 'FAKE_MODE_OK analise o risco.', agent: 'risco' },
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

    // ── fala do dono via attach ENQUANTO o serviço ainda dorme (antes do cron) ──
    const sockPath = attachSocketPath(dir);
    await waitFor(() => existsSync(sockPath));
    const conn = connectAttachSocket(sockPath, { onLine: () => {}, onClose: () => {} });
    conn.send('não esqueça de checar o book internacional');
    await waitFor(() => logs.some((l) => l.includes('serviço DORMINDO')));

    await waitFor(() => logs.some((l) => l.startsWith('acordou')));
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);
    conn.close();
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);

    // (a) a 1ª atividade recebeu a fala do dono; a 2ª NUNCA (fila drenada, não copiada).
    expect(logs).toContain('atividade 1/2 "abrir": entregando fala(s) do dono via attach.');
    expect(logs.some((l) => l.includes('atividade 2/2 "analisar": entregando fala'))).toBe(false);

    // (b) a 2ª atividade, com [agente], nasce TRAVADA na persona.
    expect(logs.some((l) => l.includes('atividade 2/2 "analisar": iniciando turno TRAVADO na persona "risco"'))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes('atividade 1/2 "abrir": iniciando turno (') && !l.includes('TRAVADO'))).toBe(
      true,
    );

    expect(logs).toContain('atividade 1/2 "abrir": ok.');
    expect(logs).toContain('atividade 2/2 "analisar": ok.');
    expect(logs.some((l) => l.startsWith('turno encerrado — 2/2 atividades concluídas.'))).toBe(true);

    // (c) o CANAL recebeu o reporte de fechamento (§8.2), não um alerta.
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain('2/2 atividades concluídas.');
    expect(client.sent[0]!.text).not.toContain('ALERTA');

    // (d) o FILHO de fato recebeu --max-tokens=77000 (77k) e a persona certa via env
    // — provado pelo side-channel do fixture (debugFile), não pelos logs do runner.
    const records = readDebugRecords(debugFile);
    expect(records).toHaveLength(2);
    expect(records[0]!.maxTokens).toBe('77000');
    expect(records[0]!.aluyServicePersona).toBeNull();
    expect(records[0]!.hasOwnerSay).toBe(true);
    expect(records[0]!.aluyServiceHome).toBe(dir);
    expect(records[1]!.maxTokens).toBe('77000');
    expect(records[1]!.aluyServicePersona).toBe('risco');
    expect(records[1]!.hasOwnerSay).toBe(false); // NUNCA duplicado.
  }, 20_000);
});
