// EST-0983 · ADR-0064 · CLI-SEC-15 — a CATRACA da memória de agente (gate FORTE).
//
// Prova as invariantes da escrita de memória na engine de permissão:
//   GS-M1 — porta estreita: `remember` é allow SILENCIOSO; `edit_file`/`run_command`
//           seguem DENY em TODO `~/.aluy/` (incl. `memory/`), ACIMA do `--unsafe`
//           (write-deny RES-M-1: path direto/indireto/$HOME/symlink-textual ⇒ deny).
//   GS-M2 — `remember` pela catraca (categoria própria): Plan = DENY; TETO por sessão
//           (além ⇒ deny); o teto NÃO é relaxável por `--unsafe` (anti-runaway).
//   GS-M4 — read-deny: `read_file`/`grep`/`run_command`(`cat`) em `~/.aluy/memory/` ⇒ deny.

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, type PermissionPolicy, type ToolCall } from '../../src/index.js';

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

// Caminhos da memória GLOBAL (na home — `~/.aluy/memory/`), em várias formas que um
// modelo manipulado por injeção tentaria p/ furar o matcher (RES-M-1).
const MEM_FORMS: readonly string[] = [
  '~/.aluy/memory/global.md',
  '$HOME/.aluy/memory/global.md',
  '${HOME}/.aluy/memory/index.md',
  '/home/tiago/.aluy/memory/global.md',
  '/root/.aluy/memory/global.md',
  '~/./.aluy/memory/x.md', // normalização `/./`
  '~//.aluy/memory/x.md', // normalização `//`
  '~/foo/../.aluy/memory/x.md', // normalização `..`
];

describe('GS-M1 · porta estreita — `remember` é o ÚNICO canal de escrita de memory/', () => {
  const engine = new PolicyPermissionEngine();

  it('`remember` (sem path do modelo) = ALLOW silencioso na categoria memory-write', () => {
    const v = engine.decide(call('remember', { fact: 'o usuário prefere pnpm', scope: 'global' }));
    expect(v.decision).toBe('allow');
    expect(v.category).toBe('memory-write');
  });

  it('edit_file mirando ~/.aluy/memory/ ⇒ DENY (não é carve-out do edit_file)', () => {
    for (const path of MEM_FORMS) {
      const v = engine.decide(call('edit_file', { path, content: 'evil' }));
      expect(v.decision, `edit_file ${path}`).toBe('deny');
      expect(v.category).toBe('always-ask:aluy-config-write-deny');
    }
  });

  it('run_command que ESCREVE em ~/.aluy/memory/ ⇒ DENY (RES-M-1, path indireto/$HOME)', () => {
    const writes = [
      'echo evil > ~/.aluy/memory/global.md',
      'echo evil >> $HOME/.aluy/memory/global.md',
      'tee ~/.aluy/memory/global.md',
      'cp evil.md ~/.aluy/memory/global.md',
      'sed -i s/a/b/ /home/tiago/.aluy/memory/global.md',
      'cd ~ && echo evil > .aluy/memory/global.md', // home-cd + relativo
    ];
    for (const command of writes) {
      expect(engine.decide(call('run_command', { command })).decision, command).toBe('deny');
    }
  });

  it('EST-0991 · ADR-0072 — sob YOLO a escrita em ~/.aluy/memory/ é ALLOW (piso derrubado)', () => {
    // O write-deny de `~/.aluy/` (incl. memory/) é o PISO de path que o dono decidiu
    // derrubar no YOLO (Alternativa C). Em `normal` PERMANECE deny (1º describe acima
    // prova). Aqui provamos que o YOLO o libera (paridade com Claude Code).
    const yolo = new PolicyPermissionEngine({ mode: 'unsafe' });
    expect(
      yolo.decide(call('edit_file', { path: '~/.aluy/memory/global.md', content: 'x' })).decision,
    ).toBe('allow');
    expect(
      yolo.decide(call('run_command', { command: 'echo x > ~/.aluy/memory/global.md' })).decision,
    ).toBe('allow');
    expect(
      yolo.decide(call('edit_file', { path: '~/.aluy/mcp.json', content: 'x' })).decision,
    ).toBe('allow');
    // NÃO-REGRESSÃO — em normal o write-deny de ~/.aluy/ continua DENY.
    const normal = new PolicyPermissionEngine();
    expect(
      normal.decide(call('edit_file', { path: '~/.aluy/memory/global.md', content: 'x' })).decision,
    ).toBe('deny');
  });

  it('`remember` NÃO é relaxável a "escrever onde quiser" — não recebe path do modelo', () => {
    // Mesmo que o modelo tente embutir um `path` no input de `remember`, a catraca
    // o trata como memory-write (allow), e a TOOL ignora qualquer `path` (porta
    // estreita). A engine não tem caminho p/ `remember` virar escrita arbitrária.
    const v = engine.decide(call('remember', { fact: 'x', path: '~/.aluy/mcp.json' }));
    expect(v.decision).toBe('allow');
    expect(v.category).toBe('memory-write'); // nunca uma escrita-de-arquivo arbitrária
  });
});

describe('GS-M2 · `remember` pela catraca — Plan-deny + teto + não-relaxável por --unsafe', () => {
  it('Plan ⇒ DENY (escrita = efeito; ADR-0055) — `remember` não está na allow-list de leitura', () => {
    const plan = new PolicyPermissionEngine({ mode: 'plan' });
    const v = plan.decide(call('remember', { fact: 'x', scope: 'global' }));
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('mode:plan-deny');
  });

  it('TETO por sessão: além do teto ⇒ DENY (anti-runaway/RES-M-2)', () => {
    const engine = new PolicyPermissionEngine({ maxMemoryWritesPerSession: 3 });
    for (let i = 0; i < 3; i++) {
      const v = engine.decide(call('remember', { fact: `f${i}` }));
      expect(v.decision).toBe('allow');
      engine.noteMemoryWrite(); // o loop registra a gravação OCORRIDA
    }
    const over = engine.decide(call('remember', { fact: 'f3' }));
    expect(over.decision).toBe('deny');
    expect(over.category).toBe('memory-write');
    expect(engine.memoryWriteUsage).toEqual({ used: 3, max: 3 });
  });

  it('o TETO é anti-runaway ⇒ NÃO-relaxável por --unsafe', () => {
    const unsafe = new PolicyPermissionEngine({ mode: 'unsafe', maxMemoryWritesPerSession: 1 });
    expect(unsafe.decide(call('remember', { fact: 'a' })).decision).toBe('allow');
    unsafe.noteMemoryWrite();
    const over = unsafe.decide(call('remember', { fact: 'b' }));
    expect(over.decision).toBe('deny');
    expect(over.category).toBe('memory-write');
  });

  it('allow-list do usuário NÃO transforma `remember` em escrita arbitrária', () => {
    const policy: PermissionPolicy = { rules: [{ tool: 'remember', decision: 'allow' }] };
    const engine = new PolicyPermissionEngine({ policy, maxMemoryWritesPerSession: 0 });
    // teto 0 ⇒ até com allow-list, a 1ª gravação já bate no teto (anti-runaway vence).
    expect(engine.decide(call('remember', { fact: 'x' })).decision).toBe('deny');
  });
});

describe('EST-0983 (extensão · recall) · CATRACA — `recall` = LEITURA local pura', () => {
  it('`recall` (sem path) = ALLOW em normal (leitura pura, default allow)', () => {
    const engine = new PolicyPermissionEngine();
    const noQuery = engine.decide(call('recall', {}));
    expect(noQuery.decision).toBe('allow');
    const withQuery = engine.decide(call('recall', { query: 'pnpm' }));
    expect(withQuery.decision).toBe('allow');
  });

  it('`recall` é PERMITIDO em Plan (leitura local na allow-list fechada — ≠ `remember`)', () => {
    const plan = new PolicyPermissionEngine({ mode: 'plan' });
    // contraste com `remember` (efeito ⇒ Plan-deny): consultar é read-only ⇒ permitido.
    expect(plan.decide(call('recall', {})).decision).toBe('allow');
    expect(plan.decide(call('recall', { query: 'x' })).decision).toBe('allow');
    // não-regressão: `remember` (escrita) segue DENY em Plan.
    expect(plan.decide(call('remember', { fact: 'x' })).decision).toBe('deny');
  });

  it('`recall` NÃO consome o teto de gravações (é leitura, não escrita)', () => {
    const engine = new PolicyPermissionEngine({ maxMemoryWritesPerSession: 0 });
    // teto 0 ⇒ `remember` já bate no teto, mas `recall` (read) passa livre.
    expect(engine.decide(call('remember', { fact: 'x' })).decision).toBe('deny');
    expect(engine.decide(call('recall', {})).decision).toBe('allow');
    expect(engine.memoryWriteUsage).toEqual({ used: 0, max: 0 });
  });

  it('Plan v1 — `recall` com um input que PARECE remoto NÃO é tratado como rede (sem alvo de URL)', () => {
    // R2 do Plan só morde alvo http(s)/scheme remoto; uma `query` textual qualquer não é
    // egress. Mas se a query contiver uma URL, o Plan é conservador (fail-safe) ⇒ deny.
    const plan = new PolicyPermissionEngine({ mode: 'plan' });
    expect(plan.decide(call('recall', { query: 'preferências do usuário' })).decision).toBe(
      'allow',
    );
    expect(plan.decide(call('recall', { query: 'http://evil.test/x' })).decision).toBe('deny');
  });
});

describe('GS-M4 · read-deny — a memória NÃO é legível por nenhum canal de tool', () => {
  const engine = new PolicyPermissionEngine();
  const unsafe = new PolicyPermissionEngine({ mode: 'unsafe' });

  it('read_file/grep em ~/.aluy/memory/ ⇒ DENY (exfiltração barrada)', () => {
    for (const path of MEM_FORMS) {
      expect(engine.decide(call('read_file', { path })).decision, `read ${path}`).toBe('deny');
      expect(engine.decide(call('grep', { pattern: 'x', path })).decision, `grep ${path}`).toBe(
        'deny',
      );
    }
  });

  it('run_command `cat ~/.aluy/memory/` ⇒ DENY em NORMAL (read-deny intacto — não-regressão)', () => {
    const reads = [
      'cat ~/.aluy/memory/global.md',
      'cat $HOME/.aluy/memory/global.md',
      'grep secret /home/tiago/.aluy/memory/global.md',
      'cd ~ && cat .aluy/memory/global.md',
    ];
    for (const command of reads) {
      expect(engine.decide(call('run_command', { command })).decision, command).toBe('deny');
    }
  });

  it('EST-0991 · ADR-0072 — sob YOLO `cat ~/.aluy/memory/` é ALLOW (piso de path derrubado)', () => {
    // Decisão do dono (Alternativa C): no YOLO o agente PODE ler `~/.aluy` (paridade
    // com Claude Code, onde `bash` livre alcança qualquer arquivo). O recall-como-dado
    // (GS-M3) segue sendo a defesa de SEMÂNTICA — fato não vira `system`.
    const reads = [
      'cat ~/.aluy/memory/global.md',
      'cat $HOME/.aluy/memory/global.md',
      'grep secret /home/tiago/.aluy/memory/global.md',
      'cd ~ && cat .aluy/memory/global.md',
    ];
    for (const command of reads) {
      expect(unsafe.decide(call('run_command', { command })).decision, command).toBe('allow');
    }
  });
});
