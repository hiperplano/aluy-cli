// EST-0974 · ADR-0053 §2.2 — WRITE-DENY da config local `~/.aluy/` (hooks.json,
// commands/, config). Editar a config de HOOK é ato do USUÁRIO, não do agente:
// senão um README malicioso (prompt-injection, CLI-SEC-4) faria o agente plantar
// um hook que roda SEMPRE (persistência/escalada). Esta bateria prova:
//   • edit_file em `~/.aluy/hooks.json` ⇒ DENY (não ask), não-relaxável por allow-list.
//   • run_command que ESCREVE em `~/.aluy/` (>, tee, cp, sed -i, …) ⇒ DENY.
//   • NÃO super-bloqueia: `.aluy/` relativo do workspace não é a config da home.
// EST-0991 · ADR-0072 (decisão do dono — Alternativa C): o piso de `~/.aluy/` AGORA
//   CAI no `--yolo` (PERMISSÃO COMPLETA). Em `normal`/`plan` PERMANECE DENY
//   (não-regressão provada abaixo).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  classifyAlwaysAsk,
  type PermissionPolicy,
  type ToolCall,
} from '../../src/index.js';

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

const HOOKS = '~/.aluy/hooks.json';
const HOOKS_ABS = '/home/tiago/.aluy/hooks.json';
const CMD_DIR = '~/.aluy/commands/evil.md';

describe('EST-0974 · edit_file na config ~/.aluy/ ⇒ DENY (não ask)', () => {
  const engine = new PolicyPermissionEngine();

  it('edit_file em ~/.aluy/hooks.json ⇒ DENY', () => {
    const v = engine.decide(call('edit_file', { path: HOOKS, content: '{"hooks":[]}' }));
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('always-ask:aluy-config-write-deny');
  });

  it('edit_file em ~/.aluy/commands/*.md ⇒ DENY (não plantar comando)', () => {
    expect(engine.decide(call('edit_file', { path: CMD_DIR, content: 'x' })).decision).toBe('deny');
  });

  it('edit_file por path ABSOLUTO da home ⇒ DENY', () => {
    expect(engine.decide(call('edit_file', { path: HOOKS_ABS, content: 'x' })).decision).toBe(
      'deny',
    );
  });

  it('o DENY é NÃO-relaxável por allow-list do usuário', () => {
    const policy: PermissionPolicy = { rules: [{ tool: 'edit_file', decision: 'allow' }] };
    const eng = new PolicyPermissionEngine({ policy });
    expect(eng.decide(call('edit_file', { path: HOOKS, content: 'x' })).decision).toBe('deny');
  });
});

describe('EST-0974 · run_command que ESCREVE em ~/.aluy/ ⇒ DENY', () => {
  const engine = new PolicyPermissionEngine();
  const writeCommands = [
    'echo "{}" > ~/.aluy/hooks.json',
    'echo evil >> ~/.aluy/hooks.json',
    'tee ~/.aluy/hooks.json',
    'cp evil.json ~/.aluy/hooks.json',
    'sed -i s/a/b/ ~/.aluy/hooks.json',
    'cp evil.md ~/.aluy/commands/evil.md',
    'cat /home/tiago/.aluy/hooks.json > /dev/null && echo x > /home/tiago/.aluy/hooks.json',
  ];
  for (const command of writeCommands) {
    it(`bash: \`${command}\` ⇒ DENY`, () => {
      const v = engine.decide(call('run_command', { command }));
      expect(v.decision).toBe('deny');
      const cats = classifyAlwaysAsk('run_command', { command });
      // dispara write-deny OU journal-read-deny (ambos negam ~/.aluy/; o write é o motivo certo).
      expect(
        cats.some(
          (c) =>
            (c.category === 'always-ask:aluy-config-write-deny' ||
              c.category === 'always-ask:journal-read-deny') &&
            c.deny,
        ),
      ).toBe(true);
    });
  }
});

describe('EST-0991 · ADR-0072 — YOLO DERRUBA o aluy-config-write-deny (Alternativa C, do dono)', () => {
  // MUDANÇA DE CONTRATO (ADR-0072, decisão do dono): o `--yolo` é PERMISSÃO COMPLETA;
  // o antigo piso `aluy-config-write-deny` (que sobrevivia ao `--unsafe`) AGORA CAI
  // no YOLO. O classifier é o MESMO — só a PRECEDÊNCIA mudou (YOLO acima do piso 0.b).
  // ⚠ NÃO-REGRESSÃO: em `normal` o piso PERMANECE DENY (provado no 1º describe acima).
  const yolo = new PolicyPermissionEngine({ mode: 'unsafe' });
  const yoloLegacy = new PolicyPermissionEngine({ unsafe: true });

  it('edit_file em ~/.aluy/hooks.json sob YOLO ⇒ ALLOW', () => {
    const v = yolo.decide(call('edit_file', { path: HOOKS, content: 'x' }));
    expect(v.decision).toBe('allow');
    expect(v.reason).toContain('--yolo');
  });

  it('flag LEGADO unsafe:true também derruba o piso no YOLO', () => {
    expect(yoloLegacy.decide(call('edit_file', { path: HOOKS, content: 'x' })).decision).toBe(
      'allow',
    );
  });

  it('run_command que escreve ~/.aluy/ sob YOLO ⇒ ALLOW', () => {
    expect(
      yolo.decide(call('run_command', { command: 'echo x > ~/.aluy/hooks.json' })).decision,
    ).toBe('allow');
  });

  it('o RESTO do YOLO segue allow (escrever FORA de ~/.aluy/ também)', () => {
    expect(yolo.decide(call('run_command', { command: 'echo x > ./out.txt' })).decision).toBe(
      'allow',
    );
    expect(yolo.decide(call('edit_file', { path: 'src/a.ts', content: 'x' })).decision).toBe(
      'allow',
    );
  });

  it('NÃO-REGRESSÃO — em `normal` o aluy-config-write-deny PERMANECE DENY', () => {
    const normal = new PolicyPermissionEngine();
    expect(normal.decide(call('edit_file', { path: HOOKS, content: 'x' })).decision).toBe('deny');
    expect(
      normal.decide(call('run_command', { command: 'echo x > ~/.aluy/hooks.json' })).decision,
    ).toBe('deny');
  });
});

describe('EST-0974 · NÃO super-bloqueia — `.aluy/` relativo do workspace', () => {
  const engine = new PolicyPermissionEngine();
  it('edit_file `.aluy/notes.txt` (relativo ao workspace) NÃO vira config-write-deny', () => {
    const v = engine.decide(call('edit_file', { path: '.aluy/notes.txt', content: 'x' }));
    expect(v.category).not.toBe('always-ask:aluy-config-write-deny');
  });
  it('write em `./out.json` (fora de ~/.aluy/) NÃO dispara a categoria', () => {
    const cats = classifyAlwaysAsk('run_command', { command: 'echo x > ./out.json' });
    expect(cats.some((c) => c.category === 'always-ask:aluy-config-write-deny')).toBe(false);
  });
});
