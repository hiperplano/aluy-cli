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
    // ISOLAMENTO DO SIDECAR DE MEMÓRIA — a suíte NUNCA pode falar com o mem0 real.
    //
    // Achado em 01/09 no store do dono: `chroma.sqlite3` tinha 5.617 vetores e só 467
    // distintos, e os campeões eram literais de TESTE — 736× "Objetivo: faça algo /
    // Resultado: pronto.", 570× "...Resultado: resultado headless." (de headless-hooks.
    // test.ts), 279× "...consolidei os filhos." (de subagent-per-model-wiring.test.ts).
    // Ou seja: cada `npm test` numa máquina com o sidecar de pé DESPEJAVA lixo na
    // memória REAL do usuário — o engine cai no default `127.0.0.1:11435` e a fiação não
    // tinha nenhuma guarda de ambiente de teste.
    //
    // O dano não é só sujeira: os clones AFOGAM as memórias reais no ranking da busca.
    // Cinco consultas sem relação entre si ("telegram", "mcp picker", "flicker", ...)
    // devolviam 10 resultados cada com UM único texto distinto — o recall funcionava e
    // voltava ruído.
    //
    // A porta 1 é privilegiada e não escuta ninguém: a conexão é RECUSADA na hora (sem
    // timeout, sem lentidão) e o caminho de degradação (CA-MA8: a sessão segue sem
    // memória) é o mesmo que roda em máquina sem sidecar. Quem testa o engine de
    // propósito passa `mem0Url` explícito, que TEM precedência (`opts.mem0Url ?? ...`).
    env: { FORCE_COLOR: '3', ALUY_MEM0_URL: 'http://127.0.0.1:1' },
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
