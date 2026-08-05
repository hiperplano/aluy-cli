// ADR-0158 §5 — FIXTURE: um "aluy -p" FALSO, spawnado de VERDADE (processo FILHO
// real, via node) pelos testes de integração de `runner.ts` (`runner-workflow-*`/
// `runner-ask-espera-*`/`runner-activity-deadline-*`.test.ts) que exercitam
// `runActivityTurn`/`runOneWorkflow` de ponta a ponta — sem mockar `child_process`
// (mesma disciplina do resto do módulo) e sem precisar do binário `aluy` REAL
// compilado (que só o smoke-test spawna).
//
// O runner invoca isto como `spawn(execPath, [aluyEntrypoint, '-p', goal,
// '--output-format', 'json', '--quiet', ...])` — `execPath`/`aluyEntrypoint` são
// os pontos de injeção JÁ existentes em `RunServiceRunnerDeps` (ver runner.ts). O
// `env` do filho é `buildActivityEnv(serviceDir, activity.agent)`, que espalha
// `process.env` (o do processo de TESTE, já que `runServiceRunner` roda IN-PROCESS
// nos testes) — por isso um teste pode setar `process.env.FAKE_TURN_DEBUG_FILE`
// ANTES de chamar `runServiceRunner` e este fixture, herdando a variável, grava
// ali um registro POR INVOCAÇÃO (JSON Lines) — o único jeito de inspecionar o que
// o runner de fato mandou pro filho (goal/--max-tokens/env) sem vazar isso pros
// LOGS do runner (que só registram "ok."/"erro" no caminho de sucesso).
//
// Comportamento decidido por um MARCADOR embutido no `goal` (o texto que o runner
// monta — inclui o texto da atividade do `workflows/<nome>.md` de teste):
//   FAKE_MODE_HANG     — nunca termina sozinho — fica vivo até receber um sinal
//                        (exercita o teto/deadline e o `stop` do runner matando a
//                        atividade via `killGracefully`). Com o marcador ADICIONAL
//                        `FAKE_IGNORE_SIGTERM`, instala um handler VAZIO de
//                        SIGTERM — só morre de SIGKILL (exercita a ESCALADA
//                        completa de `killGracefully`, não só o SIGTERM inicial).
//   FAKE_MODE_GARBAGE  — imprime uma linha que NÃO é JSON válido e sai 0 (saída
//                        ilegível). Com o marcador ADICIONAL `FAKE_WRITE_STDERR`,
//                        TAMBÉM escreve em stderr — prova que o acumulador de
//                        stderr do runner é de fato capturado (sem o marcador,
//                        stderr fica vazio e o runner cai no fallback "(sem stderr)").
//   FAKE_MODE_ERROR    — imprime {"result":"...","ok":false} e sai 0 (turno com erro).
//   FAKE_MODE_CRASH    — sai com código != 0, SEM imprimir nada (crash puro).
//   [Retomando         — PRIORIDADE sobre FAKE_MODE_ASK abaixo: um turno RETOMADO
//                        (o `goal` carrega o prefixo de `formatServiceResumeInstruction`,
//                        cli-core) sempre COMPLETA com sucesso — modela o agente real
//                        recebendo a resposta do dono e prosseguindo, nunca
//                        perguntando de novo a MESMA coisa (a regra dura do ADR).
//   FAKE_MODE_ASK      — (só quando NÃO é retomada) imprime um `result` que TERMINA
//                        com "?" (aciona `awaitsUserDecision`, cli-core) e sai 0.
//   (default/FAKE_MODE_OK) — imprime {"result":"ok","ok":true} e sai 0.
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const pIndex = argv.indexOf('-p');
const goal = pIndex >= 0 ? (argv[pIndex + 1] ?? '') : '';
const maxTokensIndex = argv.indexOf('--max-tokens');
const maxTokens = maxTokensIndex >= 0 ? argv[maxTokensIndex + 1] : undefined;
// Descoberta entre serviços (`model:`) — o runner só põe `--model <slug>` no argv
// quando o service.md declara `model:` (ver runner.ts, `runActivityTurn`). Gravado
// no debug record p/ os testes provarem presença/ausência, mesmo padrão do
// `--max-tokens` acima.
const modelIndex = argv.indexOf('--model');
const model = modelIndex >= 0 ? argv[modelIndex + 1] : undefined;

const debugFile = process.env.FAKE_TURN_DEBUG_FILE;
if (debugFile !== undefined && debugFile !== '') {
  const record = {
    goal,
    maxTokens: maxTokens ?? null,
    model: model ?? null,
    aluyServiceHome: process.env.ALUY_SERVICE_HOME ?? null,
    aluyServicePersona: process.env.ALUY_SERVICE_PERSONA ?? null,
    // ADR-0158 — `workspace:` do service.md: o runner só põe
    // `ALUY_SERVICE_WORKSPACE_ROOTS` (JSON de um array de paths absolutos) quando o
    // manifesto declara `workspace:` (ver runner.ts, `buildActivityEnv`). Gravado
    // no debug record p/ os testes provarem presença/ausência, mesmo padrão de
    // `aluyServicePersona` acima.
    aluyServiceWorkspaceRoots: process.env.ALUY_SERVICE_WORKSPACE_ROOTS ?? null,
    isResume: goal.includes('[Retomando'),
    hasOwnerSay: goal.includes('aluy service attach'),
  };
  appendFileSync(debugFile, `${JSON.stringify(record)}\n`);
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (goal.includes('FAKE_MODE_HANG')) {
  if (goal.includes('FAKE_IGNORE_SIGTERM')) process.on('SIGTERM', () => {});
  setInterval(() => {}, 60_000);
} else if (goal.includes('FAKE_MODE_GARBAGE')) {
  if (goal.includes('FAKE_WRITE_STDERR')) {
    process.stderr.write('erro-fake-de-verdade-no-stderr: algo quebrou na atividade\n');
  }
  process.stdout.write('isto nao eh json valido\n');
  process.exit(0);
} else if (goal.includes('FAKE_MODE_ERROR')) {
  emit({ result: 'a atividade terminou com erro (proposital).', ok: false });
  process.exit(0);
} else if (goal.includes('FAKE_MODE_CRASH')) {
  process.exit(1);
} else if (goal.includes('[Retomando')) {
  emit({ result: 'retomei com a resposta do dono e concluí a atividade.', ok: true });
  process.exit(0);
} else if (goal.includes('FAKE_MODE_ASK')) {
  emit({ result: 'Encontrei duas opções válidas — aumento a posição agora?', ok: true });
  process.exit(0);
} else {
  emit({ result: 'ok', ok: true });
  process.exit(0);
}
