// EST-0982 (Fase 0) — ENRIQUECER O DADO da atividade: a `FlowActivity` ganha ts/duração/
// diffstat/summary/tokens/tail, TODOS opcionais e tolerantes. Esta bateria prova:
//   • `noteToolStart` carimba `ts` (do Clock injetável — determinístico).
//   • `noteToolEnd`/`noteLastToolEnd` congelam a DURAÇÃO real (agora−ts) e mesclam os
//     detalhes (summary/diffstat/tokens), TODOS opcionais.
//   • RES-C-1 — o `summary` e o `tail` são REDIGIDOS NA ORIGEM: um segredo no resultado/
//     stream NUNCA aparece na atividade observável.
//   • a árvore ANTIGA (atividade sem os campos novos) continua íntegra — campo ausente.
//   • a duração AO VIVO de uma atividade `running` é derivada no drill-in (tail), sem
//     mutar o estado guardado.

import { describe, expect, it } from 'vitest';
import { FlowTree, REDACTED } from '../../src/index.js';

/** Relógio determinístico: avança em passos controlados (contabilidade de TEMPO). */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('EST-0982 (Fase 0) · FlowActivity enriquecida — ts/duração/summary/diffstat/tokens', () => {
  it('noteToolStart carimba `ts` (do Clock) — quando a atividade começou', () => {
    const clock = fakeClock(5_000);
    const tree = new FlowTree({ clock: clock.now });
    const c = tree.ensureChild('build');
    c.noteToolStart('read_file', 'src/app.ts');
    const a = tree.drillIn('root/build')!.recent[0]!;
    expect(a.ts).toBe(5_000);
    expect(a.running).toBe(true);
    // Enquanto `running`, ainda não há duração congelada — mas o drill-in deriva a AO VIVO.
    clock.advance(700);
    const live = tree.drillIn('root/build')!.recent[0]!;
    expect(live.durationMs).toBe(700);
    expect(live.running).toBe(true);
  });

  it('noteToolEnd congela a DURAÇÃO real (agora−ts) e mescla summary/diffstat/tokens', () => {
    const clock = fakeClock();
    const tree = new FlowTree({ clock: clock.now });
    const c = tree.ensureChild('edit');
    c.noteToolStart('edit_file', 'src/x.ts');
    clock.advance(1_250);
    c.noteToolEnd('edit_file', true, { summary: 'aplicado', added: 12, removed: 3, tokens: 0 });
    const a = tree.drillIn('root/edit')!.recent[0]!;
    expect(a.running).toBe(false);
    expect(a.ok).toBe(true);
    expect(a.durationMs).toBe(1_250); // congelada (não muda mais)
    expect(a.summary).toBe('aplicado');
    expect(a.added).toBe(12);
    expect(a.removed).toBe(3);
    // tokens 0 (tool local não custa) ⇒ OMITIDO (degrada — campo ausente).
    expect(a.tokens).toBeUndefined();
    // A duração congelada NÃO corre mais com o relógio.
    clock.advance(9_999);
    expect(tree.drillIn('root/edit')!.recent[0]!.durationMs).toBe(1_250);
  });

  it('tokens POR atividade quando a tool custa (>0) — accounting por evento', () => {
    const tree = new FlowTree();
    const c = tree.ensureChild('think');
    c.noteToolStart('web_fetch', 'https://x');
    c.noteLastToolEnd(true, { summary: '2 resultados', tokens: 1_280 });
    const a = tree.drillIn('root/think')!.recent[0]!;
    expect(a.tokens).toBe(1_280);
    expect(a.summary).toBe('2 resultados');
  });

  it('TOLERANTE — `noteToolEnd` sem detalhe nenhum: só fecha (running→ok), sem campos extras', () => {
    const clock = fakeClock();
    const tree = new FlowTree({ clock: clock.now });
    const c = tree.ensureChild('plain');
    c.noteToolStart('grep', '/foo/');
    clock.advance(40);
    c.noteLastToolEnd(true);
    const a = tree.drillIn('root/plain')!.recent[0]!;
    expect(a.running).toBe(false);
    expect(a.ok).toBe(true);
    expect(a.durationMs).toBe(40);
    expect(a.summary).toBeUndefined();
    expect(a.added).toBeUndefined();
    expect(a.removed).toBeUndefined();
    expect(a.tokens).toBeUndefined();
  });
});

describe('EST-0982 (Fase 0) · RES-C-1 — summary e tail REDIGIDOS na ORIGEM (segredo NUNCA aparece)', () => {
  it('o `summary` de fim passa por redactOutputSecrets — um Bearer no resumo é redigido', () => {
    const tree = new FlowTree();
    const c = tree.ensureChild('deploy');
    c.noteToolStart('run_command', './deploy.sh');
    // O resultado (improvável, mas defensivo) traz um header com token — NÃO pode vazar.
    c.noteLastToolEnd(false, {
      summary: 'falhou: Authorization: Bearer sk-secret-abcdef1234567890',
    });
    const a = tree.drillIn('root/deploy')!.recent[0]!;
    expect(a.summary).toContain(REDACTED);
    expect(a.summary).not.toContain('sk-secret');
    // E o objeto inteiro do drill-in não carrega o segredo em lugar nenhum.
    expect(JSON.stringify(tree.drillIn('root/deploy'))).not.toContain('sk-secret');
  });

  it('o `tail` ao vivo é REDIGIDO e bounded (últimas N linhas) — stream cru não vaza', () => {
    const tree = new FlowTree();
    const c = tree.ensureChild('run');
    c.noteToolStart('run_command', 'echo $TOKEN; curl ...');
    // O stream traz muitas linhas + um segredo numa delas.
    const stream = [
      'linha 1',
      'linha 2',
      'linha 3',
      'linha 4',
      'linha 5',
      'token=sk-live-zzzzzzzzzzzzzzzz aqui',
    ].join('\n');
    c.noteToolTail(stream);
    const a = tree.drillIn('root/run')!.recent[0]!;
    // Bounded: só as últimas 4 linhas (MAX_TAIL_LINES) — `linha 1`/`linha 2` ficam de fora.
    expect(a.tail!.split('\n')).toHaveLength(4);
    expect(a.tail).not.toContain('linha 1');
    // REDIGIDO: o token na última linha vira ‹redigido›.
    expect(a.tail).toContain('token=' + REDACTED);
    expect(a.tail).not.toContain('sk-live-zzzz');
    expect(JSON.stringify(tree.drillIn('root/run'))).not.toContain('sk-live-zzzz');
  });

  it('o tail só vive enquanto `running` — fechar a atividade não derruba o campo, mas não há novo stream', () => {
    const tree = new FlowTree();
    const c = tree.ensureChild('r');
    c.noteToolStart('run_command', 'ls');
    c.noteToolTail('saída ok');
    c.noteLastToolEnd(true, { summary: 'exit 0' });
    // `noteToolTail` agora é no-op (nenhuma atividade `running`) — não cria atividade nova.
    c.noteToolTail('vazaria?');
    const recent = tree.drillIn('root/r')!.recent;
    expect(recent).toHaveLength(1);
    expect(recent[0]!.summary).toBe('exit 0');
  });
});

describe('EST-0982 (Fase 0) · não-regressão — atividade antiga (sem campos novos) intacta', () => {
  it('uma atividade só com tool/target/running/ok continua válida (campos novos ausentes)', () => {
    const tree = new FlowTree();
    const c = tree.ensureChild('legacy');
    c.noteToolStart('read_file', 'a.ts');
    c.noteToolEnd('read_file', true); // sem detalhe — caminho antigo
    const a = tree.drillIn('root/legacy')!.recent[0]!;
    expect(a.tool).toBe('read_file');
    expect(a.target).toBe('a.ts');
    expect(a.running).toBe(false);
    expect(a.ok).toBe(true);
    // Os campos novos são simplesmente ausentes — a UI antiga não tenta lê-los.
    expect(a.summary).toBeUndefined();
    expect(a.tail).toBeUndefined();
    expect(a.tokens).toBeUndefined();
  });
});
