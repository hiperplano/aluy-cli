# Eval comportamental do Aluy CLI

Roda o `aluy` REAL em modo headless (`-p ... --output-format stream-json`) contra o
provider configurado em `~/.aluy/config.json` e mede **comportamento**: o agente
planeja (`update_plan`) antes de agir? Delega (`spawn_agent`) quando a tarefa é grande?
Fica quieto quando a tarefa é trivial? Serve para comparar prompts/modelos antes e depois.

**Não roda na CI nem no `npm test`** (só os testes das partes puras, `lib.test.mjs`,
sem rede). Cada execução real **gasta tokens do seu provider**.

## Como rodar

```bash
npm run build                                   # gera packages/cli/dist
npm run eval -- --dry-run                       # lista o que rodaria, sem gastar nada
npm run eval -- --label main                    # todos os cenários, 1 repetição
npm run eval -- --scenarios controle-pergunta   # um cenário só
npm run eval -- --reps 3 --timeout-s 900        # mais repetições (máx. 5)
npm run eval -- --entry /outro/checkout/packages/cli/dist/bin/aluy.js --label feat-x
```

Opções principais: `--entry` (qualquer build do `aluy.js`), `--scenarios a,b`, `--reps N`,
`--timeout-s N` (600), `--max-iterations N` (40), `--max-tokens N`, `--model/--provider`
(default: a config local), `--label`, `--out`, `--keep`, `--yolo`, `--dry-run`.

Saída em `scripts/eval/results/` (gitignored): `<label>-<data>.json` e `.md` (tabela PT-BR).

## Baseline vs branch

```bash
# 1) baseline (main, já buildada)
npm run eval -- --entry /caminho/main/packages/cli/dist/bin/aluy.js --label main
# 2) branch nova (buildada)
npm run eval -- --entry /caminho/branch/packages/cli/dist/bin/aluy.js --label feat-x
# 3) diferença
npm run eval -- --compare scripts/eval/results/main-*.json scripts/eval/results/feat-x-*.json
```

## Cenários (`scenarios/scenarios.json`)

4 cenários **grandes** (feature multi-parte, investigar+corrigir+testar, auditoria ampla,
refatoração) que devem gerar plano e delegação, e 2 **controles** (correção de uma linha,
pergunta simples) em que delegar seria exagero. Cada um roda numa **cópia temporária nova**
de `fixtures/mini-loja` (apagada ao fim, salvo `--keep`). Expectativas por cenário
(`expect`): `planBeforeEffect`, `planUpdatesMin/Max`, `delegated`, `effectsMax`.

## Métricas e limites do stream-json

Por execução: `planejou_antes_do_efeito`, `plan_updates`, `delegou`/`filhos`
(nº de chamadas `spawn_agent` do agente principal), `todos`, `efeitos`, chamadas por tool,
`iteracoes_aprox`, tempo, exit code.

- O stream-json só traz `tool_call`/`tool_result`/`text`/`phase`/`error`/`result`.
  **Não há tokens/usage** (aparece como `null`) nem contador de iterações — `iteracoes_aprox`
  conta transições para a fase `thinking`.
- Tool-calls dos sub-agentes **não** aparecem; só o `spawn_agent` do pai.
- Nomes: `edit_file`→`edit`, `run_command`→`bash`, `read_file`→`read`.

## "Sem cota" e falhas

HTTP 429 / mensagens de quota/rate-limit são classificados como **`sem_cota`** (não é
falha de comportamento do agente) e a bateria **aborta** na hora, sem retentar (exit 2).
Outros desfechos: `ok`, `timeout`, `erro_provider`, `falha`.

## Segurança / permissões

Em headless não há como confirmar permissão, então no modo **normal (default)** os efeitos
(edit/write/bash) são **negados**: o agente é medido pelo que _tenta_ fazer (as chamadas
aparecem no stream), mas pode não concluir a tarefa. Efeitos negados NÃO aparecem como tool-call no stream (efeitos = 0); por isso, sem efeito
visível, `planBeforeEffect` usa "chamou `update_plan`" como proxy, e cenários grandes podem
estourar o timeout (o agente fica sem poder agir). `--yolo` auto-aprova tudo, porém o
`--yolo` do aluy **derruba a cerca de workspace** (disco inteiro) — não dá para confinar ao
diretório temporário. Use `--yolo` por sua conta e risco, de preferência em VM/container.
Por segurança o harness sempre usa `--new --anonymous` (sem retomar sessão, sem gravar
transcrição nem memória) e `cwd` na cópia temporária.

## Custo

Um cenário grande pode fazer dezenas de chamadas ao modelo; a bateria completa (6 cenários)
tende a custar de dezenas a centenas de milhares de tokens. Use `--dry-run`, `--scenarios`
e os tetos (`--max-iterations`, `--max-tokens`, `--timeout-s`) para controlar.
