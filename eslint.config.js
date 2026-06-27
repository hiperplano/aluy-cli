// ESLint flat config (v9) — aluy-vau monorepo.
// CI honesta: roda `eslint . --max-warnings=0` (ci-ts.yml). Warning = vermelho.
//
// Regra de fronteira modular (ADR-0053 §8): @aluy/cli-core é o engine PORTÁVEL
// (loop/tools/permissão) e NÃO pode importar Ink nem fazer I/O de terminal.
// O `no-restricted-imports` abaixo BLOQUEIA, dentro de packages/cli-core/src,
// qualquer import de `ink`, `react`, `readline`, `tty` e afins. Se o core
// importar TUI/IO, o lint fica VERMELHO. Isto é a metade-de-máquina do
// teste de fronteira (a outra metade é o teste unitário em cli-core).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const TERMINAL_AND_TUI = [
  {
    name: 'ink',
    message: 'cli-core é portável: sem Ink/TUI no engine (ADR-0053 §8). TUI mora em @aluy/cli.',
  },
  { name: 'react', message: 'cli-core é portável: sem React/Ink no engine (ADR-0053 §8).' },
  {
    name: 'readline',
    message: 'cli-core não faz I/O de terminal (ADR-0053 §8). I/O mora em @aluy/cli.',
  },
  { name: 'readline/promises', message: 'cli-core não faz I/O de terminal (ADR-0053 §8).' },
  { name: 'tty', message: 'cli-core não faz I/O de terminal (ADR-0053 §8).' },
  { name: 'node:readline', message: 'cli-core não faz I/O de terminal (ADR-0053 §8).' },
  { name: 'node:readline/promises', message: 'cli-core não faz I/O de terminal (ADR-0053 §8).' },
  { name: 'node:tty', message: 'cli-core não faz I/O de terminal (ADR-0053 §8).' },
];

export default tseslint.config(
  {
    // `scripts/` é harness de SMOKE manual (Node ESM puro, rodado à mão), não
    // código publicado — fora do lint de produção (paridade com `dist/`). A
    // verificação de tipos do produto é o `tsc -b` sobre `packages/*`.
    ignores: [
      '**/dist/**',
      '**/dist-bundle/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // `scripts/` (raiz E por-pacote, ex.: packages/cli/scripts/) = harness/tooling
      // Node ESM puro, rodado à mão / no build — fora do lint de produto (paridade dist/).
      '**/scripts/**',
      // worktrees efêmeras de agentes (cópias do repo) — NUNCA são código de produto;
      // o lint só deve ver a árvore real, não snapshots de outras sessões.
      '**/.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Fronteira modular: vale SÓ para o engine portável.
    files: ['packages/cli-core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: TERMINAL_AND_TUI }],
    },
  },
  {
    // EST-0970/EST-1007 — fixtures de teste são scripts Node puros: servers MCP ESM
    // (`.mjs`, processo-server no teste stdio) e preloads `--require` (`.cjs`, ex.: o
    // `force-root` que simula uid 0). Análogos ao harness `scripts/`. Recebem os globais
    // de Node (process/etc.).
    files: ['packages/**/tests/**/fixtures/**/*.mjs', 'packages/**/tests/**/fixtures/**/*.cjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
