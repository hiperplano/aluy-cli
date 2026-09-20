<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/hiperplano/aluy-cli/main/docs/aluy-wordmark-white.png">
    <img src="https://raw.githubusercontent.com/hiperplano/aluy-cli/main/docs/aluy-wordmark.png" alt="Aluy" height="56">
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

Você usa o **seu próprio modelo** (BYO), com a sua própria credencial — direto,
sem intermediário e sem metering. O catálogo traz **nove providers**: Anthropic,
OpenAI, OpenRouter, Google, DeepSeek, Groq, Mistral, xAI e **Ollama** (local).
Qualquer endpoint compatível com a API da OpenAI também serve.

## Instalação

```bash
npm install -g @hiperplano/aluy-cli
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
aluy --resume <id|nome>       # retoma uma conversa anterior (id ao sair, ou o nome do /rename)
aluy --continue               # retoma a sessão mais recente deste diretório
aluy --plan                   # modo Plan: o agente lê e analisa, sem efeito nenhum
aluy --image foto.png "…"     # anexa imagem(ns) ao objetivo (ou `@caminho.png` no composer)
aluy --telegram               # sobe a ponte do Telegram junto com a sessão
```

E os subcomandos, todos read-only salvo onde dito:

| Subcomando                                | O que faz                                                        |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `onboard` · `bootstrap` · `uninstall`     | instalador guiado · complementos (turbo) · remoção                |
| `doctor [--deep]` · `config`              | health-check que testa de verdade · configuração efetiva + origem |
| `login` · `logout` · `whoami`             | credencial (no cofre, nunca em claro)                             |
| `models` · `providers`                    | o que está disponível p/ usar                                     |
| `agents` · `skills` · `workflows` · `cron`| o que o aluy mapeou em `~/.aluy/` e no projeto                     |
| `service …`                               | serviços contínuos (ver abaixo)                                   |
| `telegram …`                              | ponte do Telegram (ver abaixo)                                    |
| `mcp …`                                   | servers MCP sem editar JSON à mão                                 |

`aluy --help` traz a lista completa, com todas as flags.

## Slash-commands

Dentro da sessão, **46 slash-commands** controlam tudo sem sair do fluxo. Os principais:

| Comando                                             | O que faz                                             |
| --------------------------------------------------- | ----------------------------------------------------- |
| `/model` · `/provider` · `/effort` · `/window`      | modelo, provider, esforço de raciocínio, janela        |
| `/init`                                             | cria o `ALUY.md` + a estrutura `.aluy/` do projeto     |
| `/mcp` · `/agents` · `/skills` · `/workflows`       | MCP, sub-agentes, skills e workflows                   |
| `/service` · `/telegram` · `/cron` · `/cycle`       | serviços, ponte remota, agendamento, ciclos autônomos  |
| `/rooms` · `/subagent`                              | salas de conversa entre agentes (multi-agente)         |
| `/permissions` · `/tools` · `/add-dir`              | a catraca: o que é permitido, onde                     |
| `/memory` · `/compact` · `/history` · `/export`     | memória, contexto, histórico, transcrição              |
| `/undo` · `/redo` · `/rewind`                       | desfaz o que o agente editou                           |
| `/upgrade` · `/usage` · `/inventory` · `/doctor`    | versão, consumo, inventário, diagnóstico               |
| `/rename` · `/theme` · `/lang` · `/split` · `/fullscreen` | aparência e organização da sessão                |

## Como funciona

- **Agente + permissão** — o loop de ferramentas passa por um ponto único de
  interceptação: nada com efeito acontece sem a catraca liberar (ou você aprovar).
  As tools nativas são `read_file`, `write_file`, `edit_file`, `run_command`,
  `run_tests`, `grep`, `glob`, `change_dir`, `web_fetch`, `web_search`,
  `spawn_agent`, `perguntar` e `update_plan`. O modo `--yolo` dispensa as
  confirmações por sua conta e risco; o `--plan` faz o oposto (read-only puro).
- **BYO provider** — `--backend local` (o **padrão**) fala direto com o provider,
  por API key ou OAuth.
- **Credencial nunca em claro** — vai para o **keychain do SO** quando ele existe e
  é estável (macOS Keychain · Windows Credential Manager · Linux Secret Service) e,
  quando não, para um **cofre em arquivo cifrado** (`~/.aluy/credentials.enc`,
  AES-256-GCM com chave derivada da máquina). O cofre em arquivo é o que faz o aluy
  funcionar em **servidor headless**, onde o keyring do kernel é memória e a chave
  sumiria no reboot. Copiado para outra máquina, o arquivo é um blob inútil.
- **Serviços contínuos** — um serviço é um diretório-manifesto (`service.md` +
  agents/workflows/skills) com schedule, canal, orçamento e autonomia. O
  `aluy service start` sobe um runner destacado que dorme até o horário, abre um
  turno headless e, quando precisa decidir, **pergunta a você pelo canal e espera** —
  nunca segue por suposição. `aluy service attach` entra no serviço vivo para
  acompanhar e conversar com ele.
- **Telegram** — `aluy --telegram` sobe a ponte: long-poll do chat que você
  autorizou (allowlist fechada por padrão) e a tool `telegram_send` para o agente
  responder por lá. É como um serviço te alcança quando você não está no terminal.
  Sem token no keychain a ponte não sobe, e nada é enviado.
- **MCP** — conecta servers MCP (`~/.aluy/mcp.json` global e `.mcp.json` do projeto),
  compatível com o ecossistema; o onboard oferece pré-instalar alguns (Playwright,
  Filesystem, Memory, RPA). Detalhes em [docs/mcp.md](docs/mcp.md).
  ⚠️ Um server MCP roda com **os seus privilégios**, sem sandbox — plugue só os que
  você confia.
- **Complementos opcionais** (modo turbo) — memória persistente, modelos locais via
  Ollama e gestão de contexto, instaláveis no onboard ou depois com `aluy bootstrap`.
  Guia completo: [docs/turbo.md](docs/turbo.md).
- **Atualização** — o aluy checa versões novas em segundo plano e o `/upgrade`
  pergunta antes de trocar o binário.

## Configuração

Tudo vive em `~/.aluy/`:

| Arquivo / pasta      | Conteúdo                                                        |
| -------------------- | ---------------------------------------------------------------- |
| `config.json`        | preferências (idioma, tema, provider/modelo, perfil, limites…)  |
| `providers.json`     | seus providers BYO (override do catálogo)                        |
| `mcp.json`           | servers MCP globais                                              |
| `hooks.json`         | hooks — `session-start`, `user-prompt-submit`, `pre-tool`, `post-tool`, `turn-end`, `subagent-stop`, `notification`. Passam pela catraca; o agente nunca escreve aqui |
| `credentials.enc`    | cofre cifrado (AES-256-GCM) quando não há keychain utilizável    |
| `sessions/`          | histórico das conversas (retomável com `--resume`)               |
| `audit.jsonl`        | trilha append-only dos efeitos                                   |
| `services/` · `cron/`| serviços instalados e tarefas agendadas                          |
| `agents/` · `skills/` · `workflows/` · `plugins/` | o que você instalou, global          |
| `memory/` · `logs/` · `exports/` · `undo/` | memória, logs de sidecar, transcrições, undo   |

Variáveis `ALUY_*` e flags de CLI sobrescrevem (precedência **flag > env > config > default**).
No **projeto**, o `ALUY.md` dá as instruções ao agente e `.aluy/` guarda agents, workflows,
commands e skills. O aluy também lê `AGENTS.md` (Codex) e `CLAUDE.md` (Claude Code), que
**compõem** com o `ALUY.md` em vez de competir com ele.

Compatibilidade de configuração com outros agentes: [docs/config-compat.md](docs/config-compat.md).

## Monorepo

| Pacote                          | Papel                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@hiperplano/aluy-cli-core`** | Engine **portável** do agente (loop · tools · permissão). Sem Ink, sem I/O de terminal. Hospeda o ponto único de interceptação de tool-calls. |
| **`@hiperplano/aluy-cli`**      | TUI (**Ink**) + binário **`aluy`** + wiring. Consome `@hiperplano/aluy-cli-core`.                                                             |

Lema: **core modular, entrega monolítica** — você instala só o `@hiperplano/aluy-cli`;
o core entra bundlado. A fronteira `core × TUI` é explícita e testada (o core não
importa Ink).

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

MIT — ver [`LICENSE`](LICENSE).
