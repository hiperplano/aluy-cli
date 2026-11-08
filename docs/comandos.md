# Comandos

Referência dos subcomandos, das flags de sessão e dos slash-commands.
`aluy --help` traz a mesma coisa no terminal, sempre gerada do código.

## Subcomandos

Todos read-only, salvo onde dito.

| Comando                                | O que faz                                                                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aluy onboard`                         | instalador guiado: idioma, provider (com teste de conectividade real), modelo e os complementos opcionais                                                                                                                                                   |
| `aluy bootstrap [--no-agent]`          | provisiona os complementos do modo turbo. `--no-agent` pula a rota pelo agente                                                                                                                                                                              |
| `aluy uninstall [--agent]`             | remove os complementos. `--agent` tira também o ollama de sistema                                                                                                                                                                                           |
| `aluy doctor [--deep]`                 | health-check que **testa de verdade**: autentica a credencial, conecta nos servers MCP (handshake + conta tools), valida perfis e config. Sai com código ≠ 0 se houver ✗, útil em CI. `--deep` adiciona uma chamada mínima ao modelo (opt-in, porque gasta) |
| `aluy config [--json]`                 | configuração efetiva: cada chave, o valor e a **origem** (default / env / `config.json`), na precedência real                                                                                                                                               |
| `aluy login` · `logout` · `whoami`     | credencial (guardada cifrada, nunca em claro)                                                                                                                                                                                                               |
| `aluy models` · `providers`            | o que está disponível para usar, com `--json` para script                                                                                                                                                                                                   |
| `aluy agents` · `skills` · `workflows` | o que o aluy mapeou em `~/.aluy/` e no projeto, com os **rejeitados** e o motivo                                                                                                                                                                            |
| `aluy cron`                            | tarefas agendadas pelo cron do SO                                                                                                                                                                                                                           |
| `aluy mcp …`                           | gerencia servers MCP sem editar JSON à mão — ver [MCP](mcp.md)                                                                                                                                                                                              |
| `aluy service …`                       | serviços contínuos — ver abaixo                                                                                                                                                                                                                             |
| `aluy telegram …`                      | ponte do Telegram — ver abaixo                                                                                                                                                                                                                              |

## Flags de sessão

As principais. A lista completa, com todas as regras de precedência, está no `--help`.

| Flag                                                                                | O que faz                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `-p, --print "prompt"`                                                              | modo headless (one-shot). Combina com `--output-format text\|json\|stream-json` e `--quiet` |
| `--plan`                                                                            | modo Plan: o agente **lê e analisa**, sem efeito nenhum                                     |
| `--yolo`                                                                            | ⚠️ auto-aprova tudo. Permissão completa na máquina, por sua conta e risco                   |
| `--model <slug>` · `--provider <nome>` · `--tier <tier>`                            | escolhe o modelo desta sessão                                                               |
| `--backend local\|broker`                                                           | `local` é o **padrão**: fala direto com o seu provider                                      |
| `--image <path>`                                                                    | anexa imagem ao objetivo (repetível). No composer, `@caminho.png`                           |
| `--telegram`                                                                        | sobe a ponte do Telegram junto com a sessão                                                 |
| `--continue` · `--resume [<id\|nome>]` · `--new`                                    | retomar ou começar do zero                                                                  |
| `--anonymous`                                                                       | não grava transcrição nem memória. Incompatível com `--continue`/`--resume`                 |
| `--max-tokens N` · `--max-iterations N` · `--budget`/`--no-budget`                  | tetos anti-runaway                                                                          |
| `--cycle` · `--cycles N` · `--cycle-for <dur>`                                      | (com `-p`) roda o objetivo em ciclos autônomos                                              |
| `--lang pt-BR\|en` · `--theme` · `--dense` · `--split` · `--fullscreen` · `--ascii` | interface                                                                                   |
| `--no-subagents`                                                                    | desliga os sub-agentes paralelos (força mono-agente)                                        |

Precedência: **flag > env `ALUY_*` > `config.json` > default**.

## Slash-commands

Dentro da sessão, sem sair do fluxo. Digite `/` para abrir o menu: ele lista o que cabe na tela,
agrupado por seção, e **busca** enquanto você digita — pelo nome, pelo apelido (`/view`, `/cockpit`,
`/a`, `/n`), pela descrição e por palavras em português: `/tema` acha `/theme`, `/sair` acha `/quit`,
`/parar` acha `/task`, `/senha` acha `/secret`, `/resumir` acha `/compact`. O nome exato e o prefixo
vêm primeiro. `ctrl+p` (de dentro do menu ou com ele fechado) abre a paleta, que busca por tudo.
`/help` mostra as mesmas seções com os atalhos do modo em que você está; `/help all` inclui os raros.

Ficam fora da lista padrão (mas aparecem ao buscar e funcionam digitados): `/rooms`, `/service`,
`/upgrade`, `/window`, `/telegram`, `/agents`, `/skills`, `/redo`. Alguns só valem em certo modo:
`/task`, `/approve` e `/deny` no concierge (no clássico, `/ask`), `/back` só com um sub-agente em foco.

### Seletores

Rodar o comando **sem argumento** abre uma lista (a mesma moldura de `/theme` e `/effort`), com o valor
atual marcado por `●`; `↑↓` navega, `enter` escolhe, `esc` volta. Cada item roda exatamente o comando
que você teria digitado (`/notify` → "nada" executa `/notify off`), então o que você digita continua
valendo, para script e para quem já sabe os argumentos.

| Sem argumento                                                                       | O que o seletor oferece                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/conversation`                                                                     | concierge · clássico                                                                  |
| `/notify`                                                                           | tudo · só atenção · nada                                                              |
| `/statusline`                                                                       | completo · compacto · oculto (com a prévia de cada um)                                |
| `/suggest` · `/split`                                                               | ligada/desligada · mostrar/ocultar log (`/split on\|off` também existe)               |
| `/window`                                                                           | 32k · 64k · 128k · 200k · 1M · outro valor (preenche o composer)                      |
| `/clear`                                                                            | só a conversa · conversa + memória · só a memória (as duas últimas pedem confirmação) |
| `/task`                                                                             | a tarefa → ver detalhe · parar (e "parar todas")                                      |
| `/approve` · `/deny`                                                                | com 2 ou mais pedidos pendentes: o pedido → aprovar / aprovar para a sessão / negar   |
| `/memory` · `/todo` · `/cron` · `/plugin` · `/workflows` · `/service` · `/subagent` | o item → a ação (nada de decorar id); remover/esquecer pede confirmação               |
| `/rooms` · `/secret`                                                                | a sala → ler/observar · os nomes salvos → remover (o valor nunca aparece)             |
| `/add-dir`                                                                          | um navegador de pastas (ver abaixo)                                                   |
| `/telegram`                                                                         | status · liberar · bloquear · desconectar                                             |
| `/cycle`                                                                            | com um ciclo ativo: status · pausar · retomar · editar · parar                        |

Sem seletor por enquanto: `/rename` (a cor) e `/permissions` (o painel dele já troca o modo).

**`/add-dir` sem argumento** abre um navegador de pastas (só pastas, em ordem alfabética, sem as
ocultas). Ele começa na pasta-mãe da raiz do workspace, porque a raiz e o que há dentro dela já estão
autorizados: quem roda `/add-dir` quase sempre quer uma pasta irmã. A raiz aparece marcada.

| Tecla                                                         | O que faz                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `↑` `↓`                                                       | move a seleção                                                           |
| `enter` ou `→`                                                | entra na pasta selecionada                                               |
| `←` ou `backspace`                                            | sobe uma pasta (com texto no filtro, o backspace apaga o texto primeiro) |
| primeira linha `✓ adicionar esta pasta (<caminho>)` + `enter` | roda `/add-dir <caminho>`                                                |
| digitar                                                       | filtra a lista como a busca do menu `/`                                  |
| `/srv/x`, `~`, `../y`                                         | caminho digitado: `enter` pula para ele se existir                       |
| `esc`                                                         | fecha                                                                    |

Pastas já autorizadas mostram `● já adicionada`; as sem permissão de leitura, `(sem permissão)`. A
lista tem no máximo 500 pastas (`… +N` mostra o resto; filtre para achar). Escolher uma pasta roda
exatamente o `/add-dir <caminho>` digitado: as mesmas validações e o mesmo confinamento valem.

### Conversa

|                 |                                                               |
| --------------- | ------------------------------------------------------------- |
| `/help`         | ver comandos e atalhos                                        |
| `/ask`          | fazer uma pergunta sem interromper o trabalho (modo clássico) |
| `/task`         | ver e parar tarefas em segundo plano (concierge)              |
| `/approve` `/a` | aprovar o pedido pendente (concierge)                         |
| `/deny` `/n`    | negar o pedido pendente (concierge)                           |
| `/conversation` | escolher o modo de conversa                                   |
| `/history`      | retomar uma sessão anterior                                   |
| `/rename`       | dar nome e cor à sessão                                       |
| `/clear`        | limpar a conversa (mantém a memória) · `full` · `memory`      |
| `/compact`      | resumir a conversa para liberar contexto                      |
| `/export`       | exportar a conversa (sem segredos) para `~/.aluy/exports/`    |
| `/quit`         | sair do aluy                                                  |

### Interface

|               |                                                     |
| ------------- | --------------------------------------------------- |
| `/theme`      | trocar o tema de cores                              |
| `/lang`       | trocar o idioma                                     |
| `/fullscreen` | alternar tela cheia (cockpit) · `/cockpit`          |
| `/split`      | mostrar ou ocultar o painel de log · `/view`        |
| `/statusline` | escolher o rodapé (completo, compacto, oculto) · F2 |
| `/suggest`    | ligar ou desligar a sugestão do próximo prompt      |
| `/notify`     | escolher quando o aluy avisa                        |

### Modelo

|             |                                                    |
| ----------- | -------------------------------------------------- |
| `/model`    | trocar o modelo                                    |
| `/provider` | trocar o provedor (OpenRouter, Ollama…) · `save`   |
| `/effort`   | ajustar o esforço de raciocínio                    |
| `/window`   | definir a janela de contexto do modelo (ex.: 128k) |
| `/usage`    | ver tokens e janela de contexto da sessão          |

### Trabalho

|                               |                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/undo` · `/redo` · `/rewind` | desfazer a última edição do agente · refazer · voltar a um ponto da sessão (Esc Esc)                                                                             |
| `/cycle` · `/cron`            | repetir uma tarefa a cada intervalo, com limites · agendar tarefas recorrentes                                                                                   |
| `/permissions`                | ver e ajustar as permissões do agente                                                                                                                            |
| `/add-dir`                    | liberar mais uma pasta para o agente nesta sessão                                                                                                                |
| `/init`                       | criar o `ALUY.md` e a estrutura `.aluy/` do projeto                                                                                                              |
| `/secret`                     | passar um segredo ao agente por um campo **mascarado** (`list` · `remove NOME` · `--save`) — [ADR 0005](decisions/0005-segredos-do-dono-sem-passar-pelo-chat.md) |
| `/todo`                       | ver e concluir os pedidos anotados (≠ `/task`, que é trabalho em segundo plano)                                                                                  |

### Extensões

|                       |                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------- |
| `/memory`             | ver (com a origem `usuario`/`derivado`), editar, esquecer e fixar                     |
| `/mcp`                | gerenciar servidores MCP · `search <termo>`                                           |
| `/plugin`             | gerenciar plugins (bundles em `~/.aluy/plugins`)                                      |
| `/workflows`          | executar fluxos de trabalho salvos                                                    |
| `/subagent` · `/back` | conversar 1:1 com um sub-agente; voltar ao principal                                  |
| `/inventory`          | ver tudo que foi carregado de `.aluy/`                                                |
| `/tools`              | listar as ferramentas — nativas, MCP e o que a catraca diz de cada uma                |
| `/agents` · `/skills` | listar os agentes `.md` e as skills `SKILL.md` mapeados (os rejeitados, com o motivo) |
| `/service` · `/rooms` | serviços em segundo plano (ver abaixo) · salas de conversa entre agentes              |

### Conta

|                                  |                                                       |
| -------------------------------- | ----------------------------------------------------- |
| `/login` · `/logout` · `/whoami` | entrar · sair e apagar a credencial local · ver conta |
| `/doctor`                        | diagnosticar a instalação                             |
| `/upgrade`                       | atualizar o aluy para a versão mais nova              |
| `/telegram`                      | conectar o Telegram (status, liberar, bloquear)       |

## Atalho de shell: `!` e `!!`

|                     |                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `!cmd`              | roda no terminal **sem pedir permissão** (você digitou) e o agente **vê** a saída no próximo passo |
| `!!cmd`             | idem, mas **só local**: o agente não vê a saída (marcado `· só local` no bloco)                    |
| `!cd dir` · `!cd -` | muda o diretório **da sessão** (confinado às raízes; vale também para o agente)                    |

O que **não** persiste: `export VAR=…` (cada `!` é um shell de um comando só). O `!` **não é
interativo** — sem teclado nem terminal; `ssh`, `sudo`, `vim`, `read`… rode em outro terminal (o bloco
avisa quando detecta). O bloco mostra a saída pura: `exit N` só se ≠ 0, stderr só se houver. Modo
Plan e os pisos de `~/.aluy` continuam bloqueando. Ver [ADR 0003](decisions/0003-bang-do-usuario-sem-caixa-de-permissao.md).

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

### `/conversation`

O **Concierge** (ADR [0006](decisions/0006-concierge-conversa-desacoplada.md)) separa a conversa do
motor de execução. Cada mensagem sua ganha uma chamada curta ao modelo (prompt de ~1,5k tokens, sem o
catálogo de ferramentas do agente) que responde **na hora**, mesmo com trabalho rodando; o trabalho em
si roda em **tarefas** (`t1`, `t2`…), que o Concierge abre (`task_start`), corrige (`task_send`), para
(`task_stop`) e consulta (`task_status`).

- `/conversation concierge | classic` troca o modo e **persiste** (`conversation` no `config.json`);
  `--classic` força o clássico só naquela sessão. Neste ramo o padrão é `concierge`.
- **Esc nunca para tarefa**: limpa o rascunho. Parar é explícito: peça ao Concierge ("pare a t1"),
  `/task stop <id>` (ou `all`), ou **F8** (para tudo). Ctrl-C duas vezes sai.
- O trabalho NÃO aparece na conversa: as tarefas moram num **painel abaixo do composer** (uma linha por
  tarefa, sub-agentes aninhados; com 3 ou mais, `3 tarefas · 2 rodando · ↓ ver`). `↓` expande, `↑↓`
  escolhe, `enter` abre o detalhe (no inline vira uma nota no histórico; no `/fullscreen`, vista rolável), `ctrl+k` para a tarefa (pede confirmação com um 2º `ctrl+k`). Digitar tira o foco do painel: atalho de letra nunca dispara.
  A conclusão vira uma linha na conversa (`✔ t1 concluída — …`); `/task show t1` abre o detalhe.
- No modo clássico, os sub-agentes também saem da conversa e moram nesse rodapé.
- `/task` (sem argumento) abre a lista de tarefas: escolha a tarefa e depois a ação. Aprovações viram uma **caixa de entrada** acima do composer; responda com
  `/a [tarefa] [s]` (aprova; `s` = sempre nesta sessão) ou `/n [tarefa]` (nega) enquanto a conversa segue.
- Uma correção entra na tarefa "após o passo atual"; se ela está no meio de uma chamada ao modelo, essa
  chamada não muda (o Concierge diz isso). Duas tarefas no mesmo arquivo: a segunda espera a primeira.
- `conciergeModel` (opcional, `config.json`) escolhe outro modelo para o Concierge; por padrão ele usa o da sessão.

### `/notify`

`/notify all | attention | off` escolhe quando o Aluy avisa (som + notificação de desktop): `all` (padrão) avisa quando precisa de você e quando conclui um turno longo (5 s ou mais); `attention` avisa só quando precisa de você; `off` silencia. `on` = `all`. Sem argumento mostra o modo atual. A escolha fica em `~/.aluy/config.json`; `ALUY_NOTIFY` sobrescreve.
