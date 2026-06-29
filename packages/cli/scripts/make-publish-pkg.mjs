// EST-0949 — gera o package.json de PUBLICAÇÃO a partir do de dev: aponta main/bin
// p/ o dist-bundle, REMOVE @hiperplano/aluy-cli-core (embutido), mantém os externals. NÃO toca
// o package.json de dev (workspaces precisam do @hiperplano/aluy-cli-core).
//
// README/LICENSE: o monorepo guarda os dois na RAIZ (não em packages/cli/), então o
// `npm publish` do pacote não os enxergaria e o tarball sairia SEM doc/licença (defeito
// p/ pacote público). Aqui copiamos os dois p/ o dir do pacote e os incluímos no `files`.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// TRAVA anti-regressão: os assets RUNTIME (ex.: o servidor do sidecar mem0) PRECISAM existir
// no dir do pacote, senão o `files:['assets']` publica um dir vazio e o mem0 quebra em toda
// máquina (já aconteceu). Falhar AQUI é barato; descobrir em produção custou várias rc.
const REQUIRED_ASSETS = ['assets/mem0/aluy-mem0-server.py'];
for (const rel of REQUIRED_ASSETS) {
  if (!existsSync(rel)) {
    console.error(`[publish-pkg] ERRO: asset obrigatório ausente: ${rel} — abortando publish.`);
    process.exit(1);
  }
}

const repoRoot = join(process.cwd(), '..', '..');
copyFileSync(join(repoRoot, 'README.md'), 'README.md');
copyFileSync(join(repoRoot, 'LICENSE'), 'LICENSE');

const dev = JSON.parse(readFileSync('package.json', 'utf8'));
const deps = { ...dev.dependencies };
delete deps['@hiperplano/aluy-cli-core']; // embutido no bundle
const pub = {
  name: dev.name,
  version: dev.version,
  description: dev.description,
  type: dev.type,
  license: dev.license,
  repository: dev.repository,
  bugs: dev.bugs,
  homepage: dev.homepage,
  keywords: dev.keywords,
  engines: dev.engines,
  publishConfig: dev.publishConfig,
  main: './dist-bundle/index.js',
  // SEM o prefixo `./` — npm (>=10) rejeita `bin` com `./` e "auto-corrige" removendo
  // a entrada no publish (binário `aluy` sumiria do pacote). Caminho relativo cru.
  bin: { aluy: 'dist-bundle/bin/aluy.js' },
  // README/LICENSE explícitos no allowlist (npm os inclui por convenção, mas explícito
  // é honesto e à prova de regressão). dist-bundle = só o artefato bundlado.
  // `assets` é OBRIGATÓRIO: carrega o aluy-mem0-server.py (o servidor do sidecar mem0).
  // Sem ele o pacote publica sem o script ⇒ o venv do mem0 fica sem o que rodar ⇒
  // `mem0 ✗ (fora)` em TODA máquina, em qualquer SO (regressão histórica — não esquecer).
  files: ['dist-bundle', 'assets', 'README.md', 'LICENSE'],
  dependencies: deps,
};
writeFileSync('package.publish.json', JSON.stringify(pub, null, 2) + '\n');
console.log(
  '[publish-pkg] gerado package.publish.json (sem @hiperplano/aluy-cli-core; main/bin→dist-bundle; README+LICENSE copiados da raiz)',
);
