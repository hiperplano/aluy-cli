// EST-0965 · ADR-0076 §5 — PROVA pyte/emulador: o RENDERER DIFERENCIAL do cockpit NÃO
// corrompe a região da conversa sob STREAMING. O bug (visto via PTY+pyte com agentes
// reais): o diff escrevia uma linha nova mais CURTA sobre uma linha velha mais LONGA sem
// limpar o rabo ⇒ sobreposição ("ajudar!ar você hoje?"), e o 1º char da linha diffada
// virava um artefato ("A"→"●").
//
// CAUSA-RAIZ (provada aqui): o cockpit ENCHE `rows` na maioria dos frames ⇒ o Ink usa
// `clearTerminal`+frame (caminho `outputHeight>=rows`). MAS quando uma linha da conversa
// ENCOLHE e o frame fica < `rows`, o Ink cai no `log-update` e emite OUTROS bytes —
// `eraseLines`(`\x1b[2K…`) OU conteúdo CRU (1º `throttledLog`, `previousLineCount=0`). O
// differ ANTIGO só casava `clearTerminal` e passava esses outros CRUS ⇒ eram escritos da
// posição em que o cursor PAROU (meio da tela) ⇒ sobrescreviam linhas ERRADAS, deixando
// CAUDA da velha e MESCLANDO conteúdo + artefato no início. O FIX: o differ OWNS os TRÊS
// formatos e SEMPRE faz o diff por-linha ABSOLUTO (CUP+`\x1b[K`).
//
// A prova é uma RECONSTRUÇÃO de tela (emulador de terminal que interpreta os MESMOS escapes
// que o differ emite — CUP/`\x1b[K`/`\x1b[J`/`\x1b[H`/`\n`/`\r` + imprimíveis) alimentada
// com os BYTES REAIS do Ink através do envelope REAL (`wrapStdoutWithSync` + `setCockpit`).
// Espelha o pyte do gate de PTY sem depender de um PTY (determinístico no runner).

import './_scrub-ci-env.js';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, Box, Text } from 'ink';
import { wrapStdoutWithSync } from '../../src/session/synchronized-output.js';

const ESC = '\x1b[';
const ERASE_SCREEN = `${ESC}2J`; // o branqueamento de tela = a fonte do flicker (#150).

// `\x1b` literal num regex literal dispara `no-control-regex`; monta-se via RegExp.
const CUP_RE = new RegExp(`${ESC.replace('[', '\\[')}\\d+;1H`, 'g');
function countCursorTo(s: string): number {
  return (s.match(CUP_RE) ?? []).length;
}
function count(s: string, needle: string): number {
  return s.split(needle).length - 1;
}

/**
 * Emulador de terminal MÍNIMO (no espírito do pyte): interpreta as sequências que o differ
 * emite e mantém um grid `rows`×`cols`. Reconstrói a TELA que o usuário veria — é onde a
 * SOBREPOSIÇÃO (rabo da linha velha) apareceria se o `\x1b[K`/posição falhasse.
 */
class ScreenEmulator {
  cols: number;
  rows: number;
  grid: string[][];
  r = 0;
  c = 0;
  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
  }
  feed(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b' && s[i + 1] === '[') {
        let j = i + 2;
        let num = '';
        while (j < s.length && /[0-9;?]/.test(s[j]!)) {
          num += s[j];
          j += 1;
        }
        const cmd = s[j];
        const args = num
          .replace('?', '')
          .split(';')
          .map((x) => (x === '' ? undefined : parseInt(x, 10)));
        const n = args[0];
        switch (cmd) {
          case 'A':
            this.r = Math.max(0, this.r - (n ?? 1));
            break;
          case 'B':
            this.r = Math.min(this.rows - 1, this.r + (n ?? 1));
            break;
          case 'G':
            this.c = (n ?? 1) - 1;
            break;
          case 'H':
          case 'f':
            this.r = (args[0] ?? 1) - 1;
            this.c = (args[1] ?? 1) - 1;
            break;
          case 'K': {
            const mode = n ?? 0;
            const row = this.grid[this.r]!;
            if (mode === 0) for (let x = this.c; x < this.cols; x++) row[x] = ' ';
            else if (mode === 1) for (let x = 0; x <= this.c; x++) row[x] = ' ';
            else for (let x = 0; x < this.cols; x++) row[x] = ' ';
            break;
          }
          case 'J': {
            const mode = n ?? 0;
            if (mode === 0) {
              const row = this.grid[this.r]!;
              for (let x = this.c; x < this.cols; x++) row[x] = ' ';
              for (let y = this.r + 1; y < this.rows; y++) this.grid[y]!.fill(' ');
            }
            break;
          }
          default:
            break;
        }
        i = j + 1;
        continue;
      }
      if (ch === '\n') {
        this.r = Math.min(this.rows - 1, this.r + 1);
        this.c = 0;
        i += 1;
        continue;
      }
      if (ch === '\r') {
        this.c = 0;
        i += 1;
        continue;
      }
      if (this.r < this.rows && this.c < this.cols) {
        this.grid[this.r]![this.c] = ch;
        this.c += 1;
      }
      i += 1;
    }
  }
  line(r: number): string {
    return this.grid[r]!.join('').replace(/\s+$/, '');
  }
}

function makeStub(rows: number, columns: number): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    },
    isTTY: true,
    columns,
    rows,
    on() {
      return this;
    },
    off() {
      return this;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
    emit() {
      return false;
    },
    end() {},
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

/** Conversa de cockpit: N linhas de conversa + nada mais. A 1ª linha é a que strema. */
function Conversa({ linhas }: { linhas: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column" width={50}>
      {linhas.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('EST-0965 · ADR-0076 §5 — cockpit diff NÃO corrompe a conversa sob streaming (prova de tela)', () => {
  it('linha LONGA → linha CURTA na mesma região (frame encolhe < rows): tela LIMPA, SEM rabo da velha, SEM artefato no início', async () => {
    const rows = 6;
    const cols = 50;
    const { stream, writes } = makeStub(rows, cols);
    // o envelope REAL do cockpit (overwrite ON + setCockpit como no wiring). Sync OFF só p/
    // a reconstrução ler os bytes sem o `?2026` em volta (o `?2026` é ortogonal à posição).
    const sync = wrapStdoutWithSync(stream, { sync: false, overwrite: true });
    sync.setCockpit(true);
    const term = new ScreenEmulator(cols, rows);

    // Frame que ENCHE `rows` (clearTerminal): a 1ª linha é LONGA, como o agente respondendo.
    const inst = render(
      <Conversa
        linhas={['Λ Agente 1: Olá! Como posso ajudar você hoje?', 'b', 'c', 'd', 'e', 'f']}
      />,
      { stdout: sync.stdout, exitOnCtrlC: false, patchConsole: false },
    );
    await tick();
    // STREAMING: a 1ª linha encolhe (token novo mais curto) ⇒ frame fica < `rows` ⇒ o Ink
    // cai no `log-update` (NÃO clearTerminal). É AQUI que o bug aparecia.
    inst.rerender(<Conversa linhas={['  Ambos estão prontos para ajudar!', 'b', 'c', 'd', 'e']} />);
    await tick();
    inst.unmount();

    for (const w of writes) term.feed(w);

    // (1) A linha NOVA aparece LIMPA — SEM o rabo da linha velha mais longa. ANTES o
    //     emulador mostraria "  Ambos…ajudar!" mesclado com a cauda "ar você hoje?"/
    //     "f" da linha anterior; DEPOIS, só o conteúdo novo.
    expect(term.line(0)).toBe('  Ambos estão prontos para ajudar!');
    // (2) SEM artefato no INÍCIO: o 1º caractere é o esperado ('Espaço'+'A'), não um '●'/
    //     byte de controle (origem do "A"→"●": cursor em coluna errada). CUP absoluto p/
    //     `;1H` garante coluna 1.
    expect(term.line(0).startsWith('  Ambos')).toBe(true);
    // (3) Nenhuma linha da tela carrega CAUDA mesclada da longa velha ("você hoje?").
    for (let r = 0; r < rows; r += 1) {
      expect(term.line(r).includes('você hoje?'), `linha ${r} vazou a cauda da velha`).toBe(false);
      // a sobreposição clássica da evidência: NEW '…ajudar!' colado em OLD '…você hoje?'.
      expect(term.line(r).includes('ajudar!ar'), `linha ${r} tem a sobreposição`).toBe(false);
    }
    // (4) A linha órfã do frame que encolheu (a 6ª, que sumiu) ficou LIMPA.
    expect(term.line(5)).toBe('');
  });

  it('flicker MÍNIMO preservado: 1 char muda ⇒ POUCAS linhas reescritas (CUP), `\\x1b[2J`=0 (#150/#151)', async () => {
    const rows = 40; // cockpit cheio ⇒ caminho clearTerminal (1 char ⇒ 1 linha no diff).
    const cols = 80;
    const { stream, writes } = makeStub(rows, cols);
    const sync = wrapStdoutWithSync(stream, { sync: true, overwrite: true });
    sync.setCockpit(true);
    const linhasBase = Array.from({ length: rows - 1 }, (_, i) => `linha estática ${i}`);
    const inst = render(<Conversa linhas={[...linhasBase, '› ola']} />, {
      stdout: sync.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await tick();
    const before = writes.length;
    // digita 1 char no composer: só a ÚLTIMA linha muda.
    inst.rerender(<Conversa linhas={[...linhasBase, '› olas']} />);
    await tick();
    inst.unmount();

    const rerender = writes.slice(before).join('');
    expect(rerender.length, 'o re-render não produziu bytes').toBeGreaterThan(0);
    // ZERO branqueamento de tela (não regride #150).
    expect(count(rerender, ERASE_SCREEN), 'cintila: \\x1b[2J no re-render').toBe(0);
    // POUCAS linhas reescritas (1 char ⇒ ~1 linha), NÃO ~`rows`. Folga p/ ruído de borda.
    expect(countCursorTo(rerender)).toBeLessThanOrEqual(3);
    expect(
      countCursorTo(rerender),
      'o diff não reescreveu linha nenhuma (vacuamente verde)',
    ).toBeGreaterThanOrEqual(1);
  });
});
