<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/hiperplano/aluy-cli/main/docs/aluy-wordmark-white.png">
    <img src="https://raw.githubusercontent.com/hiperplano/aluy-cli/main/docs/aluy-wordmark.png" alt="Aluy" height="56">
  </picture>
</p>

<p align="center">
  <b>Um agente de terminal que roda na sua máquina, com a sua chave.</b><br>
  Sem intermediário, sem metering, sem mandar o seu código para o servidor de ninguém.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@hiperplano/aluy-cli"><img alt="npm" src="https://img.shields.io/npm/v/@hiperplano/aluy-cli?color=%23cc3534&label=npm"></a>
  <a href="LICENSE"><img alt="Licença MIT" src="https://img.shields.io/badge/licen%C3%A7a-MIT-blue"></a>
  <a href="https://github.com/hiperplano/aluy-cli/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/hiperplano/aluy-cli/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Node 20+" src="https://img.shields.io/node/v/@hiperplano/aluy-cli">
  <img alt="Linux · macOS · Windows" src="https://img.shields.io/badge/-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-informational">
</p>

---

```bash
npm install -g @hiperplano/aluy-cli
aluy onboard      # instalador guiado: idioma, provider, modelo
aluy              # abre a sessão
```

O **Aluy CLI** lê e edita arquivos, executa comandos, busca no seu código e conduz
o próprio loop de ferramentas numa TUI rica. Você aponta o objetivo; ele trabalha.

```bash
aluy "migre os testes de jest para vitest"   # um objetivo, e acompanhe
aluy -p "liste os TODOs" --output-format json # headless, para script e CI
aluy --plan "como eu quebraria esse módulo?"  # só lê e analisa, zero efeito
aluy --continue                               # retoma de onde parou
```

## Por que este, e não outro

**A chave é sua, e o caminho é direto.** Nove providers no catálogo — Anthropic,
OpenAI, OpenRouter, Google, DeepSeek, Groq, Mistral, xAI e Ollama — ou qualquer
endpoint compatível com a API da OpenAI. Não há servidor nosso no meio: o seu
código e o seu prompt vão do seu terminal para o provider que **você** escolheu.
A credencial nunca fica em claro — vai para o keychain do SO ou, onde ele não
existe, para um cofre cifrado que não funciona em outra máquina.

**Uma catraca, e só uma.** Todo tool-call passa por um ponto único de
interceptação antes de virar efeito, com negação por padrão. Não é uma convenção:
é uma fronteira travada no lint e coberta por teste, e a engine que a hospeda não
pode nem importar a TUI. Quando você quiser velocidade em vez de perguntas, o
`--yolo` existe; quando quiser o contrário, o `--plan` deixa tudo read-only.

**O trabalho continua sem você.** Um serviço é um diretório com um `service.md`:
horário, orçamento, autonomia e canal. Ele acorda sozinho, abre um turno, respeita
o teto de tokens — e, quando precisa de uma decisão que não é dele, **pergunta pelo
Telegram e espera**, em vez de chutar. Você responde do celular e ele retoma.

**Fala com o resto do ecossistema.** Servers MCP (globais e por projeto), sub-agentes
em `.md`, skills, workflows, hooks e plugins. E ele lê o `AGENTS.md` e o `CLAUDE.md`
do seu repositório junto com o `ALUY.md` — eles compõem, não competem, então adotar
o aluy não obriga a reescrever o que você já tem.

## Documentação

| | |
| --- | --- |
| [Comandos](docs/comandos.md) | subcomandos, flags e os 46 slash-commands |
| [Configuração](docs/configuracao.md) | `~/.aluy/`, precedência, hooks, arquivos de projeto |
| [Serviços](docs/comandos.md#serviços) | o `service.md` e o runner contínuo |
| [MCP](docs/mcp.md) | conectar servers, e o que isso implica |
| [Modo turbo](docs/turbo.md) | memória persistente, Ollama, gestão de contexto |
| [Compatibilidade](docs/config-compat.md) | conviver com a config de outros agentes |

`aluy --help` traz tudo isso no terminal, e `aluy doctor` diz o que está quebrado
e como consertar.

## Segurança

O aluy roda **na sua máquina, com os seus privilégios**. Três coisas que vale saber
antes de usar:

- Um **server MCP** de terceiro roda com os seus privilégios e **sem sandbox** — ele
  pode ler o seu filesystem. Plugue só os que você confia.
- O **`--yolo`** aprova tudo automaticamente. É útil e é perigoso; a escolha é sua.
- Credencial **nunca** vai para arquivo em claro, log ou `.env`, e o `gitleaks` roda
  na CI para garantir que nenhuma vaze para o repositório.

Encontrou uma vulnerabilidade? Abra uma
[issue](https://github.com/hiperplano/aluy-cli/issues) marcando como sensível, ou
fale com os mantenedores antes de divulgar.

## Contribuir

PRs são bem-vindos. O [CONTRIBUTING.md](CONTRIBUTING.md) tem o essencial:

```bash
git clone https://github.com/hiperplano/aluy-cli && cd aluy-cli
npm install && npm run build
npm test
```

Duas regras que não relaxamos: **a CI é honesta** (nada de `|| true` ou
`continue-on-error` — gate vermelho bloqueia o merge) e **a fronteira do core é
real** (`@hiperplano/aluy-cli-core` não importa Ink nem faz I/O de terminal,
travado no eslint e em teste).

O histórico de cada versão está no [CHANGELOG.md](CHANGELOG.md).

## Estado

`1.0.0-rc` — em uso diário, com release frequente. A superfície de comandos está
estável; o que ainda muda vem anotado no CHANGELOG a cada rc.

## Licença

[MIT](LICENSE) © Hiperplano
