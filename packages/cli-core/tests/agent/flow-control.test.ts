// EST-0982 · ADR-0063 — CONTROLE/OBSERVABILIDADE da árvore de fluxos: a bateria do
// gate MÉDIO do `seguranca` (GS-C1..C5 + RES-C-1/2/3) sobre a MECÂNICA portável
// (cli-core): FlowTree/FlowNode (ver/parar + contabilidade), ControlAudit (CLI-SEC-10)
// e injectedInputItem (interagir). A integração no @hiperplano/aluy-cli (controller/UI) é testada
// em packages/cli/tests/session/controller-flow-control.test.ts.

import { describe, expect, it } from 'vitest';
import {
  FlowTree,
  ControlAudit,
  injectedInputItem,
  INJECTED_INPUT_LABEL,
  REDACTED,
} from '../../src/index.js';

/** Relógio determinístico: avança em passos controlados (contabilidade de TEMPO). */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('EST-0982 · FlowTree/FlowNode — VER (drill-in) + contabilidade (tokens+tempo)', () => {
  it('GS-C4 — cada nó carrega o RÓTULO DE ORIGEM (CLI-SEC-9) na visão geral e no drill-in', () => {
    const tree = new FlowTree({ rootLabel: 'aluy' });
    tree.ensureChild('rust');
    tree.ensureChild('go');
    const overview = tree.overview();
    expect(overview.map((n) => n.label)).toEqual(['aluy', 'rust', 'go']);
    expect(tree.drillIn('root/rust')?.label).toBe('rust');
    // A árvore é profundidade ≤1: raiz + filhos diretos, sem netos.
    expect(overview.filter((n) => n.kind === 'subagent')).toHaveLength(2);
  });

  it('CONTABILIDADE — tokens (do budget/broker) E tempo (do relógio) por nó e do turno', () => {
    const clock = fakeClock();
    const tree = new FlowTree({ clock: clock.now });
    const rust = tree.ensureChild('rust');
    rust.setUsage({ tokens: 74_400, toolCalls: 13, iterations: 5 });
    clock.advance(2_100); // 2.1s de trabalho do filho
    rust.finish('final');
    const acc = tree.drillIn('root/rust')!.accounting;
    expect(acc.tokens).toBe(74_400);
    expect(acc.toolCalls).toBe(13);
    expect(acc.durationMs).toBe(2_100);
    expect(acc.endedAt).toBe(1_000 + 2_100);
    // A contabilidade do TURNO (raiz) corre enquanto vivo (endedAt undefined).
    clock.advance(900);
    const root = tree.rootAccounting();
    expect(root.endedAt).toBeUndefined();
    expect(root.durationMs).toBe(2_100 + 900);
  });

  it('RES-C-1 / GS-C3 — o drill-in NÃO vaza segredo: a atividade observável é REDIGIDA', () => {
    const tree = new FlowTree();
    const child = tree.ensureChild('deploy');
    // O agente rodou um curl com um Bearer token na linha — a OBSERVABILIDADE não pode
    // expor o token cru (CLI-SEC-6). O FlowNode redige o alvo ANTES de torná-lo visível.
    child.noteToolStart(
      'run_command',
      'curl -H "Authorization: Bearer sk-secret-abcdef1234567890" https://api.x',
    );
    const drill = tree.drillIn('root/deploy')!;
    const target = drill.recent[0]!.target;
    expect(target).not.toContain('sk-secret-abcdef 1234567890'.replace(/\s/g, ''));
    expect(target).not.toContain('sk-secret');
    expect(target).toContain(REDACTED);
    // Um "stream cru" seria bypass — não existe: a árvore só conhece ATIVIDADE redigida,
    // nunca o conteúdo confinado (journal de /undo / memória não são referenciáveis aqui).
    expect(JSON.stringify(drill)).not.toContain('sk-secret');
  });

  it('RES-C-1 — env-inline e query-string com segredo também saem redigidos no drill-in', () => {
    const tree = new FlowTree();
    const c = tree.ensureChild('build');
    c.noteToolStart('run_command', 'AWS_SECRET_ACCESS_KEY=AKIAREALSECRET0001 ./deploy.sh');
    c.noteToolStart('web_fetch', 'https://h/api?token=sk-live-zzzzzzzzzzzzzzzz&x=1');
    const recent = tree.drillIn('root/build')!.recent;
    expect(recent[0]!.target).toContain('AWS_SECRET_ACCESS_KEY=' + REDACTED);
    expect(recent[0]!.target).not.toContain('AKIAREALSECRET');
    expect(recent[1]!.target).toContain('token=' + REDACTED);
    expect(recent[1]!.target).not.toContain('sk-live-zzzz');
  });
});

describe('EST-0982 · PARAR (abort) — seguro por construção + sem deadlock', () => {
  it('GS-C1 — cancelar SÓ aborta (cessar≠agir): dispara o signal; não há efeito/decide()', () => {
    const tree = new FlowTree();
    const child = tree.ensureChild('rust');
    expect(child.signal.aborted).toBe(false);
    expect(tree.cancelOne('root/rust')).toBe(true);
    // O signal foi disparado (o loop/broker já cancela in-flight por ele — EST-0948).
    expect(child.signal.aborted).toBe(true);
    // O nó vira `cancelled` (não `failed`): cessar não é falha.
    expect(child.stop).toBe('cancelled');
    expect(child.phase).toBe('cancelled');
  });

  it('GS-C2 / RES-C-3 — cancelar o PAI cancela a SUBÁRVORE (filhos param junto)', () => {
    const tree = new FlowTree();
    const a = tree.ensureChild('a');
    const b = tree.ensureChild('b');
    tree.cancelAll(); // aborta a raiz → desce a subárvore
    expect(tree.rootNode.signal.aborted).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(a.stop).toBe('cancelled');
    expect(b.stop).toBe('cancelled');
  });

  it('GS-C2 / RES-C-3 — cancelar UM FILHO NÃO derruba os irmãos NEM o pai (anti-deadlock)', () => {
    const tree = new FlowTree();
    const a = tree.ensureChild('a');
    const b = tree.ensureChild('b');
    tree.cancelOne('root/a');
    expect(a.signal.aborted).toBe(true);
    // O irmão B e o pai seguem VIVOS — um filho cancelado não trava os demais.
    expect(b.signal.aborted).toBe(false);
    expect(b.isTerminal()).toBe(false);
    expect(tree.rootNode.signal.aborted).toBe(false);
    expect(tree.rootNode.isTerminal()).toBe(false);
  });

  it('RES-C-3 — um filho PENDURADO (nunca termina) não trava o cancelamento dos demais', () => {
    const tree = new FlowTree();
    const hung = tree.ensureChild('hung'); // nunca chamamos finish() — fica "vivo"
    const other = tree.ensureChild('other');
    // Cancelar o `other` é independente do `hung` pendurado.
    expect(tree.cancelOne('root/other')).toBe(true);
    expect(other.signal.aborted).toBe(true);
    expect(hung.signal.aborted).toBe(false);
    // E parar-todos também resolve, sem depender do `hung` "responder".
    tree.cancelAll();
    expect(hung.signal.aborted).toBe(true);
  });

  it('cancelar é IDEMPOTENTE e não-existente devolve false', () => {
    const tree = new FlowTree();
    const a = tree.ensureChild('a');
    expect(tree.cancelOne('root/a')).toBe(true);
    expect(tree.cancelOne('root/a')).toBe(true); // 2ª vez não lança
    expect(a.signal.aborted).toBe(true);
    expect(tree.cancelOne('root/inexistente')).toBe(false);
  });

  it('um nó já-terminal mantém seu desfecho REAL ao cancelar (coleta parcial/concluído)', () => {
    const tree = new FlowTree();
    const done = tree.ensureChild('done');
    done.setUsage({ tokens: 100, toolCalls: 1, iterations: 1 });
    done.finish('final'); // concluiu de verdade
    tree.cancelAll(); // parar-todos depois NÃO reescreve o desfecho real
    expect(done.stop).toBe('final');
    expect(done.phase).toBe('done');
  });
});

describe('EST-0982 · SEMÂNTICA DO ESC — cancelRoot (só o pai) vs cancelAll (tudo)', () => {
  it('cancelRoot (esc) cessa SÓ o turno do pai: os FILHOS seguem vivos (não-abortados)', () => {
    const tree = new FlowTree();
    const a = tree.ensureChild('a');
    const b = tree.ensureChild('b');
    tree.cancelRoot(); // esc — para SÓ o pai
    // O turno do pai cessou (o signal da raiz É o do loop do pai — EST-0948).
    expect(tree.rootNode.signal.aborted).toBe(true);
    expect(tree.rootNode.stop).toBe('cancelled');
    // Os filhos NÃO caíram: signal intacto, não-terminais — seguem trabalhando.
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
    expect(a.isTerminal()).toBe(false);
    expect(b.isTerminal()).toBe(false);
    expect(tree.liveChildren().map((c) => c.label)).toEqual(['a', 'b']);
  });

  it('após o esc, o PARAR-TUDO (cancelAll) ainda alcança os filhos sobreviventes', () => {
    const tree = new FlowTree();
    const a = tree.ensureChild('a');
    tree.cancelRoot(); // esc — `a` sobrevive
    expect(a.signal.aborted).toBe(false);
    tree.cancelAll(); // F8 — agora TUDO cai
    expect(a.signal.aborted).toBe(true);
    expect(a.stop).toBe('cancelled');
  });

  it('um filho criado APÓS o PARAR-TUDO nasce abortado; após SÓ o esc, nasce vivo', () => {
    const hard = new FlowTree();
    hard.cancelAll();
    expect(hard.ensureChild('tardio').signal.aborted).toBe(true);
    const soft = new FlowTree();
    soft.cancelRoot(); // esc não cascateia — um filho do MESMO fan-out segue nascendo
    expect(soft.ensureChild('tardio').signal.aborted).toBe(false);
  });

  it('cancelRoot é IDEMPOTENTE e não regride um desfecho real da raiz', () => {
    const tree = new FlowTree();
    tree.rootNode.finish('final');
    tree.cancelRoot();
    tree.cancelRoot();
    expect(tree.rootNode.stop).toBe('final'); // desfecho real preservado
    expect(tree.rootNode.signal.aborted).toBe(true); // o abort em si é idempotente
  });
});

describe('EST-0982 · ControlAudit (CLI-SEC-10) — actor_type=cli + nó-alvo', () => {
  it('GS-C1 — PARAR audita actor_type=cli com o nó-alvo', () => {
    const audit = new ControlAudit();
    audit.recordCancel('root/rust', 'rust');
    audit.recordCancelAll();
    const log = audit.log;
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      actorType: 'cli',
      verb: 'cancel',
      targetId: 'root/rust',
      targetLabel: 'rust',
    });
    expect(log[1]).toMatchObject({ actorType: 'cli', verb: 'cancel-all', targetId: '*' });
  });

  it('GS-C5 — INTERAGIR audita actor_type=cli + nó-alvo + resumo REDIGIDO do input', () => {
    const audit = new ControlAudit();
    audit.recordInjectInput(
      'root/rust',
      'rust',
      'use o token Authorization: Bearer sk-secret-abcdefghij12345 por favor',
    );
    const e = audit.log[0]!;
    expect(e).toMatchObject({ actorType: 'cli', verb: 'inject-input', targetId: 'root/rust' });
    // O resumo é REDIGIDO (CLI-SEC-6) — a trilha de auditoria NÃO guarda o segredo cru.
    expect(e.inputDigest).toBeDefined();
    expect(e.inputDigest).toContain(REDACTED);
    expect(e.inputDigest).not.toContain('sk-secret');
  });
});

describe('EST-0982 · INTERAGIR (injectedInputItem) — GS-C5 / RES-C-2', () => {
  it('o input vira INSTRUÇÃO do dono (user_inject → user), NUNCA system (separação de canais)', () => {
    const item = injectedInputItem('mude o foco para o módulo de auth');
    expect(item).toBeDefined();
    // EST-0982 — o usuário é o PRINCIPAL: o input é `user_inject` (canal `user`,
    // INSTRUÇÃO do dono), NÃO `observation`/DADO_NAO_CONFIÁVEL e NUNCA `system`.
    expect(item!.role).toBe('user_inject');
    // Carrega o RÓTULO DE ORIGEM (veio do dono pela borda do CLI — CLI-SEC-4/9).
    expect((item as { origin: string }).origin).toBe(INJECTED_INPUT_LABEL);
    // O texto é o do usuário, SEM o carimbo de "DADO não-confiável" (não é ambiente).
    expect(item!.text).toBe('mude o foco para o módulo de auth');
    expect(item!.text).not.toContain('DADO');
  });

  it('input vazio/whitespace ⇒ undefined (nada a injetar — fail-safe)', () => {
    expect(injectedInputItem('')).toBeUndefined();
    expect(injectedInputItem('   \n  ')).toBeUndefined();
  });
});
