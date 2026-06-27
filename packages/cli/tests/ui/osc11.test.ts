// EST-0966 · /theme — auto-detecção do fundo do terminal via OSC 11.
//
// Cobre o PURO (parse das respostas XTerm/hex + luminância → brightness) e a CONSULTA
// de TTY (best-effort): escolhe LIGHT quando o terminal responde com fundo claro;
// cai p/ null (⇒ default dark no caller) sem resposta, sem TTY ou com NO_COLOR.

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  parseOsc11,
  brightnessOf,
  brightnessFromOsc11,
  relativeLuminance,
  queryTerminalBrightness,
  defaultOsc11TimeoutMs,
  OSC11_QUERY,
  type Osc11Probe,
} from '../../src/ui/theme/osc11.js';

const BEL = '\x07';
const ESC = '\x1b';

describe('parseOsc11 — formas de resposta', () => {
  it('rgb:RRRR/GGGG/BBBB (16-bit XTerm) — preto', () => {
    const rgb = parseOsc11(`${ESC}]11;rgb:0000/0000/0000${BEL}`);
    expect(rgb).toEqual({ r: 0, g: 0, b: 0 });
  });
  it('rgb:RRRR/GGGG/BBBB — branco (ffff escala p/ 255)', () => {
    const rgb = parseOsc11(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`);
    expect(rgb).toEqual({ r: 255, g: 255, b: 255 });
  });
  it('rgb com 2 dígitos por componente', () => {
    expect(parseOsc11('rgb:1a/17/12')).toEqual({ r: 26, g: 23, b: 18 });
  });
  it('forma hex curta #RRGGBB', () => {
    expect(parseOsc11('#F2EEE8')).toEqual({ r: 242, g: 238, b: 232 });
  });
  it('lixo / vazio ⇒ null', () => {
    expect(parseOsc11('não é uma resposta')).toBeNull();
    expect(parseOsc11('')).toBeNull();
  });
});

describe('luminância → brightness', () => {
  it('fundo escuro ⇒ dark', () => {
    expect(brightnessOf({ r: 26, g: 23, b: 18 })).toBe('dark'); // #1A1712 (DS dark)
    expect(brightnessOf({ r: 0, g: 0, b: 0 })).toBe('dark');
  });
  it('fundo claro ⇒ light', () => {
    expect(brightnessOf({ r: 242, g: 238, b: 232 })).toBe('light'); // #F2EEE8 (DS light)
    expect(brightnessOf({ r: 255, g: 255, b: 255 })).toBe('light');
  });
  it('relativeLuminance: preto≈0, branco≈1', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });
  it('brightnessFromOsc11 encadeia parse + classificação', () => {
    expect(brightnessFromOsc11(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`)).toBe('light');
    expect(brightnessFromOsc11(`${ESC}]11;rgb:1a1a/1717/1212${BEL}`)).toBe('dark');
    expect(brightnessFromOsc11('lixo')).toBeNull();
  });
});

// ── consulta de TTY (best-effort) ────────────────────────────────────────────
// Um stdin FAKE que é um EventEmitter com a API mínima do ReadStream que o probe usa.
function fakeStdin(opts: { isTTY: boolean }): NodeJS.ReadStream & { emitData(s: string): void } {
  const ee = new EventEmitter();
  const stub = ee as unknown as NodeJS.ReadStream & { emitData(s: string): void };
  Object.assign(stub, {
    isTTY: opts.isTTY,
    isRaw: false,
    setRawMode: vi.fn(() => stub),
    resume: vi.fn(() => stub),
    pause: vi.fn(() => stub),
    emitData: (s: string) => ee.emit('data', Buffer.from(s, 'utf8')),
  });
  return stub;
}

function fakeStdout(opts: { isTTY: boolean }): {
  stream: Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;
  written: string[];
} {
  const written: string[] = [];
  return {
    stream: {
      isTTY: opts.isTTY,
      write: ((s: string) => {
        written.push(s);
        return true;
      }) as NodeJS.WriteStream['write'],
    },
    written,
  };
}

describe('queryTerminalBrightness — best-effort', () => {
  it('terminal responde com fundo CLARO ⇒ light (e enviou a query OSC 11)', async () => {
    const stdin = fakeStdin({ isTTY: true });
    const { stream, written } = fakeStdout({ isTTY: true });
    const probe: Osc11Probe = { stdout: stream, stdin, env: {}, timeoutMs: 1000 };
    const p = queryTerminalBrightness(probe);
    // o terminal responde de forma assíncrona (próximo tick).
    setTimeout(() => stdin.emitData(`${ESC}]11;rgb:f2f2/eeee/e8e8${BEL}`), 0);
    expect(await p).toBe('light');
    expect(written).toContain(OSC11_QUERY);
  });

  it('terminal responde com fundo ESCURO ⇒ dark', async () => {
    const stdin = fakeStdin({ isTTY: true });
    const { stream } = fakeStdout({ isTTY: true });
    const p = queryTerminalBrightness({ stdout: stream, stdin, env: {}, timeoutMs: 1000 });
    setTimeout(() => stdin.emitData(`${ESC}]11;rgb:1a1a/1717/1212${BEL}`), 0);
    expect(await p).toBe('dark');
  });

  it('SEM resposta (terminal sem suporte) ⇒ null no timeout (→ default dark)', async () => {
    const stdin = fakeStdin({ isTTY: true });
    const { stream } = fakeStdout({ isTTY: true });
    const got = await queryTerminalBrightness({
      stdout: stream,
      stdin,
      env: {},
      timeoutMs: 20, // curto: não trava o boot
    });
    expect(got).toBeNull();
  });

  it('NO_COLOR ⇒ null sem nem perguntar (respeita a preferência)', async () => {
    const stdin = fakeStdin({ isTTY: true });
    const { stream, written } = fakeStdout({ isTTY: true });
    const got = await queryTerminalBrightness({
      stdout: stream,
      stdin,
      env: { NO_COLOR: '1' },
      timeoutMs: 1000,
    });
    expect(got).toBeNull();
    expect(written).toHaveLength(0); // nem escreveu a query
  });

  it('stdout não-TTY ⇒ null (sem terminal a quem perguntar)', async () => {
    const stdin = fakeStdin({ isTTY: true });
    const { stream } = fakeStdout({ isTTY: false });
    expect(
      await queryTerminalBrightness({ stdout: stream, stdin, env: {}, timeoutMs: 1000 }),
    ).toBeNull();
  });

  it('stdin não-TTY ⇒ null (não há como ler a resposta)', async () => {
    const stdin = fakeStdin({ isTTY: false });
    const { stream } = fakeStdout({ isTTY: true });
    expect(
      await queryTerminalBrightness({ stdout: stream, stdin, env: {}, timeoutMs: 1000 }),
    ).toBeNull();
  });

  it('restaura o stdin (sai do raw-mode, pausa) ao concluir', async () => {
    const stdin = fakeStdin({ isTTY: true });
    const { stream } = fakeStdout({ isTTY: true });
    const p = queryTerminalBrightness({ stdout: stream, stdin, env: {}, timeoutMs: 1000 });
    setTimeout(() => stdin.emitData(`${ESC}]11;rgb:0000/0000/0000${BEL}`), 0);
    await p;
    // entrou em raw (true) e saiu (false); pausou.
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
  });
});

describe('defaultOsc11TimeoutMs — folga p/ terminal remoto (regressão SSH)', () => {
  it('default local = 500ms', () => expect(defaultOsc11TimeoutMs({})).toBe(500));
  it('SSH_CONNECTION ⇒ 1000ms (ida-e-volta pela rede)', () =>
    expect(defaultOsc11TimeoutMs({ SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' })).toBe(1000));
  it('SSH_TTY também conta como SSH', () =>
    expect(defaultOsc11TimeoutMs({ SSH_TTY: '/dev/pts/0' })).toBe(1000));
  it('override ALUY_OSC11_TIMEOUT_MS é respeitado', () =>
    expect(defaultOsc11TimeoutMs({ ALUY_OSC11_TIMEOUT_MS: '1500' })).toBe(1500));
  it('override é capado em 5000ms', () =>
    expect(defaultOsc11TimeoutMs({ ALUY_OSC11_TIMEOUT_MS: '999999' })).toBe(5000));
  it('override inválido ⇒ cai no default', () =>
    expect(defaultOsc11TimeoutMs({ ALUY_OSC11_TIMEOUT_MS: 'abc' })).toBe(500));
});

describe('queryTerminalBrightness — robustez em terminal remoto/lento (regressão)', () => {
  it('NÃO faz .unref() no timer (senão o Node encerra ANTES da resposta e o OSC vaza no shell)', async () => {
    const stdin = fakeStdin({ isTTY: true });
    const { stream } = fakeStdout({ isTTY: true });
    let unrefCalls = 0;
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: TimerHandler,
      ms?: number,
      ...a: unknown[]
    ) => {
      const t = realSetTimeout(fn as () => void, ms, ...a);
      const orig = t.unref.bind(t);
      (t as unknown as { unref: () => unknown }).unref = () => {
        unrefCalls++;
        return orig();
      };
      return t;
    }) as typeof globalThis.setTimeout);
    await queryTerminalBrightness({ stdout: stream, stdin, env: {}, timeoutMs: 20 });
    spy.mockRestore();
    expect(unrefCalls).toBe(0);
  });

  it('resposta ATRASADA (~50ms) ainda é consumida ⇒ resolve (não vaza no shell)', async () => {
    const stdin = fakeStdin({ isTTY: true });
    const { stream } = fakeStdout({ isTTY: true });
    const p = queryTerminalBrightness({ stdout: stream, stdin, env: {}, timeoutMs: 300 });
    setTimeout(() => stdin.emitData(`${ESC}]11;rgb:0000/0000/0000${BEL}`), 50);
    expect(await p).toBe('dark');
  });
});
