// ADR-0158 — `workspace:` (raiz extra além da própria pasta do serviço) — este
// arquivo prova o CAMINHO ATÉ O TURNO-FILHO: `workspace:` declarado no service.md
// ⇒ o filho REAL (via o mesmo fixture `fake-turn.mjs`/harness que `runner-model.
// test.ts` usa) recebe `ALUY_SERVICE_WORKSPACE_ROOTS` com o(s) path(s) já
// RESOLVIDOS/canonicalizados (JSON de um array); ausente ⇒ env IDÊNTICO ao de hoje
// (zero regressão p/ quem não declara o campo).
//
// O piso "~/.aluy/ nunca vira raiz" e a resolução em si (~/relativo/canonicalizar)
// já têm cobertura dedicada em `workspace-roots.test.ts` (unidade) e
// `services-store.test.ts` (integração do registry) — aqui o foco é só a ÚLTIMA
// milha: o valor RESOLVIDO chega ao `env` do processo-filho de verdade.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  readonly aluyServiceWorkspaceRoots: string | null;
}

function readDebugRecords(path: string): DebugRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as DebugRecord);
}

describe('runServiceRunner — workspace: (raiz extra, processo-filho REAL via fixture)', () => {
  let base: string;
  let externalBase: string;
  let debugFile: string;

  beforeEach(() => {
    base = newBase('aluy-svc-workspace-');
    externalBase = mkdtempSync(join(tmpdir(), 'aluy-svc-workspace-external-'));
    debugFile = join(base, 'debug.jsonl');
    process.env.FAKE_TURN_DEBUG_FILE = debugFile;
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    delete process.env.FAKE_TURN_DEBUG_FILE;
    removeBase(base);
    rmSync(externalBase, { recursive: true, force: true });
  });

  it('"workspace: <dir>" no service.md ⇒ o filho recebe ALUY_SERVICE_WORKSPACE_ROOTS resolvido', async () => {
    const extraDir = join(externalBase, 'projects', 'fluider');
    mkdirSync(extraDir, { recursive: true });
    const dir = writeServiceManifest(base, { workflow: 'turno', workspace: extraDir });
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
    expect(records[0]!.aluyServiceWorkspaceRoots).not.toBeNull();
    expect(JSON.parse(records[0]!.aluyServiceWorkspaceRoots!)).toEqual([extraDir]);
  }, 20_000);

  it('sem "workspace:" declarado ⇒ o filho NÃO recebe ALUY_SERVICE_WORKSPACE_ROOTS nenhum (zero regressão)', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno' }); // sem workspace:
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
    expect(records[0]!.aluyServiceWorkspaceRoots).toBeNull();
  }, 20_000);

  it('"workspace: ~/.aluy" (aqui, o baseDir isolado) ⇒ o serviço NEM SOBE (fail-closed no boot do runner)', async () => {
    // O piso não cai: o `aluyBaseDir` desta suíte É o "~/.aluy/" isolado do teste
    // (nunca o real da máquina — ver a trava no topo do harness). Declarar
    // `workspace: <base>` é o equivalente isolado de `workspace: ~/.aluy` — o
    // runner recusa o manifesto e NUNCA chega a abrir turno nenhum.
    writeServiceManifest(base, { workflow: 'turno', workspace: base });
    const dir = join(base, 'services', 'trader');
    writeWorkflow(dir, 'turno', [{ id: 'unica', goal: 'FAKE_MODE_OK única atividade.' }]);

    const logs: string[] = [];
    // O manifesto inválido é recusado ANTES de qualquer `log()` (o runner escreve
    // direto em stderr nesse caminho — ver `runServiceRunner`) — o que este teste
    // prova é o CÓDIGO DE SAÍDA e o fato de NENHUM turno ter sido aberto.
    const code = await runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      execPath: process.execPath,
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
    });

    expect(code).toBe(1);
    expect(readDebugRecords(debugFile)).toEqual([]); // nenhum turno chegou a abrir.
  }, 20_000);
});
