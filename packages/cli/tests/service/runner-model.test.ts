// Descoberta entre serviços (`group:`/`model:`) — este arquivo prova o `model:`
// especificamente: presente ⇒ `--model <slug>` chega no argv do turno-filho REAL
// (via o mesmo fixture `fake-turn.mjs`/harness que `runner-workflow-happy.test.ts`
// usa para `budget:`→`--max-tokens`); ausente ⇒ argv IDÊNTICO ao de hoje (sem
// `--model` nenhum) — zero regressão p/ quem não declara o campo.
//
// PRECEDÊNCIA (documentada aqui, não testada de ponta a ponta): um agente invocado
// dentro do turno com seu PRÓPRIO `model:` (`agents/*.md`, via `spawn_agent`)
// continua vencendo este default — `resolveModelTier` (cli-core) só herda o caller
// do PAI quando o agente NÃO declara `model:` próprio (`kind: 'inherit'`); este
// `model:` do serviço só troca QUAL É o caller do pai (o que o turno herdaria por
// padrão), nunca desliga essa herança. Como a resolução de tier/herança já é
// testada exaustivamente em `agent-model-tier.test.ts` (cli-core), não duplicamos
// aqui — só provamos que o SLUG do manifesto chega ao argv do filho, condicional.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runServiceRunner } from '../../src/service/runner.js';
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

interface DebugRecord {
  readonly model: string | null;
}

function readDebugRecords(path: string): DebugRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as DebugRecord);
}

describe('runServiceRunner — model: (descoberta entre serviços, processo-filho REAL via fixture)', () => {
  let base: string;
  let debugFile: string;

  beforeEach(() => {
    base = newBase('aluy-svc-model-');
    debugFile = join(base, 'debug.jsonl');
    process.env.FAKE_TURN_DEBUG_FILE = debugFile;
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    delete process.env.FAKE_TURN_DEBUG_FILE;
    removeBase(base);
  });

  it('"model: xiaomi/mimo-v2.5-pro" no service.md ⇒ o filho recebe "--model xiaomi/mimo-v2.5-pro"', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', model: 'xiaomi/mimo-v2.5-pro' });
    writeWorkflow(dir, 'turno', [{ id: 'unica', goal: 'FAKE_MODE_OK única atividade.' }]);

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

    await waitFor(() => logs.some((l) => l.startsWith('turno encerrado')));
    externalStop.abort();
    await promise;

    const records = readDebugRecords(debugFile);
    expect(records).toHaveLength(1);
    expect(records[0]!.model).toBe('xiaomi/mimo-v2.5-pro');
  }, 20_000);

  it('sem "model:" declarado ⇒ o filho NÃO recebe "--model" nenhum (zero regressão)', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno' }); // sem model:
    writeWorkflow(dir, 'turno', [{ id: 'unica', goal: 'FAKE_MODE_OK única atividade.' }]);

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

    await waitFor(() => logs.some((l) => l.startsWith('turno encerrado')));
    externalStop.abort();
    await promise;

    const records = readDebugRecords(debugFile);
    expect(records).toHaveLength(1);
    expect(records[0]!.model).toBeNull();
  }, 20_000);
});
