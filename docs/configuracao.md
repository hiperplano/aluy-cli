# Configuração

Onde o aluy guarda as coisas, em que ordem ele resolve um valor, e o que você pode
pôr no seu projeto.

`aluy config` mostra a configuração **efetiva** com a origem de cada chave — é a
forma mais rápida de responder "por que esse valor está assim".

## Precedência

```
flag de CLI  >  env ALUY_*  >  ~/.aluy/config.json  >  default
```

## `~/.aluy/`

| Arquivo / pasta | Conteúdo |
| --- | --- |
| `config.json` | preferências duráveis: idioma, tema, provider/modelo, perfil, limites |
| `providers.json` | seus providers BYO (override do catálogo) |
| `mcp.json` | servers MCP globais — ver [MCP](mcp.md) |
| `hooks.json` | hooks. O agente **nunca** escreve aqui |
| `credentials.enc` | cofre cifrado (AES-256-GCM), quando não há keychain utilizável |
| `sessions/` | histórico das conversas (retomável com `--resume`) |
| `audit.jsonl` | trilha append-only dos efeitos |
| `services/` | serviços instalados |
| `cron/` | tarefas agendadas |
| `agents/` · `skills/` · `workflows/` · `plugins/` | o que você instalou, global |
| `memory/` | store da memória persistente (modo turbo) |
| `exports/` | transcrições do `/export` |
| `undo/` | pilha de undo das edições do agente |
| `logs/` | logs dos sidecars |
| `update-check.json` | cache do verificador de versão |

## Credencial

A credencial **nunca** é gravada em claro. Há dois lugares legítimos, nesta ordem:

1. **Keychain do SO** — macOS Keychain, Windows Credential Manager, Linux Secret
   Service. Usado quando existe e é estável.
2. **Cofre em arquivo cifrado** — `~/.aluy/credentials.enc`, AES-256-GCM com chave
   derivada da identidade da máquina.

O segundo não é um plano B pior: em **servidor headless** sem Secret Service, o
keyring do kernel é só memória e a chave sumiria no reboot. A chave derivada da
máquina não viaja junto com o arquivo, então o `credentials.enc` copiado para outro
lugar é um blob inútil.

Isso vale também para o token do conector Telegram, e o `logout` apaga dos dois.

## Hooks

`~/.aluy/hooks.json` liga comandos seus a eventos do agente. Sete eventos, e a lista
é fechada — um nome desconhecido é **ignorado**, não vira erro silencioso:

`session-start` · `user-prompt-submit` · `pre-tool` · `post-tool` · `turn-end` ·
`subagent-stop` · `notification`

Hooks passam pela catraca de permissão como qualquer outro efeito. Se você já tem
hooks no formato do Claude Code, veja [compatibilidade](config-compat.md).

## No projeto

| | |
| --- | --- |
| `ALUY.md` | instruções do projeto para o agente. É o que o `/init` cria |
| `.aluy/agents/` · `commands/` · `skills/` · `workflows/` | extensões versionadas junto com o repo |
| `.mcp.json` | servers MCP do projeto |

O aluy lê **três** arquivos de instrução na raiz e eles **compõem** — são
concatenados, na ordem, sem que nenhum vença o outro:

```
ALUY.md  →  AGENTS.md  →  CLAUDE.md
 (aluy)      (Codex)      (Claude Code)
```

Isso é deliberado: adotar o aluy não obriga a reescrever o que você já mantém para
outro agente. A ordem só decide a sequência no `system` e o desempate quando é
preciso cortar pelo teto de contexto.

> O alias `AGENT.md` (singular) era aceito até a rc.181 e **não é mais lido**. Se
> você tem um, renomeie para `ALUY.md`.

## Variáveis de ambiente

As `ALUY_*` sobrescrevem o `config.json`. As mais usadas:

| | |
| --- | --- |
| `ALUY_BACKEND` | `local` (padrão) ou `broker` |
| `ALUY_LOCAL_PROVIDER` · `ALUY_LOCAL_MODEL` | provider e modelo do backend local |
| `ALUY_LOCAL_AUTH` | `apikey` ou `oauth` |
| `ALUY_LOCAL_BASE_URL` | endpoint próprio (validado por anti-SSRF) |
| `ALUY_RETRY` | `off` desliga a retentativa automática |
| `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `OPENROUTER_API_KEY` | credencial do provider |

`aluy config` lista todas, com o valor efetivo e de onde ele veio.
