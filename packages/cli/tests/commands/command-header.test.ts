// Testes de `command-header.ts` — o cabeçalho de marca dos comandos NÃO-TUI
// (`aluy login`, `aluy config`, `aluy doctor` etc.). O PONTO CRÍTICO (requisito duro
// do pedido, F-CMD-HEADER) é provar o ramo que NÃO imprime: sem TTY (pipe/CI/serviço
// automatizado) e com saída ESTRUTURADA (`--json`) — um cabeçalho ali seria uma
// REGRESSÃO séria (quebra qualquer parser/consumidor). Um teste que só verifica "o
// cabeçalho aparece" não provaria nada — os testes abaixo exercitam os dois ramos que
// NÃO devem imprimir, cada um sozinho, e só depois o ramo positivo (TTY, sem json).

import { describe, expect, it } from 'vitest';
import {
  buildCommandHeaderLines,
  printCommandHeader,
  shouldPrintCommandHeader,
} from '../../src/commands/command-header.js';

/** Stream fake que só acumula o que foi escrito — sem tocar I/O real nenhum. */
function fakeStream(isTTY: boolean): {
  lines: string[];
  stream: { write: (s: string) => boolean } & { isTTY: boolean };
} {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      isTTY,
      write(s: string): boolean {
        lines.push(s);
        return true;
      },
    },
  };
}

describe('buildCommandHeaderLines', () => {
  it('sai com a grafia Λluy quando o ambiente suporta Unicode', () => {
    const lines = buildCommandHeaderLines({
      env: { LANG: 'pt_BR.UTF-8', TERM: 'xterm' },
      version: '9.9.9',
    });
    expect(lines).toEqual(['', 'Λluy · v9.9.9']);
  });

  it('cai no fallback ASCII "Aluy" — nunca "Aluy Cli" nem "Λ Aluy" — sem Unicode', () => {
    const lines = buildCommandHeaderLines({ env: { TERM: 'linux' }, version: '9.9.9' });
    expect(lines).toEqual(['', 'Aluy · v9.9.9']);
    const joined = lines.join('\n');
    expect(joined).not.toContain('Aluy Cli');
    expect(joined).not.toContain('Λ Aluy');
  });

  it('usa CLI_VERSION default quando a versão não é passada', () => {
    const lines = buildCommandHeaderLines({ env: { TERM: 'xterm' } });
    expect(lines[1]).toMatch(/^Λluy · v\d+\.\d+\.\d+/);
  });

  it('compacto: no máximo 2 linhas (respiro + marca/versão) — não é uma splash screen', () => {
    const lines = buildCommandHeaderLines({ env: { TERM: 'xterm' } });
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.length).toBe(2);
  });
});

describe('shouldPrintCommandHeader — o requisito duro: os dois ramos que NÃO imprimem', () => {
  // ─── RAMO (a): NÃO é TTY — pipe/redirect/CI/serviço automatizado ───
  it('NÃO imprime quando o stdout não é TTY, mesmo sem --json', () => {
    expect(shouldPrintCommandHeader({ isTTY: false, json: false })).toBe(false);
    expect(shouldPrintCommandHeader({ isTTY: false })).toBe(false);
  });

  // ─── RAMO (b): saída ESTRUTURADA (--json) — mesmo rodando num TTY de verdade ───
  it('NÃO imprime quando json:true, MESMO em TTY (copiar --json de um terminal interativo)', () => {
    expect(shouldPrintCommandHeader({ isTTY: true, json: true })).toBe(false);
  });

  it('NÃO imprime quando os dois ramos de recusa se somam (não-TTY + json)', () => {
    expect(shouldPrintCommandHeader({ isTTY: false, json: true })).toBe(false);
  });

  // ─── ramo positivo: só imprime quando NENHUM dos dois vetos se aplica ───
  it('imprime quando é TTY e não pediu json', () => {
    expect(shouldPrintCommandHeader({ isTTY: true, json: false })).toBe(true);
    expect(shouldPrintCommandHeader({ isTTY: true })).toBe(true);
  });
});

describe('printCommandHeader — efeito de I/O, gated pelo mesmo requisito', () => {
  it('NÃO escreve NADA no stream quando isTTY é false (pipe/redirect)', () => {
    const { lines, stream } = fakeStream(false);
    printCommandHeader({ stream, env: { TERM: 'xterm' } });
    expect(lines).toEqual([]);
  });

  it('NÃO escreve NADA no stream quando json:true, mesmo com isTTY true', () => {
    const { lines, stream } = fakeStream(true);
    printCommandHeader({ stream, json: true, env: { TERM: 'xterm' } });
    expect(lines).toEqual([]);
  });

  it('NÃO escreve nada quando isTTY é undefined (stream sem TTY, ex.: pipe puro)', () => {
    const lines: string[] = [];
    const stream = { write: (s: string): boolean => (lines.push(s), true) }; // sem isTTY
    printCommandHeader({ stream, env: { TERM: 'xterm' } });
    expect(lines).toEqual([]);
  });

  it('escreve as linhas do cabeçalho quando isTTY:true e sem json', () => {
    const { lines, stream } = fakeStream(true);
    printCommandHeader({ stream, env: { LANG: 'pt_BR.UTF-8', TERM: 'xterm' }, version: '1.2.3' });
    expect(lines).toEqual(['\n', 'Λluy · v1.2.3\n']);
  });
});
