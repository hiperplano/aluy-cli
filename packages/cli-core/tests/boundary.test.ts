// CA-2 — teste de FRONTEIRA do core modular (ADR-0053 §8).
//
// @aluy/cli-core é o engine PORTÁVEL: NÃO pode importar Ink/React nem fazer I/O
// de terminal (readline/tty). Este teste varre os fontes de cli-core e FALHA
// (vermelho) se qualquer import proibido aparecer. É a contrapartida do
// `no-restricted-imports` no eslint — defesa em profundidade: se alguém
// silenciar o lint, o teste ainda pega; se alguém pular o teste, o lint pega.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

// Specifiers proibidos no engine portável. Casam `from 'ink'`, `from "react"`,
// `import('node:readline')`, etc. — com ou sem o prefixo `node:`.
const FORBIDDEN = ['ink', 'react', 'react-dom', 'readline', 'readline/promises', 'tty'];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importedSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // import ... from '<spec>' | import '<spec>' | export ... from '<spec>'
  const staticRe = /(?:import|export)[^'"]*?['"]([^'"]+)['"]/g;
  // import('<spec>') | require('<spec>')
  const dynRe = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, dynRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.push(m[1]!);
  }
  return specs;
}

function isForbidden(spec: string): boolean {
  const bare = spec.replace(/^node:/, '');
  return FORBIDDEN.includes(bare);
}

describe('fronteira modular: @aluy/cli-core não importa TUI/IO de terminal', () => {
  const files = tsFiles(SRC);

  it('encontrou fontes do core para varrer', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('nenhum fonte do core importa ink/react/readline/tty', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importedSpecifiers(source)) {
        if (isForbidden(spec)) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders, `import(s) de TUI/IO proibidos no core:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });
});
