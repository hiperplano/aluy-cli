# 0001 — O `spawn_agent` deixa de prender o turno: o pai escolhe esperar ou despachar

- **Status:** Proposto
- **Data:** 2026-09-22
- **Origem:** pedido do dono em 21/09/2026 — *"quando ele dispara agentes, esses agentes
  ficam em estado processando e travam o turno — o correto não seria eles ficarem sendo
  monitorados e deixar o turno livre?"*
- **Antecedentes:** ADR-0079 (monitor: vigia de evento, dispara e reage) e ADR-0146/0152
  (modelo e tier dos sub-agentes), no repositório de specs antigo. Este é o primeiro
  registro de decisão dentro do próprio `aluy-cli`.

## Contexto

Hoje o `spawn_agent` é uma chamada **bloqueante**: o pai fica pendurado num
`await port.spawn(...)` até o **último** filho terminar, e o turno inteiro fica preso
junto. O que o dono digita durante o fan-out entra numa fila e só é incorporado depois.

A máquina de **desacoplar** já existe e é usada por três gatilhos — o ESC no pai, a
injeção de mensagem durante o fan-out (ligada por padrão desde a rc.142) e, desde a
rc.185, o Ctrl+B. Quando o fan-out é desacoplado:

- os filhos seguem vivos, cercados pelos **mesmos tetos** (budget agregado, iterações,
  heartbeat) e ao alcance do parar-tudo (F8, `agents_stop`);
- o pai recebe, no lugar do resultado, um desfecho com `detached: true` e um texto que o
  instrui a não esperar, não re-disparar e não inventar o conteúdo;
- quando os filhos concluem, o resultado real entra como **dado**: na fila de monitor se
  há turno vivo (`monitorQueue`, drenada no topo da iteração como `observation`), ou como
  semente do próximo turno (`pendingSeed`) se a sessão está em repouso;
- `agents_status` / `agents_stop` já dão ao pai leitura e freio sobre os filhos soltos.

Ou seja: o que falta **não é mecanismo** — é o pai poder **escolher** isso na origem, em
vez de depender de o dono apertar uma tecla.

## O que está em jogo

O fan-out costuma ter um fan-in: o pai dispara os filhos para **usar** o resultado no
mesmo turno (o padrão "produtores → coordenador" que a própria descrição da tool ensina).
Se todo `spawn_agent` soltasse na hora, esse padrão quebraria — o pai encerraria dizendo
"despachei" e o resultado chegaria num turno em que ninguém pediu nada.

Por outro lado, um fan-out de **investigação longa** (auditar três módulos, rodar três
suítes) não precisa do pai parado: o dono quer continuar conversando enquanto os filhos
trabalham, e quer ser avisado quando terminarem.

Os dois usos são legítimos. A decisão é **não escolher por eles**.

## Decisão

**O `spawn_agent` ganha um modo, e o default preserva o contrato de hoje.**

```
{ "agents": [...], "wait": true | false }   // default: true
```

- `wait: true` (default) — comportamento atual, byte a byte. O pai espera e recebe o
  resultado como observação da própria chamada. Nenhum fluxo existente muda.
- `wait: false` — o `spawn_agent` **retorna imediatamente** com o mesmo desfecho
  `detached: true` que o Ctrl+B produz hoje (reusa `detachSpawn`; nada novo de máquina).
  O resultado real chega pelo canal que já existe: `monitorQueue` com turno vivo,
  `pendingSeed` em repouso. O pai é instruído a encerrar o turno dizendo o que despachou
  e a não esperar.

**Três regras que acompanham o modo:**

1. **O modelo não pode usar `wait: false` para escapar de um fan-in.** A descrição da
   tool diz quando cada modo serve: `false` para trabalho cujo resultado não é
   necessário neste turno; `true` quando o pai vai consumir o resultado. Um filho
   despachado com `wait: false` **não pode ser lido por `room_read` bloqueante** no mesmo
   turno — a tool recusa a combinação `wait: false` + `room: true` com leitura
   bloqueante, porque é a corrida produtor-consumidor que a descrição já proíbe.
2. **O aviso ao dono é o mesmo do Ctrl+B.** Nota `segundo plano` com os rótulos, o
   contador persistente de desacoplados, e a nota `sub-agentes concluíram` quando o
   resultado chega. Nada de canal novo.
3. **Concorrência é do dono, não da tool.** Com o turno livre, o dono e os filhos podem
   tocar os mesmos arquivos; um filho pode pedir aprovação enquanto o dono digita outra
   coisa. Isso já é verdade hoje após um Ctrl+B ou um ESC, e a catraca é a mesma. Esta
   decisão **não** introduz lock de arquivo nem fila de aprovação — se isso se mostrar
   necessário, é outra decisão.

## O que fica de fora

- **Tornar `wait: false` o default.** Quebraria o padrão produtores → coordenador que a
  tool ensina e que o dono usa. Pode ser revisto com medição de uso, nunca por palpite.
- **Um `spawn_agent` que "acorda" o pai sozinho** (o resultado dispara um turno novo sem
  o dono pedir). O ciclo já tem `wake()` para o descanso entre iterações; abrir um turno
  do zero por conta de um resultado de filho é uma mudança de autonomia que merece
  registro próprio.
- **Lock de arquivos / fila de aprovação entre pai e filhos** (regra 3).

## Evidência

- Os três gatilhos de desacople convergem em `spawnDetachable` → `detachSpawn`
  (`packages/cli/src/session/controller.ts`), com `detachedOutcome(label, motivo)` já
  distinguindo `esc` / `inject` / `solto`. O modo `wait: false` é um quarto motivo.
- Entrega do resultado sem turno preso já é coberta por `controller-fanout-inject.test.ts`
  e `controller-ctrl-b-fanout.test.ts` (invariante E-A2: o budget agregado não reseta
  enquanto há desacoplados vivos).
- Medido na TUI real em 21/09/2026: dois filhos presos num comando de 90 s, Ctrl+B →
  nota imediata, `spawn_agent … ok ✔`, composer livre, resultado entregue ao concluir.

## Consequências

- Uma tool a menos dependente de tecla: o modelo pode planejar "despacha e segue".
- A descrição do `spawn_agent` cresce um parágrafo — e a descrição já é o lugar onde o
  modelo lê o contrato (o `?` do schema não é lido como opcional; a frase é).
- Nenhum teste existente muda de expectativa: o default é o comportamento atual.

## Aprovação

Sem aprovação do dono, nada no código depende deste registro. Com ela, a implementação é
uma estória pequena: o campo no schema e na prosa da tool, o quarto motivo em
`detachedOutcome`, a recusa da combinação da regra 1, e testes para os dois modos.
