// TRAVA de publish ingênuo.
//
// O `package.json` de DEV de @hiperplano/aluy-cli NÃO é o artefato publicável: ele declara
// `@hiperplano/aluy-cli-core` (interno, `private`) como dep e ship `files:["dist"]` (com
// sourcemaps/.tsbuildinfo). Publicar ele direto (`npm publish` na pasta do
// pacote) produziria um tarball QUEBRADO (import @hiperplano/aluy-cli-core não-resolvido) e
// SUJO. A entrega monolítica passa pelo pipeline de release:
//   npm run bundle && npm run make-publish-pkg  → publica `package.publish.json`.
//
// Este guard roda no `prepublishOnly` do pacote de DEV. O `package.publish.json`
// gerado NÃO tem `prepublishOnly`, então o publish REAL (com o publish-pkg) não
// dispara esta trava. Quem tentar `npm publish` na pasta de dev bate aqui e para.
//
// Escotilha de emergência consciente: ALUY_ALLOW_RAW_PUBLISH=1 (não usar — existe
// só p/ não engessar um cenário extremo; o caminho correto é o pipeline de bundle).
if (process.env.ALUY_ALLOW_RAW_PUBLISH === '1') {
  console.warn(
    '[guard-publish] ALUY_ALLOW_RAW_PUBLISH=1 — pulando a trava. Você está publicando o package.json de DEV (tarball quebrado/sujo). Quase certamente ERRADO.',
  );
  process.exit(0);
}

console.error(
  [
    'ERRO: publish do package.json de DEV de @hiperplano/aluy-cli está BLOQUEADO (entrega monolítica).',
    '',
    'Este package.json declara @hiperplano/aluy-cli-core (interno/private) e ship sourcemaps — o tarball sairia',
    'QUEBRADO e SUJO. O artefato publicável é gerado pelo pipeline de bundle:',
    '',
    '  npm run scan-bundle      # embute @hiperplano/aluy-cli-core + scan do bundle',
    '  npm run make-publish-pkg # gera package.publish.json (sem dep interna; README+LICENSE)',
    '  # publica usando package.publish.json',
  ].join('\n'),
);
process.exit(1);
