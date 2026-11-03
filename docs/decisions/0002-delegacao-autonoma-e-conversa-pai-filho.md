# 0002 — Delegação autônoma e conversa pai ⇄ filho

- **Status:** Proposto — aguardando validação do dono
- **Data:** 2026-11-03
- **Origem:** pedido do dono — _"o CLI sempre tenta resolver tudo sozinho; não deveria quebrar
  mais em agentes, de forma autônoma? E o Claude Code conversa muito bem com os agentes, dando
  novas instruções no meio do caminho. No aluy-cli isso não acontece: apesar da sala, não vejo
  uma conversa fluida entre pai e filhos."_ Complemento: _"com instrução GRANDE o agente nunca
  planeja/distribui, só começa a fazer."_
- **Antecedentes:** ADR 0001 (`spawn_agent` não prende o turno), E-A1/E-A2/E-A3 (profundidade ≤1,
  budget agregado, grants por filho), CLI-SEC-3/4/8.

## Contexto

Verificado no código antes de decidir:

- A política "DELEGAÇÃO É O PADRÃO" só entrava no prompt quando existia um time `.md`; sem time,
  havia uma linha genérica, sem critério de **quando** decompor. O prompt também nunca mencionava
  `update_plan`.
- `spawn_agent` é `effect: 'exec'` e, sem regra, a engine o tratava como "efeito desconhecido ⇒
  `ask`": **toda** delegação pedia confirmação (exceto sob `--yolo`).
- O pai não tinha como falar com um filho vivo. A injeção do dono pela árvore de fluxo, ao
  contrário do que a docstring sugeria, **não chegava ao loop do filho**: para um nó filho ela caía
  em `pendingInjected` (próximo turno do **pai**), porque o loop do filho não tinha `pollInjected`.
- O filho só devolvia o desfecho final; não havia como perguntar nada ao pai sem terminar.
- Não existia "sempre permitir" persistente: só `approve-session` (memória da sessão).

## Decisão

### 1. `spawn_agent` é permitido sem perguntar, por padrão

A delegação não tem efeito próprio no mundo: **cada** filho passa pela mesma `decide()` para tudo
que faz (engine ⊆ pai, grants próprios, `spawn_agent` negado, Plan/YOLO herdados). Perguntar a cada
delegação só tirava a autonomia que o dono quer. Portanto `spawn_agent`, `agent_send`,
`agents_status` (e, no filho, `ask_parent`/`report_status`) são **allow por padrão**
(`DELEGATION_ALLOW_BY_DEFAULT`, precedência 0.55 de `decide()`, abaixo de Plan/YOLO/toolScope).
`agents_stop` **continua `ask`** (encerrar trabalho que o dono pediu não é decisão silenciosa).

Quem quiser voltar ao comportamento antigo: `policy.defaults.spawn_agent = "ask"`, uma regra
explícita, ou o painel `/permissions` (que passa a poder também devolver `allow`). Regra explícita
vence tudo; o "lembrar" do dono vence o default configurado.

**Lembrar esta decisão.** O diálogo de permissão ganhou `[l] lembrar` (nova resolução
`approve-always`): vale já, como o `approve-session`, e **persiste** o _nome da tool_ em
`~/.aluy/config.json → permissions.alwaysAllow`, lido no boot e compartilhado com as engines dos
filhos. Limites (CLI-SEC-3, não relaxáveis): não é ofertado em categorias sempre-ask; **nunca**
vale para `run_command`, `edit_file` e `write_file` (a TUI rebaixa para "sessão", a engine e o
`sanitize` do config descartam); o allow lembrado só age na precedência de _default_ — categorias
sempre-ask, Plan, `toolScope` e hooks continuam acima. Revogar = apagar o nome do arquivo.

### 2. Pai → filho: `agent_send` é INSTRUÇÃO rotulada

Tool **só do pai** (`{ to, message }`). Entra na **fila viva** do filho (a mesma ideia do inject
mid-turn do pai, agora também no loop do filho via `pollInjected`) e é drenada no topo da
próxima iteração, como `user_inject` — canal `user`, instrução, **como se viesse do dono** — mas com
origem carimbada: `[do orquestrador] …` no histórico do filho e `↳ do orquestrador → f1: …` na TUI.

- Funciona com filhos desacoplados (`wait:false`/Ctrl+B/ESC): o pai despacha, segue trabalhando e
  orienta. Filho inexistente, terminado ou ainda na fila de concorrência ⇒ erro claro sugerindo
  `agents_status` e spawnar um novo.
- **Não dá poder.** A mensagem não troca a engine do filho; toda tool que ele disparar depois
  passa por `decide()` (ver testes). Os filhos **não têm** `agent_send` (some do toolset e a engine
  do filho o nega, inclusive sob `--yolo`) — nada de irmão mandando em irmão.
- A injeção do **dono** pelo painel de fluxo agora usa o mesmo canal, chegando ao filho vivo de fato
  (rotulada `usuário`), em vez de esperar o próximo turno do pai.

### 3. Filho → pai: `ask_parent` é DADO NÃO-CONFIÁVEL

Tool **só do filho** (`{ message, kind: "pergunta" | "progresso" }`), não bloqueia: o filho segue
com a melhor suposição. Chega ao pai como `observation` (`<<<DADO_NAO_CONFIAVEL`, rótulo
`[sub-agente f1 → orquestrador · pergunta]`), pela fila de monitor — **nunca** como instrução
(CLI-SEC-4): um filho comprometido por injeção não manda no pai. É drenada no próximo ponto seguro
do loop do pai; se o pai está em repouso com filhos soltos, uma `pergunta` o acorda (o pai pode
responder com `agent_send`), `progresso` espera. Com fan-out síncrono o pai está preso no
`spawn_agent`, então a conversa de verdade pede `wait:false` — o texto da tool diz isso.
`ask_parent` é isenta do `toolScope` do `.md` (é comunicação, não capacidade).

### 4. Prompt: planejar e decompor (com ou sem time `.md`)

Um bloco curto (~8 linhas, só quando `update_plan`/`spawn_agent` existem): pedido grande ⇒
**primeira ação `update_plan`** (marcando o que vai para sub-agentes) e mantê-lo atualizado;
decompor quando há subtarefas independentes em paralelo, busca ampla, áreas de mudança separadas
ou verificação longa; **não** decompor tarefa trivial (1–2 passos) nem edições sequenciais
acopladas. `update_plan` entra no MAPA DE CAPACIDADES. O bloco é igual para todos os tiers (é curto
demais para justificar um corte por tier); o few-shot de tier fraco, que já exemplifica o
`spawn_agent`, é o único reforço extra.

## Modelo de confiança

| Direção                    | Canal                                | Confiança          | Por quê                                                                               |
| -------------------------- | ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------- |
| dono → filho / pai → filho | `user_inject` (instrução) com origem | instrução rotulada | o pai age em nome do dono; o poder do filho é ⊆ pai e cada efeito re-passa `decide()` |
| filho → pai                | `observation` envelopada             | **dado**           | o filho lê conteúdo não-confiável; não pode comandar o pai                            |

## Tetos anti-runaway (espírito do CLI-SEC-8)

`MESSAGING_LIMITS` é a fonte única: **8** mensagens do pai por filho; no máximo **3** não
consumidas por vez; **6** notas do filho ao pai; **1500** caracteres por mensagem (cortado com `…`).
Estourou ⇒ erro em PT-BR ao modelo e nada é enviado. Cada nota do filho usa id próprio na fila (não
é coalescida, o teto é que protege). Tudo acompanha a vida do filho: filho novo, contador novo — e o
budget agregado (E-A2) continua cercando o custo de quem fala demais.

## UX

Nota compacta na região viva (`agentes`): `↳ do orquestrador → f1: …` /
`↳ f1 → orquestrador (pergunta): …`, redigida (CLI-SEC-6) e cortada em 90 caracteres. O nó do
filho guarda a última troca e a visão geral da árvore a mostra em **uma** linha extra, só para quem
conversou. O diálogo de permissão mostra `[l] lembrar` apenas onde é permitido.

## Fora desta decisão

- Resposta síncrona do pai a um `ask_parent` (o filho esperando): seria um novo ponto de bloqueio
  e de deadlock; o desenho atual é assíncrono.
- Mensagens filho ↔ filho fora de sala (a sala já existe para isso).
- Acordar o pai por `progresso`.
- Lock de arquivos / fila de aprovação entre pai e filhos (segue o ADR 0001).

## Consequências

- Delegar deixa de abrir diálogo; a segurança está nos filhos, como já estava.
- Quem usava o `ask` do `spawn_agent` como freio precisa configurá-lo (uma linha de config).
- O config ganha `permissions.alwaysAllow`; arquivos antigos continuam válidos.
- Nenhum teste de comportamento de filho muda: o canal novo só existe se alguém escreve nele.

## Adendo — dica de delegação no loop

A regra de prompt sozinha não fez o modelo (glm) delegar: só o cenário `auditoria-ampla` delegou.
Agora o loop do agente PRINCIPAL injeta **uma** dica curta (`reanchor`, canal `assistant` de
auto-lembrete, o mesmo do self-check; nunca `user_inject` nem `system`) quando: o `update_plan`
tem >= 3 passos abertos independentes (marcados `parallel: true`/`owner: 'subagente'`, ou com
arquivos/áreas próprios sem alvo em comum) e o modelo então executa uma tool de efeito sem ter
chamado `spawn_agent`. No máximo uma vez por execução, nunca para plano pequeno, e desligada com
`ALUY_DELEGATION_NUDGE=0`. Sub-agentes nunca recebem. É só uma sugestão: `spawn_agent` segue por
`decide()`. Código: `cli-core/src/agent/delegation-nudge.ts`.
