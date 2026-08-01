// ADR-0158 §6 — daemons.ts: cenários de LIMPEZA do `stopDaemons` não cobertos por
// `daemons.test.ts` (achado em auditoria de cobertura — ver relatório): pidfile
// CORROMPIDO (conteúdo não-numérico) e pidfile ÓRFÃO (aponta pra um pid já morto).
// Os dois são caminhos de AUTO-CURA — um `.state/*.pid` sujo NUNCA pode travar o
// `stop`/`start` seguinte nem sobreviver à limpeza (relevante sobretudo pro caso de
// uso "trader" do ADR-0158: um daemon próprio travado não pode virar processo
// fantasma que ninguém mais consegue derrubar).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopDaemons } from '../../src/service/daemons.js';
import { serviceStateDir } from '../../src/service/paths.js';

describe('stopDaemons — limpeza de pidfile sujo', () => {
  let serviceDir: string;
  const logs: string[] = [];
  const log = (l: string): number => logs.push(l);

  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-cleanup-'));
    logs.length = 0;
  });
  afterEach(() => {
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('pidfile com conteúdo NÃO-NUMÉRICO (corrompido) ⇒ removido sem lançar, sem tentar kill', () => {
    const stateDir = serviceStateDir(serviceDir);
    mkdirSync(stateDir, { recursive: true });
    const pidPath = join(stateDir, 'guard.pid');
    writeFileSync(pidPath, 'não é um pid\n');

    expect(() => stopDaemons(serviceDir, log)).not.toThrow();
    expect(existsSync(pidPath)).toBe(false);
  });

  it('pidfile ÓRFÃO (pid aponta pra processo já morto) ⇒ log "pidfile órfão", removido', () => {
    const stateDir = serviceStateDir(serviceDir);
    mkdirSync(stateDir, { recursive: true });
    const pidPath = join(stateDir, 'guard.pid');
    // PID improvável de estar vivo: um número alto fora da faixa típica do SO de
    // teste, e ainda assim > 0 (passa a validação de `readPidFile`).
    writeFileSync(pidPath, '999999\n');

    stopDaemons(serviceDir, log);
    expect(logs.some((l) => l.includes('pidfile órfão'))).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('"runner.pid" nunca é tocado por `stopDaemons` (mesmo órfão) — é outro ciclo de vida', () => {
    // NOTA: não usamos `process.pid` (o processo do próprio vitest) como pidfile
    // "vivo" aqui — `stopDaemons` manda SIGTERM de verdade, e matar o runner do
    // teste ia derrubar a própria suíte. O caminho "pidfile vivo ⇒ SIGTERM" já é
    // coberto com um processo `sleep` real e descartável em `daemons.test.ts`.
    const stateDir = serviceStateDir(serviceDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'orfao.pid'), '999999\n');
    writeFileSync(join(stateDir, 'runner.pid'), '999999\n');

    stopDaemons(serviceDir, log);

    expect(existsSync(join(stateDir, 'orfao.pid'))).toBe(false);
    // runner.pid é filtrado explicitamente (`f !== 'runner.pid'`) — stopDaemons
    // nunca deve tocá-lo (é o pidfile do PRÓPRIO runner, de outro ciclo de vida).
    expect(existsSync(join(stateDir, 'runner.pid'))).toBe(true);
  });
});
