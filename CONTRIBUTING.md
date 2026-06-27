# Contribuindo com o Aluy CLI

Obrigado pelo interesse. Este guia cobre o essencial para abrir um PR.

## Ambiente

Monorepo npm (`@hiperplano/aluy-cli-core` + `@hiperplano/aluy-cli`), TypeScript/Node, TUI em Ink.

```bash
npm install
npm run build       # tsc -b (cli-core → cli, na ordem do grafo)
npm run lint
npm run typecheck
npm test
node packages/cli/dist/bin/aluy.js --help
```

## Fluxo de PR

1. Trabalhe em uma branch e abra o PR contra `main`.
2. **CI verde é obrigatória** — lint + type-check + build + testes. Sem masking
   (nada de `|| true` / `continue-on-error` / `--exit-zero`): gate vermelho
   bloqueia o merge.
3. Acrescente testes para o que você muda; mantenha o estilo do código ao redor.

## Fronteira modular

`@hiperplano/aluy-cli-core` é a engine **portável** do agente — **não importa Ink nem faz
I/O de terminal**. Isso é travado no eslint (`no-restricted-imports`) e no teste
de fronteira (`packages/cli-core/tests/boundary.test.ts`). Toda a parte de TUI e
o binário `aluy` vivem em `@hiperplano/aluy-cli`.

## Segurança

Nenhum segredo versionado — só `.env.example` com placeholders. Credenciais ficam
no keychain do SO, nunca em arquivo, `.env` ou log. O `gitleaks` roda na CI.
