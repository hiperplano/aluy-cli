# Self-check enxuto: menos passadas e "pula se já verificou"

O self-check (EST-0944) liga sozinho no tier `custom`. Antes de aceitar um "pronto", o loop
injeta uma sonda e o modelo reconfere o trabalho (até `maxVerifications` passadas, **padrão 1**).
No provider medido (zai-coding/glm-5.3) cada passada custa ~10-15 s. Esta página descreve
duas opções. O número de passadas passou a **1 por padrão** (decisão do dono, F1); o "pula se já verificou" segue **opt-in**.

## Opções

| O quê                        | Env                                     | `~/.aluy/config.json` (`advanced.selfCheck`) |
| ---------------------------- | --------------------------------------- | -------------------------------------------- |
| Número de passadas (1 a 10)  | `ALUY_SELF_CHECK_MAX=1`                 | `maxVerifications`                           |
| Pula a sonda se já verificou | `ALUY_SELF_CHECK_SKIP_VERIFIED=1`       | `skipWhenVerified: true`                     |
| Liga/desliga tudo            | `ALUY_SELF_CHECK=0/1` ou `--self-check` | —                                            |

Precedência: flag/env > config > padrão.

## Padrão 1 passada e sinal honesto (F1)

Medido numa edição trivial: 1m34s / 110k tokens contra 20 s / 65k do trabalho em si, com 2 passadas.
O padrão agora é `maxVerifications = 1`; quem quer mais sobe com `ALUY_SELF_CHECK_MAX=2`.

A TUI só diz "a verificação achou pendências — corrigindo" quando a passada executa um EFEITO novo
(`VerificationLedger.isEffect`: escrita, comando não só-leitura, tool não auditável). Uma passada
que só relê/busca/roda teste passante e reconfirma é CONFIRMAÇÃO ("✓ auto-verificado").

## Regra exata do "pula se já verificou"

Implementada em `packages/cli-core/src/agent/verification-ledger.ts`. O loop registra cada
tool-call do turno; a sonda só é dispensada quando TODAS valem:

1. houve ao menos um efeito no turno (`edit_file`/`write_file` com sucesso, ou comando que
   possa alterar estado). Turno só de leitura continua sondando;
2. todo arquivo mutado foi depois **relido com sucesso** (mesmo caminho normalizado, via
   `read_file` ou `cat/head/tail/diff...`) **ou** coberto por um teste/build/lint que
   passou depois (`run_tests` exit 0, ou `run_command` com vitest/jest/pytest/eslint/tsc,
   `npm test|build|lint`, `go|cargo test`, `make test`... exit 0);
3. nenhum comando com efeito não atribuível a arquivo (rm, mv, cp, `>`, `sed -i`,
   `npm install`, tool MCP, subagente...) aconteceu depois; só um teste/build/lint passante
   posterior o cobre;
4. o último teste/build/lint não falhou (falhou: sonda; só um passante posterior limpa).

Reler OUTRO arquivo, ou o mesmo arquivo antes da última edição, não conta. Os gates
existentes (conversa pura, resposta esperando o usuário) e o cap continuam valendo.

Limite conhecido: a regra não enxerga requisito OMITIDO (pedido em várias partes em que o
agente só fez e conferiu uma; nada "sujo" sobra). Um teste verde também pode não exercitar
o arquivo editado.

## Evidência (parcial)

Experimento em `scripts/experiments/self-check/` (8 tarefas, configs A=2 passadas, B=1,
C=pula+1, D=desligado). A execução foi **interrompida por 429** do provider (compartilhado
com outros agentes) após 14 de 32 execuções; só `t1`, `t2`, `t3` fecharam as 4 configs.

| Tarefa     | A (2 passadas)               | B (1 passada)           | C (pula+1)       | D (off)   |
| ---------- | ---------------------------- | ----------------------- | ---------------- | --------- |
| t1 upper   | ok, 128 s, 2 pass            | ok, 63 s, 1 pass        | ok, 30 s, 0 pass | ok, 29 s  |
| t2 sum     | ok, 420 s (timeout, outlier) | ok, 54 s, 1 pass        | ok, 40 s, 1 pass | ok, 19 s  |
| t3 multi   | ok, 58 s, 2 pass             | ok, 56 s, 1 pass        | ok, 43 s, 1 pass | ok, 64 s  |
| t4 callers | ok, 119 s, 2 pass            | inválida (429, 0 tools) | não rodou        | não rodou |

Leitura: no caso fácil (t1, o agente já relê o arquivo) a regra pulou a sonda e economizou
~100 s contra A sem perda de correção; passar para 1 passada economizou ~65 s. Nas tarefas
de armadilha medidas, nenhuma config falhou, então **não há evidência de perda de
correção em nenhuma delas, nem de ganho da sonda** (as fixtures com armadilha de verdade,
t4 a t8, não foram medidas). Amostra de 1 repetição, confiança baixa. O padrão NÃO foi
alterado. Para concluir, rodar o restante: `node scripts/experiments/self-check/run.mjs
--tasks t4-callers,t5-paginate,t6-rename-config,t7-fizzbazz,t8-slugify` quando o provider
tiver folga.
