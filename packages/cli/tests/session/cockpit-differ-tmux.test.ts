// Cockpit — a régua que ENCHE a largura não pode perder a última coluna (tmux real).
//
// Com o auto-wrap OFF (`?7l`) o cursor fica PARADO na última coluna depois de escrever nela, e
// um `\x1b[K` DEPOIS da linha apagava o próprio último caractere (régua de 106 col saía com
// 105; foi o que o tmux mostrou). O differ agora apaga a linha ANTES (`\x1b[2K`). Emuladores
// como o xterm.js tratam esse caso diferente do tmux/xterm de verdade, por isso este teste usa
// o tmux real (pulado se não houver `tmux`).
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

describe.skipIf(!hasTmux)('createCockpitDiffer × tmux real', () => {
  it('linhas que enchem a largura (réguas) chegam inteiras, após frames diffados', () => {
    const dist = pathToFileURL(
      fileURLToPath(new URL('../../dist/session/synchronized-output.js', import.meta.url)),
    ).href;
    const dir = mkdtempSync(join(tmpdir(), 'aluy-tmux-'));
    const script = join(dir, 's.mjs');
    writeFileSync(
      script,
      `import { createCockpitDiffer } from ${JSON.stringify(dist)};
const R = process.stdout.rows, C = process.stdout.columns;
const d = createCockpitDiffer(() => R, () => R, () => C);
process.stdout.write('\\x1b[?1049h\\x1b[?25l\\x1b[?7l');
const CT = '\\x1b[2J\\x1b[3J\\x1b[H';
for (let f = 0; f < 6; f++) {
  const rows = Array.from({ length: R }, (_, i) => (i % 5 === 1 ? '─'.repeat(C) : 'linha ' + i + ' f' + f + ' 🪶 ok'));
  process.stdout.write(d.transform(CT + rows.join('\\n') + '\\n'));
}
setTimeout(() => {}, 20000);
`,
    );
    const name = `aluy-t-${process.pid}`;
    try {
      spawnSync('tmux', [
        'new-session',
        '-d',
        '-s',
        name,
        '-x',
        '106',
        '-y',
        '30',
        `node ${script}`,
      ]);
      spawnSync('sleep', ['1.5']);
      const cap = spawnSync('tmux', ['capture-pane', '-p', '-t', name])
        .stdout.toString()
        .split('\n');
      const rules = cap.filter((l) => /^─+$/.test(l));
      expect(rules.length).toBeGreaterThan(3);
      for (const l of rules) expect(l.length).toBe(106);
    } finally {
      spawnSync('tmux', ['kill-session', '-t', name]);
    }
  });
});
