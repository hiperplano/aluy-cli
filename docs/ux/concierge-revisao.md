# Concierge — revisão de UX (modo concierge × clássico)

Fluxo do dono repetido nos dois modos, com o stub OpenAI-compatível e capturas do `tmux`
(socket privado): três tarefas rápidas, conversa enquanto rodam, uma aprovação, detalhe de uma
tarefa, fim. Inline (150×40/50) e `/fullscreen` (150×45). Clássico = `--classic` (mesmo binário).

## Regressões encontradas e o que foi feito

| #   | Regressão frente ao clássico                                                                       | Prova                                                                                                                  | Estado                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Linha da tarefa em formato novo e pobre (sem modelo, tokens, tools, tempo, brilho)                 | captura: `[t1 …] ◕ rodando · herdado (stub-model) · 14s` igual à linha de sub-agente                                   | corrigido: o painel usa `<ChildLine>` (a mesma do clássico)                                                                         |
| 2   | Brilho dos agentes perdido                                                                         | `capture-pane -e`: 3/3 linhas `rodando` mudam de SGR entre dois frames                                                 | corrigido; teste de SGR por frame                                                                                                   |
| 3   | Aprovação/fila marcadas como "rodando" (e brilhando)                                               | captura da t3 esperando arquivo                                                                                        | corrigido: palavra própria (`aguardando aprovação`, `espera t1`), sem brilho                                                        |
| 4   | Resultado duplicado (resposta da tarefa + relato) e trabalho no meio da conversa                   | transcrição só tem `você`/`Λluy`/linha de conclusão                                                                    | corrigido                                                                                                                           |
| 5   | Três linhas em branco entre resposta e o `você` seguinte                                           | **também no clássico da `main` (rc.191)**: era a divisória "subtle" (linha vazia + padding) somada ao respiro do bloco | corrigido nos dois modos: exatamente 1                                                                                              |
| 6   | Três linhas em branco entre a resposta e o composer                                                | idem (contêiner vivo somava topo e base em repouso)                                                                    | corrigido: 1                                                                                                                        |
| 7   | Atalho de letra (`p`) roubava a digitação ("parou?")                                               | teste: digitar `parou?` com o painel focado não para nada                                                              | corrigido: digitar tira o foco; parar = `ctrl+k` + confirmação (`ctrl+k` de novo)                                                   |
| 8   | Vista de detalhe inline crescia a região viva, empurrava a conversa e deixava **buraco** ao fechar | captura 40 linhas: ~15 linhas em branco acima do composer                                                              | corrigido: no inline o detalhe vira UMA nota no histórico (scroll do terminal); no `/fullscreen` segue vista rolável de altura fixa |
| 9   | Ordem do rodapé                                                                                    | decisão do dono                                                                                                        | composer → statusline → painel, sem linha em branco; painel cresce para baixo; aprovações nunca somem                               |

Hierarquia do painel: nível 1 = **tarefas**; nível 2 = os agentes da tarefa, na linha do clássico. Sem
espaço, os agentes recolhem para `· N agentes` na linha da tarefa; sem espaço nem para as tarefas,
uma linha `3 tarefas · 2 rodando · ↓ ver`. No clássico (sem tarefas) o rodapé lista os agentes direto.

## O que continua pior que o clássico (e por quê)

- **Detalhe inline não é interativo**: é uma nota com o transcrito (redigido) no histórico. Uma vista
  que cresce deixa buraco ao fechar (o Ink só apaga linhas ainda na tela). O `/fullscreen` tem a vista
  rolável, mas um único bloco muito longo é cortado (`…(+N linhas)`), sem rolar dentro do bloco.
- **Uma chamada ao modelo a mais por mensagem** (~1,5k tokens) e a fala do Concierge não vê o código.
- **Menu `/` deixa buraco ao fechar** com a tela cheia — **pré-existente** (medido na `main`: maior
  corrida de brancos 5 → 14). Não corrigido aqui; é o mesmo mecanismo (região viva que cresce).
- Tarefa = sessão própria: não há contador de custo agregado entre tarefas.
- No `/fullscreen` a statusline fica acima do composer (layout fixo do cockpit); o painel fica logo
  abaixo do composer.

## Resumo para o dono

Mudou: a conversa não espera mais o trabalho; as tarefas aparecem num painel no rodapé com a mesma
linha dos agentes (brilho, modelo, tokens, ferramentas, tempo), os agentes aninhados na tarefa;
conclusão vira uma linha; entre blocos agora há uma linha em branco (antes eram três, nos dois modos);
digitar nunca aciona atalho; parar uma tarefa exige `ctrl+k` duas vezes.

Ainda pior que o clássico: o detalhe inline é um despejo no histórico (não uma vista rolável) e cada
mensagem custa uma chamada curta a mais (mais uma por tarefa concluída, no relato automático). O buraco do menu `/` já
existia e continua.

## Segunda rodada (teste real no WezTerm)

| #   | Problema                                                                 | Correção                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tarefa rodando sem sinal de vida (`1 tarefa · 1 rodando · ↓ ver` parado) | com statusline `compact`/sem espaço o resumo ganha a linha viva de quem roda (brilho, atividade, tokens, tempo); o tick de animação liga com tarefa rodando; `hidden` segue só resumo |
| 2   | Concierge não relatava o resultado (só a linha `✔ tN concluída — …`)     | fim de tarefa (done/failed) ⇒ turno automático com o resultado (dado, não instrução), em bloco `Λluy` em stream; espera o dono ficar ocioso; anti-laço (ver abaixo)                   |
| 3   | Diff achatado numa linha na aprovação                                    | cabeçalho `tool arquivo`, linhas `-`/`+` coloridas (`DiffLine` do clássico), 10 linhas + `… +N linhas`; `/a show` mostra tudo                                                         |
| 4   | Fadiga de aprovação                                                      | `/a!` (= `/approve always`): "aprovar sempre nesta tarefa" via `decide()`; só o `ask` por default de run_command/edit_file/write_file; sempre-ask, hooks e política seguem            |
| 5   | Só a 1ª aprovação deixava registro                                       | cada aprovar/negar escreve 1 linha (`✓ aprovado · t1 · run_command …`), coladas entre si                                                                                              |
| 6   | Resposta aparecia de uma vez                                             | verificado com caller real e cliente lento: o bloco cresce palavra a palavra (teste + tmux); era só resposta curta                                                                    |

Anti-laço do relato: um turno automático pode iniciar tarefa só se o pedido original do dono previa
o passo seguinte; as tarefas nascidas assim são relatadas SEM poder iniciar/enviar nada, e
`task_stop` nunca vale num turno automático.

## Terceira rodada (ritmo, buracos, custo)

- **Buracos após fechar sobreposições (menu `/`, painel expandido, seletores, caixa de aprovação)**:
  causa = a âncora do composer (`createFrameAnchor`, `synchronized-output.ts`) segurava a altura do
  quadro vivo com linhas em branco no topo quando a tela estava cheia. Medido no tmux (inline, 30
  linhas): menu aberto e fechado deixava **11 linhas em branco** entre a conversa e o composer.
  Agora a âncora só segura encolhimentos de até `MAX_ANCHOR_PAD` (2) linhas (indicador
  "processando", "↳ encaixando…"); encolhimento maior é solto na hora. Depois: 0 linhas de buraco.
  No `/fullscreen` (cockpit) não houve buraco: o cockpit tem regiões de altura fixa e repinta.
  Consequência assumida: com a tela cheia, o composer SOBE quando um overlay grande fecha (em vez de
  ficar fixo com um vão acima dele).
- **Ritmo**: 1 linha em branco entre `Λluy` e o próximo `você`, notas (`✓ aprovado`, `✔ tN
concluída`) coladas e 1 em branco antes do bloco seguinte — conferido no tmux (inline e cockpit,
  inclusive com mensagens durante o stream) e travado por teste. A corrida de 4 linhas em branco que
  a revisão viu era o vão da âncora acima.
- **Custo**: o agente de uma tarefa recebe junto do objetivo uma orientação ("pequeno ⇒ faça você
  mesmo, sem spawn_agent; delegue só se for amplo e independente"). Só no Concierge; o clássico não
  muda. Motivo: com um time de agentes configurado, o prompt de sistema manda delegar por padrão e
  um conserto trivial custou ~72k tokens.

## Quarta rodada (diff, custo por chamada, Esc no `/`)

- **Diff da aprovação**: `unifiedDiff` alinhava as linhas por índice (uma inserção desalinhava tudo
  e `-`/`+` saíam intercalados). Agora é um diff de linhas por LCS: contexto inalterado fica como
  contexto, em cada trecho as remoções vêm antes das adições, e o branco entre funções é contexto.
  Vale também para o diálogo clássico e para o transcrito (mesma função).
- **Custo por chamada** (tarefa do Concierge, medido no stub, parent, caracteres por request):

  | parte                       | antes  | depois |
  | --------------------------- | ------ | ------ |
  | prompt de sistema           | 12 655 | 6 956  |
  | schemas das tools (31 → 21) | 29 103 | 20 073 |
  | histórico (início do turno) | 342    | 342    |
  | **total**                   | 42 100 | 27 371 |

  ≈ 12k → 7,8k tokens por chamada (÷3,5). O custo de uma tarefa é (nº de chamadas × isso): os
  ~73k tokens vistos ao vivo eram ~7 chamadas de ~10k, sem delegação. Cortes (só nas sessões de
  tarefa; o clássico não muda): tools `perguntar` (a tarefa é headless: ninguém responde),
  `session_command`, `capabilities`, `list_tools`, `room_*`, `monitor*`, `headroom_retrieve` e o
  catálogo de COMANDOS DA SESSÃO (5,4k chars, só serve a `session_command`). A catraca e as tools de
  trabalho (ler/editar/escrever/buscar/comando/testes/web/plano/memória/`spawn_agent`) ficam.
  Ainda pesa: `spawn_agent` (5,5k chars) e o prompt-base (~7k); o medido aqui é um piso (sem o
  bloco de memória/ALUY.md do dono).

- **Esc no menu `/`**: se o composer tem só `/`, o Esc fecha o menu e limpa o gatilho; com `/mod…` o
  texto fica.

## Quinta rodada (medir o custo ao vivo)

- **Rastro de uso opt-in**: `ALUY_DEBUG_USAGE=<arquivo>` grava UMA linha JSONL por request ao modelo
  (`ts`, `session` = `concierge` | `main` | `task tN` | `task tN/sub:<agente>`, `request` = índice na
  sessão, `tier`/`provider`/`model`, `messages`, `chars{system,tools,history,last}`, `last_role`,
  `tool_names`, `head_hash`, `prefix_same_chars`/`prefix_prev_chars` e `usage{prompt_tokens,
cached_tokens, cache_write_tokens, completion_tokens, reasoning_tokens}` quando o provider
  reporta). Só tamanhos, nomes e hashes curtos: nunca conteúdo, chave ou cabeçalho. Desligado não
  envolve nada e não cria arquivo. `prefix_same_chars == prefix_prev_chars` ⇒ o prefixo
  (tools+system) é idêntico ao do request anterior da sessão (o cache de prefixo pode acertar).
- **O que o `N tokens` da linha da tarefa soma**: prompt + completion de TODA chamada ao modelo da
  tarefa (agente principal e sub-agentes, sem contar duas vezes), com o prompt em cache contado por
  inteiro. É volume processado, não o que foi cobrado; por isso a linha passou a mostrar `(X% cache)`
  quando o provider reporta cache.
- **Cache de prompt** (leitura do código): o system é montado com o conteúdo estável primeiro e a
  cauda dinâmica (modelo, raízes, segredos) por último; sem data/hora nem plano no system; o histórico
  só cresce por append. O adaptador OpenAI-compatível/OpenRouter manda `session_id` fixo (roteamento
  pegajoso), `stream_options.include_usage` e `cache_control` no system quando ele passa do piso.
  Ressalva: o bloco de memória do dono fica no MEIO do system — se uma tarefa grava memória
  (`remember`), o prefixo muda dali em diante.
- **Planejamento**: a orientação de custo da tarefa agora também diz para NÃO montar plano
  (`update_plan`) nem lista de afazeres em trabalho pequeno e para rodar o teste uma vez; as tools
  `add_todo`/`done_todo`/`list_todos` saíram das sessões de tarefa.

## Sexta rodada (composer estável, frases de espera, ┃ órfãs)

- **Linhas `┃` órfãs após a resposta** (1 por tarefa iniciada): o modelo emite `\n` soltos antes/entre as
  tool-calls; o texto do bloco `Λluy` assentava com essas quebras no fim. Agora o texto assentado é aparado
  (`finishAluyTurn`). Regressão: `concierge-app.test.tsx` (3 tarefas, `\n\n\n` no fim).
- **Resumo do painel**: `2 tarefas · 2 encerradas` com 3 encerradas — a lista mostra no máx. 2 encerradas e o
  resumo contava só as listadas; agora soma as ocultas (`hiddenEnded`).
- **Relato único**: `reportSettleMs` (1500 ms em produção) agrupa tarefas que terminam juntas num só turno
  automático; cada término reinicia a espera (teto 4×).
- **Frase de espera** (`session/frases-espera.ts`, lista em `working.quips`, 56 frases): gira a cada 4 s na
  linha de trabalho; existe também com tarefa em segundo plano (conversa ociosa) e na pausa por cota. Sem
  rotação com `ALUY_NO_ANIM`; `ALUY_SPINNER_VERBS=plain` volta aos rótulos planos.
- **Composer**: o respiro de 1 linha acima da linha de trabalho já era constante (o `paddingBottom` do bloco do
  aluy com a prévia viva, o `paddingTop` da linha sem ela) — somar os dois dava 2 em branco; mantido o original.
  Rodapé de agentes (clássico): as linhas do bloco são reservadas no MESMO quadro da tool-line `processando N
agentes`. Dicas do rodapé, linhas das tarefas e dos
  agentes cortam em vez de quebrar (antes quebravam em 60 colunas e o composer pulava).
- **Limites conhecidos**: o 1º crescimento do rodapé (bloco de agentes) chega ~50 ms depois da tool-line
  `processando N agentes` — um sobe/desce de 1 linha por instante, uma vez por lote; o menu `/` aberto sobre
  rodapé alto continua empurrando a tela (o composer sobe ao fechar, já documentado acima).
