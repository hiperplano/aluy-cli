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
- **Aprovação sem diff**: a caixa do rodapé mostra o efeito exato (comando/caminho, até 4 linhas), mas
  não o diff de `edit_file` que o diálogo clássico mostra.
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

Ainda pior que o clássico: o detalhe inline é um despejo no histórico (não uma vista rolável), a
aprovação não mostra diff, e cada mensagem custa uma chamada curta a mais. O buraco do menu `/` já
existia e continua.
