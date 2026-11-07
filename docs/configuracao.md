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

| Arquivo / pasta                                   | Conteúdo                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `config.json`                                     | preferências duráveis: idioma, tema, provider/modelo, perfil, limites         |
| `providers.json`                                  | seus providers BYO (override do catálogo)                                     |
| `mcp.json`                                        | servers MCP globais — ver [MCP](mcp.md)                                       |
| `hooks.json`                                      | hooks. O agente **nunca** escreve aqui                                        |
| `credentials.enc`                                 | cofre cifrado (AES-256-GCM), quando não há keychain utilizável                |
| `sessions/`                                       | histórico das conversas (retomável com `--resume`)                            |
| `pausas/`                                         | trabalho pausado por cota esgotada, retomado junto com a sessão               |
| `audit.jsonl`                                     | trilha append-only dos efeitos                                                |
| `services/`                                       | serviços instalados                                                           |
| `cron/`                                           | tarefas agendadas                                                             |
| `agents/` · `skills/` · `workflows/` · `plugins/` | o que você instalou, global                                                   |
| `memory/`                                         | memória persistente: `global.md` (fatos globais) + store do mem0 (modo turbo) |
| `exports/`                                        | transcrições do `/export`                                                     |
| `undo/`                                           | pilha de undo das edições do agente                                           |
| `logs/`                                           | logs dos sidecars                                                             |
| `update-check.json`                               | cache do verificador de versão                                                |

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

## Segredos para o agente (`/secret`)

Para dar uma chave ao agente **sem colá-la no chat** (onde ela iria ao modelo, à sessão em disco, ao
histórico e ao export): `/secret API_KEY` abre um campo mascarado. O agente vê só o **nome** e usa
`$API_KEY` nos comandos.

- Por padrão o valor vive **só em memória** e some ao sair. `--save` o grava no cofre cifrado
  (`credentials.enc`, o mesmo da credencial, conta própria por projeto) e ele volta no próximo boot
  **nesse projeto**. `/secret list` mostra os nomes; `/secret remove NOME` apaga de tudo.
- O valor é exportado como variável de ambiente **só** no shell do `run_command`, do
  `watch_command` e do `!` — nunca em MCP, sub-agentes, hooks ou outras tools. Num comando do
  agente, só chega se o texto do comando **citar** o nome, e então a catraca **pergunta sempre**
  (mostra o nome, nunca o valor; vale também sob `--yolo`).
- Toda saída é redigida por **valor exato** (`‹redigido›`) além das regras por padrão. Valor com
  menos de 8 caracteres é recusado (use `--force`).
- Limites: um comando aprovado pode transformar o valor (base64…) e o processo que ele lança recebe
  o valor de verdade — leia o comando antes de aprovar. Detalhes e limites honestos:
  [ADR 0005](decisions/0005-segredos-do-dono-sem-passar-pelo-chat.md).
- Não digite `/secret NOME valor`: o valor ficaria visível no terminal. O Aluy recusa, não guarda e avisa.

## Hooks

`~/.aluy/hooks.json` liga comandos seus a eventos do agente. Sete eventos, e a lista
é fechada — um nome desconhecido é **ignorado**, não vira erro silencioso:

`session-start` · `user-prompt-submit` · `pre-tool` · `post-tool` · `turn-end` ·
`subagent-stop` · `notification`

Hooks passam pela catraca de permissão como qualquer outro efeito. Se você já tem
hooks no formato do Claude Code, veja [compatibilidade](config-compat.md).

## No projeto

|                                                          |                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `ALUY.md`                                                | instruções do projeto para o agente. É o que o `/init` cria |
| `.aluy/agents/` · `commands/` · `skills/` · `workflows/` | extensões versionadas junto com o repo                      |
| `.mcp.json`                                              | servers MCP do projeto                                      |

O aluy lê **três** arquivos de instrução na raiz e eles **compõem** — são
concatenados, na ordem, sem que nenhum vença o outro:

```
ALUY.md  →  AGENTS.md  →  CLAUDE.md
 (aluy)      (Codex)      (Claude Code)
```

Isso é deliberado: adotar o aluy não obriga a reescrever o que você já mantém para
outro agente. A ordem só decide a sequência no `system` e o desempate quando é
preciso cortar pelo teto de contexto.

### Memória: o que o dono pede para lembrar é seguido

`~/.aluy/memory/global.md` e `.aluy/memory/project.md` entram no `system` em **toda** sessão
(nova, `--resume`, `--continue`) e nos **sub-agentes**. Quando você diz "a partir de agora…" ou "não
implemente, chame subagentes", o agente grava na hora (`remember`, origem `usuario`, sem caixa de
confirmação) e avisa em uma linha. Fatos `usuario` são seguidos como instrução sua; os `derivado`
são só contexto de fundo. Veja e apague tudo com `/memory`. Teto de 8.000 caracteres (os seus têm
prioridade; o que ficar de fora é avisado). Motivo e risco aceito em
[ADR 0004](decisions/0004-memoria-do-dono-e-seguida.md).

> O alias `AGENT.md` (singular) era aceito até a rc.181 e **não é mais lido**. Se
> você tem um, renomeie para `ALUY.md`.

## Variáveis de ambiente

As `ALUY_*` sobrescrevem o `config.json`. As mais usadas:

|                                                                |                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ALUY_BACKEND`                                                 | `local` (padrão) ou `broker`                                                                                                                                                                                                                                                                     |
| `ALUY_LOCAL_PROVIDER` · `ALUY_LOCAL_MODEL`                     | provider e modelo do backend local                                                                                                                                                                                                                                                               |
| `ALUY_LOCAL_AUTH`                                              | `apikey` ou `oauth`                                                                                                                                                                                                                                                                              |
| `ALUY_LOCAL_BASE_URL`                                          | endpoint próprio (validado por anti-SSRF)                                                                                                                                                                                                                                                        |
| `conversation` (`config.json`) · `--classic` · `/conversation` | `concierge` (padrão neste ramo) ou `classic`. No Concierge a conversa nunca espera o trabalho; o Esc só limpa o rascunho. Opcional `conciergeModel`: slug do modelo do Concierge (padrão: o da sessão). Ver ADR 0006                                                                             |
| `ALUY_NOTIFY`                                                  | notificações: `all` (padrão), `attention` (só quando o Aluy precisa de você; sem aviso de turno concluído) ou `off`. `on`/`1`/`true` = all; `0`/`false` = off. O `/notify` também grava a escolha em `config.json` (`"notify"`); valores antigos em PT (`tudo`/`atencao`/`nada`) ainda são lidos |
| `ALUY_RETRY`                                                   | `off` desliga a retentativa automática                                                                                                                                                                                                                                                           |
| `ALUY_SPINNER_VERBS`                                           | `plain` troca os verbos de espera brincalhões (`Garimpando…`, `Matutando…`) pelos rótulos planos (`pensando…`). Padrão: `playful`. `ALUY_SPINNER_VERBS_SEED` fixa o sorteio (testes)                                                                                                             |
| `ALUY_STATUSLINE`                                              | `full` · `compact` · `hidden` — o que aparece abaixo do composer (vence a pref salva). Sem valor: `full`, ou `compact` em terminal de até 30 linhas. `F2` alterna e `/statusline` escolhe; a escolha vai para `statusline` no `config.json`. O `⚠ yolo` nunca some                               |
| `ALUY_QUOTA_PAUSE` · `ALUY_QUOTA_MAX_WAIT`                     | pausa por cota esgotada: `off` desliga; espera máxima (`90m`, `6h`) — ver [pausa por cota](pausa-por-cota.md)                                                                                                                                                                                    |
| `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `OPENROUTER_API_KEY`  | credencial do provider                                                                                                                                                                                                                                                                           |

`aluy config` lista todas, com o valor efetivo e de onde ele veio.
