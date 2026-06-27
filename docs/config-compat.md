# Compat de config — Claude Code / Codex / `.aluy` nativo

O Aluy CLI lê, **além** dos arquivos nativos Aluy, também os caminhos do **padrão
Claude Code** e (onde viável) do **Codex/OpenAI** — para trazer projetos já
configurados **sem reescrever config**. **Nenhuma capacidade nova:** é só ampliar o
**locus de descoberta** das mesmas famílias já suportadas, com **precedência** e
**confinamento** explícitos.

## Princípio transversal

**Config de PROJETO vinda do workspace = DADO confinado, NÃO relaxa a permissão.**
`ALUY.md`/`CLAUDE.md`/`AGENTS.md`/`.mcp.json`/`.claude/commands/` do repo são
instruções/manifestos lidos **confinados ao workspace**, mas:

- **não auto-promovem permissão**, não relaxam categorias sempre-ask, não viram egress;
- `.mcp.json` lido ⇒ **`ask` para conectar** cada server (efeito por padrão, segredo
  por-server, **credencial do CLI nunca no `environ`**);
- **path-deny** e **teto de tamanho** ao ler cada arquivo;
- **nenhum** desses arquivos é instrução privilegiada **por ser "do projeto"** ou "de
  outro ecossistema". A proveniência é a MESMA do `ALUY.md`.

Config **GLOBAL** (`~/.aluy/` e `~/.codex/`) é igualmente **DADO** (confiável-do-dono),
mas os servers MCP que ela declara entram pela **mesma permissão** (conectar = `ask`).

## Famílias e fontes

| Família                   | Nativo Aluy                      | Compat Claude Code                  | Compat Codex                                    |
| ------------------------- | -------------------------------- | ----------------------------------- | ----------------------------------------------- |
| **Instruções de projeto** | `ALUY.md` (repo)                 | `CLAUDE.md` (repo)                  | `AGENTS.md` (repo)                              |
| **MCP servers**           | `~/.aluy/mcp.json` (global)      | `.mcp.json` (workspace)             | `~/.codex/config.toml` `[mcp_servers]` (global) |
| **Comandos**              | `~/.aluy/commands/*.md` (global) | `.claude/commands/*.md` (workspace) | — (sem equivalente `.md`)                       |

## Precedência

### Instruções de projeto — **COMPÕEM** (concatenam), ordem fixa

Quando há mais de um arquivo de instrução na raiz, **todos compõem** num único bloco no
canal `system`, nesta ordem (o nativo lidera):

```
ALUY.md  >  AGENTS.md  >  CLAUDE.md
(nativo)    (Codex)       (Claude Code)
```

Cada arquivo é clampado individualmente; a composição é re-clampada (anti-estouro de
janela). Um arquivo só ⇒ injetado **sem** cabeçalho. Racional: o dono pode ter contexto
**complementar** em cada ecossistema; **nenhum** é privilegiado — a ordem só fixa a
sequência e o desempate ao cortar.

### MCP e comandos — **projeto especializa o global** (nome colidente: projeto vence)

```
MCP:       ~/.codex/config.toml (Codex global)  <  ~/.aluy/mcp.json (Aluy global)  <  .mcp.json (projeto)
Comandos:  ~/.aluy/commands (global)            <  .claude/commands (projeto)
```

- **União** de servers/comandos das fontes; em **colisão de nome**, vence a fonte **mais
  específica** (à direita). Determinístico (ordem de 1ª aparição preservada).
- **MCP — três fontes:** o `~/.codex/config.toml` `[mcp_servers]` (Codex **global**,
  padrão OpenAI Codex) entra como a fonte de **MENOR precedência** — o `~/.aluy/mcp.json`
  (Aluy global, nativo) **vence** o Codex, e o `.mcp.json` (projeto) vence ambos.

## Indicador discreto de fontes (TUI)

No boot, uma **nota discreta** lista **quais** fontes carregaram (instruções
nativo/compat, comandos global/projeto, MCP Aluy-global/projeto/**Codex**). Nada
carregado ⇒ silêncio (prompt baseline).

## Notas

- O `~/.codex/config.toml [mcp_servers]` é lido por um parser TOML confinado próprio
  (sem dependência nova), restrito ao subconjunto `[mcp_servers]`, e mesclado na cadeia
  MCP (Codex global = menor precedência), pela mesma permissão.
- O Codex não tem convenção de comando custom em `.md` por projeto equivalente a
  `.claude/commands/`; não há fonte de comandos Codex a ler.
