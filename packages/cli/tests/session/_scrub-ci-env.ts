// EST-0965 · ADR-0076 — SCRUB das marcas de CI ANTES de o Ink ser importado (side-effect
// de import). O Ink importa `is-in-ci`, que avalia `isInCi` UMA vez no import (top-level
// const) lendo `process.env`: se `CI`/`CONTINUOUS_INTEGRATION`/`CI_*` estão setados, o Ink
// DESLIGA o loop de render (escreve só staticOutput e NÃO o frame) — então um teste que mede
// os BYTES do frame do Ink dá resultado ENGANOSO no runner (`CI=true`): 0 frame ⇒ asserção
// vazia. (A mesma classe do #149/cockpit-paint-pty, mas IN-PROCESS em vez de sob PTY.)
//
// Por ser um MÓDULO importado ANTES do `ink` (ESM avalia os imports em ordem de fonte, em
// profundidade), este scrub roda ANTES de o `is-in-ci` congelar o `isInCi` ⇒ o Ink pinta
// como pinta pro usuário real (com `clearTerminal` no caminho `outputHeight>=rows`). Espelha
// a regra EXATA do `is-in-ci` (`CI !== '0'/'false'` + `CI`/`CONTINUOUS_INTEGRATION`/`CI_*`).
//
// USO: `import './_scrub-ci-env.js';` como o PRIMEIRO import do arquivo de teste, ANTES de
// qualquer import que puxe `ink` (direta ou transitivamente).
for (const key of Object.keys(process.env)) {
  if (key === 'CI' || key === 'CONTINUOUS_INTEGRATION' || key.startsWith('CI_')) {
    delete process.env[key];
  }
}
