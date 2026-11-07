# 0003 — `!comando` do usuário roda sem caixa de permissão

- **Status:** Aceito (decisão do dono)
- **Data:** 2026-11-03
- **Origem:** UX review (F15): um comando que o **próprio usuário digitou** com `!` abria a caixa
  "executar este comando?". Perguntar a quem acabou de digitar o comando é atrito sem proteção.
  Referência: o `!` do Claude Code executa direto.
- **Antecedentes:** EST-0958 (`!comando` atrás da catraca), CLI-SEC-3/4/9, ADR 0002.

## Decisão

O `!comando` é uma **ação explícita do usuário**. No `BangExecutor` (`cli-core/src/agent/bang.ts`),
um veredito `ask` **não abre a caixa**: o comando executa direto e a saída aparece no transcript
(bloco `bang`). Opção `userExplicit` (default `true`); `false` restaura o fluxo antigo (ask via
resolver), útil só para quem embute o executor com outra política.

## O que NÃO muda (pisos mantidos)

O executor continua chamando `decide()` com o mesmo `run_command` e **bloqueia todo `deny`**:

- modo **Plan** (read-only): `!cmd` com efeito segue negado. O usuário escolheu o modo; sair dele é
  `/mode`;
- pisos de `~/.aluy` (`journal-read-deny`, `aluy-config-write-deny`), hooks que negam, teto de
  profundidade/`toolScope` (irrelevantes na raiz, mas preservados por construção);
- a execução segue pela mesma porta de shell confinada (cwd preso, timeout, redação de segredos
  CLI-SEC-6, abort mata o grupo de processos, Ctrl+B solta);
- o guarda de raiz do `--yolo` (recusa de iniciar como root) é de inicialização e não é tocado.

Não existe, hoje, um guarda de "comando catastrófico" (ex.: `rm -rf /`) no engine além das
categorias sempre-ask, que eram justamente o que o `!` pulava. Por decisão do dono, `!rm -rf x`
digitado pelo usuário **executa**. Se um dia houver lista de comandos catastróficos, ela entra como
`deny` e vale para o `!` também.

## Não vira caminho para o modelo (invariante)

- A mudança vive só em `BangExecutor.run`, chamado exclusivamente por `SessionController.runBang`
  a partir do composer (digitação do humano). O loop do agente **não** usa o `BangExecutor`; todo
  `run_command` do modelo continua por `decide()` + `AskResolver` (teste:
  `bang.test.ts` > "NÃO é caminho do modelo").
- A saída do `!cmd` realimentada ao modelo continua sendo observação não-confiável (CLI-SEC-4)
  (**agora de fato realimentada** — ver a emenda abaixo).
- Texto digitado pelo usuário só vira `!` por tecla dele; conteúdo ingerido (arquivo, web, MCP)
  nunca passa por `runBang`.

## Testes

`cli-core/tests/agent/bang.test.ts` (F15), `cli/tests/session/bang-controller.test.ts`.

## Emenda (rc.191) — a saída chega ao modelo, `!!`, `cd`, bloco enxuto, não-interativo

O teste ao vivo na rc.190 mostrou que o texto acima prometia o que o código não fazia: o
`bang.ts` dizia "quem realimenta é o chamador", mas o `runBang` só atualizava o bloco da tela.
`!echo PALAVRA-ZIMBRO-42` seguido de "que palavra saiu?" devolvia "NÃO SEI". Decisões:

1. **A saída entra na conversa.** Comando + saída (já redigida por CLI-SEC-6 e pelo cofre de
   `/secret`) viram uma `observation` (canal CONTEÚDO, CLI-SEC-4), com origem `run_command (!comando)`.
   Limite de **12 000 caracteres** (cabeça 8 000 + cauda 3 000) e a observação **diz** quando
   cortou; a tela mostra tudo o que a tool devolveu (já limitada a 20 000). Entrega:
   - _turno parado_: guardada e anexada ao **próximo** envio (o `!` não acorda o modelo sozinho);
   - _turno vivo_: pela fila de dado do monitor (a fila de inject do loop só aceita `user_inject`,
     que é instrução do dono — dado não pode entrar por ali), drenada no topo da iteração seguinte;
   - _resume/compactação_: o bloco `bang` persiste e `blocksToHistory` o reconstrói; compacta como
     qualquer observação.
     Comando **bloqueado** pela catraca não é entregue (ruído).
2. **`!!cmd` = só local.** Roda igual, mas a saída não vai ao modelo. O bloco leva a marca
   `· só local`, persiste com `localOnly` e é omitido na reconstrução do resume. Existe porque
   `!cat .env` ou `!env` são coisas que o dono quer ver sem que o agente veja.
3. **`!cd` persiste.** `cd`, `cd X`, `cd -` simples (sem `&&`, `;`, pipe, `$`, glob) movem o
   diretório de trabalho **da sessão** pela mesma porta de cwd do `change_dir` (confinada às raízes
   autorizadas; `/add-dir` autoriza outra) e passam por `decide()` como `change_dir`
   (Plan nega). Atenção: o diretório da sessão é **um só** — o `!cd` também muda onde o `run_command`
   e os caminhos relativos do **agente** partem (a observação avisa o modelo). `cd x && ls` continua
   indo ao shell e **não** persiste. `export VAR=…` também não persiste: cada `!` é um shell de um
   comando só (igual ao `!` do Claude Code); para variáveis duráveis use `/secret`.
4. **Bloco enxuto.** O bloco mostra o stdout puro; `stderr` só se existir (rotulado quando há os
   dois); `exit N` só se ≠ 0. O envelope `exit=/stdout:/stderr:` continua só para o modelo, nas
   observações de `run_command`.
5. **Não é interativo.** O stdin do `!` é fechado (EOF) — não há TTY, e **não** implementamos
   handoff de terminal agora. O que **dá** para detectar e avisar (heurística, não prova): `read` no
   texto, mensagens de "preciso de terminal" no stderr (`sudo`, `docker -it`, …) e programas de tela
   cheia sem uso não interativo (`vim`, `less`, `top`, `man`, …). O bloco ganha a dica "rode em
   outro terminal". **Não detecta** um programa próprio que leia o stdin e saia calado.
6. **Dica do composer** corrigida: "roda direto, sem pedir · o agente vê a saída · !! só local"
   (a antiga — "atrás da catraca … pergunta no efeito" — contradizia este ADR).
7. **Mid-turn** o `!` não troca mais a fase do turno para `idle` (isso acordava o monitor e
   duplicava o turno).

O que **não** mudou: `decide()` segue o único seam, `deny` bloqueia, o `!` não é caminho do modelo.
Com cofre de segredos ativo, o `!` do dono exporta **todos** os segredos como env (ADR 0005).

### Testes (emenda)

`cli-core/tests/agent/bang-feed.test.ts`, `cli/tests/session/bang-alimenta-modelo.test.ts`.
