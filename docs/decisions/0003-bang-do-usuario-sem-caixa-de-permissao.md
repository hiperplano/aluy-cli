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
- A saída do `!cmd` realimentada ao modelo continua sendo observação não-confiável (CLI-SEC-4).
- Texto digitado pelo usuário só vira `!` por tecla dele; conteúdo ingerido (arquivo, web, MCP)
  nunca passa por `runBang`.

## Testes

`cli-core/tests/agent/bang.test.ts` (F15), `cli/tests/session/bang-controller.test.ts`.
