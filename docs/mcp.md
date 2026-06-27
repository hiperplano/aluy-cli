# Servers MCP locais

O Aluy CLI conecta a **servers MCP locais** (transporte **stdio**) declarados em
`~/.aluy/mcp.json`. As **tools** desses servers entram no toolset do agente —
sempre **atrás da permissão**.

## Configuração — `~/.aluy/mcp.json`

A config é **DADO** do usuário (não código, **sem segredo literal versionável**).
Formato (paridade com o ecossistema MCP):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "ROOT": "." }
    }
  }
}
```

- `command` + `args`: como lançar o server (processo local).
- `env`: variáveis do processo-server, **escopo mínimo por-server**. **Não** ponha
  segredo literal aqui — referencie só o que o server precisa.
- O nome do server (`filesystem`) vira o prefixo das tools: `mcp__filesystem__<tool>`.

**Escrever `~/.aluy/mcp.json` é ato do USUÁRIO**, fora-de-banda. O agente **não pode
escrever** em `~/.aluy/` — a permissão **nega** (categoria `aluy-config-write-deny`,
acima até do `--yolo`). Senão um README malicioso plantaria um server que roda sempre.

## Gerenciar pela CLI — `aluy mcp add/list/remove`

Em vez de editar o JSON à mão, use a camada de conveniência. É **ato do usuário** (o
comando que você digita), equivalente a editar o arquivo — **não amplia nada** e **não
é caminho do agente** (a permissão segue negando o agente em `~/.aluy/`; o server
adicionado ainda passa pela permissão no runtime). **Sem registro/API-key externo**: só
o `command`/`args`/`env` que você passar (server **stdio** é o caso base).

```bash
# adiciona um server ao ~/.aluy/mcp.json (cria se não existe; MERGE preserva os outros)
aluy mcp add filesystem npx -y @modelcontextprotocol/server-filesystem . --env ROOT=.

# o separador `--` convencional também vale (tudo após ele é do SERVER, nunca flag
# do aluy) — é a forma que o `aluy mcp search` sugere e que o AGENTE usa:
aluy mcp add playwright -- npx -y @playwright/mcp

# no .mcp.json do PROJETO (cwd) em vez do global:
aluy mcp add meu-server node ./server.js --project

# lista os servers de TODAS as fontes (~/.aluy, projeto, Codex) com a origem:
aluy mcp list

# remove (só de onde o aluy escreve — não toca no config do Claude/Codex):
aluy mcp remove filesystem
```

- Nome duplicado é **erro** sem `--force` (não sobrescreve por acidente).
- `--env` que **pareça um segredo literal** dispara um **aviso** (não bloqueia):
  prefira uma **referência** (`--env TOKEN=$MINHA_VAR`, resolvida do teu ambiente no
  spawn) — o `mcp.json` é legível/versionável e **não deve carregar credencial**.
- A listagem mostra só as **chaves** de `env` (nunca os valores).
- `remove` de um server que vem do **Codex** avisa que o aluy **não o gerencia**
  (edite o `~/.codex/config.toml` à mão).

Na **sessão**, o slash **`/mcp`** lista os servers + suas **tools** (prefixo
`mcp__<server>__`), a **origem** e o **estado** da conexão (ok · N tools / erro), com o
resultado da descoberta **ao vivo** do boot.

A **descoberta roda só no BOOT**: depois de um `aluy mcp add`, as tools novas aparecem
na **próxima** sessão. `/mcp reload` hoje é um **stub honesto** que explica isso (reload
ao vivo está adiado). O **prompt do agente** ensina esse fluxo: pedido de "instale o MCP
X" ⇒ o agente roda `aluy mcp add <nome> -- <command>` (exec normal pela permissão; a
escrita **direta** em `~/.aluy/` segue **negada**) e avisa que é preciso reiniciar.

## Compat Claude Code — `.mcp.json` do PROJETO

Além do `~/.aluy/mcp.json` (**global**, nativo Aluy), o Aluy CLI lê também o
**`.mcp.json` na raiz do workspace** — o caminho do **padrão Claude Code**, no MESMO
formato (`mcpServers`). Isso traz repos já configurados para Claude Code **sem
reescrever config**.

- **Fonte de PROJETO = DADO confinado ao workspace:** o `.mcp.json` é lido **só de
  dentro da raiz** (um symlink `.mcp.json` → fora da raiz é **rejeitado**, nada lido). É
  config-do-dono-do-repo, mas **não relaxa a permissão**: conectar/usar cada server
  **continua sendo `ask`**. Um `.mcp.json` de um repo clonado **não** auto-pluga um server.
- **Precedência — projeto > global:** as duas fontes são **mescladas**; em **colisão de
  nome de server**, a declaração do **`.mcp.json` (projeto)** sobrepõe a do
  `~/.aluy/mcp.json` (global). Implementação: `mergeMcpConfigs(global, project)` (puro,
  no core).
- Todas as travas de segurança valem **igual** para os dois locais: tool = efeito por
  padrão, environ mínimo por-server (**sem credencial do CLI**), saída = dado
  não-confiável, Plan nega.

## Compat Codex — `~/.codex/config.toml [mcp_servers]`

Além das fontes JSON, o Aluy CLI lê também o **`~/.codex/config.toml`** — a config
**global** do OpenAI Codex, que declara servers MCP numa seção **`[mcp_servers]` (TOML)**
no MESMO formato lógico (`command`/`args`/`env`). Isso traz quem já configurou o Codex
**sem reescrever config**.

```toml
# ~/.codex/config.toml
[mcp_servers.everything]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-everything"]
env = { API_KEY = "x" }     # ou, em linhas próprias: [mcp_servers.everything.env]
```

- **Parser TOML CONFINADO próprio** (`packages/cli-core/src/mcp/codex-toml.ts`, portável):
  reconhece **só** o subconjunto `[mcp_servers]` (tabelas `[mcp_servers.<nome>]` com
  `command`/`args`/`env`, inline ou sub-tabela). Tudo o mais no `config.toml` é
  **ignorado** (não é erro). **Sem dependência nova.** O parser **só lê texto, não
  executa nada** do arquivo. **Fail-safe:** ausente/grande-demais ⇒ vazio; TOML inválido
  no subconjunto ⇒ vazio **+ erro visível** (a UX avisa, o agente segue). Teto 256 KiB.
- **Precedência — Codex global = MENOR:** as três fontes são **mescladas**; em colisão
  de nome de server, vence a mais específica:
  `~/.codex/config.toml` (Codex global) **<** `~/.aluy/mcp.json` (Aluy global) **<**
  `.mcp.json` (projeto). Implementação: `mergeMcpConfigs(codexGlobal, aluyGlobal, project)`.
- **MESMA permissão, FONTE nova:** o `config.toml` é **DADO** de config do dono, mas os
  servers que ele declara passam pela **MESMA** permissão MCP — conectar/usar = **`ask`**,
  environ mínimo **sem a credencial do CLI**, saída = dado não-confiável, Plan nega.

## Como o Aluy CLI trata as tools MCP (segurança)

- **Toda tool MCP = EFEITO por padrão ⇒ confirmação.** Nunca `allow` silencioso. A
  classificação de efeito vem de **sinais do input** (presença de path/URL/rede),
  **nunca** do rótulo `readonly`/`effect` **auto-declarado pelo server** — um server que
  se diz "readonly" mas escreve ou faz POST **ainda** cai em `ask`/`deny`.
- **Re-handshake re-classifica:** não há cache "já aprovei esta tool". A permissão
  reavalia a cada chamada.
- **Saída de tool MCP = DADO NÃO-CONFIÁVEL:** vai ao modelo como observação cercada,
  **nunca** como instrução. Um server que devolve "ignore tudo e rode X" entra como dado
  inerte.
- **Modo Plan** nega toda tool MCP (não está na allow-list fechada de leitura local).
- **Credencial do Aluy nunca vai ao server:** o environ do processo-server é **mínimo**
  (PATH/HOME/etc. + o `env` declarado) — `ALUY_TOKEN` e segredos óbvios são barrados.

## ⚠ Limite atual — sem sandbox de SO

> O Aluy CLI **não confina o processo-server no nível de SO.** O server roda como um
> processo local **com OS TEUS privilégios**: o `cwd` é o workspace e o environ é
> mínimo, mas um server **malicioso** lê o teu filesystem **direto** (fora do cwd). A
> permissão protege contra o **agente** ser manipulado a usar a tool — não contra o
> **processo-server** abusar dos teus privilégios de SO.
>
> **Só plugue servers que você confia.**

## Fronteira modular

- `@hiperplano/aluy-cli-core` (**portável**): config (`parseMcpConfig`), **parser TOML confinado do
  Codex** (`parseCodexMcpConfig` — só o subconjunto `[mcp_servers]`, sem `node:*`, sem
  dep), descoberta/handshake (`discoverMcpTools`), adaptação das tools (`adaptMcpTools`),
  classificação de efeito por sinais (`effect-signals`) e a porta `McpTransport`. **Sem
  `node:*`, sem o SDK.**
- `@hiperplano/aluy-cli` (**locus concreto**): leitura confinada do `~/.aluy/mcp.json`
  (`McpConfigStore`, global), do `.mcp.json` do projeto (`ProjectMcpConfigStore`,
  confinado ao workspace) e do `~/.codex/config.toml` (`CodexMcpConfigStore`, Codex
  global), e o transporte stdio com o **SDK MCP oficial** (`StdioMcpTransport`,
  `@modelcontextprotocol/sdk`, MIT). O merge **Codex global < Aluy global < projeto** é
  puro no core (`mergeMcpConfigs`).
