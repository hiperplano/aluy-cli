// ADR-0158 §5 — runner.ts: fecha sobreviventes de MUTAÇÃO (Stryker, pass 3) no
// laço "dormindo até o schedule" de `runServiceRunner` que os testes existentes
// (`runner-wiring-gaps.test.ts`/`runner-fatal.test.ts`, alheios — NÃO editados
// aqui) exercitam mas não afirmam com precisão suficiente:
//   · `setStatus({ turnState: 'sleeping', nextFireIso })` — os testes existentes só
//     checam o LOG "dormindo até…" (uma linha SEPARADA), nunca o `status.json` que
//     `setStatus` de fato escreve — mutantes que esvaziam esse objeto (`{}`) ou
//     trocam o literal `'sleeping'` por `""` sobrevivem porque nada lê o snapshot.
//   · `if (wake === 'stopped') break;` — quando o `externalStop` dispara ENQUANTO
//     o runner dorme, o runner tem que parar ALI, sem nunca abrir um turno; os
//     testes existentes checam só os logs de ENCERRAMENTO (que são idênticos com ou
//     sem o `break`, já que o loop externo também sai na iteração seguinte) — nunca
//     afirmam a AUSÊNCIA do log "acordou — início do expediente", que é o que de
//     fato prova que o `break` aconteceu ali, e não uma iteração depois.
//   · o `finally`/`if (stopController.signal.aborted) shutdown()` — o caminho FATAL
//     "schedule nunca dispara" faz cleanup MANUAL (nunca deveria chamar o
//     `shutdown()` gracioso de novo, pois nunca abortou) — nenhum teste existente
//     afirma a AUSÊNCIA do log "runner encerrado." nesse caminho.
//   · o hook `onSay` de fato religado ao `AttachServerHooks` real (não um objeto
//     vazio) — nenhum teste existente conecta um cliente de attach de verdade
//     DURANTE um `runServiceRunner` real.
// Sem mockar `child_process`/relógio (mesma disciplina do resto do módulo) — usa
// exatamente o padrão já estabelecido (`aluyBaseDir` em tmpdir, `externalStop`
// disparado DEPOIS da chamada, sockets/processos REAIS). Arquivo SEPARADO — não
// edita nenhum teste alheio, só ESTENDE a cobertura.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServiceRunner } from '../../src/service/runner.js';
import { connectAttachSocket } from '../../src/service/attach-client.js';
import { SERVICES_DIRNAME } from '../../src/io/services-store.js';
import { attachSocketPath } from '../../src/service/paths.js';
import { readServiceRuntimeStatus } from '../../src/service/status.js';

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('runServiceRunner — status.json E comportamento durante "dormindo até o schedule"', () => {
  let base: string;
  let dir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-sleeptx-'));
    dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'service.md'),
      ['---', 'name: trader', 'schedule: "* * * * *"', '---', 'Rege, não opera.'].join('\n'),
    );
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('ENQUANTO dorme: status.json tem turnState EXATO "sleeping" + nextFireIso definido (não um snapshot vazio/zerado)', async () => {
    const externalStop = new AbortController();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: () => {},
      externalStop: externalStop.signal,
    });
    try {
      await waitFor(() => readServiceRuntimeStatus(dir).snapshot !== undefined);
      const status = readServiceRuntimeStatus(dir);
      expect(status.running).toBe(true);
      expect(status.snapshot?.turnState).toBe('sleeping');
      expect(status.snapshot?.nextFireIso).toBeDefined();
      expect(typeof status.snapshot?.nextFireIso).toBe('string');
      // Formato ISO de verdade (não uma string vazia que ainda passaria num
      // `toBeDefined`) — prova que o mutante StringLiteral que troca o valor por ""
      // ficaria distinguível aqui também.
      expect(() => new Date(status.snapshot!.nextFireIso!).toISOString()).not.toThrow();
    } finally {
      externalStop.abort();
      await promise;
    }
  });

  it('`externalStop` dispara ENQUANTO dorme ⇒ o runner PARA ali — NUNCA loga "acordou" (o `break` acontece na MESMA iteração, não uma depois)', async () => {
    const logs: string[] = [];
    const externalStop = new AbortController();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
    });
    await waitFor(() => logs.some((l) => l.startsWith('dormindo até')));
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(logs).toContain('runner encerrado.');
    // A prova de que o `break` de fato interrompeu ANTES de abrir turno — nunca
    // deveria existir NENHUMA linha do início do expediente.
    expect(logs.some((l) => l.startsWith('acordou'))).toBe(false);
    expect(logs.some((l) => l.includes('subindo daemons'))).toBe(false);
  });

  it('conecta via attach socket DURANTE o sono e manda "say" ⇒ o handler `onSay` REAL reage (loga o texto DORMINDO), prova que o hook não é um objeto vazio', async () => {
    const logs: string[] = [];
    const externalStop = new AbortController();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
    });
    const sockPath = attachSocketPath(dir);
    try {
      await waitFor(() => existsSync(sockPath));
      const onCloseReasons: string[] = [];
      const conn = connectAttachSocket(sockPath, { onLine: () => {}, onClose: (r) => onCloseReasons.push(r) });
      conn.send('dono falando via attach');
      await waitFor(() => logs.some((l) => l.includes('"say" recebido com o serviço DORMINDO')));
      expect(
        logs,
      ).toContain(
        '[attach] "say" recebido com o serviço DORMINDO — vira instrução do PRÓXIMO despertar.',
      );
      conn.close();
    } finally {
      externalStop.abort();
      await promise;
    }
  });
});

describe('runServiceRunner — "schedule nunca dispara" (FATAL): o cleanup é MANUAL, o `shutdown()` gracioso NUNCA roda de novo', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-fatal-noshutdown-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('logs NUNCA contêm "runner encerrado." (esse texto só sai do `shutdown()` gracioso, que não deveria rodar aqui — `stopController` nunca abortou)', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'service.md'),
      ['---', 'name: trader', 'schedule: "0 0 30 2 *"', '---', 'Rege, não opera.'].join('\n'),
    );
    const logs: string[] = [];
    const code = await runServiceRunner('trader', { aluyBaseDir: base, log: (l) => logs.push(l) });

    expect(code).toBe(1);
    expect(logs.some((l) => l.includes('nunca dispara'))).toBe(true);
    expect(logs).not.toContain('runner encerrado.');
  });
});
