#!/usr/bin/env node
// Experimento: custo/benefício do self-check (A=hoje 2 passadas, B=1, C=skip+1, D=off).
// Roda `aluy -p` HEADLESS e CONFINADO com bubblewrap (yolo só dentro da pasta da tarefa).
// Ver README.md. Resultados em ./results/ (gitignorado).
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS, setupTask } from './tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const WORK = resolve(arg('work', join(tmpdir(), 'aluy-selfcheck-exp')));
const RESULTS = join(HERE, 'results');
const only = arg('tasks', '')?.split(',').filter(Boolean);
const cfgIds = arg('configs', 'A,B,C,D').split(',');
const reps = Number(arg('reps', '1'));
const timeoutMs = Number(arg('timeout', '420')) * 1000;
const AUTH_SKIP = arg('dry', '') === '1';

// Configs: env aplicado ao processo do aluy.
const CONFIGS = {
  A: { ALUY_SELF_CHECK: '1', ALUY_SELF_CHECK_MAX: '2', ALUY_SELF_CHECK_SKIP_VERIFIED: '0' },
  B: { ALUY_SELF_CHECK: '1', ALUY_SELF_CHECK_MAX: '1', ALUY_SELF_CHECK_SKIP_VERIFIED: '0' },
  C: { ALUY_SELF_CHECK: '1', ALUY_SELF_CHECK_MAX: '1', ALUY_SELF_CHECK_SKIP_VERIFIED: '1' },
  D: { ALUY_SELF_CHECK: '0' },
};

const HOME = homedir();
function bwrap(taskdir, cmd, args, env, timeout) {
  const a = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    join(HOME, '.aluy'),
    '--ro-bind',
    join(HOME, '.aluy/config.json'),
    join(HOME, '.aluy/config.json'),
    '--ro-bind',
    join(HOME, '.aluy/credentials.enc'),
    join(HOME, '.aluy/credentials.enc'),
    '--ro-bind',
    join(HOME, '.aluy/mcp.json'),
    join(HOME, '.aluy/mcp.json'),
    '--bind',
    taskdir,
    taskdir,
    '--chdir',
    taskdir,
    '--die-with-parent',
    '--new-session',
    cmd,
    ...args,
  ];
  return spawnSync('bwrap', a, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
    maxBuffer: 64 << 20,
  });
}

mkdirSync(RESULTS, { recursive: true });
const outFile = join(RESULTS, arg('out', 'results.jsonl'));
const tasks = TASKS.filter((t) => only.length === 0 || only.includes(t.id));

function parse(stdout) {
  const ev = stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const firstProbe = ev.findIndex((e) => e.type === 'self_check');
  const passes = ev.filter((e) => e.type === 'self_check').length;
  const toolsAfterProbe =
    firstProbe < 0
      ? []
      : ev
          .slice(firstProbe)
          .filter((e) => e.type === 'tool_call')
          .map((e) => e.name);
  const tools = ev.filter((e) => e.type === 'tool_call').map((e) => e.name);
  const err = ev.find((e) => e.type === 'error');
  return { passes, tools, toolsAfterProbe, err, result: ev.find((e) => e.type === 'result') };
}

let n = 0;
for (let rep = 1; rep <= reps; rep++) {
  for (const [ti, task] of tasks.entries()) {
    // rotaciona a ordem das configs por tarefa p/ diluir deriva de latência do provider
    const order = cfgIds.map((_, i) => cfgIds[(i + ti + rep) % cfgIds.length]);
    for (const cid of order) {
      const dir = join(WORK, `${task.id}-${cid}-r${rep}`);
      rmSync(dir, { recursive: true, force: true });
      setupTask(task, dir);
      const t0 = Date.now();
      let run = { stdout: '', stderr: '', status: -1 };
      if (!AUTH_SKIP) {
        run = bwrap(
          dir,
          'node',
          [
            join(ROOT, 'packages/cli/dist/bin/aluy.js'),
            '--yolo',
            '--new',
            '--anonymous',
            '-p',
            task.prompt,
            '--output-format',
            'stream-json',
          ],
          CONFIGS[cid],
          timeoutMs,
        );
      }
      const ms = Date.now() - t0;
      writeFileSync(join(RESULTS, `${task.id}-${cid}-r${rep}.ndjson`), run.stdout ?? '');
      const p = parse(run.stdout ?? '');
      const chk = bwrap(dir, 'node', [join(HERE, 'check.mjs'), task.id, dir], {}, 90000);
      let verdict = { ok: false, detail: 'checker sem saída' };
      try {
        verdict = JSON.parse((chk.stdout ?? '').trim().split('\n').pop());
      } catch {
        /* mantém */
      }
      const row = {
        task: task.id,
        kind: task.kind,
        config: cid,
        rep,
        ms,
        status: run.status,
        correct: verdict.ok,
        detail: verdict.detail,
        passes: p.passes,
        actedAfterProbe: p.toolsAfterProbe.length > 0,
        toolsAfterProbe: p.toolsAfterProbe,
        nTools: p.tools.length,
        error: p.err?.message ?? null,
      };
      appendFileSync(outFile, JSON.stringify(row) + '\n');
      console.log(
        `${++n} ${task.id} ${cid} r${rep}: ${ms / 1000}s correct=${row.correct} passes=${row.passes} acted=${row.actedAfterProbe} ${row.error ? 'ERR ' + row.error : ''} ${row.correct ? '' : row.detail}`,
      );
      const blob = (run.stdout ?? '') + (run.stderr ?? '');
      if (/\b429\b|usage limit|rate.?limit|quota/i.test(blob) && !row.correct && p.err) {
        console.error('QUOTA/429 detectado — parando.');
        process.exit(3);
      }
    }
  }
}
if (existsSync(outFile)) console.log('ok ->', outFile);
void readFileSync;
