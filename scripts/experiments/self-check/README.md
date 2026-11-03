# Experimento: self-check enxuto

Mede o custo/benefício da auto-verificação (EST-0944) em quatro configurações, com
tarefas de fixture e um checker determinístico por tarefa (olha os arquivos/testes, não a
fala do modelo).

| Config | Env                                                                        |
| ------ | -------------------------------------------------------------------------- |
| A      | hoje: `ALUY_SELF_CHECK=1 ALUY_SELF_CHECK_MAX=2`                            |
| B      | 1 passada: `ALUY_SELF_CHECK_MAX=1`                                         |
| C      | pula se já verificou + 1 passada: `ALUY_SELF_CHECK_SKIP_VERIFIED=1`, MAX=1 |
| D      | desligado: `ALUY_SELF_CHECK=0`                                             |

## Tarefas

`tasks.mjs`: duas fáceis (o modelo costuma acertar e se autoverificar) e seis com
armadilha (parte do pedido fácil de esquecer, chamadores que quebram, off-by-one,
renomeação em vários arquivos, regra de spec com ordem de concatenação, casos ocultos
de um refactor).

## Rodando

```bash
npm ci && npm run build
node scripts/experiments/self-check/run.mjs --work /tmp/aluy-selfcheck-exp --out rep1.jsonl
# opções: --tasks t1-upper,t4-callers  --configs A,C  --reps 2  --timeout 420
```

- Execução SEQUENCIAL, headless (`aluy --yolo --new --anonymous -p ... --output-format stream-json`).
- **Confinamento obrigatório:** cada execução (e cada checker) roda dentro do bubblewrap: raiz
  somente leitura, `$HOME/.aluy` vira tmpfs (só `config.json`, `credentials.enc` e `mcp.json`
  entram, somente leitura) e SÓ a pasta da tarefa é gravável. O `--yolo` nunca vê o resto do disco.
- Ordem das configs rotacionada por tarefa para diluir a deriva de latência do provider.
- Passadas = eventos `self_check` do stream-json (um por rótulo "conferindo o trabalho (n/m)").
- `actedAfterProbe` = o agente chamou alguma tool depois da 1ª sonda (indício de que a
  verificação achou lacuna e ele voltou a agir).
- Para na primeira resposta 429/limite de uso.

Resultados ficam em `results/` (gitignorado): `*.jsonl` (uma linha por execução) e o
`*.ndjson` bruto de cada execução.
