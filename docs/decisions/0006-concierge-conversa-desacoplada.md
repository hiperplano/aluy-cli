# 0006 — Concierge: a conversa é desacoplada do motor de execução

- **Status:** Proposto — implementado no ramo `feat/concierge`; o default final é decisão do dono depois de testar
- **Data:** 2026-11-07
- **Origem:** relato do dono — *"quero conversar fluido com o terminal do aluy, mas fico travado o
  tempo todo: algo está processando e minha mensagem vai pra fila, agentes trabalhando, e quando
  aperto Esc para encaixar uma mensagem ele para o turno inteiro. O terminal não deveria ser
  desacoplado do motor de execução — uma interface conversacional fluida que nunca trava e sempre
  gerencia o que acontece por trás?"*
- **Antecedentes:** ADR 0001 (o `spawn_agent` não prende o turno), ADR 0002 (conversa pai-filho),
  ADR 0004 (memória do dono é seguida). Estes tiraram o bloqueio do *fan-out*; este tira o bloqueio
  do *turno*.

## Contexto

Hoje a mensagem do dono entra no **mesmo** laço que executa o trabalho. Consequências medidas no
uso diário:

- durante um turno, texto novo vira fila, `injectInput` (entra só na próxima iteração) ou, com
  sub-agentes rodando, uma `/ask` read-only; são três comportamentos para a mesma intenção;
- o Esc interrompe o **turno** (e o F8, tudo): o gesto "quero dizer mais uma coisa" e o gesto
  "pare" são o mesmo botão;
- uma aprovação de ferramenta abre uma caixa modal: enquanto ela está aberta o dono não conversa;
- uma pausa por cota do modelo do trabalho congela a conversa junto.

O mecanismo para desacoplar já existe em pedaços (fila viva do loop, `askParallel`, filhos
desacoplados, fila FIFO de aprovações no `TuiAskResolver`, coordenador de pausa por cota). Falta
uma **camada de conversa** que nunca espera o trabalho.

## Decisão

Duas peças, com nomes internos (na tela segue sendo só "Λluy"):

- **Concierge** — a frente. Cada mensagem do dono ganha **uma chamada curta ao modelo**,
  concorrente ao trabalho, que responde em segundos. Nunca edita arquivo nem roda ferramenta longa.
  Ferramentas dele (só plano de controle): `task_start(goal, files?)`, `task_send(task_id,
  message)`, `task_stop(task_id)`, `task_status(task_id?)`. Lê o estado vivo (tarefas, sub-agentes,
  aprovações pendentes, pausas de cota, eventos recentes) como um *digest* compacto.
- **Task** — a unidade de trabalho. É o laço de agente que já existe: a primeira tarefa roda como o
  turno do agente principal (`SessionController`, intocado); tarefas paralelas rodam como
  sub-agentes desacoplados (mesma máquina do ADR 0001: histórico próprio, fila de injeção própria,
  parar-um, orçamento agregado). Não há reescrita do controller: o motor é *envolvido*.

### Núcleo portátil (`cli-core/src/concierge/`)

`TaskRegistry` (tarefas, eventos, reivindicação de arquivos), o digest, o prompt, as ferramentas e o
`Concierge` (laço de no máximo 2 chamadas ao modelo) vivem no core, atrás de portas
(`ConciergeEngine`, `ConciergeModel`, `ConciergeGate`). Sem Ink, sem I/O. O `cli` fornece o adaptador
do motor sobre o `SessionController`.

### Eventos

Tarefas publicam eventos: passo concluído, ferramenta, esperando aprovação, pausada por cota,
concluída/falhou (com resumo). A TUI mostra uma **lista compacta de tarefas** na região viva e o
Concierge **relata na conversa o que importa**, em uma linha, sem spam: o relato é por *template*
(zero chamada ao modelo), com dedupe por tarefa+estado. Só `concluída`, `falhou`, `esperando
aprovação` e `pausada por cota` relatam; passos e ferramentas ficam só na lista.

## Contrato de comportamento

1. **Mensagem durante trabalho** nunca entra numa fila atrás de uma tarefa: o Concierge responde na
   hora. Uma correção vai para a tarefa certa pela fila de injeção ("entra após o passo atual"). Se
   a tarefa está no meio de uma chamada ao modelo, ela **não pode ser alterada** naquele instante e o
   Concierge diz isso com honestidade; só oferece parar-e-refazer se o dono quiser.
2. **Esc** limpa o rascunho e fecha overlays. **Nunca** para tarefas. Parar é explícito: pedir ao
   Concierge, `/task stop <id>`, ou o F8 (parar tudo, como hoje). Ctrl-C ×2 continua saindo.
3. **Aprovações** viram uma **caixa de entrada**: só a tarefa dona espera; o dono responde com
   `/a [id]` (aprovar) e `/n [id]` (negar) ou pelas teclas da caixa quando ela está em foco, enquanto
   a conversa segue. A segurança não muda: todo efeito passa por `decide()`; as ferramentas do
   próprio Concierge também passam pelo ponto único (porta `ConciergeGate`); a saída de uma tarefa
   que chega ao Concierge é **dado não-confiável** (CLI-SEC-4), nunca instrução.
4. **Cota:** a tarefa pausada pausa; a conversa continua se o modelo do Concierge tiver cota. Se o
   próprio Concierge bater na cota, diz isso em **uma linha** e a UI segue responsiva (sem congelar).
5. **Dois trabalhos no mesmo arquivo:** `task_start` aceita `files` (caminhos que a tarefa vai
   tocar). Uma reivindicação simples: a segunda tarefa **espera** a primeira e o Concierge avisa. Só
   cobre o que o modelo declarou — ver "Limites".
6. **Memória do dono (ADR 0004)** entra no prompt do Concierge, curta; "sempre delegue" e afins são
   respeitados.

## Chave de modo

`conversation: "concierge" | "classic"` na config; `/conversation concierge|classic` (persistido);
flag `--classic`. **Default neste ramo: `concierge`**, para o dono testar com `aluy-dev`; o default
final é do dono. O modo `classic` fica **integralmente** como está. Inline e `/fullscreen` suportam
os dois; os modos de statusline e os invariantes de altura do cockpit são respeitados.

## Trade-offs

- **Uma chamada ao modelo extra por mensagem.** Prompt alvo ≤ ~3k tokens (sem catálogo de ferramentas
  do agente, sem ALUY.md inteiro). Mensagens triviais custam ~1 chamada pequena; um `task_start`
  custa 1 chamada (o texto que acompanha a tool-call é a resposta; só há 2ª chamada se não veio
  texto). Modelo: o da sessão; `conciergeModel` opcional.
- **Estado defasado.** O digest é um retrato; o Concierge responde do que viu e diz quando não sabe.
- **Não dá para interromper uma chamada ao modelo em voo.** A correção só entra no próximo limite de
  iteração. Dito ao dono, sem fingir.
- **Conflito de arquivos** só é evitado para o que foi declarado em `files`; edição não declarada
  segue o regime do ADR 0001 (sem lock). Aviso, não garantia.
- **Tarefa paralela = sub-agente:** não delega por sua vez (regra E-A1). Só a tarefa principal delega.

## Segurança

Nenhum caminho novo de efeito. Concierge não tem ferramenta de arquivo/shell/rede. `task_start`
cria trabalho que roda sob `decide()` como qualquer turno; as quatro ferramentas passam pela porta de
permissão; limites anti-runaway: no máximo 4 tarefas vivas, 2 chamadas ao modelo por mensagem,
mensagens a tarefas truncadas em 1500 caracteres (o teto do ADR 0002). Resumos de tarefa entram no
digest envelopados como dado e redigidos (CLI-SEC-6).

## O que fica de fora (explícito)

- **Daemon em processo separado** (conversa sobrevivendo ao terminal): adiado. Aqui o desacoplamento
  é lógico, dentro do processo.
- Tarefas paralelas que, elas mesmas, delegam a sub-agentes; trabalho em *worktree* por tarefa.
- Detecção de conflito de arquivo em tempo de execução (só o declarado).
- Retomar no meio de uma chamada ao modelo: `--resume` restaura a lista de tarefas e o histórico da
  conversa; o que estava em voo volta como *interrompida*, com o objetivo guardado, e o Concierge
  oferece reiniciar (a pausa por cota segue retomando de onde parou, como hoje).
