# CLAUDE.md — Aluy CLI

Guia para um agente (ou pessoa) trabalhando neste repositório.

## O que é

Aluy CLI: um **agente de terminal** que roda na máquina do usuário e conduz seu
próprio loop de ferramentas (lê/edita arquivos, executa comandos, busca no
código, fala com servers MCP), numa TUI rica. Todo efeito passa por um **ponto
único de permissão** antes de acontecer. O usuário traz o **próprio provider de
LLM** (BYO, qualquer API compatível com a da OpenAI) com a própria credencial —
direto, sem intermediário.

## Stack

TypeScript/Node · distribuição **npm** (`npm i -g @hiperplano/aluy-cli`) · TUI **Ink** · SDK
MCP TS · **monorepo (npm workspaces)**: `@hiperplano/aluy-cli-core` (engine modular) +
`@hiperplano/aluy-cli` (TUI + binário `aluy`). Lema: **core modular, entrega monolítica**.

## Regras

1. **Idioma:** PT-BR em doc/UI; inglês no código quando é o padrão da stack
   (rotas, identificadores, view-ids).
2. **CI honesta** — lint + type-check + build + testes. **Nunca** `|| true`,
   `continue-on-error` nem `--exit-zero`. Gate vermelho bloqueia o merge.
3. **Sem segredo versionado** — só `.env.example` com placeholders; credenciais
   no keychain do SO (nunca em texto, nunca no repo). O `gitleaks` roda na CI.
4. **Binário público limpo** — zero credencial de provider no repo/binário.
5. **`main` protegido** — PR + review de CODEOWNERS, sem push direto.

## Invariantes (não relaxar)

- **Ponto de interceptação único.** Todo tool-call passa por `@hiperplano/aluy-cli-core`
  antes de qualquer efeito (deny-by-default). É o seam de segurança da CLI.
- **Fronteira modular.** `@hiperplano/aluy-cli-core` é portável: **não importa Ink nem faz
  I/O de terminal**. Travado no eslint (`no-restricted-imports`) + teste de
  fronteira (`packages/cli-core/tests/boundary.test.ts`).

## Como rodar

```bash
npm install
npm run build       # tsc -b (cli-core → cli, na ordem do grafo)
npm run lint        # eslint . (inclui a regra de fronteira do core)
npm run typecheck   # tsc -b --noEmit
npm test            # vitest run (unit + fronteira + smoke do binário)
npm run format      # prettier --check .
node packages/cli/dist/bin/aluy.js --help
```

## Estrutura

- `packages/cli-core/` — **`@hiperplano/aluy-cli-core`**: engine modular PORTÁVEL
  (loop/tools/permissão). **Sem Ink, sem I/O de terminal.** Aqui vive o ponto de
  interceptação único de tool-calls (`src/permission/`).
- `packages/cli/` — **`@hiperplano/aluy-cli`**: TUI (Ink) + binário `aluy` + wiring.
  `src/bin/aluy.ts` (entrypoint), `src/cli.ts` (parser puro), `src/ui/` (Ink).
- `docs/` — `config-compat.md`, `mcp.md`.
- `.github/workflows/` — CI (lint/test/build) + secret-scan (gitleaks).

## Estado

Não é serviço hospedado: é **código de cliente** que roda local na máquina do
usuário. Sem DB próprio — o estado (config, sessões, memória) vive em `~/.aluy/`.
