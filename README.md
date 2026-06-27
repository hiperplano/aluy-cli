<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/aluy-wordmark-white.png">
    <img src="docs/aluy-wordmark.png" alt="Aluy" height="56">
  </picture>
</p>

<h1 align="center">Aluy CLI</h1>

<p align="center">
  Um agente de terminal que roda na <b>sua máquina</b>, com o <b>seu próprio provider de LLM</b>.
</p>

---

O **Aluy CLI** é um agente de terminal: ele lê e edita arquivos, executa
comandos, busca no seu código e conduz seu próprio **loop de ferramentas** — tudo
numa TUI rica, com uma **engine de permissão** onde todo efeito passa por uma
catraca antes de acontecer.

Você usa o **seu próprio modelo** (BYO): qualquer provider compatível com a API da
OpenAI, com a sua própria credencial — direto, sem intermediário e sem metering.
*(Por enquanto o aluy roda só local, com a sua chave.)*

## Instalação

```bash
npm install -g @aluy/cli
aluy onboard      # configura idioma, provider, modelo e (opcional) os complementos
aluy              # abre a sessão
```

O `aluy onboard` é o instalador guiado: escolhe o idioma, conecta o seu provider
(faz um teste de conectividade real antes de prosseguir), e oferece os complementos
opcionais. Funciona em **Linux, macOS e Windows** — o terminal recomendado é o
[WezTerm](https://wezterm.org), mas qualquer terminal moderno serve.

## Uso

```bash
aluy                          # sessão interativa (TUI)
aluy "refatore o módulo X"    # dá um objetivo direto e acompanha o agente trabalhar
aluy -p "liste os TODOs"      # modo headless (one-shot), ideal p/ scripts/CI
aluy --resume <id>            # retoma uma conversa anterior (o id aparece ao sair)
aluy --continue               # retoma a sessão mais recente deste diretório
```

Dentro da sessão, **slash-commands** controlam tudo sem sair do fluxo:

| Comando | O que faz |
|---|---|
| `/model` · `/provider` · `/effort` | troca modelo / provider / esforço de raciocínio |
| `/init` | cria o `ALUY.md` + a estrutura `.aluy/` do projeto |
| `/mcp` · `/agents` · `/skills` · `/workflows` | gerencia MCP, sub-agentes, skills e workflows |
| `/rooms` | salas de conversa entre agentes (multi-agente) |
| `/rename` · `/theme` · `/lang` | nome+cor da sessão, tema, idioma |
| `/memory` · `/compact` · `/history` | memória, compactação de contexto, histórico |

## Como funciona

- **Agente + permissão** — o loop de ferramentas (ler/editar/rodar/buscar) passa por
  um ponto único de interceptação: nada com efeito acontece sem a catraca liberar
  (ou você aprovar). O modo `--yolo` dispensa as confirmações por sua conta e risco.
- **BYO provider** — `--backend local` fala direto com o provider (API key ou OAuth).
  A credencial fica **só no keychain do SO** (macOS Keychain · Windows Credential
  Manager · Linux Secret Service) — nunca em arquivo, `.env` ou log.
- **MCP** — conecta servers MCP (`~/.aluy/mcp.json` global e `.mcp.json` do projeto),
  compatível com o ecossistema; o onboard ainda oferece pré-instalar alguns (Playwright,
  Filesystem, Memory, …).
- **Complementos opcionais** (modo turbo) — memória persistente, modelos locais via
  Ollama e gestão de contexto, instaláveis no onboard ou depois com `aluy bootstrap`.

## Configuração

Tudo vive em `~/.aluy/`:

| Arquivo | Conteúdo |
|---|---|
| `config.json` | preferências (idioma, tema, provider/modelo, perfil, limites…) |
| `providers.json` | seus providers BYO (OpenAI-compatíveis) |
| `mcp.json` | servers MCP globais |

Variáveis `ALUY_*` e flags de CLI sobrescrevem (precedência **flag > env > config > default**).
No **projeto**, o `ALUY.md` dá as instruções ao agente e `.aluy/` guarda agents, workflows,
commands e skills.

## Monorepo

| Pacote | Papel |
|---|---|
| **`@aluy/cli-core`** | Engine **portável** do agente (loop · tools · permissão). Sem Ink, sem I/O de terminal. Hospeda o ponto único de interceptação de tool-calls. |
| **`@aluy/cli`** | TUI (**Ink**) + binário **`aluy`** + wiring. Consome `@aluy/cli-core`. |

Lema: **core modular, entrega monolítica**. A fronteira `core × TUI` é explícita e
testada (o core não importa Ink).

### Desenvolvimento

```bash
npm install
npm run build       # tsc -b (cli-core → cli)
npm run lint
npm test
node packages/cli/dist/bin/aluy.js --help
```

## Contribuir

Ver [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licença

Ver [`LICENSE`](LICENSE).
