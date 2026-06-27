// EST-0965 · ADR-0076 §5 (FIX #151) — A PROVA DE POSIÇÃO do renderer diferencial do cockpit.
//
// O #151 matou o flicker (1 char ⇒ só a linha mudada, não a tela), mas introduziu DOIS bugs
// de POSICIONAMENTO (relato do Tiago):
//   (1) o "local de escrever" (caret do composer) ficou DESLOCADO PRA BAIXO do cursor — na
//       verdade o diff deixava o cursor no HOME (`\x1b[H`), enquanto o composer mora na
//       ÚLTIMA linha do frame; o caret blinkava no TOPO, não no composer.
//   (2) quando os agentes de teste começavam a rodar, o LOG saía no lugar errado — porque o
//       cursor parado no HOME quebrava o posicionamento RELATIVO do write seguinte (ex.: o
//       `log-update` do Ink num frame que cai no caminho `outputHeight<rows`).
//
// AMBOS têm a MESMA causa-raiz: o diff terminava em `\x1b[H` (home) em vez de reposicionar o
// cursor ONDE O FULL-PAINT o deixaria (o FIM do frame). O fix re-emite essa posição.
//
// Por que ESTE teste e não só o de bytes (cockpit-diff): flicker é uma prova de BYTES (quantas
// linhas repinta); POSIÇÃO é uma prova de TELA RECONSTRUÍDA. Aqui aplicamos os bytes do diff
// num EMULADOR de terminal (grid + cursor, interpreta CUP/CR/LF/CUU/EL/ED) e checamos onde o
// cursor e o conteúdo ASSENTAM. O emulador é PURO JS (roda em QUALQUER runner, sem pyte — que
// o runner self-hosted não tem, ver cockpit-paint-pty.test.ts). Um cross-check opcional com
// pyte (`skipIf` quando ausente) confirma o emulador contra um emulador de referência.

import './_scrub-ci-env.js';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createCockpitDiffer } from '../../src/session/synchronized-output.js';

const ESC = '\x1b[';
const CLEAR_TERMINAL = `${ESC}2J${ESC}3J${ESC}H`; // o `clearTerminal` do Ink no alt-screen.
const SHOW_CURSOR = `${ESC}?25h`; // o Ink anexa isto ao FIM do frame (largura ZERO).

// ── Emulador de terminal MÍNIMO (grid + cursor) ──────────────────────────────────────────
// Interpreta SÓ o que o renderer emite: CUP (`\x1b[r;cH`/`\x1b[rH`), CUU (`\x1b[nA`), CHA
// (`\x1b[nG`), EL (`\x1b[K`), ED (`\x1b[J`), `\n`, `\r` e caracteres imprimíveis. Demais CSI
// (cor, `?25h`) são consumidos SEM efeito de posição/conteúdo. Coordenadas 0-based internas.
interface Term {
  feed(s: string): void;
  /** Linha `r` (0-based) com a cauda de espaços removida. */
  line(r: number): string;
  /** Cursor {row,col} 0-based. */
  cursor(): { row: number; col: number };
}
function makeTerm(rows: number, cols: number): Term {
  const grid: string[][] = Array.from({ length: rows }, () => Array<string>(cols).fill(' '));
  let cr = 0;
  let cc = 0;
  const put = (ch: string): void => {
    if (cr < rows && cc < cols) grid[cr]![cc] = ch;
    if (cc < cols) cc += 1;
  };
  const feed = (s: string): void => {
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === '\x1b' && s[i + 1] === '[') {
        let j = i + 2;
        let p = '';
        while (j < s.length && /[0-9;?]/.test(s[j]!)) {
          p += s[j];
          j += 1;
        }
        const fin = s[j];
        const nums = p
          .replace(/\?/g, '')
          .split(';')
          .map((x) => (x === '' ? undefined : Number(x)));
        if (fin === 'H' || fin === 'f') {
          cr = (nums[0] ?? 1) - 1;
          cc = (nums[1] ?? 1) - 1;
        } else if (fin === 'A') {
          cr = Math.max(0, cr - (nums[0] ?? 1));
        } else if (fin === 'B') {
          cr = Math.min(rows - 1, cr + (nums[0] ?? 1));
        } else if (fin === 'G') {
          cc = (nums[0] ?? 1) - 1;
        } else if (fin === 'K') {
          for (let x = cc; x < cols; x += 1) grid[cr]![x] = ' ';
        } else if (fin === 'J') {
          for (let y = cr; y < rows; y += 1)
            for (let x = y === cr ? cc : 0; x < cols; x += 1) grid[y]![x] = ' ';
        }
        // demais CSI (m/?25h/…): consome sem efeito.
        i = j + 1;
        continue;
      }
      if (c === '\n') {
        cr = Math.min(rows - 1, cr + 1);
        cc = 0;
        i += 1;
        continue;
      }
      if (c === '\r') {
        cc = 0;
        i += 1;
        continue;
      }
      put(c);
      i += 1;
    }
  };
  return {
    feed,
    line: (r) => grid[r]!.join('').replace(/\s+$/, ''),
    cursor: () => ({ row: cr, col: cc }),
  };
}

const ROWS = 12;
const COLS = 40;

/** Monta o frame do cockpit como o Ink o emite: `clearTerminal` + body + `?25h` no fim. */
function cockpitFrame(lines: string[]): string {
  const padded = [...lines];
  while (padded.length < ROWS) padded.push(''); // altura fixa == ROWS (invariante §3).
  return `${CLEAR_TERMINAL}${padded.join('\n')}${SHOW_CURSOR}`;
}

/** Onde o FULL-PAINT deixaria o cursor: aplica `home + body + \x1b[J` num term limpo. */
function fullPaintCursor(lines: string[]): { row: number; col: number } {
  const t = makeTerm(ROWS, COLS);
  const body = cockpitFrame(lines).slice(CLEAR_TERMINAL.length);
  t.feed(`${ESC}H${body}${ESC}J`);
  return t.cursor();
}

describe('EST-0965 · ADR-0076 §5 (FIX #151) — POSIÇÃO: composer/caret na linha certa, log no lugar certo', () => {
  it('BUG 1 — caret do composer fica na LINHA do composer, NÃO deslocado pro topo', () => {
    // Cockpit típico: regiões estáticas em cima, COMPOSER na última linha de conteúdo.
    const f1 = ['log A', 'log B', 'log C', '─────', '> ol'];
    const f2 = ['log A', 'log B', 'log C', '─────', '> ola']; // digitou 1 char no composer.
    const composerRow = 4; // 0-based: a 5ª linha de conteúdo.

    const differ = createCockpitDiffer();
    const term = makeTerm(ROWS, COLS);
    term.feed(differ.transform(cockpitFrame(f1))); // 1º frame: full paint.
    term.feed(differ.transform(cockpitFrame(f2))); // 2º frame: diff (só o composer muda).

    // O conteúdo do composer está na linha certa (sanidade da pintura).
    expect(term.line(composerRow)).toBe('> ola');

    // A PROVA do BUG 1: o cursor (= caret/"local de escrever") assenta no FIM do frame, ONDE
    // o full-paint o deixaria — NÃO no topo (row 0). Antes do fix terminava em `\x1b[H` ⇒
    // cursor em {0,0} ⇒ caret no topo, composer "abaixo do cursor".
    const cur = term.cursor();
    const expected = fullPaintCursor(f2);
    expect(cur).toEqual(expected); // idêntico ao full-paint.
    expect(cur.row, 'caret no topo (row 0) = bug "composer abaixo do cursor"').not.toBe(0);
    // O caret está NA região do composer ou ABAIXO dela (no fim do frame), nunca acima.
    expect(cur.row).toBeGreaterThanOrEqual(composerRow);
  });

  it('BUG 1 (contraste) — terminar em HOME deixaria o caret no topo (a regressão do #151)', () => {
    // Reproduz o COMPORTAMENTO ANTIGO (diff que termina em `\x1b[H`) e prova que o caret cai
    // no topo — o defeito que o Tiago viu. Constrói o diff "à mão" terminando em home.
    const f1 = ['x', 'y', '> ol'];
    const term = makeTerm(ROWS, COLS);
    term.feed(`${ESC}H${cockpitFrame(f1).slice(CLEAR_TERMINAL.length)}${ESC}J`); // full paint
    // diff antigo: reescreve a linha do composer (1-based row 3) e termina em HOME (o bug).
    term.feed(`${ESC}3;1H> ola${ESC}K${ESC}H`);
    expect(term.cursor()).toEqual({ row: 0, col: 0 }); // caret NO TOPO = o bug.
    // (o teste acima prova que o FIX leva o caret pro fim do frame, não pra cá.)
  });

  it('BUG 2 — sob ATIVIDADE (N nós de log mudando/crescendo), cada linha de log fica na SUA row', () => {
    // Simula vários agentes: o log CRESCE e REFLUI ao longo de frames. Cada frame vem do Ink
    // como `clearTerminal`+body; o diff reescreve só o que muda, mas SEMPRE por CUP absoluto.
    const differ = createCockpitDiffer();
    const term = makeTerm(ROWS, COLS);

    // Sequência de frames de atividade: a região de LOG (linhas 0..k) ganha nós; o composer
    // segue na última linha de conteúdo. O log CRESCE de 2 → 5 nós e depois REFLUI p/ 3.
    const frames: string[][] = [
      ['[1] foo: lendo', '[2] bar: build', '> '],
      ['[1] foo: ok', '[2] bar: build', '[3] baz: testando', '> '],
      ['[1] foo: ok', '[2] bar: ok', '[3] baz: testando', '[4] qux: lint', '> a'],
      ['[1] foo: ok', '[2] bar: ok', '[3] baz: ok', '[4] qux: ok', '[5] zee: e2e', '> ab'],
      ['[3] baz: ok', '[4] qux: ok', '[5] zee: ok', '> abc'], // REFLUIU (encolheu).
    ];
    for (const f of frames) term.feed(differ.transform(cockpitFrame(f)));

    // PROVA: a tela reconstruída casa EXATAMENTE o último frame — cada linha de log na SUA
    // row absoluta, nada espalhado/deslocado. (Se o diff errasse a row absoluta, alguma
    // linha estaria fora do lugar ou duplicada.)
    const last = frames[frames.length - 1]!;
    for (let r = 0; r < last.length; r += 1) {
      expect(term.line(r), `linha de log/composer fora de lugar na row ${r}`).toBe(last[r]);
    }
    // As linhas órfãs (do frame maior anterior, que encolheu) foram VARRIDAS — não sobra
    // cauda de '[5] zee: e2e' / '> ab' embaixo.
    for (let r = last.length; r < ROWS; r += 1) {
      expect(term.line(r), `sobra órfã não varrida na row ${r}`).toBe('');
    }
    // E o caret assenta no fim do frame (o composer), como o full-paint — não no topo.
    expect(term.cursor()).toEqual(fullPaintCursor(last));
  });

  it('FIX corrupção — frame `log-update` (eraseLines, NÃO clearTerminal) é DIFFADO absoluto e cai na row certa', () => {
    // O caminho real do bug (corrupção sob streaming): às vezes o Ink NÃO emite `clearTerminal`
    // (frame `outputHeight<rows`), e sim o `log-update` (eraseLines `\x1b[2K…` RELATIVO ao
    // cursor). O differ ANTIGO devolvia esse chunk CRU e CONFIAVA que o reposicionamento do FIM
    // do frame (#151) faria o eraseLines relativo cair certo — mas isso só valia quando o
    // cursor estava EXATAMENTE no fim da região; em geral o eraseLines relativo sobrescrevia
    // linhas ERRADAS, deixando CAUDA da velha e mesclando conteúdo. AGORA o differ OWNS o
    // `eraseLines` no cockpit e o transforma em diff por-linha ABSOLUTO (CUP+`\x1b[K`) ⇒ cai
    // SEMPRE na row certa, independente de onde o cursor parou.
    const differ = createCockpitDiffer();
    const term = makeTerm(ROWS, COLS);
    const f1 = ['log A', 'log B', 'log C', '> ol'];
    const f2 = ['log A', 'log B', 'log C', '> ola'];
    term.feed(differ.transform(cockpitFrame(f1)));
    term.feed(differ.transform(cockpitFrame(f2))); // cursor agora no FIM do frame (#151).
    const curAfterDiff = term.cursor();
    expect(curAfterDiff).toEqual(fullPaintCursor(f2)); // pré-condição.

    // Agora o Ink manda um frame `log-update` (NÃO clearTerminal). Construímos o eraseLines
    // REAL que o Ink emitiria (sobe N linhas, apaga, reescreve do topo).
    const regionRows = curAfterDiff.row + 1; // da row 0 até o cursor, inclusive.
    let eraseLines = '';
    for (let k = 0; k < regionRows - 1; k += 1) eraseLines += `${ESC}2K${ESC}1A`;
    eraseLines += `${ESC}2K${ESC}G`;
    // novo conteúdo do log-update: log cresceu (entrou 'log D') — região reescrita do topo.
    const newRegion = ['log A', 'log B', 'log C', 'log D', '> ola'].join('\n');
    const transformed = differ.transform(eraseLines + newRegion);
    // O differ AGORA OWNS esse frame: NÃO passa cru — vira diff ABSOLUTO (ZERO `\x1b[2K`).
    expect(transformed).not.toBe(eraseLines + newRegion);
    expect(transformed.includes(`${ESC}2K`), 'sem branqueamento relativo de linha').toBe(false);
    term.feed(transformed);

    // PROVA (a que importa, a TELA): o log assentou nas rows 0..4 corretas — sem deslocamento,
    // sem cauda da velha. (A linha 'log D' entrou na row 3; '> ola' desceu p/ a row 4.)
    const expectedLines = ['log A', 'log B', 'log C', 'log D', '> ola'];
    for (let r = 0; r < expectedLines.length; r += 1) {
      expect(term.line(r), `log-update caiu na row errada (${r})`).toBe(expectedLines[r]);
    }
  });

  it('FLICKER PRESERVADO — 1 char ⇒ só a linha do composer é reescrita (1 CUP), zero `\\x1b[2J`', () => {
    // O DoD exige manter a prova do #151 ao lado da de posição: o fix NÃO regride o flicker.
    const differ = createCockpitDiffer();
    differ.transform(cockpitFrame(['est 0', 'est 1', 'est 2', '> ol'])); // assenta.
    const diff = differ.transform(cockpitFrame(['est 0', 'est 1', 'est 2', '> ola']));
    // zero branqueamento de tela (não regride o #150/#151).
    expect(diff.includes(`${ESC}2J`)).toBe(false);
    // POUCAS linhas reescritas (não o frame cheio): conta CUP `\x1b[<n>;<m>H`. 1 char ⇒ a
    // linha do composer (1 CUP) + o reposicionamento final do cursor (1 CUP) = 2 — MUITO
    // abaixo das `ROWS` que um full-paint reescreveria. O critério-mestre do flicker.
    const cupRe = new RegExp(`${ESC.replace('[', '\\[')}\\d+;\\d+H`, 'g');
    const cups = (diff.match(cupRe) ?? []).length;
    expect(cups, `diff reescreveu ${cups} CUP (esperado ~2, jamais ~${ROWS})`).toBeLessThanOrEqual(
      3,
    );
    expect(cups).toBeGreaterThanOrEqual(1);
    // o conteúdo estático NÃO foi reescrito (linhas iguais não entram no diff).
    expect(diff.includes('est 0')).toBe(false);
    expect(diff.includes('> ola')).toBe(true);
  });
});

// ── Cross-check opcional com pyte (emulador de referência) — só se pyte estiver disponível ──
const HAS_PYTE = spawnSync('python3', ['-c', 'import pyte'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!HAS_PYTE)(
  'FIX #151 — cross-check de POSIÇÃO com pyte (emulador de referência)',
  () => {
    /** Roda os bytes num pyte Screen e devolve as linhas + a posição do cursor. */
    function pyteReplay(chunks: string[]): { lines: string[]; cursor: { x: number; y: number } } {
      const script = `
import sys, json, pyte
rows, cols = ${ROWS}, ${COLS}
screen = pyte.Screen(cols, rows)
stream = pyte.Stream(screen)
chunks = json.loads(sys.stdin.read())
for c in chunks:
    stream.feed(c)
lines = [screen.display[i].rstrip() for i in range(rows)]
print(json.dumps({"lines": lines, "cursor": {"x": screen.cursor.x, "y": screen.cursor.y}}))
`;
      const res = spawnSync('python3', ['-c', script], {
        input: JSON.stringify(chunks),
        encoding: 'utf8',
      });
      if (res.status !== 0) throw new Error(`pyte falhou: ${res.stderr}`);
      return JSON.parse(res.stdout.trim());
    }

    it('pyte confirma: composer na linha certa + caret no fim do frame (não no topo)', () => {
      const differ = createCockpitDiffer();
      const f1 = ['log A', 'log B', 'log C', '> ol'];
      const f2 = ['log A', 'log B', 'log C', '> ola'];
      const c1 = differ.transform(cockpitFrame(f1));
      const c2 = differ.transform(cockpitFrame(f2));
      const { lines, cursor } = pyteReplay([c1, c2]);

      // composer na 4ª linha de conteúdo (row 3, 0-based) — pyte reconstrói a tela real.
      expect(lines[3]).toBe('> ola');
      expect(lines[0]).toBe('log A'); // estático intacto.
      // O caret NÃO está no topo (row 0) — está no fim do frame (a prova do BUG 1 sob pyte).
      expect(cursor.y, 'pyte: caret no topo = bug "composer abaixo do cursor"').not.toBe(0);
      // pyte e o full-paint concordam na linha do cursor (y == row).
      expect(cursor.y).toBe(fullPaintCursor(f2).row);
    });

    it('pyte confirma: sob atividade (log cresce/reflui) cada linha fica na SUA row', () => {
      const differ = createCockpitDiffer();
      const frames: string[][] = [
        ['[1] foo', '[2] bar', '> '],
        ['[1] foo', '[2] bar', '[3] baz', '> a'],
        ['[1] foo', '[2] bar', '[3] baz', '[4] qux', '> ab'],
        ['[3] baz', '[4] qux', '> abc'], // refluiu.
      ];
      const chunks = frames.map((f) => differ.transform(cockpitFrame(f)));
      const { lines } = pyteReplay(chunks);
      const last = frames[frames.length - 1]!;
      for (let r = 0; r < last.length; r += 1) expect(lines[r]).toBe(last[r]);
      for (let r = last.length; r < ROWS; r += 1) expect(lines[r]).toBe(''); // órfãs varridas.
    });
  },
);
