// Eval comportamental — partes PURAS (sem I/O, sem rede): parse do stream-json,
// métricas, classificação de falha ("sem cota"), pontuação de expectativas,
// comparação e renderização do resumo. Testadas em lib.test.mjs com streams gravados.
//
// FATOS do stream-json do `aluy -p ... --output-format stream-json` (EST-1007,
// packages/cli/src/session/linear.ts › runHeadlessStreamJson):
//  - NDJSON no stdout; tipos: tool_call{name,status:'running'}, tool_result{name,
//    status:'done'|'error'}, text{text}, phase{phase}, error{message,status?},
//    result{result,ok,[stop,reason,limit]}.
//  - `name` é o NOME DA TOOL, exceto 3 apelidos de verbOfTool: read_file→read,
//    edit_file→edit, run_command→bash.
//  - NÃO há usage/tokens nem contador de iterações no stream; iterações são
//    aproximadas pelo nº de transições para a fase `thinking`.
//  - Sub-agentes: só o `spawn_agent` do PAI aparece (as tool-calls dos filhos não).

/** Tools de EFEITO (o stream usa os apelidos edit/bash). */
export const EFFECT_TOOLS = new Set([
  'edit',
  'edit_file',
  'write_file',
  'bash',
  'run_command',
  'change_dir',
]);
export const PLAN_TOOL = 'update_plan';
export const SPAWN_TOOL = 'spawn_agent';
export const TODO_TOOLS = new Set(['add_todo', 'done_todo', 'list_todos']);

const QUOTA_RE =
  /\b429\b|quota|rate[ _-]?limit|too many requests|insufficient[_ ](?:quota|balance|funds)|exceeded your|out of (?:credits|tokens)|sem cota|limite de (?:uso|requisi)|billing/i;

/** Converte o stdout NDJSON em eventos; linhas não-JSON são contadas, não fatais. */
export function parseStream(text) {
  const events = [];
  let invalidas = 0;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const ev = JSON.parse(line);
      if (ev !== null && typeof ev === 'object' && typeof ev.type === 'string') events.push(ev);
      else invalidas++;
    } catch {
      invalidas++;
    }
  }
  return { events, invalidas };
}

/**
 * Sequência de chamadas de tool em ordem. Conta 1 por `tool_call`; um `tool_result`
 * sem `tool_call` pendente do mesmo nome (tool instantânea cujo `running` foi
 * coalescido) também conta como uma chamada.
 */
export function toolSequence(events) {
  const seq = [];
  const pendentes = new Map();
  for (const ev of events) {
    if (ev.type === 'tool_call' && typeof ev.name === 'string') {
      seq.push(ev.name);
      pendentes.set(ev.name, (pendentes.get(ev.name) ?? 0) + 1);
    } else if (ev.type === 'tool_result' && typeof ev.name === 'string') {
      const n = pendentes.get(ev.name) ?? 0;
      if (n > 0) pendentes.set(ev.name, n - 1);
      else seq.push(ev.name);
    }
  }
  return seq;
}

/** Métricas de comportamento a partir dos eventos. */
export function computeMetrics(events, meta = {}) {
  const seq = toolSequence(events);
  const porNome = {};
  for (const n of seq) porNome[n] = (porNome[n] ?? 0) + 1;
  const iPlan = seq.indexOf(PLAN_TOOL);
  const iEfeito = seq.findIndex((n) => EFFECT_TOOLS.has(n));
  const efeitos = seq.filter((n) => EFFECT_TOOLS.has(n)).length;
  const result = [...events].reverse().find((e) => e.type === 'result');
  const iteracoes = events.filter((e) => e.type === 'phase' && e.phase === 'thinking').length;
  return {
    plan_chamado: iPlan >= 0,
    // null = não aplicável (nenhum efeito aconteceu)
    planejou_antes_do_efeito: iEfeito < 0 ? null : iPlan >= 0 && iPlan < iEfeito,
    plan_updates: porNome[PLAN_TOOL] ?? 0,
    delegou: (porNome[SPAWN_TOOL] ?? 0) > 0,
    filhos: porNome[SPAWN_TOOL] ?? 0,
    todos: seq.filter((n) => TODO_TOOLS.has(n)).length,
    efeitos,
    tool_calls_total: seq.length,
    tool_calls: porNome,
    iteracoes_aprox: iteracoes,
    tokens: null, // o stream-json não expõe usage
    wall_ms: meta.wallMs ?? null,
    exit_code: meta.exitCode ?? null,
    timeout: meta.timedOut === true,
    resultado_ok: result?.ok === true,
    parada_por_limite: result?.stop === 'limit',
    primeiras_tools: seq.slice(0, 8),
  };
}

/**
 * Classifica o desfecho: 'ok' | 'sem_cota' | 'erro_provider' | 'timeout' | 'falha'.
 * `sem_cota` NÃO é falha de comportamento do agente — aborta a bateria.
 */
export function classifyOutcome({ events, stderr = '', exitCode, timedOut }) {
  const result = [...events].reverse().find((e) => e.type === 'result');
  if (result?.ok === true && exitCode === 0) return 'ok';
  const errors = events.filter((e) => e.type === 'error');
  const alvo = [
    ...errors.map((e) => `${e.status ?? ''} ${e.message ?? ''}`),
    String(stderr),
    result?.reason ?? '',
  ].join('\n');
  if (errors.some((e) => Number(e.status) === 429) || QUOTA_RE.test(alvo)) return 'sem_cota';
  if (timedOut) return 'timeout';
  if (errors.length > 0) return 'erro_provider';
  return 'falha';
}

/**
 * Pontua expectativas do cenário contra as métricas. Chaves suportadas:
 * planBeforeEffect, planUpdatesMin, planUpdatesMax, delegated, effectsMax.
 * Devolve [{ chave, esperado, obtido, ok }].
 */
export function scoreExpectations(expect, m) {
  const out = [];
  const add = (chave, esperado, obtido, ok) => out.push({ chave, esperado, obtido, ok });
  if (!expect) return out;
  if (expect.planBeforeEffect !== undefined)
    add(
      'planBeforeEffect',
      expect.planBeforeEffect,
      m.planejou_antes_do_efeito,
      m.planejou_antes_do_efeito === expect.planBeforeEffect,
    );
  if (expect.planUpdatesMin !== undefined)
    add(
      'planUpdatesMin',
      expect.planUpdatesMin,
      m.plan_updates,
      m.plan_updates >= expect.planUpdatesMin,
    );
  if (expect.planUpdatesMax !== undefined)
    add(
      'planUpdatesMax',
      expect.planUpdatesMax,
      m.plan_updates,
      m.plan_updates <= expect.planUpdatesMax,
    );
  if (expect.delegated !== undefined)
    add('delegated', expect.delegated, m.delegou, m.delegou === expect.delegated);
  if (expect.effectsMax !== undefined)
    add('effectsMax', expect.effectsMax, m.efeitos, m.efeitos <= expect.effectsMax);
  return out;
}

/** Agrega repetições de um cenário (taxa de aprovação por chave e médias). */
export function aggregateScenario(runs) {
  const validas = runs.filter(
    (r) => r.outcome === 'ok' || r.outcome === 'falha' || r.outcome === 'timeout',
  );
  const chaves = new Map();
  for (const r of validas)
    for (const c of r.checks) {
      const a = chaves.get(c.chave) ?? { ok: 0, total: 0 };
      a.total++;
      if (c.ok) a.ok++;
      chaves.set(c.chave, a);
    }
  const media = (f) =>
    validas.length ? validas.reduce((s, r) => s + f(r), 0) / validas.length : null;
  return {
    runs: runs.length,
    validas: validas.length,
    checks: Object.fromEntries(chaves),
    aprovado: validas.length > 0 && validas.every((r) => r.checks.every((c) => c.ok)),
    plan_updates: media((r) => r.metrics.plan_updates),
    filhos: media((r) => r.metrics.filhos),
    efeitos: media((r) => r.metrics.efeitos),
    iteracoes_aprox: media((r) => r.metrics.iteracoes_aprox),
    wall_s: media((r) => (r.metrics.wall_ms ?? 0) / 1000),
  };
}

const f1 = (n) =>
  n === null || n === undefined ? '-' : Number.isInteger(n) ? String(n) : n.toFixed(1);

/** Tabela Markdown (PT-BR) de um arquivo de resultados. */
export function renderSummary(resultados) {
  const L = [];
  L.push(`# Eval comportamental — ${resultados.meta.rotulo ?? 'execução'}`);
  L.push('');
  L.push(
    `Build: \`${resultados.meta.entry}\` · modelo: ${resultados.meta.modelo ?? 'config local'} · permissão: ${resultados.meta.permissao} · repetições: ${resultados.meta.repeticoes}`,
  );
  if (resultados.meta.abortado) L.push('', `> ABORTADO: ${resultados.meta.abortado}`);
  L.push('');
  L.push(
    '| Cenário | Tipo | Resultado | Plano antes do efeito | plan_updates | Filhos | Efeitos | Iter.~ | Tempo (s) | Checagens |',
  );
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const s of resultados.cenarios) {
    const rs = s.runs;
    const outs = [...new Set(rs.map((r) => r.outcome))].join('/');
    const ag = s.agregado;
    const pa = rs
      .map((r) =>
        r.metrics.planejou_antes_do_efeito === null
          ? 'n/a'
          : r.metrics.planejou_antes_do_efeito
            ? 'sim'
            : 'não',
      )
      .join(',');
    const checks =
      Object.entries(ag.checks)
        .map(([k, v]) => `${k} ${v.ok}/${v.total}`)
        .join('; ') || '-';
    const veredito = outs.includes('sem_cota') ? 'SEM COTA' : ag.aprovado ? 'PASSOU' : 'FALHOU';
    L.push(
      `| ${s.id} | ${s.kind} | ${veredito} (${outs}) | ${pa} | ${f1(ag.plan_updates)} | ${f1(ag.filhos)} | ${f1(ag.efeitos)} | ${f1(ag.iteracoes_aprox)} | ${f1(ag.wall_s)} | ${checks} |`,
    );
  }
  L.push('');
  L.push(
    'Tokens/uso não são expostos pelo stream-json; "Iter.~" = transições para a fase `thinking`.',
  );
  return L.join('\n') + '\n';
}

/** Comparação de dois arquivos de resultados (base vs novo). */
export function compareResults(base, novo) {
  const mapa = new Map(base.cenarios.map((s) => [s.id, s]));
  const linhas = [];
  for (const n of novo.cenarios) {
    const b = mapa.get(n.id);
    linhas.push({
      id: n.id,
      kind: n.kind,
      base: b ? veredito(b) : 'ausente',
      novo: veredito(n),
      d_plan_updates: b ? delta(b.agregado.plan_updates, n.agregado.plan_updates) : null,
      d_filhos: b ? delta(b.agregado.filhos, n.agregado.filhos) : null,
      d_efeitos: b ? delta(b.agregado.efeitos, n.agregado.efeitos) : null,
      d_wall_s: b ? delta(b.agregado.wall_s, n.agregado.wall_s) : null,
    });
  }
  return linhas;
}

function veredito(s) {
  if (s.runs.some((r) => r.outcome === 'sem_cota')) return 'SEM COTA';
  if (s.runs.length === 0) return 'não rodou';
  return s.agregado.aprovado ? 'PASSOU' : 'FALHOU';
}

function delta(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return null;
  return b - a;
}

const sg = (n) => (n === null ? '-' : (n > 0 ? '+' : '') + f1(n));

export function renderComparison(base, novo) {
  const linhas = compareResults(base, novo);
  const L = [];
  L.push(`# Comparação — ${base.meta.rotulo ?? 'base'} vs ${novo.meta.rotulo ?? 'novo'}`);
  L.push('');
  L.push('| Cenário | Tipo | Base | Novo | Δ plan_updates | Δ filhos | Δ efeitos | Δ tempo (s) |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const l of linhas)
    L.push(
      `| ${l.id} | ${l.kind} | ${l.base} | ${l.novo} | ${sg(l.d_plan_updates)} | ${sg(l.d_filhos)} | ${sg(l.d_efeitos)} | ${sg(l.d_wall_s)} |`,
    );
  return L.join('\n') + '\n';
}
