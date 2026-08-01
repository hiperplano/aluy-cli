// ADR-0158 §5 — runner.ts: os caminhos FATAIS (fail-closed) de `runServiceRunner`
// que não exigem spawn/relógio real — serviço ausente/inválido, sem "schedule:".
// O ciclo completo (dorme → acorda → turno → dorme) é validado na FUMAÇA do
// binário real (não replicável aqui sem depender de tempo real ou mocks pesados
// de `child_process`/relógio — ver o relatório da fase 2).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServiceRunner } from '../../src/service/runner.js';
import { SERVICES_DIRNAME } from '../../src/io/services-store.js';
import { runnerPidPath } from '../../src/service/paths.js';

describe('runServiceRunner — caminhos fatais', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-fatal-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('serviço inexistente ⇒ exit 1, sem escrever pidfile', async () => {
    const code = await runServiceRunner('fantasma', { aluyBaseDir: base });
    expect(code).toBe(1);
  });

  it('serviço com service.md inválido ⇒ exit 1', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'quebrado');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), '---\n---\n'); // sem name ⇒ inválido
    const code = await runServiceRunner('quebrado', { aluyBaseDir: base });
    expect(code).toBe(1);
  });

  it('serviço sem "schedule:" ⇒ exit 1, pidfile é removido (nunca fica órfão)', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), '---\nname: trader\n---\nRege, não opera.\n');
    const logs: string[] = [];
    const code = await runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
    });
    expect(code).toBe(1);
    expect(logs.some((l) => l.includes('schedule'))).toBe(true);
    // sem "schedule:" o runner sai ANTES de gravar pidfile — nunca cria o
    // `.state/runner.pid` (nada pra `stop` limpar depois).
    expect(existsSync(runnerPidPath(dir))).toBe(false);
  });

  it('"schedule:" que passa a validação de faixa mas NUNCA dispara (30 de fevereiro) ⇒ exit 1, sem pidfile órfão', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    // "30 2" (dia 30, mês fev.) está DENTRO das faixas (1-31/1-12) — passa o
    // `validateCronExpr` do registry — mas nunca existe de verdade (`nextCronFire`
    // varre 2 anos e devolve `undefined`). O runner tem que se fechar sem deixar
    // pidfile pra trás (achado ao revisar o `finally`/shutdown gracioso).
    writeFileSync(
      join(dir, 'service.md'),
      ['---', 'name: trader', 'schedule: "0 0 30 2 *"', '---', 'Rege, não opera.'].join('\n'),
    );
    const logs: string[] = [];
    const code = await runServiceRunner('trader', { aluyBaseDir: base, log: (l) => logs.push(l) });
    expect(code).toBe(1);
    expect(logs.some((l) => l.includes('nunca dispara'))).toBe(true);
    expect(existsSync(runnerPidPath(dir))).toBe(false);
  });
});
