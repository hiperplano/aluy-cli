# 0005 — `/secret`: dar um segredo ao agente sem ele passar pelo chat

- **Status:** Aceito (pedido do dono)
- **Data:** 2026-11-07
- **Origem:** "algum jeito de mandar informações sensíveis sem ficar no texto". Hoje a única forma
  é colar a chave no prompt — e ela vai ao modelo, à sessão em disco, ao histórico, ao export.
- **Antecedentes:** CLI-SEC-2/3/4/6/9, regra 3 do `CLAUDE.md` (cofre cifrado), ADR 0003.

## Decisão

`/secret <NOME>` abre um campo **mascarado** (só `•`), com colagem (inclusive bracketed paste) e
Esc para cancelar. O valor vai direto ao cofre da sessão — **nunca** passa pelo composer, pelo
histórico ↑↓, pelo transcript, pelo registro de sessão, pelo journal, pelo undo, pelo export nem
pelo log de crash. O modelo aprende só o **NOME**; usa `$NOME` num comando.

| Comando                | Efeito                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/secret NOME`         | campo mascarado; guarda **só em memória** (some ao sair; o buffer é zerado ao remover)                                                                       |
| `/secret NOME --save`  | também grava no cofre cifrado (AES-256-GCM, `~/.aluy/credentials.enc`), conta `secrets:<hash do projeto>`; volta no boot **só nesse projeto**                |
| `/secret NOME --force` | aceita valor com menos de 8 caracteres (ver "redação")                                                                                                       |
| `/secret list`         | só os nomes (e se estão salvos)                                                                                                                              |
| `/secret remove NOME`  | remove da memória, zera o buffer e apaga do cofre cifrado                                                                                                    |
| `/secret`              | uso                                                                                                                                                          |
| `/secret NOME valor`   | **recusado**: não executa, não guarda, não entra no histórico, e avisa que o valor foi digitado em aberto (ficou no terminal/scrollback → considere exposto) |

`NOME` é estilo env, maiúsculo (`API_KEY`); nomes de sistema (`PATH`, `HOME`, `LD_PRELOAD`,
`NODE_OPTIONS`, …) são recusados. A mensagem de erro **não ecoa** o que foi digitado (o valor pode
ter sido colado no lugar do nome).

### Onde o valor entra (e só aí)

1. **Env do shell** do `run_command`, do `watch_command` e do `!` do dono. Nada no `process.env`
   do Aluy. **Não** vai a servers MCP, sub-agentes (nem ao foco `/subagent`), hooks, nem a
   outras tools.
2. **Comando do modelo**: o env só leva os segredos que o **texto do comando cita** (`$API_KEY`,
   `${API_KEY}`, `printenv API_KEY`, `os.environ["API_KEY"]`…). Um comando que não cita o nome
   não recebe segredo nenhum — nem `env`/`printenv` sem argumento, nem um script que leia o
   ambiente por conta própria (`./deploy.sh` não vê `$TOKEN`; escreva `TOKEN=$TOKEN ./deploy.sh`).
   Isso fecha por construção a classe "algo que poderia ler o env": sem citar, não há env.
3. **`!` do dono**: recebe **todos** (ação explícita, ADR 0003).

### Permissão (o ponto único)

`decide()` ganhou a categoria `always-ask:secret-use`: um `run_command`/`watch_command` do
**modelo** que cita um segredo é **sempre `ask`**; a caixa mostra o comando (com o NOME, nunca o
valor).

- Não é relaxável por regra `allow`, hook ou grant de sessão.
- **Sob `--yolo` continua `ask`.** Decisão consciente, com precedente: o `session_command`
  destrutivo (ADR-0147) já é "nunca auto-aprovável, nem sob `--yolo`" — fica **acima** do bloco do
  YOLO. Racional: o YOLO libera efeitos de trabalho, mas entregar um segredo a um processo
  escolhido por um modelo (que pode estar sob injeção de prompt) é outra classe; se o dono quer
  fluxo sem perguntas usa `!` (que ele mesmo digita, ADR 0003). **Flag para o dono:** se preferir
  o contrário (YOLO aprova), é uma linha em `engine.ts` (mover o bloco `-0.8` para depois do YOLO).
- **Sub-agente** (`forSubAgent`): `deny` — o valor não é repassado a filhos.
- Plan segue negando (vem antes).

### Redação (CLI-SEC-6 + valor exato)

O cofre se pluga no **ponto único** da redação: `redactCommandSecrets`/`redactOutputSecrets`
aplicam primeiro a troca por **valor exato** (`‹redigido›`; mais longos primeiro; forma crua e
escapada para JSON) e depois as regras por padrão. Como esse ponto já cobre observações de tools,
blocos `bang`, export, notas e resumos de sub-agente, o valor fica coberto em todos eles. Além
disso, nos sinks que escrevem/enviam sem passar por ali:

- **corpo da requisição ao provedor** (broker, OpenAI-compat, Anthropic) — último ponto antes do fio;
- **registro de sessão** (`writeAtomic`), **pausas**, **stack do journal**, **log de crash**,
  **log de comando solto** (Ctrl+B);
- **stream**: um `StreamRedactor` (por canal) **retém** o sufixo que pode ser começo de um
  segredo até o próximo chunk decidir — um valor partido entre chunks não vaza (testado com
  chunks de 1 a 7 caracteres); vale para a saída do comando, a fala do modelo e o raciocínio.
  O que sobra retido sem se completar é devolvido no fim (nada some).

**Valor com menos de 8 caracteres é recusado** (redigir `123` trocaria trechos comuns de toda
saída e não protege nada); com `--force` guarda e avisa.

### O que o modelo vê

Só a lista de NOMES, na **cauda dinâmica** do prompt (depois de todo o conteúdo estável, para não
invalidar o cache de prefixo do provedor), com a instrução de usar `$NOME` e **nunca** pedir o
valor, nem tentar imprimi-lo/transformá-lo.

## Limites honestos (o que isto NÃO garante)

- **Um comando do modelo pode transformar o valor** (`base64`, `rev`, fatiar, `xxd`, `${X:0:4}`)
  e a saída escapa da redação por valor exato. A defesa real é a **aprovação** de cada comando que
  cita o segredo — leia o comando antes de aprovar. A redação é rede de segurança, não barreira.
- **O valor chega a qualquer processo que o comando lance** (`curl`, um script, um `npm run`…), e
  esse processo pode mandá-lo para onde quiser (rede incluída). A catraca de rede/egress segue
  valendo, mas não enxerga o conteúdo.
- **Citar o nome é o gatilho.** `eval "echo \$A""_KEY"` não cita `API_KEY` — mas, pelo mesmo motivo,
  também não recebe o valor (o env é injetado pelo mesmo critério).
- **Memória:** o `Buffer` é zerado ao remover, mas JS não garante apagar cópias em `string`
  (necessárias para comparar/exportar); elas ficam até o GC. Não há proteção contra dump de memória
  do processo nem contra outro processo do mesmo usuário lendo `/proc/<pid>/environ` **do filho**
  enquanto ele roda.
- **Digitado em aberto não tem volta:** `/secret NOME valor`, ou colar o valor no chat, expõe-no ao
  terminal, ao scrollback e (no chat) ao modelo. O Aluy avisa e não guarda, mas não apaga o
  scrollback.
- **`--save`** protege contra `tar`/`scp`/snapshot do `~/.aluy` (chave derivada da máquina), não
  contra quem já é você nesta máquina.
- **Sob `!`**, o valor sai nos processos do dono; a saída é redigida na tela e no que vai ao
  modelo, mas um `!echo $X | base64` mostra o base64 (o dono pediu).
- O **terminal** do dono pode registrar o que é digitado/colado (gravadores de sessão, `script`,
  scrollback do tmux): o campo não ecoa, mas o terminal é dele.
- `watch_command`: recebe o env como o `run_command`, mas o `onExit` entrega ao modelo só a cauda
  da saída (redigida).

## Verificação

Testes: `cli-core/tests/secrets/*` (cofre, stream, gate, env, requisição no fio),
`cli/tests/session/secrets.test.ts` (parser, `--save`, projeto), `cli/tests/session/secret-leak.test.tsx`
(vazamento ponta a ponta: fluxo mascarado real da `<App>` → comando imprime o valor partido em
chunks → turno do modelo → varredura de sessão, export, histórico ↑↓, frames, journal e corpo
da requisição: **zero** ocorrências). Cada garantia tem teste que falha se for removida (mutações
listadas no relatório do PR).
