// ADR-0158 §5 — runner.ts: fecha sobreviventes de MUTAÇÃO no WIRING de
// `runServiceRunner` que `runner-fatal.test.ts`/`runner-alerts.test.ts` já
// EXERCITAM mas não afirmam com precisão suficiente (achado numa auditoria — ver
// relatório): a mensagem de stderr do serviço inexistente, o default do
// `egressLimiter` (`??`, não `&&`), o texto exato de "runner iniciado", o
// cleanup de listeners de sinal (SIGTERM/SIGINT — nunca vazam), e o caminho
// "schedule válido, mas `stop` externo já disparado" (nunca testado: os testes
// fatais existentes só cobrem schedule AUSENTE/INVÁLIDO). Arquivo SEPARADO —
// não editamos teste alheio, só ESTENDEMOS com cenários NOVOS, sempre com
// `aluyBaseDir` num tmpdir (NUNCA o HOME real — mesma trava dos demais testes
// deste módulo).
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServiceRunner } from '../../src/service/runner.js';
import { SERVICES_DIRNAME } from '../../src/io/services-store.js';
import { runnerPidPath } from '../../src/service/paths.js';
import type { ServiceChannelClient } from '../../src/service/channel.js';

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

describe('runServiceRunner — mensagem de stderr do serviço inexistente/inválido', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-stderr-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('serviço inexistente ⇒ escreve a mensagem EXATA em stderr (não uma string vazia)', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runServiceRunner('fantasma', { aluyBaseDir: base });
      expect(code).toBe(1);
      expect(writeSpy).toHaveBeenCalledWith(
        'aluy: serviço "fantasma" inválido/não encontrado — não é possível iniciar o runner.\n',
      );
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('runServiceRunner — default do egressLimiter é `??` (cria um NOVO), nunca `&&` (herdaria undefined)', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-egress-default-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('channelDeps SEM egressLimiter, mas COM secretStore/clientFactory ⇒ alerta ainda assim é ENVIADO (limiter default funcional)', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      dir + '/service.md',
      ['---', 'name: trader', 'channel: "telegram:555"', '---', 'Rege, não opera.'].join('\n'),
    );
    const client = fakeClient();
    const code = await runServiceRunner('trader', {
      aluyBaseDir: base,
      log: () => {},
      // PROPOSITALMENTE sem `egressLimiter` — se o wiring interno usasse `&&`
      // em vez de `??`, `channelBaseDeps.egressLimiter` viraria `undefined` e
      // `sendServiceAlert` explodiria ao chamar `.tryConsume` nele.
      channelDeps: {
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
      },
    });
    expect(code).toBe(1);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain('ALERTA');
  });
});

describe('runServiceRunner — schedule VÁLIDO + `externalStop` JÁ abortado ⇒ caminho "dormindo", nunca o fatal "nunca dispara"', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-preaborted-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('loga "runner iniciado"/"dormindo até" (texto EXATO), NUNCA "nunca dispara"; encerra graciosamente (código 0, pidfile removido, listeners de sinal sem vazar)', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      dir + '/service.md',
      ['---', 'name: trader', 'schedule: "* * * * *"', '---', 'Rege, não opera.'].join('\n'),
    );
    const logs: string[] = [];
    const externalStop = new AbortController();

    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');

    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
    });
    // NUNCA aborta ANTES de chamar `runServiceRunner` — um `AbortSignal` JÁ
    // abortado no momento do `addEventListener` NÃO dispara o listener (o
    // evento já "aconteceu" no passado); o `stop` precisa disparar DEPOIS que
    // o runner registrou o listener (dentro da chamada), senão o teste trava
    // esperando o `schedule` de verdade (achado ao escrever este teste).
    await new Promise((r) => setTimeout(r, 50));
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith('runner iniciado (pid'))).toBe(true);
    expect(logs.some((l) => l.startsWith('dormindo até') && l.includes('próximo turno'))).toBe(true);
    expect(logs.some((l) => l.includes('nunca dispara'))).toBe(false);
    expect(logs).toContain('runner encerrado.');
    expect(existsSync(runnerPidPath(dir))).toBe(false);
    // nenhum listener de SIGTERM/SIGINT vazado — o `shutdown()` gracioso os remove.
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
  });
});

describe('runServiceRunner — "schedule nunca dispara": listeners de sinal também não vazam no cleanup MANUAL (caminho FATAL fora do shutdown() gracioso)', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-neverfire-listeners-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('pid removido e SIGTERM/SIGINT voltam à contagem ANTERIOR à chamada', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      dir + '/service.md',
      ['---', 'name: trader', 'schedule: "0 0 30 2 *"', '---', 'Rege, não opera.'].join('\n'),
    );
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');

    const code = await runServiceRunner('trader', { aluyBaseDir: base, log: () => {} });

    expect(code).toBe(1);
    expect(existsSync(runnerPidPath(dir))).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
  });
});
