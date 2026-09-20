# Comandos

Referência dos subcomandos, das flags de sessão e dos 46 slash-commands.
`aluy --help` traz a mesma coisa no terminal, sempre gerada do código.

## Subcomandos

Todos read-only, salvo onde dito.

| Comando | O que faz |
| --- | --- |
| `aluy onboard` | instalador guiado: idioma, provider (com teste de conectividade real), modelo e os complementos opcionais |
| `aluy bootstrap [--no-agent]` | provisiona os complementos do modo turbo. `--no-agent` pula a rota pelo agente |
| `aluy uninstall [--agent]` | remove os complementos. `--agent` tira também o ollama de sistema |
| `aluy doctor [--deep]` | health-check que **testa de verdade**: autentica a credencial, conecta nos servers MCP (handshake + conta tools), valida perfis e config. Sai com código ≠ 0 se houver ✗, útil em CI. `--deep` adiciona uma chamada mínima ao modelo (opt-in, porque gasta) |
| `aluy config [--json]` | configuração efetiva: cada chave, o valor e a **origem** (default / env / `config.json`), na precedência real |
| `aluy login` · `logout` · `whoami` | credencial (guardada cifrada, nunca em claro) |
| `aluy models` · `providers` | o que está disponível para usar, com `--json` para script |
| `aluy agents` · `skills` · `workflows` | o que o aluy mapeou em `~/.aluy/` e no projeto, com os **rejeitados** e o motivo |
| `aluy cron` | tarefas agendadas pelo cron do SO |
| `aluy mcp …` | gerencia servers MCP sem editar JSON à mão — ver [MCP](mcp.md) |
| `aluy service …` | serviços contínuos — ver abaixo |
| `aluy telegram …` | ponte do Telegram — ver abaixo |

## Flags de sessão

As principais. A lista completa, com todas as regras de precedência, está no `--help`.

| Flag | O que faz |
| --- | --- |
| `-p, --print "prompt"` | modo headless (one-shot). Combina com `--output-format text\|json\|stream-json` e `--quiet` |
| `--plan` | modo Plan: o agente **lê e analisa**, sem efeito nenhum |
| `--yolo` | ⚠️ auto-aprova tudo. Permissão completa na máquina, por sua conta e risco |
| `--model <slug>` · `--provider <nome>` · `--tier <tier>` | escolhe o modelo desta sessão |
| `--backend local\|broker` | `local` é o **padrão**: fala direto com o seu provider |
| `--image <path>` | anexa imagem ao objetivo (repetível). No composer, `@caminho.png` |
| `--telegram` | sobe a ponte do Telegram junto com a sessão |
| `--continue` · `--resume [<id\|nome>]` · `--new` | retomar ou começar do zero |
| `--anonymous` | não grava transcrição nem memória. Incompatível com `--continue`/`--resume` |
| `--max-tokens N` · `--max-iterations N` · `--budget`/`--no-budget` | tetos anti-runaway |
| `--cycle` · `--cycles N` · `--cycle-for <dur>` | (com `-p`) roda o objetivo em ciclos autônomos |
| `--lang pt-BR\|en` · `--theme` · `--dense` · `--split` · `--fullscreen` · `--ascii` | interface |
| `--no-subagents` | desliga os sub-agentes paralelos (força mono-agente) |

Precedência: **flag > env `ALUY_*` > `config.json` > default**.

## Slash-commands

Dentro da sessão, sem sair do fluxo.

### Modelo e sessão

| | |
| --- | --- |
| `/model` | trocar o tier |
| `/provider` | seta o provider do modelo Custom · `save` fixa como padrão |
| `/effort` | seta o `reasoning_effort` (low/medium/high/custom) |
| `/window` | informa a janela de contexto do modelo ativo (ex.: `/window 128k`) |
| `/usage` | tokens e janela desta sessão |
| `/compact` | compacta o contexto (resume a conversa e continua) |
| `/clear` | limpa a sessão · `full` também apaga a memória do agente |
| `/history` | navega e retoma uma sessão anterior, sem sair do aluy |
| `/rename` | dá nome + cor à sessão |
| `/export` | exporta o transcript **redigido** para `~/.aluy/exports/` (0600) |
| `/ask` | pergunta paralela (read-only) sem parar o trabalho em curso |

### Permissão e workspace

| | |
| --- | --- |
| `/permissions` | painel: modo, grants e tools seguras |
| `/tools` | inventário unificado — nativas, MCP e o que a catraca diz de cada uma |
| `/add-dir` | autoriza um diretório **extra** para o agente nesta sessão |
| `/init` | cria o `ALUY.md` e a estrutura `.aluy/` do projeto |
| `/inventory` | o que foi carregado da `.aluy/` (agentes · comandos · skills · workflows · memória) |
| `/memory` | vê, edita, esquece e fixa a memória do agente |
| `/todo` | backlog de tarefas anotadas |
| `/undo` · `/redo` · `/rewind` | desfaz edições do agente; `/rewind` volta a um ponto da sessão (Esc Esc) |

### Frota e extensões

| | |
| --- | --- |
| `/agents` | perfis `.md` de sub-agente mapeados (válidos **e** rejeitados, com o motivo) |
| `/subagent` · `/back` | conversa 1:1 com um sub-agente numa sub-sessão focada, e volta |
| `/rooms` | salas entre agentes — cria, lê e observa ao vivo a conversa da frota |
| `/skills` | skills `SKILL.md` mapeadas |
| `/workflows` | fluxos de atividades — lista, executa e ativa |
| `/plugin` | plugins instalados (bundles em `~/.aluy/plugins`) |
| `/mcp` | lista e gerencia servers MCP · `search <termo>` |
| `/service` | serviços plugáveis — ver abaixo |
| `/cycle` · `/cron` | ciclos autônomos com teto duro; agendamento persistente |
| `/telegram` | status, allowlist e logout do conector |

### Instalação e aparência

| | |
| --- | --- |
| `/doctor` | diagnóstico da instalação |
| `/upgrade` | atualiza para a versão mais nova do canal |
| `/login` · `/logout` · `/whoami` | conta |
| `/theme` · `/lang` · `/split` · `/fullscreen` · `/notify` · `/suggest` | interface |
| `/help` · `/quit` | |

## Ferramentas nativas

O que o agente pode chamar sem nenhum MCP. **Todas** passam pela catraca:

`read_file` · `write_file` · `edit_file` · `run_command` · `run_tests` · `grep` ·
`glob` · `change_dir` · `web_fetch` · `web_search` · `spawn_agent` · `perguntar` ·
`update_plan`

Com a ponte do Telegram ativa, entra também `telegram_send`.

## Serviços

Um serviço é um **diretório-manifesto**: um `service.md` (mais agents, workflows e
skills, no mesmo formato que você já usa) declarando `schedule`, `channel`, `budget`
e autonomia.

```bash
aluy service install <path|url>   # copia um diretório ou clona um repo git.
                                  # MOSTRA o manifesto antes de ativar e pede
                                  # confirmação (--yes pula, p/ script)
aluy service start <nome>         # sobe o runner DESTACADO (sobrevive ao terminal)
                                  # --group <g> itera o grupo inteiro
aluy service stop <nome>          # para o runner · --group <g>
aluy service list [--group <g>]   # nome, estado, próximo schedule
aluy service status <nome>        # detalhe + validação do cron/workflow
aluy service logs <nome> [-f]     # runner.log · -n <N> muda quantas linhas (default 50)
aluy service attach <nome>        # ENTRA no serviço vivo: acompanha e conversa com ele
aluy service uninstall <nome>     # remove o diretório
```

O runner dorme até o horário, abre um turno headless pela atividade do `workflow:`,
respeita `until:` e `budget:` — e, quando o turno fecha com uma decisão pendente,
**envia a pergunta para o `channel:` e espera**, em vez de seguir por suposição.
Você responde, ele retoma a mesma atividade com pergunta e resposta anexadas.

`create` é conversacional (é uma entrevista de verdade) e por isso mora **dentro da
sessão**: `/service create`.

## Telegram

A ponte deixa o agente te alcançar quando você não está no terminal — e é o que
torna a espera de um serviço útil em vez de um travamento.

```bash
aluy telegram login [--token <t>]   # token do bot (@BotFather), guardado cifrado
aluy telegram allow <chat-id>       # allowlist do dono — fechada por padrão
aluy telegram deny <chat-id>
aluy telegram status                # token (redigido), allowlist e estado da ponte
aluy telegram logout                # apaga o token dos dois cofres
aluy --telegram                     # sobe a ponte junto com a sessão
```

Com token e allowlist, a ponte faz long-poll do chat autorizado e o agente responde
pela tool `telegram_send`. **Sem token no keychain a ponte não sobe** — o boot não
falha, e nada é enviado para `api.telegram.org`.
