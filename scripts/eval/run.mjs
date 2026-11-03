#!/usr/bin/env node
// Eval comportamental do Aluy CLI — roda o `aluy` REAL em modo headless contra o
// provider configurado do dono e mede planejamento/delegação. NÃO roda na CI nem
// no `npm test`. Uso: `npm run eval -- --help`. Docs: scripts/eval/README.md.

import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateScenario,
  classifyOutcome,
  computeMetrics,
  parseStream,
  renderComparison,
  renderSummary,
  scoreExpectations,
} from './lib.mjs';
import { bwrapDisponivel, confinar } from './sandbox.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');

const AJUDA = `Eval comportamental do Aluy CLI

  npm run eval -- [opções]
  npm run eval -- --compare base.json novo.json

Opções:
  --entry <caminho>       aluy.js a avaliar (default: packages/cli/dist/bin/aluy.js deste checkout)
  --scenarios <a,b>       ids separados por vírgula (default: todos)
  --reps <N>              repetições por cenário (default 1)
  --timeout-s <N>         timeout por execução (default 600)
  --max-iterations <N>    teto de iterações do agente por execução (default 40)
  --max-tokens <N>        teto de tokens da sessão por execução (default: o do aluy)
  --model <slug> --provider <nome>   repassa ao aluy (default: a config local do dono)
  --sandbox               roda cada aluy dentro do bubblewrap (disco read-only, só o diretório
                          do cenário gravável) e LIGA --yolo (default dentro do sandbox)
  --no-yolo               com --sandbox, mantém o modo normal (efeitos negados em headless)
  --yolo                  auto-aprova efeitos; RECUSADO sem --sandbox (derruba a cerca do aluy)
  --self-test-sandbox     prova o confinamento (escritas fora falham + sonda ao vivo) e sai
  --rescore <json>        reavalia e re-renderiza um resultado salvo (sem rodar nada)
  --label <nome>          rótulo do resultado (ex.: main, feat-x)
  --out <dir>             saída (default scripts/eval/results/, gitignored)
  --keep                  não apaga os diretórios temporários
  --dry-run               só lista o que rodaria
  --compare <a> <b>       compara dois JSON de resultado e imprime a tabela
`;

function parseArgs(argv) {
  const o = {
    reps: 1,
    timeoutS: 600,
    maxIterations: 40,
    yolo: false,
    sandbox: false,
    noYolo: false,
    keep: false,
    dry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--entry') o.entry = v();
    else if (a === '--scenarios') o.scenarios = v().split(',').filter(Boolean);
    else if (a === '--reps') o.reps = Number(v());
    else if (a === '--timeout-s') o.timeoutS = Number(v());
    else if (a === '--max-iterations') o.maxIterations = Number(v());
    else if (a === '--max-tokens') o.maxTokens = v();
    else if (a === '--model') o.model = v();
    else if (a === '--provider') o.provider = v();
    else if (a === '--yolo') o.yolo = true;
    else if (a === '--sandbox') o.sandbox = true;
    else if (a === '--no-yolo') o.noYolo = true;
    else if (a === '--self-test-sandbox') o.selfTest = true;
    else if (a === '--rescore') o.rescore = v();
    else if (a === '--label') o.label = v();
    else if (a === '--out') o.out = v();
    else if (a === '--keep') o.keep = true;
    else if (a === '--dry-run') o.dry = true;
    else if (a === '--compare') o.compare = [v(), v()];
    else throw new Error(`opção desconhecida: ${a}`);
  }
  for (const k of ['reps', 'timeoutS', 'maxIterations']) {
    if (!Number.isInteger(o[k]) || o[k] < 1) throw new Error(`--${k} inválido`);
  }
  if (o.reps > 5) throw new Error('--reps máximo 5 (proteção de orçamento)');
  if (o.yolo && !o.sandbox)
    throw new Error(
      '--yolo recusado sem --sandbox: o --yolo do aluy derruba a cerca de workspace. ' +
        'Rode com --sandbox (bubblewrap) ou sem --yolo.',
    );
  if (o.sandbox && !o.noYolo) o.yolo = true;
  if (o.sandbox && o.noYolo) o.yolo = false;
  return o;
}

function argvDoAluy(o, prompt) {
  const a = [
    o.entry,
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--quiet',
    '--new',
    '--anonymous',
  ];
  a.push('--max-iterations', String(o.maxIterations));
  if (o.maxTokens) a.push('--max-tokens', o.maxTokens);
  if (o.model) a.push('--model', o.model);
  if (o.provider) a.push('--provider', o.provider);
  if (o.yolo) a.push('--yolo');
  return a;
}

function executar(o, cwd, prompt) {
  return new Promise((res) => {
    const t0 = Date.now();
    const cmd = [process.execPath, ...argvDoAluy(o, prompt)];
    const [bin, ...args] = o.sandbox ? confinar(cwd, cmd) : cmd;
    const filho = spawn(bin, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    filho.stdout.on('data', (d) => (out += d));
    filho.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-filho.pid, 'SIGKILL');
      } catch {
        /* já saiu */
      }
    }, o.timeoutS * 1000);
    filho.on('close', (code) => {
      clearTimeout(timer);
      res({ out, err, exitCode: code, timedOut, wallMs: Date.now() - t0 });
    });
  });
}

/** Prova o confinamento: escritas fora do diretório do cenário FALHAM, dentro funciona. */
function autoTesteSandbox(o) {
  if (!bwrapDisponivel()) throw new Error('bubblewrap (/usr/bin/bwrap) indisponível');
  const base = realpathSync(tmpdir());
  const dir = mkdtempSync(join(base, 'aluy-eval-selftest-'));
  const home = homedir();
  const sonda = join(home, 'eval-escape-probe');
  const alvos = [
    ['$HOME/eval-escape-probe', sonda],
    ['/home/aluy/projects/x', '/home/aluy/projects/x'],
    ['~/.aluy/x (real)', join(home, '.aluy', 'x')],
  ];
  const credencial = join(home, '.aluy', 'config.json');
  for (const [, p] of alvos) rmSync(p, { force: true });
  let falhas = 0;
  const tenta = (rotulo, arq, esperaSucesso) => {
    const [bin, ...args] = confinar(dir, ['/bin/sh', '-c', ': >> "$1"', 'sh', arq]);
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    const sucesso = r.status === 0;
    const ok = sucesso === esperaSucesso;
    if (!ok) falhas++;
    console.log(
      `${ok ? 'OK  ' : 'FALHA'} escrever em ${rotulo}: ${sucesso ? 'permitido' : 'bloqueado'} (esperado: ${esperaSucesso ? 'permitido' : 'bloqueado'})`,
    );
  };
  tenta('diretório do cenário', join(dir, 'ok.txt'), true);
  for (const [r, p] of alvos.slice(0, 2)) tenta(r, p, false);
  // ~/.aluy é um tmpfs descartável: a escrita "funciona" lá dentro, mas nunca chega ao real
  // (conferido logo abaixo). Os arquivos de auth montados por cima são somente-leitura.
  tenta('~/.aluy/x (tmpfs descartável; o real é conferido abaixo)', alvos[2][1], true);
  if (existsSync(credencial)) tenta('~/.aluy/config.json (ro-bind)', credencial, false);
  // O arquivo real não pode ter aparecido fora (nem o ~/.aluy/x).
  for (const [r, p] of alvos)
    if (existsSync(p)) {
      falhas++;
      console.log(`FALHA ${r} EXISTE no disco real: ${p}`);
    }
  // Sonda ao vivo: o agente real tenta escapar; o arquivo NÃO pode existir.
  if (!existsSync(o.entry)) throw new Error(`entry não existe: ${o.entry}`);
  console.log('\nsonda ao vivo: aluy --yolo pedindo `touch ' + sonda + '` dentro do sandbox...');
  const live = { ...o, sandbox: true, yolo: true, maxIterations: 6 };
  const prompt = `Execute exatamente este comando no shell e diga o resultado: touch ${sonda}`;
  const cmd = [process.execPath, ...argvDoAluy(live, prompt)];
  const [bin, ...args] = confinar(dir, cmd);
  const r = spawnSync(bin, args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const { events } = parseStream(r.stdout);
  const tools = events.filter((e) => e.type === 'tool_call').map((e) => e.name);
  console.log(`  exit=${r.status} tools=[${tools.join(',')}] eventos=${events.length}`);
  const res = [...events].reverse().find((e) => e.type === 'result');
  if (res) console.log(`  result: ${JSON.stringify(res).slice(0, 300)}`);
  if (events.length === 0) console.log(`  stderr: ${(r.stderr ?? '').slice(-300)}`);
  const existe = existsSync(sonda);
  if (existe) {
    falhas++;
    rmSync(sonda, { force: true });
  }
  console.log(
    `${existe ? 'FALHA' : 'OK  '} ${sonda} ${existe ? 'EXISTE (escapou!)' : 'não existe após a sonda'}`,
  );
  if (!tools.includes('bash'))
    console.log(
      '  aviso: o agente não chegou a chamar bash; sonda inconclusiva quanto à tentativa.',
    );
  rmSync(dir, { recursive: true, force: true });
  console.log(falhas === 0 ? '\nSANDBOX OK' : `\nSANDBOX COM ${falhas} FALHA(S)`);
  process.exitCode = falhas === 0 ? 0 : 1;
}

/** Reavalia as expectativas a partir das métricas salvas e re-renderiza. */
function reavaliar(arquivo) {
  const dados = JSON.parse(readFileSync(arquivo, 'utf8'));
  const todos = JSON.parse(readFileSync(join(AQUI, 'scenarios/scenarios.json'), 'utf8'));
  for (const s of dados.cenarios) {
    const def = todos.find((x) => x.id === s.id);
    for (const r of s.runs)
      r.checks =
        r.outcome === 'sem_cota' || r.outcome === 'erro_provider'
          ? []
          : scoreExpectations(def?.expect, r.metrics);
    s.agregado = aggregateScenario(s.runs);
  }
  const md = renderSummary(dados);
  writeFileSync(arquivo, JSON.stringify(dados, null, 2));
  writeFileSync(arquivo.replace(/\.json$/, '.md'), md);
  console.log(md);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return void console.log(AJUDA);
  if (o.rescore) return void reavaliar(o.rescore);
  if (o.selfTest) {
    o.entry = resolve(o.entry ?? join(RAIZ, 'packages/cli/dist/bin/aluy.js'));
    return void autoTesteSandbox(o);
  }
  if (o.compare) {
    const [a, b] = o.compare.map((p) => JSON.parse(readFileSync(p, 'utf8')));
    return void console.log(renderComparison(a, b));
  }
  o.entry = resolve(o.entry ?? join(RAIZ, 'packages/cli/dist/bin/aluy.js'));
  const todos = JSON.parse(readFileSync(join(AQUI, 'scenarios/scenarios.json'), 'utf8'));
  const sel = o.scenarios ? todos.filter((s) => o.scenarios.includes(s.id)) : todos;
  if (sel.length === 0) throw new Error('nenhum cenário selecionado');
  if (o.scenarios) {
    const ruins = o.scenarios.filter((id) => !todos.some((s) => s.id === id));
    if (ruins.length) throw new Error(`cenário(s) inexistente(s): ${ruins.join(', ')}`);
  }

  console.log(`aluy: ${o.entry}`);
  console.log(
    `permissão: ${o.yolo ? 'yolo CONFINADO (bwrap: só o diretório do cenário é gravável)' : 'normal (efeitos são NEGADOS em headless)'}`,
  );
  console.log(
    `execuções: ${sel.length} cenário(s) x ${o.reps} rep = ${sel.length * o.reps} (timeout ${o.timeoutS}s, max-iter ${o.maxIterations})`,
  );
  for (const s of sel) console.log(`  - ${s.id} [${s.kind}] ${s.descricao}`);
  if (o.dry) return void console.log('\n(dry-run: nada executado)');
  if (!existsSync(o.entry)) throw new Error(`entry não existe: ${o.entry} (rode npm run build)`);
  if (o.sandbox && !bwrapDisponivel()) throw new Error('--sandbox exige /usr/bin/bwrap (Linux)');
  if (typeof process.getuid === 'function' && process.getuid() === 0 && o.yolo)
    throw new Error('--yolo recusado como root');

  const resultados = {
    meta: {
      rotulo: o.label ?? 'execucao',
      entry: o.entry,
      modelo: o.model ?? null,
      permissao: o.yolo ? 'yolo-confinado' : 'normal',
      repeticoes: o.reps,
      iniciado_em: new Date().toISOString(),
      abortado: null,
    },
    cenarios: [],
  };
  const outDir = resolve(o.out ?? join(AQUI, 'results'));
  mkdirSync(outDir, { recursive: true });
  const base = realpathSync(tmpdir());

  parar: for (const s of sel) {
    const reg = { id: s.id, kind: s.kind, runs: [], agregado: null };
    resultados.cenarios.push(reg);
    for (let r = 1; r <= o.reps; r++) {
      const dir = mkdtempSync(join(base, `aluy-eval-${s.id}-`));
      cpSync(join(AQUI, 'fixtures', s.fixture), dir, { recursive: true });
      console.log(`> ${s.id} #${r} (${dir})`);
      const x = await executar(o, dir, s.prompt);
      const { events, invalidas } = parseStream(x.out);
      const outcome = classifyOutcome({
        events,
        stderr: x.err,
        exitCode: x.exitCode,
        timedOut: x.timedOut,
      });
      const metrics = computeMetrics(events, x);
      const checks =
        outcome === 'sem_cota' || outcome === 'erro_provider'
          ? []
          : scoreExpectations(s.expect, metrics);
      reg.runs.push({
        rep: r,
        outcome,
        metrics,
        checks,
        linhas_invalidas: invalidas,
        stderr_cauda: x.err.slice(-500),
      });
      console.log(
        `  ${outcome} · ${(x.wallMs / 1000).toFixed(0)}s · tools=${metrics.tool_calls_total} plan=${metrics.plan_updates} filhos=${metrics.filhos}`,
      );
      if (!o.keep) rmSync(dir, { recursive: true, force: true });
      if (outcome === 'sem_cota') {
        resultados.meta.abortado = `sem cota do provider em ${s.id} — restante não executado`;
        reg.agregado = aggregateScenario(reg.runs);
        console.error(
          `\nSEM COTA: abortando a bateria. Detalhe: ${x.err.slice(-300) || '(ver eventos error)'}`,
        );
        break parar;
      }
    }
    reg.agregado = aggregateScenario(reg.runs);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nome = `${o.label ?? 'eval'}-${stamp}`;
  writeFileSync(join(outDir, `${nome}.json`), JSON.stringify(resultados, null, 2));
  const md = renderSummary(resultados);
  writeFileSync(join(outDir, `${nome}.md`), md);
  console.log('\n' + md);
  console.log(`resultados: ${join(outDir, nome)}.{json,md}`);
  process.exitCode = resultados.meta.abortado ? 2 : 0;
}

main().catch((e) => {
  console.error(`eval: ${e.message}`);
  process.exit(1);
});
