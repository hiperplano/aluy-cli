#!/usr/bin/env node
// Eval comportamental do Aluy CLI — roda o `aluy` REAL em modo headless contra o
// provider configurado do dono e mede planejamento/delegação. NÃO roda na CI nem
// no `npm test`. Uso: `npm run eval -- --help`. Docs: scripts/eval/README.md.

import { spawn } from 'node:child_process';
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
import { tmpdir } from 'node:os';
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
  --yolo                  auto-aprova efeitos (⚠ NÃO é confinado ao diretório; ver README)
  --label <nome>          rótulo do resultado (ex.: main, feat-x)
  --out <dir>             saída (default scripts/eval/results/, gitignored)
  --keep                  não apaga os diretórios temporários
  --dry-run               só lista o que rodaria
  --compare <a> <b>       compara dois JSON de resultado e imprime a tabela
`;

function parseArgs(argv) {
  const o = { reps: 1, timeoutS: 600, maxIterations: 40, yolo: false, keep: false, dry: false };
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
    const filho = spawn(process.execPath, argvDoAluy(o, prompt), {
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

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return void console.log(AJUDA);
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
    `permissão: ${o.yolo ? 'yolo (sem confinamento!)' : 'normal (efeitos são NEGADOS em headless)'}`,
  );
  console.log(
    `execuções: ${sel.length} cenário(s) x ${o.reps} rep = ${sel.length * o.reps} (timeout ${o.timeoutS}s, max-iter ${o.maxIterations})`,
  );
  for (const s of sel) console.log(`  - ${s.id} [${s.kind}] ${s.descricao}`);
  if (o.dry) return void console.log('\n(dry-run: nada executado)');
  if (!existsSync(o.entry)) throw new Error(`entry não existe: ${o.entry} (rode npm run build)`);
  if (typeof process.getuid === 'function' && process.getuid() === 0 && o.yolo)
    throw new Error('--yolo recusado como root');

  const resultados = {
    meta: {
      rotulo: o.label ?? 'execucao',
      entry: o.entry,
      modelo: o.model ?? null,
      permissao: o.yolo ? 'yolo' : 'normal',
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
