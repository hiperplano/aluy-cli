// CA-2 — teste de FRONTEIRA do core modular (ADR-0053 §8).
//
// @hiperplano/aluy-cli-core é o engine PORTÁVEL: NÃO pode importar Ink/React nem fazer I/O
// de terminal (readline/tty). Este teste varre os fontes de cli-core e FALHA
// (vermelho) se qualquer import proibido aparecer. É a contrapartida do
// `no-restricted-imports` no eslint — defesa em profundidade: se alguém
// silenciar o lint, o teste ainda pega; se alguém pular o teste, o lint pega.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

describe('fronteira modular: @hiperplano/aluy-cli-core não importa TUI/IO de terminal', () => {
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

// CORREÇÃO DE FRONTEIRA (rc.99) — o `SubAgentSpawner` (agent/subagent.ts) lia
// `process.env` DIRETO (via `readProcessEnv()`) pros tunables `ALUY_SUBAGENT_MAX_PER_CALL`/
// `ALUY_SUBAGENT_MAX_CONCURRENCY`, furando a fronteira portável (ADR-0053 §8: o core
// não lê env/arquivo). A correção moveu a leitura pro `cli` (session/wiring.ts →
// controller.ts, MESMO padrão do `mcpEnv`/`parentEnv` do `mcp/setup.ts`), injetada via
// `SubAgentSpawnerOptions.env`. Este teste é a contrapartida: varre `cli-core/src` e
// FALHA se qualquer fonte (fora de comentário) acessar `process.env`/`globalThis.process`
// diretamente — pega a regressão (alguém reintroduzindo o padrão) e qualquer violação
// NOVA fora da allowlist abaixo.
describe('fronteira modular: @hiperplano/aluy-cli-core não lê process.env/globalThis.process', () => {
  const files = tsFiles(SRC);

  // DÍVIDA TÉCNICA PRÉ-EXISTENTE (anterior a esta reconciliação/rc.99, fora do escopo
  // desta correção pontual): default-parâmetro injetável que cai em `process.env`
  // quando o caller não passa nada. Documentada explicitamente para não crescer sem
  // querer — qualquer arquivo NOVO fora desta lista que acesse process.env/
  // globalThis.process quebra o teste. Path relativo a `cli-core/src`, `/`-separado.
  const LEGACY_ENV_ACCESS_ALLOWLIST = new Set([
    'agent/degeneration.ts',
    'agent/mem-pressure.ts',
    'agent/stream-cap.ts',
    'agent/stuck-watchdog.ts',
    'sandbox/fail-mode.ts',
  ]);

  /** Remove comentários de bloco e de linha (best-effort — mesmo espírito do scanner de imports acima). */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  /** `process.env`/`process?.env`, ou o cast/acesso `globalThis...process`. */
  function accessesProcessEnvDirectly(code: string): boolean {
    if (/\bprocess\s*\??\s*\.\s*env\b/.test(code)) return true;
    if (/globalThis\s*(?:as\s*\{[^}]*process|\.\s*process\b)/.test(code)) return true;
    return false;
  }

  it('nenhum fonte NOVO do core lê process.env/globalThis.process diretamente', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (LEGACY_ENV_ACCESS_ALLOWLIST.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (accessesProcessEnvDirectly(code)) offenders.push(rel);
    }
    expect(
      offenders,
      `acesso direto a process.env/globalThis.process no core (ADR-0053 §8 — injete via opções, o cli lê o env):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
