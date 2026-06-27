import { defineConfig } from 'vitest/config';

// CI honesta (ci-ts.yml): a CENTRAL roda `vitest run --passWithNoTests=false` e
// o gate de cobertura aplica os pisos via FLAG (--coverage.thresholds.*). NÃO
// fixamos thresholds=0 aqui (ci-honesty pega `passWithNoTests:true` e pisos
// zerados). O include/exclude abaixo é legítimo (estrategia.md §3.2): binário
// de entrada e tipos não contam como linha-de-lógica testável.
export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      // EST-0948 — testes de componente Ink (ink-testing-library) são .tsx.
      'packages/*/tests/**/*.test.tsx',
    ],
    passWithNoTests: false,
    // F66 — GATE HONESTO sob paralelismo. Os suites de INTEGRAÇÃO mais pesados
    // (buildSession completo, dirs temp, spawn de node-filho + handshake de
    // broker: bin.smoke, headless-*, *-wiring, subagent-*) excediam o
    // testTimeout DEFAULT de 5000ms quando a máquina fica sobre-inscrita pelos
    // workers paralelos do vitest — falhavam FLAKY ("Test timed out in 5000ms")
    // na suíte cheia mas passavam 100% ISOLADOS. Isso intoxicava o sinal do gate
    // (um dev não distinguia flaky de regressão real). 20s dá folga p/ contenção
    // de CPU sem ESCONDER falha real — um hang genuíno ainda falha, só que mais
    // tarde. (Os testes cross-process de SALAS já usavam 30s inline e nunca
    // caíram — mesma lógica, agora global.) hookTimeout idem p/ beforeAll/Each
    // pesados (criação de dirs temp / build de registry).
    testTimeout: 45_000,
    hookTimeout: 45_000,
    // Suites de INTEGRAÇÃO que spawnam o binário/processos-filho (kill de grupo,
    // handshake de broker/MCP) podem FALHAR-FLAKY sob contenção de CPU no CI
    // (timeout/race), passando 100% isolados. `retry` re-tenta o flake transiente
    // sem esconder regressão real (um bug determinístico ainda falha as N+1 vezes).
    retry: 2,
    // EST · acabamento TUI — FORCE_COLOR=3 (truecolor) p/ os testes de RENDER do
    // markdown/realce poderem afirmar a SAÍDA ANSI REAL que um terminal truecolor
    // vê (cores derivadas dos papéis do DS). Sem isto, o `chalk` da Ink detecta
    // não-TTY (level 0) e suprime TODA cor, tornando impossível provar o
    // acabamento. O env entra no processo ANTES do chalk cachear o nível. NÃO
    // afeta o smoke do binário: `aluy --version`/`--help` são `console.log` puros
    // (sem Ink/chalk), logo sem ANSI mesmo com FORCE_COLOR. Os fallbacks NO_COLOR
    // continuam exercitados via env do PRÓPRIO teste (resolveTheme({env})), pois
    // a palette MONO simplesmente não tem `color` — nenhum SGR de cor é emitido.
    env: { FORCE_COLOR: '3' },
    // Build (`tsc -b`) ANTES da suíte — o job `unit` da CI central roda `vitest
    // run` sem build prévio, mas cli.test.ts resolve `@hiperplano/aluy-cli-core` pelo seu
    // `exports` (./dist/index.js, wiring REAL de pacote) e bin.smoke.test.ts
    // spawna o binário COMPILADO. O globalSetup garante o dist/ p/ AMBOS, de
    // forma honesta (sem alias, sem skip). Ver vitest.global-setup.ts.
    globalSetup: ['./vitest.global-setup.ts'],
    coverage: {
      provider: 'v8',
      // all:true — conta TODO arquivo de `include`, mesmo os nunca importados por
      // um teste. Sem isso, um fonte novo sem teste não derrubaria a %, e o gate
      // de cobertura viraria um falso-verde (desonesto). Com all:true, código
      // não-testado pesa contra o piso — é o que torna o gate real (CA-4).
      all: true,
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'packages/cli/src/bin/**', // ponto de entrada do binário (smoke via spawn, não unit)
        // Fronteira de I/O de terminal (readline real / process.std*): como o
        // bin, é I/O puro — testado por smoke/manual, não por unit. A LÓGICA dos
        // comandos (login/logout/whoami) usa um `TerminalIO` injetável e ESSA é
        // testada (commands.test.ts). Mesma razão do `bin/` acima (estrategia.md §3.2).
        'packages/cli/src/auth/io.ts',
        '**/index.ts', // barrels de reexport
        // EST-0948 — superfícies de RENDER/COMPOSIÇÃO de I/O da TUI (mesma razão
        // do `bin/` e do `auth/io.ts`): App.tsx renderiza Ink + captura teclado
        // (TTY puro, smoke/manual), run.tsx faz o render/spawn, wiring.ts é a
        // composição de objetos concretos (fs/child_process/keychain reais). A
        // LÓGICA está nos módulos testados: controller (estado), ask-resolver
        // (fail-safe), io/* (confinamento/timeout/egress), theme/slash (puros).
        'packages/cli/src/session/App.tsx',
        'packages/cli/src/session/run.tsx',
        'packages/cli/src/session/wiring.ts',
      ],
    },
  },
});
