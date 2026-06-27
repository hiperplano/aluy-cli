// globalSetup do Vitest — garante o BUILD (`tsc -b`) antes da suíte rodar.
//
// POR QUÊ (ordem build->teste, honesta): a CI central (aluy-infra/ci-ts.yml) roda
// o job `unit` como `vitest run` PURO, SEM passo de build antes (o `build` é um
// job separado e paralelo). Mas duas suítes deste repo dependem do `dist/`:
//   1. cli.test.ts importa `@aluy/cli-core`, cujo `exports` aponta para
//      `./dist/index.js` (entry de pacote PUBLICADO — é o wiring real, não um
//      alias de teste). Sem `dist/`, o Vite/Vitest falha em resolver o pacote.
//   2. bin.smoke.test.ts (CA-3) spawna o binário COMPILADO `dist/bin/aluy.js`.
// Construir aqui resolve AMBOS de um jeito honesto: o teste exercita o wiring de
// `exports` REAL e o binário REAL — nada é mascarado, pulado ou aliasado. O
// smoke segue com sua pré-condição "dist existe" (agora satisfeita pelo build).
//
// Idempotente e barato: `tsc -b` é incremental (.tsbuildinfo); se o `dist/` já
// está atualizado, é quase no-op. Roda UMA vez por execução (globalSetup), não
// por arquivo de teste.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const cwd = fileURLToPath(new URL('.', import.meta.url));
  // `tsc -b` percorre o grafo de referências (cli-core -> cli) na ordem certa.
  // npx --no-install: usa o typescript do repo (determinístico; nada ad-hoc).
  const r = spawnSync('npx', ['--no-install', 'tsc', '-b'], {
    cwd,
    stdio: 'inherit',
    encoding: 'utf8',
    // No Windows, `npx` é um .cmd e precisa de shell para ser encontrado.
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    throw new Error(
      `globalSetup: build (tsc -b) falhou (status=${String(r.status)}) — ` +
        'a suíte depende do dist/ (exports de @aluy/cli-core + binário do smoke).',
    );
  }
}
