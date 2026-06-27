// EST-0990 — PROVA da projeção PURA do LOG (V2 agrupado por agente). Cobre:
//   • AGRUPAMENTO por nó (root + sub-agentes) — uma seção por agente, na ordem da árvore;
//   • REDAÇÃO (RES-C-1): a fonte é a `FlowTree` REAL — um segredo na linha de comando NÃO
//     aparece na projeção (vem `‹redigido›` do core, nunca o stream cru);
//   • COLAPSO de seção (some os eventos da seção colapsada);
//   • filtro `errorsOnly` (só erros/deny);
//   • anel BOUNDED (teto global de eventos).

import { describe, expect, it } from 'vitest';
import { FlowTree, REDACTED } from '@hiperplano/aluy-cli-core';
import { buildActivityLog, MAX_LOG_EVENTS } from '../../src/session/activity-log.js';

/** Monta uma FlowTree real com root + (opcional) sub-agentes e algumas atividades. */
function treeWith(): FlowTree {
  const tree = new FlowTree({ clock: () => 1000 });
  const root = tree.rootNode;
  root.setUsage({ tokens: 18400, toolCalls: 6, iterations: 3 });
  root.noteToolStart('read_file', 'src/app.ts');
  root.noteLastToolEnd(true);
  root.noteToolStart('run_command', 'npm test');
  root.noteLastToolEnd(false); // erro
  return tree;
}

describe('buildActivityLog — V2 agrupado por agente', () => {
  it('uma seção POR NÓ da árvore (root + sub-agentes), na ordem do overview', () => {
    const tree = treeWith();
    const child = tree.ensureChild('test', 'subagent');
    child.setUsage({ tokens: 4200, toolCalls: 2, iterations: 1 });
    child.noteToolStart('grep', 'TODO');
    child.noteLastToolEnd(true);

    const proj = buildActivityLog(tree.overview(), (id) => tree.drillIn(id));
    expect(proj.sections.map((s) => s.label)).toEqual(['aluy', 'test']);
    expect(proj.sections[0]!.kind).toBe('root');
    expect(proj.sections[1]!.kind).toBe('subagent');
    // contabilidade por seção (tokens/tools) vem do accounting do nó.
    expect(proj.sections[0]!.tokens).toBe(18400);
    expect(proj.sections[0]!.toolCalls).toBe(6);
    expect(proj.sections[1]!.tokens).toBe(4200);
  });

  it('os eventos da seção carregam tool + status (ok/err) da atividade redigida', () => {
    const tree = treeWith();
    const proj = buildActivityLog(tree.overview(), (id) => tree.drillIn(id));
    // EST-1015 — o root da árvore está em 'thinking' (default) ⇒ ganha um evento `broker`
    // derivado AO FIM; aqui checamos os eventos de TOOL (a derivação broker tem teste próprio).
    const tools = proj.sections[0]!.events.filter((e) => e.kind === 'tool');
    expect(tools.map((e) => e.label)).toEqual(['read_file', 'run_command']);
    expect(tools[0]!.status).toBe('ok');
    expect(tools[1]!.status).toBe('err');
  });

  // RES-C-1 — a TRAVA de segurança: um SEGREDO na linha de comando NÃO aparece.
  it('RES-C-1: um segredo no comando NÃO aparece — vem ‹redigido› (nunca o stream cru)', () => {
    const tree = new FlowTree({ clock: () => 1000 });
    const SECRET = 'sk-live-DEADBEEF1234567890SECRET';
    tree.rootNode.noteToolStart('run_command', `curl -H "Authorization: Bearer ${SECRET}" api`);
    tree.rootNode.noteLastToolEnd(true);

    const proj = buildActivityLog(tree.overview(), (id) => tree.drillIn(id));
    const serialized = JSON.stringify(proj);
    // O segredo NÃO vaza em LUGAR NENHUM da projeção do log.
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('DEADBEEF');
    // E o marcador de redação ESTÁ lá (o core redigiu antes de a árvore expor).
    expect(proj.sections[0]!.events[0]!.detail).toContain(REDACTED);
  });

  it('seção COLAPSADA não exibe eventos (mas a seção segue listada)', () => {
    const tree = treeWith();
    const proj = buildActivityLog(tree.overview(), (id) => tree.drillIn(id), {
      collapsed: new Set(['root']),
    });
    expect(proj.sections[0]!.collapsed).toBe(true);
    expect(proj.sections[0]!.events).toHaveLength(0);
  });

  it('filtro errorsOnly: só os eventos de erro/deny ficam', () => {
    const tree = treeWith();
    const proj = buildActivityLog(tree.overview(), (id) => tree.drillIn(id), {
      errorsOnly: true,
    });
    const events = proj.sections[0]!.events;
    expect(events.every((e) => e.status === 'err' || e.kind === 'deny')).toBe(true);
    expect(events.map((e) => e.label)).toEqual(['run_command']); // só o que falhou
  });

  it('anel BOUNDED: o teto global de eventos é respeitado (cauda preservada)', () => {
    // Uma árvore com muitos nós, cada um com atividade — força exceder um cap pequeno.
    const tree = new FlowTree({ clock: () => 1000 });
    for (let i = 0; i < 10; i++) {
      const c = tree.ensureChild(`f${i}`, 'subagent');
      for (let j = 0; j < 5; j++) {
        c.noteToolStart('bash', `cmd ${i}.${j}`);
        c.noteLastToolEnd(true);
      }
    }
    const proj = buildActivityLog(tree.overview(), (id) => tree.drillIn(id), { cap: 12 });
    const total = proj.sections.reduce((n, s) => n + s.events.length, 0);
    expect(total).toBeLessThanOrEqual(12);
  });

  it('MAX_LOG_EVENTS é o teto default documentado (anti-crescimento)', () => {
    expect(MAX_LOG_EVENTS).toBe(500);
  });

  // EST-1015 (pedido do dono: mais detalhe no log do fullscreen) — durante o THINKING deriva
  // um evento `● broker · gerando` p/ a seção não ficar só com o cabeçalho.
  it('fase THINKING deriva o evento broker "gerando" (mais detalhe no log)', () => {
    const acct: FlowAccounting = {
      tokens: 1234,
      toolCalls: 0,
      iterations: 1,
      startedAt: 0,
      durationMs: 300,
    };
    const drill: FlowDrillIn = {
      id: 'root',
      kind: 'root',
      label: 'aluy',
      phase: 'thinking',
      accounting: acct,
      recent: [],
    };
    const overview: FlowSummary[] = [
      { id: 'root', kind: 'root', label: 'aluy', phase: 'thinking', accounting: acct },
    ];
    const proj = buildActivityLog(overview, () => drill);
    const ev = proj.sections[0]!.events;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe('broker');
    expect(ev[0]!.detail).toBe('gerando');
    expect(ev[0]!.status).toBe('running');
    expect(ev[0]!.tokens).toBe(1234);
  });

  it('fase NÃO-thinking (done/tool) NÃO deriva o broker (não polui o histórico)', () => {
    // o fixture1 usa phase 'done' ⇒ sem broker derivado.
    const proj = buildActivityLog(
      fixture1([{ tool: 'bash', target: 'ls', running: false, ok: true, ts: 0 }]).overview,
      (id) =>
        fixture1([{ tool: 'bash', target: 'ls', running: false, ok: true, ts: 0 }]).drillIn(id),
    );
    expect(proj.sections[0]!.events.some((e) => e.kind === 'broker')).toBe(false);
  });
});

// ─── EST-1013: endurecimento de cobertura ───────────────────────────────────
// Fixtures MANUAIS que replicam os shapes EXATOS de FlowSummary/FlowDrillIn/
// FlowActivity, sem depender da FlowTree real — para isolar os ramos do
// mapeador interno activityToEvent e do anel bounded.

import type { FlowSummary, FlowDrillIn, FlowActivity, FlowAccounting } from '@hiperplano/aluy-cli-core';

/** Contabilidade padrão para fixtures de overview. */
const BASE_ACCT: FlowAccounting = {
  tokens: 1000,
  toolCalls: 3,
  iterations: 1,
  startedAt: 0,
  durationMs: 500,
};

/** Um overview de 1 nó (root) + drillIn que retorna as atividades dadas. */
function fixture1(
  recent: FlowActivity[],
  id = 'root',
): { overview: FlowSummary[]; drillIn: (id: string) => FlowDrillIn | undefined } {
  const drillInMap = new Map<string, FlowDrillIn>([
    [
      id,
      {
        id,
        kind: 'root',
        label: 'aluy',
        phase: 'done',
        accounting: BASE_ACCT,
        recent,
      },
    ],
  ]);
  return {
    overview: [
      {
        id,
        kind: 'root',
        label: 'aluy',
        phase: 'done',
        accounting: BASE_ACCT,
      },
    ],
    drillIn: (fid: string) => drillInMap.get(fid),
  };
}

describe('EST-1013 — activityToEvent status + campos opcionais', () => {
  it('(A) running → status running; ok===false → err; ok+opcionais → ok c/ campos', () => {
    // Três atividades de tool: running, erro, ok com todos os campos opcionais.
    const activities: FlowActivity[] = [
      {
        tool: 'bash',
        target: 'sleep 1',
        running: true, // => status 'running'
      },
      {
        tool: 'grep',
        target: 'TODO',
        running: false,
        ok: false, // => status 'err'
      },
      {
        tool: 'write_file',
        target: 'src/app.ts',
        running: false,
        ok: true, // => status 'ok'
        durationMs: 123,
        added: 10,
        removed: 3,
        summary: '10 linhas escritas',
        tokens: 42,
        tail: 'import { x } from "y";',
      },
    ];

    const { overview, drillIn } = fixture1(activities);
    const proj = buildActivityLog(overview, drillIn);
    const events = proj.sections[0]!.events;

    expect(events).toHaveLength(3);

    // (1) running
    expect(events[0]!.status).toBe('running');
    expect(events[0]!.kind).toBe('tool');
    expect(events[0]!.label).toBe('bash');
    expect(events[0]!.detail).toBe('sleep 1');

    // (2) err
    expect(events[1]!.status).toBe('err');
    expect(events[1]!.label).toBe('grep');
    expect(events[1]!.detail).toBe('TODO');

    // (3) ok + campos opcionais
    expect(events[2]!.status).toBe('ok');
    expect(events[2]!.label).toBe('write_file');
    expect(events[2]!.detail).toBe('src/app.ts');
    expect(events[2]!.durationMs).toBe(123);
    expect(events[2]!.added).toBe(10);
    expect(events[2]!.removed).toBe(3);
    expect(events[2]!.summary).toBe('10 linhas escritas');
    expect(events[2]!.tokens).toBe(42);
    expect(events[2]!.tail).toBe('import { x } from "y";');
  });

  it('(B) cap bounded: apara seções antigas e mantém cauda; totalEvents reflete bruto', () => {
    // 2 seções, cada uma com 2 eventos = 4 eventos > cap 2
    const acct: FlowAccounting = {
      tokens: 500,
      toolCalls: 2,
      iterations: 1,
      startedAt: 100,
      durationMs: 200,
    };

    const drillInMap = new Map<string, FlowDrillIn>([
      [
        'old',
        {
          id: 'old',
          kind: 'subagent',
          label: 'old-agent',
          phase: 'done',
          accounting: acct,
          recent: [
            { tool: 'bash', target: 'old-cmd-1', running: false, ok: true },
            { tool: 'bash', target: 'old-cmd-2', running: false, ok: true },
          ],
        },
      ],
      [
        'new',
        {
          id: 'new',
          kind: 'subagent',
          label: 'new-agent',
          phase: 'done',
          accounting: acct,
          recent: [
            { tool: 'grep', target: 'new-pat-1', running: false, ok: true },
            { tool: 'read_file', target: 'new-file-2', running: false, ok: true },
          ],
        },
      ],
    ]);

    const overview: FlowSummary[] = [
      { id: 'old', kind: 'subagent', label: 'old-agent', phase: 'done', accounting: acct },
      { id: 'new', kind: 'subagent', label: 'new-agent', phase: 'done', accounting: acct },
    ];

    const proj = buildActivityLog(overview, (id) => drillInMap.get(id), { cap: 2 });

    // A seção mais antiga ('old') deve ter events vazio (apara por completo)
    expect(proj.sections[0]!.id).toBe('old');
    expect(proj.sections[0]!.events).toHaveLength(0);

    // A seção mais recente ('new') mantém os 2 eventos (cauda)
    expect(proj.sections[1]!.id).toBe('new');
    expect(proj.sections[1]!.events).toHaveLength(2);

    // totalEvents reflete o conteúdo BRUTO (4), não o aparado
    expect(proj.totalEvents).toBe(4);
  });

  it('(C) errorsOnly: só eventos err/deny aparecem; ok é filtrado', () => {
    const activities: FlowActivity[] = [
      {
        tool: 'bash',
        target: 'ok-command',
        running: false,
        ok: true, // → 'ok' → deve ser filtrado
      },
      {
        tool: 'run_command',
        target: 'failing',
        running: false,
        ok: false, // → 'err' → permanece
      },
    ];

    const { overview, drillIn } = fixture1(activities);
    const proj = buildActivityLog(overview, drillIn, { errorsOnly: true });
    const events = proj.sections[0]!.events;

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe('err');
    expect(events[0]!.label).toBe('run_command');
  });

  it('(D) collapsed: id em collapsed ⇒ seção events vazio + collapsed true', () => {
    const { overview, drillIn } = fixture1([
      { tool: 'bash', target: 'x', running: false, ok: true },
      { tool: 'grep', target: 'y', running: false, ok: true },
    ]);

    const proj = buildActivityLog(overview, drillIn, {
      collapsed: new Set(['root']),
    });

    expect(proj.sections[0]!.collapsed).toBe(true);
    expect(proj.sections[0]!.events).toHaveLength(0);
  });
});
