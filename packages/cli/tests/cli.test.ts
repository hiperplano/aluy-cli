import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseArgs, versionText, suggestFlag } from '../src/cli.js';

/** Helper: extrai unknownFlags de uma ação launch. */
function unknownOf(argv: string[]): readonly string[] {
  const a = parseArgs(argv);
  return a.kind === 'launch' ? (a.unknownFlags ?? []) : [];
}

describe('F109 — flag desconhecida (typo) é detectada, não ignorada em silêncio', () => {
  it('typo de flag de SEGURANÇA (--plna) é detectado com sugestão', () => {
    expect(unknownOf(['--plna', '-p', 'oi'])).toEqual(['--plna']);
    expect(suggestFlag('plna')).toBe('plan');
  });

  it('typo de --backedn sugere --backend', () => {
    expect(unknownOf(['--backedn', 'local'])).toEqual(['--backedn']);
    expect(suggestFlag('backedn')).toBe('backend');
  });

  it('flags VÁLIDAS (inline e separadas) NÃO disparam', () => {
    expect(unknownOf(['--plan', '--dense', '--no-budget', '--autocompact-at=0.9'])).toEqual([]);
    expect(
      unknownOf(['--yolo', '--tier', 'sonnet', '--backend', 'local', '--max-iterations', '5']),
    ).toEqual([]);
  });

  it('o PROMPT de -p/--print/--exec começando com `--` NÃO é falso-positivo', () => {
    expect(unknownOf(['-p', '--isto-é-prompt'])).toEqual([]);
    expect(unknownOf(['--print', '--outro-prompt'])).toEqual([]);
  });

  it('VALOR de flag separada começando com `--` não é flag (ex.: --model/--tier/--effort)', () => {
    expect(unknownOf(['--model', '--algum-slug'])).toEqual([]);
    expect(unknownOf(['--tier', '--x'])).toEqual([]);
    expect(unknownOf(['--effort', '--alto'])).toEqual([]);
  });

  it('tudo após o separador `--` é posicional (não checado)', () => {
    expect(unknownOf(['oi', '--', '--literal'])).toEqual([]);
  });

  it('TODAS as flags REAIS de launch não disparam (known-set em sync com o parser)', () => {
    // Lista curada das flags que o caminho de LAUNCH reconhece (não as menções do HELP a
    // flags do Claude tipo `--dangerously-skip-permissions`, nem flags só-de-subcomando).
    const launchFlags = [
      '--plan',
      '--yolo',
      '--unsafe',
      '--dense',
      '--fullscreen',
      '--split',
      '--ascii',
      '--quiet',
      '--cycle',
      '--new',
      '--continue',
      '--resume',
      '--no-budget',
      '--budget',
      '--no-autocompact',
      '--no-self-check',
      '--self-check',
      '--no-subagent',
      '--no-subagents',
      '--tier',
      '--model',
      '--provider',
      '--effort',
      '--backend',
      '--lang',
      '--output-format',
      '--max-tokens',
      '--max-iterations',
      '--max-output-tokens',
      '--autocompact-at',
      '--cycles',
      '--cycle-for',
      '--local-provider',
      '--local-model',
      '--local-auth',
      '--local-base-url',
      '--view',
      '--cockpit',
    ];
    for (const f of launchFlags) {
      expect(unknownOf([f]), `flag REAL de launch ${f} foi tida como desconhecida`).toEqual([]);
    }
  });
});

describe('parseArgs', () => {
  it('-v / --version resolvem para version', () => {
    expect(parseArgs(['-v']).kind).toBe('version');
    expect(parseArgs(['--version']).kind).toBe('version');
  });

  it('-h / --help resolvem para help', () => {
    expect(parseArgs(['-h']).kind).toBe('help');
    expect(parseArgs(['--help']).kind).toBe('help');
  });

  it('sem argumentos -> launch (TUI)', () => {
    expect(parseArgs([]).kind).toBe('launch');
  });

  it('version precede launch quando ambos pareceriam aplicar', () => {
    expect(parseArgs(['--version', 'algo']).kind).toBe('version');
  });

  it('EST-0970 — `doctor` roteia p/ o health-check (não vira launch/goal)', () => {
    const a = parseArgs(['doctor']);
    expect(a.kind).toBe('doctor');
    if (a.kind === 'doctor') expect(a.deep).toBe(false); // sem --deep ⇒ NÃO gasta modelo
  });

  it('EST-0970 — `doctor --deep`/`--test` ligam o teste do tier ao vivo (opt-in)', () => {
    const deep = parseArgs(['doctor', '--deep']);
    expect(deep.kind === 'doctor' && deep.deep).toBe(true);
    const test = parseArgs(['doctor', '--test']);
    expect(test.kind === 'doctor' && test.deep).toBe(true);
  });

  it('EST-0970 — `doctor --help` cai no help geral (subcomando sem flags próprias)', () => {
    expect(parseArgs(['doctor', '--help']).kind).toBe('help');
  });

  it('EST-0970 — HELP_TEXT documenta o `aluy doctor`', () => {
    expect(HELP_TEXT).toContain('doctor');
  });

  it('EST-0977 — `agents` roteia p/ a listagem de perfis .md (não vira launch/goal)', () => {
    expect(parseArgs(['agents']).kind).toBe('agents');
  });

  it('EST-0977 — `agents --help` cai no help geral (subcomando sem flags próprias)', () => {
    expect(parseArgs(['agents', '--help']).kind).toBe('help');
    expect(parseArgs(['agents', '-h']).kind).toBe('help');
  });

  it('EST-0977 — HELP_TEXT documenta o `aluy agents`', () => {
    expect(HELP_TEXT).toContain('agents');
  });

  it('EST-1116 — `models` roteia p/ a listagem (scope both, view models, sem json)', () => {
    const a = parseArgs(['models']);
    expect(a.kind).toBe('models');
    if (a.kind === 'models') {
      expect(a.scope).toBe('both');
      expect(a.which).toBe('models');
      expect(a.json).toBe(false);
    }
  });

  it('EST-1116 — `providers` é a MESMA ação com which=providers', () => {
    const a = parseArgs(['providers']);
    expect(a.kind).toBe('models');
    if (a.kind === 'models') expect(a.which).toBe('providers');
  });

  it('EST-1116 — `--backend local|broker` foca a seção; valor inválido ⇒ both', () => {
    const local = parseArgs(['models', '--backend', 'local']);
    const broker = parseArgs(['models', '--backend=broker']);
    const bad = parseArgs(['models', '--backend', 'xpto']);
    if (local.kind === 'models') expect(local.scope).toBe('local');
    if (broker.kind === 'models') expect(broker.scope).toBe('broker');
    if (bad.kind === 'models') expect(bad.scope).toBe('both');
  });

  it('EST-1116 — `--json` liga o modo script', () => {
    const a = parseArgs(['models', '--json']);
    if (a.kind === 'models') expect(a.json).toBe(true);
  });

  it('EST-1116 — `models --help` cai no help geral', () => {
    expect(parseArgs(['models', '--help']).kind).toBe('help');
    expect(parseArgs(['providers', '-h']).kind).toBe('help');
  });

  it('EST-1116 — HELP_TEXT documenta `aluy models`/`aluy providers`', () => {
    expect(HELP_TEXT).toContain('models');
    expect(HELP_TEXT).toContain('providers');
  });

  it('EST-0970 — `mcp …` roteia p/ o runner com o argv cru (sem o `mcp`)', () => {
    const a = parseArgs(['mcp', 'add', 'foo', 'npx', '--env', 'K=V']);
    expect(a.kind).toBe('mcp');
    if (a.kind === 'mcp') expect(a.argv).toEqual(['add', 'foo', 'npx', '--env', 'K=V']);
  });

  it('EST-0970 — `mcp --help` NÃO cai no help geral (vai ao runner do mcp)', () => {
    const a = parseArgs(['mcp', '--help']);
    expect(a.kind).toBe('mcp');
    if (a.kind === 'mcp') expect(a.argv).toEqual(['--help']);
  });

  // EST-0959 — `--yolo` é o nome OFICIAL do bypass (decisão de produto do Tiago);
  // `--unsafe` segue como ALIAS deprecado, idêntico (compat de script).
  it('--yolo liga a flag de bypass no launch (nome OFICIAL, sem aviso de alias)', () => {
    const a = parseArgs(['--yolo']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.mode).toBe('unsafe'); // o identificador INTERNO continua `'unsafe'`
      expect(a.unsafe).toBe(true);
      expect(a.unsafeAliasUsed).toBe(false);
    }
  });

  it('--unsafe AINDA funciona (alias deprecado de --yolo, idêntico) e marca o aviso', () => {
    const a = parseArgs(['--unsafe']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.mode).toBe('unsafe');
      expect(a.unsafe).toBe(true);
      expect(a.unsafeAliasUsed).toBe(true); // o binário avisa "agora é --yolo"
    }
  });

  it('launch sem --yolo/--unsafe ⇒ unsafe=false (default seguro)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') {
      expect(a.unsafe).toBe(false);
      expect(a.unsafeAliasUsed).toBe(false);
    }
  });

  it('--yolo + objetivo posicional: liga o bypass e captura o objetivo', () => {
    const a = parseArgs(['--yolo', 'faça x']);
    if (a.kind === 'launch') {
      expect(a.unsafe).toBe(true);
      expect(a.goal).toBe('faça x');
    }
  });

  // EST-0969 · ADR-0057 — sub-agentes paralelos: LIGADO por padrão; opt-out.
  it('launch sem flag ⇒ subAgents=true (sub-agentes paralelos ligados por padrão)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.subAgents).toBe(true);
  });

  it('--no-subagents DESLIGA os sub-agentes paralelos (modo mono-agente)', () => {
    const a = parseArgs(['--no-subagents']);
    if (a.kind === 'launch') expect(a.subAgents).toBe(false);
  });

  it('EST-0984 — launch sem flag ⇒ safeGlyphs=false; `--ascii` liga o perfil seguro', () => {
    const off = parseArgs([]);
    if (off.kind === 'launch') expect(off.safeGlyphs).toBe(false);
    const on = parseArgs(['--ascii']);
    if (on.kind === 'launch') expect(on.safeGlyphs).toBe(true);
  });

  it('EST-0990 — sem flag ⇒ split UNDEFINED (cai na pref); `--split`/`--view` ⇒ true', () => {
    const off = parseArgs([]);
    if (off.kind === 'launch') expect(off.split).toBeUndefined();
    const split = parseArgs(['--split']);
    if (split.kind === 'launch') expect(split.split).toBe(true);
    const view = parseArgs(['--view']);
    if (view.kind === 'launch') expect(view.split).toBe(true);
    // `--split` não engole o objetivo posicional.
    const withGoal = parseArgs(['--split', 'rode os testes']);
    if (withGoal.kind === 'launch') {
      expect(withGoal.split).toBe(true);
      expect(withGoal.goal).toBe('rode os testes');
    }
  });

  it('EST-1000 — sem flag ⇒ fullscreen UNDEFINED (cai na pref); `--fullscreen`/`--cockpit` ⇒ true', () => {
    const off = parseArgs([]);
    if (off.kind === 'launch') expect(off.fullscreen).toBeUndefined();
    const fs = parseArgs(['--fullscreen']);
    if (fs.kind === 'launch') expect(fs.fullscreen).toBe(true);
    const cockpit = parseArgs(['--cockpit']);
    if (cockpit.kind === 'launch') expect(cockpit.fullscreen).toBe(true);
    // `--fullscreen` não engole o objetivo posicional.
    const withGoal = parseArgs(['--fullscreen', 'rode os testes']);
    if (withGoal.kind === 'launch') {
      expect(withGoal.fullscreen).toBe(true);
      expect(withGoal.goal).toBe('rode os testes');
    }
  });

  it('EST-1000 — --fullscreen aparece no help', () => {
    expect(HELP_TEXT).toContain('--fullscreen');
    expect(HELP_TEXT).toContain('MODO COCKPIT');
  });

  it('--yolo + objetivo continua com sub-agentes ligados (independem do modo)', () => {
    const a = parseArgs(['--yolo', 'pesquise 3 linguagens em paralelo']);
    if (a.kind === 'launch') {
      expect(a.unsafe).toBe(true);
      expect(a.subAgents).toBe(true);
    }
  });

  it('EST-0944 — sem flag ⇒ selfCheck undefined (cai em env/tier no wiring)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.selfCheck).toBeUndefined();
  });

  it('EST-0944 — --self-check força ON (`1`); --no-self-check força OFF (`0`)', () => {
    const on = parseArgs(['--self-check']);
    if (on.kind === 'launch') expect(on.selfCheck).toBe('1');
    const off = parseArgs(['--no-self-check']);
    if (off.kind === 'launch') expect(off.selfCheck).toBe('0');
  });

  it('EST-0944 — --no-self-check VENCE --self-check (desligar é o lado seguro)', () => {
    const a = parseArgs(['--self-check', '--no-self-check']);
    if (a.kind === 'launch') expect(a.selfCheck).toBe('0');
  });

  it('EST-0944 — HELP menciona o self-check', () => {
    expect(HELP_TEXT).toContain('--self-check');
    expect(HELP_TEXT).toContain('ALUY_SELF_CHECK');
  });

  // EST-0973 — AUTO-COMPACTAÇÃO da janela (`--autocompact-at <razão|%|off>`).
  it('EST-0973 — sem flag ⇒ autoCompactAt undefined (cai em env/default no controller)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.autoCompactAt).toBeUndefined();
  });

  it('EST-0973 — --autocompact-at <v> (separado) e =<v> capturam o valor cru', () => {
    const sep = parseArgs(['--autocompact-at', '0.9']);
    if (sep.kind === 'launch') expect(sep.autoCompactAt).toBe('0.9');
    const eq = parseArgs(['--autocompact-at=85']);
    if (eq.kind === 'launch') expect(eq.autoCompactAt).toBe('85');
  });

  it('EST-0973 — --no-autocompact é açúcar p/ off', () => {
    const a = parseArgs(['--no-autocompact']);
    if (a.kind === 'launch') expect(a.autoCompactAt).toBe('off');
  });

  it('EST-0973 — o VALOR de --autocompact-at não é confundido com o objetivo posicional', () => {
    const a = parseArgs(['--autocompact-at', '0.9', 'explore o repo']);
    if (a.kind === 'launch') {
      expect(a.autoCompactAt).toBe('0.9');
      expect(a.goal).toBe('explore o repo');
    }
  });

  it('EST-0973 — HELP menciona a auto-compactação', () => {
    expect(HELP_TEXT).toContain('--autocompact-at');
    expect(HELP_TEXT).toContain('ALUY_AUTOCOMPACT_AT');
  });

  // EST-0959 · ADR-0055 — eixo de MODO (`--plan`/`--yolo` = mesmo eixo).
  it('launch sem flag de modo ⇒ mode=normal (default seguro)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') {
      expect(a.mode).toBe('normal');
      expect(a.unsafe).toBe(false);
    }
  });

  it('--plan ⇒ mode=plan (e unsafe derivado = false)', () => {
    const a = parseArgs(['--plan']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.mode).toBe('plan');
      expect(a.unsafe).toBe(false);
    }
  });

  it('--yolo ⇒ mode=unsafe (e unsafe derivado = true)', () => {
    const a = parseArgs(['--yolo']);
    if (a.kind === 'launch') {
      expect(a.mode).toBe('unsafe');
      expect(a.unsafe).toBe(true);
    }
  });

  it('--yolo e --unsafe produzem o MESMO launch (alias idêntico, fora o aviso)', () => {
    const yolo = parseArgs(['--yolo']);
    const alias = parseArgs(['--unsafe']);
    if (yolo.kind === 'launch' && alias.kind === 'launch') {
      expect({ ...alias, unsafeAliasUsed: false }).toEqual(yolo);
    }
  });

  it('--plan + --yolo juntos ⇒ Plan VENCE (read-only é o teto; ADR-0055 não regride)', () => {
    const a = parseArgs(['--plan', '--yolo']);
    if (a.kind === 'launch') {
      expect(a.mode).toBe('plan');
      expect(a.unsafe).toBe(false); // o bypass NÃO sobrevive ao plan
    }
  });

  it('--plan + --unsafe (alias) juntos ⇒ Plan VENCE igualmente', () => {
    const a = parseArgs(['--plan', '--unsafe']);
    if (a.kind === 'launch') {
      expect(a.mode).toBe('plan');
      expect(a.unsafe).toBe(false); // unsafe NÃO sobrevive ao plan
    }
  });

  it('--plan + objetivo posicional: liga Plan e captura o objetivo', () => {
    const a = parseArgs(['--plan', 'planeje o refactor']);
    if (a.kind === 'launch') {
      expect(a.mode).toBe('plan');
      expect(a.goal).toBe('planeje o refactor');
    }
  });

  // EST-0962 — `--tier <x>` (tier inicial; troca em runtime pelo /model).
  it('--tier <x> captura o tier inicial', () => {
    const a = parseArgs(['--tier', 'aluy-deep']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.tier).toBe('aluy-deep');
  });

  it('--tier=<x> (forma com igual) também é aceito', () => {
    const a = parseArgs(['--tier=aluy-strata']);
    if (a.kind === 'launch') expect(a.tier).toBe('aluy-strata');
  });

  it('sem --tier ⇒ tier ausente (default do wiring)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.tier).toBeUndefined();
  });

  it('o VALOR de --tier não é confundido com o objetivo posicional', () => {
    const a = parseArgs(['--tier', 'aluy-deep', 'faça x']);
    if (a.kind === 'launch') {
      expect(a.tier).toBe('aluy-deep');
      expect(a.goal).toBe('faça x');
    }
  });

  // EST-0948 — `--max-tokens N` (teto de tokens da sessão; cru aqui, o wiring resolve).
  it('--max-tokens <N> captura o teto cru', () => {
    const a = parseArgs(['--max-tokens', '500000']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.maxTokens).toBe('500000');
  });

  it('--max-tokens=<N> (forma com igual) também é aceito', () => {
    const a = parseArgs(['--max-tokens=2000000']);
    if (a.kind === 'launch') expect(a.maxTokens).toBe('2000000');
  });

  it('sem --max-tokens ⇒ ausente (default/env no wiring)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.maxTokens).toBeUndefined();
  });

  it('o VALOR de --max-tokens não é confundido com o objetivo posicional', () => {
    const a = parseArgs(['--max-tokens', '500000', 'faça x']);
    if (a.kind === 'launch') {
      expect(a.maxTokens).toBe('500000');
      expect(a.goal).toBe('faça x');
    }
  });

  it('--max-tokens=<N> + objetivo posicional convivem', () => {
    const a = parseArgs(['--max-tokens=999999', 'pesquise algo']);
    if (a.kind === 'launch') {
      expect(a.maxTokens).toBe('999999');
      expect(a.goal).toBe('pesquise algo');
    }
  });

  // EST-0948 — `--max-iterations N` (teto de iterações; cru aqui, o wiring resolve).
  it('--max-iterations <N> captura o teto cru', () => {
    const a = parseArgs(['--max-iterations', '500']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.maxIterations).toBe('500');
  });

  it('--max-iterations=<N> (forma com igual) também é aceito', () => {
    const a = parseArgs(['--max-iterations=1000']);
    if (a.kind === 'launch') expect(a.maxIterations).toBe('1000');
  });

  it('sem --max-iterations ⇒ ausente (default/env no wiring)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.maxIterations).toBeUndefined();
  });

  it('o VALOR de --max-iterations não é confundido com o objetivo posicional', () => {
    const a = parseArgs(['--max-iterations', '500', 'faça x']);
    if (a.kind === 'launch') {
      expect(a.maxIterations).toBe('500');
      expect(a.goal).toBe('faça x');
    }
  });

  it('--max-iterations e --max-tokens convivem (ambos cruzam sem colidir)', () => {
    const a = parseArgs(['--max-iterations', '400', '--max-tokens', '900000', 'crie páginas']);
    if (a.kind === 'launch') {
      expect(a.maxIterations).toBe('400');
      expect(a.maxTokens).toBe('900000');
      expect(a.goal).toBe('crie páginas');
    }
  });

  // EST-0948 — `--max-output-tokens N` (max_tokens de OUTPUT por chamada; cru aqui, o
  // wiring resolve flag>env>UNSET). DISTINTO do budget local `--max-tokens`.
  it('--max-output-tokens <N> captura o valor cru', () => {
    const a = parseArgs(['--max-output-tokens', '16384']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.maxOutputTokens).toBe('16384');
  });

  it('--max-output-tokens=<N> (forma com igual) também é aceito', () => {
    const a = parseArgs(['--max-output-tokens=32768']);
    if (a.kind === 'launch') expect(a.maxOutputTokens).toBe('32768');
  });

  it('sem --max-output-tokens ⇒ ausente (UNSET/env no wiring; broker decide)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.maxOutputTokens).toBeUndefined();
  });

  it('o VALOR de --max-output-tokens não é confundido com o objetivo posicional', () => {
    const a = parseArgs(['--max-output-tokens', '16384', 'crie um HTML grande']);
    if (a.kind === 'launch') {
      expect(a.maxOutputTokens).toBe('16384');
      expect(a.goal).toBe('crie um HTML grande');
    }
  });

  it('--max-output-tokens NÃO colide com --max-tokens (budget local) — eixos distintos', () => {
    const a = parseArgs(['--max-tokens', '900000', '--max-output-tokens', '16384', 'faça x']);
    if (a.kind === 'launch') {
      expect(a.maxTokens).toBe('900000'); // budget LOCAL acumulado da sessão
      expect(a.maxOutputTokens).toBe('16384'); // OUTPUT por chamada
      expect(a.goal).toBe('faça x');
    }
  });

  // EST-1007 — MODO HEADLESS one-shot (`-p`/`--print`/`--exec`).
  it('-p liga o modo headless e captura o prompt inline (`-p "x"`)', () => {
    const a = parseArgs(['-p', 'ola mundo']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.print).toBe(true);
      expect(a.printArg).toBe('ola mundo');
      expect(a.goal).toBeUndefined(); // o prompt inline NÃO vira objetivo posicional.
    }
  });

  it('--print e --exec são aliases de -p (mesmo print:true + printArg)', () => {
    const p = parseArgs(['--print', 'x']);
    const e = parseArgs(['--exec', 'x']);
    if (p.kind === 'launch') {
      expect(p.print).toBe(true);
      expect(p.printArg).toBe('x');
    }
    if (e.kind === 'launch') {
      expect(e.print).toBe(true);
      expect(e.printArg).toBe('x');
    }
  });

  it('-p SEM valor inline ⇒ print:true, printArg ausente (o binário lê o stdin)', () => {
    const a = parseArgs(['-p']);
    if (a.kind === 'launch') {
      expect(a.print).toBe(true);
      expect(a.printArg).toBeUndefined();
      expect(a.goal).toBeUndefined();
    }
  });

  it('-p + objetivo POSICIONAL ⇒ print:true e o goal posicional (3ª forma do prompt)', () => {
    const a = parseArgs(['ola', '-p']);
    if (a.kind === 'launch') {
      expect(a.print).toBe(true);
      expect(a.printArg).toBeUndefined();
      expect(a.goal).toBe('ola'); // o binário usa o posicional como prompt.
    }
  });

  it('-p=inline e --print=inline (forma com igual) capturam o prompt', () => {
    const a = parseArgs(['-p=inline']);
    const b = parseArgs(['--print=inline']);
    if (a.kind === 'launch') expect(a.printArg).toBe('inline');
    if (b.kind === 'launch') expect(b.printArg).toBe('inline');
  });

  it('sem -p ⇒ print:false (modo TUI normal)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.print).toBe(false);
  });

  it('--output-format json só é capturado sob -p; ignorado sem -p', () => {
    const withP = parseArgs(['-p', 'x', '--output-format', 'json']);
    if (withP.kind === 'launch') {
      expect(withP.outputFormat).toBe('json');
      expect(withP.printArg).toBe('x');
    }
    const noP = parseArgs(['--output-format', 'json']);
    if (noP.kind === 'launch') expect(noP.outputFormat).toBeUndefined();
  });

  // EST-1007 · EST-0962 · HG-2 — `--model <slug>` (modelo CUSTOM direto).
  it('--model <slug> captura o slug (HG-2: só o slug, é DADO não credencial)', () => {
    const a = parseArgs(['--model', 'xiaomi/mimo-v2.5']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.model).toBe('xiaomi/mimo-v2.5');
  });

  it('--model=<slug> (forma com igual) também é aceito', () => {
    const a = parseArgs(['--model=acme/foo-v1']);
    if (a.kind === 'launch') expect(a.model).toBe('acme/foo-v1');
  });

  it('o VALOR de --model não é confundido com o objetivo posicional', () => {
    const a = parseArgs(['--model', 'xiaomi/mimo-v2.5', 'faça x']);
    if (a.kind === 'launch') {
      expect(a.model).toBe('xiaomi/mimo-v2.5');
      expect(a.goal).toBe('faça x');
    }
  });

  it('--model + -p convivem (o slug e o prompt não colidem)', () => {
    const a = parseArgs(['--model', 'xiaomi/mimo-v2.5', '-p', 'faça x']);
    if (a.kind === 'launch') {
      expect(a.model).toBe('xiaomi/mimo-v2.5');
      expect(a.print).toBe(true);
      expect(a.printArg).toBe('faça x');
    }
  });

  it('--model NÃO expõe provider nem api-key — só o slug sai (HG-2/CLI-SEC-7)', () => {
    const a = parseArgs(['--model', 'xiaomi/mimo-v2.5']);
    if (a.kind === 'launch') {
      expect(a.model).toBe('xiaomi/mimo-v2.5');
      // nenhuma chave parecida com credencial existe no objeto de launch.
      expect(JSON.stringify(a)).not.toMatch(/api[_-]?key|secret|provider|credential/i);
    }
  });

  // EST-0962 · HG-2/CLI-SEC-7/PROV-SEC-5 — `--provider <name>` (em par com `--model`).
  it('--provider <name> + --model captura o NOME do provider (par com o slug)', () => {
    const a = parseArgs(['--provider', 'deepseek', '--model', 'deepseek-v4-pro']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.provider).toBe('deepseek');
      expect(a.model).toBe('deepseek-v4-pro');
    }
  });

  it('--provider=<name> (forma com igual) também é aceito, em par com --model', () => {
    const a = parseArgs(['--provider=deepseek', '--model=deepseek-v4-pro']);
    if (a.kind === 'launch') {
      expect(a.provider).toBe('deepseek');
      expect(a.model).toBe('deepseek-v4-pro');
    }
  });

  it('o VALOR de --provider não é confundido com o objetivo posicional', () => {
    const a = parseArgs(['--provider', 'deepseek', '--model', 'deepseek-v4-pro', 'faça x']);
    if (a.kind === 'launch') {
      expect(a.provider).toBe('deepseek');
      expect(a.model).toBe('deepseek-v4-pro');
      expect(a.goal).toBe('faça x');
    }
  });

  it('SEM --provider ⇒ o campo não existe (retrocompat — nada muda)', () => {
    const a = parseArgs(['--model', 'deepseek-v4-pro']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.provider).toBeUndefined();
      expect('provider' in a).toBe(false);
    }
  });

  it('--provider SOZINHO (sem --model) ⇒ ERRO DE USO (exit≠0, não monta sessão)', () => {
    const a = parseArgs(['--provider', 'deepseek']);
    expect(a.kind).toBe('usage-error');
    if (a.kind === 'usage-error') {
      expect(a.exitCode).not.toBe(0);
      expect(a.message).toMatch(/--provider/);
      expect(a.message).toMatch(/--model/);
    }
  });

  it('--provider=<name> SOZINHO (forma com igual, sem --model) ⇒ ERRO DE USO', () => {
    const a = parseArgs(['--provider=deepseek']);
    expect(a.kind).toBe('usage-error');
  });

  it('--provider só carrega o NOME — nunca api-key/base_url (HG-2/CLI-SEC-7)', () => {
    const a = parseArgs(['--provider', 'deepseek', '--model', 'deepseek-v4-pro']);
    if (a.kind === 'launch') {
      expect(JSON.stringify(a)).not.toMatch(/api[_-]?key|secret|base[_-]?url|credential/i);
    }
  });

  // HUNT-CATALOG (roteamento) — `--tier custom` NU (sem `--model`) era um beco-sem-saída:
  // saía `tier:custom` sem slug ⇒ 422 tardio do broker (falha confusa, longe da causa).
  // Agora recusa CEDO e EXPLÍCITO (espelha `--provider` sem `--model`). Cada teste FALHA
  // sem o guard (antes era `launch` com tier:'custom' sem model).
  it('--tier custom SOZINHO (sem --model) ⇒ ERRO DE USO (exit≠0, não monta sessão)', () => {
    const a = parseArgs(['--tier', 'custom']);
    expect(a.kind).toBe('usage-error');
    if (a.kind === 'usage-error') {
      expect(a.exitCode).not.toBe(0);
      expect(a.message).toMatch(/--tier custom/);
      expect(a.message).toMatch(/--model/);
    }
  });

  it('--tier=custom (forma com igual) SOZINHO ⇒ ERRO DE USO', () => {
    const a = parseArgs(['--tier=custom']);
    expect(a.kind).toBe('usage-error');
  });

  it('--tier CUSTOM (maiúsculo) SOZINHO ⇒ ERRO DE USO (case-insensitive)', () => {
    const a = parseArgs(['--tier', 'CUSTOM']);
    expect(a.kind).toBe('usage-error');
  });

  it('--tier custom COM --model ⇒ OK (a via Custom tem o slug)', () => {
    const a = parseArgs(['--tier', 'custom', '--model', 'deepseek-v4-pro']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.model).toBe('deepseek-v4-pro');
    }
  });

  it('--tier canônico SOZINHO (sem --model) ⇒ OK (só custom exige slug)', () => {
    const a = parseArgs(['--tier', 'aluy-strata']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.tier).toBe('aluy-strata');
  });

  it('os três tetos convivem (--max-iterations + --max-tokens + --max-output-tokens)', () => {
    const a = parseArgs([
      '--max-iterations',
      '400',
      '--max-tokens',
      '900000',
      '--max-output-tokens',
      '16384',
      'crie páginas',
    ]);
    if (a.kind === 'launch') {
      expect(a.maxIterations).toBe('400');
      expect(a.maxTokens).toBe('900000');
      expect(a.maxOutputTokens).toBe('16384');
      expect(a.goal).toBe('crie páginas');
    }
  });

  // EST-0989 (i18n) — `--lang pt-BR|en`.
  it('--lang en captura o idioma (forma separada)', () => {
    const a = parseArgs(['--lang', 'en']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.lang).toBe('en');
  });

  it('--lang=pt-BR captura o idioma (forma com =)', () => {
    const a = parseArgs(['--lang=pt-BR']);
    if (a.kind === 'launch') expect(a.lang).toBe('pt-BR');
  });

  it('sem --lang ⇒ lang undefined (cai na pref/auto-detect no wiring)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.lang).toBeUndefined();
  });

  it('--lang <code> NÃO captura o code como objetivo posicional', () => {
    const a = parseArgs(['--lang', 'en', 'faça x']);
    if (a.kind === 'launch') {
      expect(a.lang).toBe('en');
      expect(a.goal).toBe('faça x');
    }
  });

  it('--lang convive com --tier e objetivo (sem confundir valores)', () => {
    const a = parseArgs(['--tier', 'aluy-granito', '--lang', 'en', 'crie x']);
    if (a.kind === 'launch') {
      expect(a.tier).toBe('aluy-granito');
      expect(a.lang).toBe('en');
      expect(a.goal).toBe('crie x');
    }
  });
});

describe('textos', () => {
  it('versionText inclui o binário e o engine', () => {
    const t = versionText();
    expect(t).toMatch(/^aluy \d+\.\d+\.\d+/);
    expect(t).toContain('@aluy/cli-core');
  });

  it('HELP_TEXT cita uso e opções', () => {
    expect(HELP_TEXT).toContain('Uso:');
    expect(HELP_TEXT).toContain('--version');
    expect(HELP_TEXT).toContain('--help');
  });

  it('HELP_TEXT documenta --yolo como PERMISSÃO COMPLETA (e não promove --unsafe)', () => {
    // EST-0959 — `--yolo` é o nome OFICIAL; o uso e a opção documentada são --yolo.
    expect(HELP_TEXT).toMatch(/aluy \["objetivo"\] \[--plan \| --yolo\]/);
    expect(HELP_TEXT).toMatch(/^\s{2}--yolo\s/m);
    // EST-0991 · EST-1007 · ADR-0072 · AG-0008 — o --yolo é PERMISSÃO COMPLETA (catraca-off
    // + cerca-off + anti-SSRF-off). Pós AG-0008: headless ENTRA DIRETO (a flag é o
    // consentimento; ALUY_YOLO_HEADLESS não é mais necessário) e RECUSA SEMPRE como root.
    expect(HELP_TEXT).toMatch(/PERMISSÃO COMPLETA|BYPASS TOTAL/i);
    // documenta que o env var caiu (não é mais necessário) — DoD EST-1007.
    expect(HELP_TEXT).toMatch(/ALUY_YOLO_HEADLESS NÃO é mais necessário/);
    // o ÚNICO bloqueio duro que resta é o ROOT.
    expect(HELP_TEXT).toMatch(/RECUSA SEMPRE como root/i);
    // `--unsafe` é só alias deprecado: NÃO aparece como opção própria do help
    // (nenhuma linha de opção começa com `--unsafe`), só a nota de deprecação.
    expect(HELP_TEXT).not.toMatch(/^\s{2}--unsafe\s/m);
    expect(HELP_TEXT).not.toMatch(/\[--plan \| --unsafe\]/);
  });

  it('HELP_TEXT documenta --plan como modo read-only (EST-0959)', () => {
    expect(HELP_TEXT).toContain('--plan');
    expect(HELP_TEXT).toMatch(/read-only|só leitura|NEGADA/i);
  });

  it('HELP_TEXT documenta --tier (e que o modelo é resolvido pelo broker) — EST-0962', () => {
    expect(HELP_TEXT).toContain('--tier');
    expect(HELP_TEXT).toMatch(/\/model/);
    expect(HELP_TEXT).toMatch(/broker/i);
  });

  // EST-1007 — o help documenta os dois recursos novos + a segurança fail-closed.
  it('HELP_TEXT documenta -p/--print/--exec (headless one-shot + stdin + exit code)', () => {
    expect(HELP_TEXT).toMatch(/-p, --print, --exec/);
    expect(HELP_TEXT).toMatch(/HEADLESS/i);
    expect(HELP_TEXT).toMatch(/stdin/i);
    expect(HELP_TEXT).toMatch(/Exit code/i);
  });

  it('HELP_TEXT documenta o FAIL-CLOSED do headless (sempre-ask nega; --yolo libera)', () => {
    expect(HELP_TEXT).toMatch(/fail-closed/i);
    expect(HELP_TEXT).toMatch(/sempre-ask/i);
    // EST-1007 · AG-0008 — sem o duplo opt-in: só a flag `--yolo` libera no headless.
    expect(HELP_TEXT).toMatch(/só --yolo libera/i);
  });

  it('HELP_TEXT documenta --model como slug (DADO, não credencial)', () => {
    expect(HELP_TEXT).toMatch(/--model <slug>/);
    expect(HELP_TEXT).toMatch(/tier:custom/);
    expect(HELP_TEXT).toMatch(/não credencial|NUNCA aceita/i);
  });

  it('HELP_TEXT documenta --provider <name> (par com --model, só o NOME, não credencial)', () => {
    expect(HELP_TEXT).toMatch(/--provider <name>/);
    expect(HELP_TEXT).toMatch(/EXIGE --model/);
    expect(HELP_TEXT).toMatch(/não credencial|NUNCA base_url|PROV-SEC-5/i);
  });

  // EST-0972 — retomada de sessão (`--continue`/`--resume`).
  it('--continue ⇒ launch com resume {kind:"continue"}', () => {
    const a = parseArgs(['--continue']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.resume).toEqual({ kind: 'continue' });
  });

  // EST-0972 (BUG 2) — `--new`: opt-out da auto-oferta de retomada.
  it('sem --new ⇒ fresh=false (boot pode auto-ofertar retomar)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.fresh).toBe(false);
  });

  it('--new ⇒ fresh=true (ignora a oferta, começa do zero) — sem virar objetivo', () => {
    const a = parseArgs(['--new']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.fresh).toBe(true);
      expect(a.goal).toBeUndefined();
      expect(a.resume).toBeUndefined();
    }
  });

  it('--resume SEM id ⇒ resume {kind:"resume"} (sem id ⇒ lista)', () => {
    const a = parseArgs(['--resume']);
    if (a.kind === 'launch') expect(a.resume).toEqual({ kind: 'resume' });
  });

  it('--resume <id> ⇒ resume {kind:"resume", id}', () => {
    const a = parseArgs(['--resume', 'abc-123']);
    if (a.kind === 'launch') expect(a.resume).toEqual({ kind: 'resume', id: 'abc-123' });
  });

  it('--resume=<id> (forma com igual) também captura o id', () => {
    const a = parseArgs(['--resume=zzz']);
    if (a.kind === 'launch') expect(a.resume).toEqual({ kind: 'resume', id: 'zzz' });
  });

  it('o id de --resume NÃO é confundido com o objetivo posicional', () => {
    const a = parseArgs(['--resume', 'sess-1']);
    if (a.kind === 'launch') {
      expect(a.resume).toEqual({ kind: 'resume', id: 'sess-1' });
      expect(a.goal).toBeUndefined();
    }
  });

  it('--resume seguido de OUTRA flag ⇒ sem id (lista), e a flag é respeitada', () => {
    const a = parseArgs(['--resume', '--dense']);
    if (a.kind === 'launch') {
      expect(a.resume).toEqual({ kind: 'resume' });
      expect(a.dense).toBe(true);
    }
  });

  it('--continue vence --resume se ambos vierem', () => {
    const a = parseArgs(['--resume', 'x', '--continue']);
    if (a.kind === 'launch') expect(a.resume).toEqual({ kind: 'continue' });
  });

  it('sem flag de retomada ⇒ resume ausente (sessão nova)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.resume).toBeUndefined();
  });

  it('HELP_TEXT documenta --continue e --resume (EST-0972)', () => {
    expect(HELP_TEXT).toContain('--continue');
    expect(HELP_TEXT).toContain('--resume');
    expect(HELP_TEXT).toMatch(/~\/\.aluy\/sessions/);
  });

  // EST-1112 · ADR-0119 — BUDGET LOCAL (--budget / --no-budget).
  it('EST-1112 — sem flag ⇒ budget UNDEFINED (cai na precedência flag>env>config>default)', () => {
    const a = parseArgs([]);
    if (a.kind === 'launch') expect(a.budget).toBeUndefined();
  });

  it('EST-1112 — --budget força ON; --no-budget força OFF', () => {
    const on = parseArgs(['--budget']);
    if (on.kind === 'launch') expect(on.budget).toBe(true);
    const off = parseArgs(['--no-budget']);
    if (off.kind === 'launch') expect(off.budget).toBe(false);
  });

  it('EST-1112 — --no-budget VENCE --budget (desligar é o lado seguro)', () => {
    const a = parseArgs(['--budget', '--no-budget']);
    if (a.kind === 'launch') expect(a.budget).toBe(false);
  });

  it('EST-1112 — --budget NÃO engole o objetivo posicional', () => {
    const a = parseArgs(['--budget', 'rode os testes']);
    if (a.kind === 'launch') {
      expect(a.budget).toBe(true);
      expect(a.goal).toBe('rode os testes');
    }
  });

  it('EST-1112 — --no-budget NÃO engole o objetivo posicional', () => {
    const a = parseArgs(['--no-budget', 'rode os testes']);
    if (a.kind === 'launch') {
      expect(a.budget).toBe(false);
      expect(a.goal).toBe('rode os testes');
    }
  });

  it('EST-1112 — HELP_TEXT documenta --budget e --no-budget', () => {
    expect(HELP_TEXT).toContain('--budget');
    expect(HELP_TEXT).toContain('--no-budget');
    expect(HELP_TEXT).toContain('ALUY_BUDGET');
  });
});
