// Montagem PURA dos seletores de comando (rótulo PT-BR → argumento em inglês, valor atual,
// item→ação, confirmação dos destrutivos). Revisão de UX dos menus, §6.2.

import { describe, expect, it } from 'vitest';
import {
  initialIndex,
  menuStepFor,
  type MenuCtx,
  type MenuItem,
  type MenuOutcome,
  type MenuStep,
} from '../../src/slash/menu-pickers.js';

const BASE: MenuCtx = {
  conversation: 'concierge',
  conciergeAvailable: true,
  statusline: 'full',
  suggestionsOn: true,
  splitOn: false,
};

const step = (id: string, ctx: Partial<MenuCtx> = {}): MenuStep => {
  const s = menuStepFor(id, { ...BASE, ...ctx });
  if (s === null || s instanceof Promise) throw new Error(`esperava passo síncrono para ${id}`);
  return s;
};
const asyncStep = async (id: string, ctx: Partial<MenuCtx> = {}): Promise<MenuStep> => {
  const s = menuStepFor(id, { ...BASE, ...ctx });
  if (s === null) throw new Error(`sem seletor para ${id}`);
  return s;
};
const item = (s: MenuStep, id: string): MenuItem => {
  const it = s.items.find((i) => i.id === id);
  if (!it) throw new Error(`item ${id} ausente em ${s.title}`);
  return it;
};
const argsOf = (o: MenuOutcome): readonly string[] => {
  if (o.kind !== 'run') throw new Error(`esperava run, veio ${o.kind}`);
  return o.args;
};
const nextOf = async (o: MenuOutcome): Promise<MenuStep> => {
  if (o.kind !== 'next') throw new Error(`esperava next, veio ${o.kind}`);
  return await o.step;
};

describe('seletores estáticos: rótulo PT-BR → argumento em inglês', () => {
  it('/conversation', () => {
    const s = step('conversation', { conversation: 'classic' });
    expect(s.items.map((i) => i.label)).toEqual(['concierge', 'clássico']);
    expect(argsOf(item(s, 'concierge').outcome)).toEqual(['concierge']);
    expect(argsOf(item(s, 'classic').outcome)).toEqual(['classic']);
    expect(item(s, 'classic').current).toBe(true);
    expect(item(s, 'concierge').current).toBe(false);
    expect(initialIndex(s)).toBe(1);
    const c = step('conversation', { conversation: 'concierge' });
    expect(item(c, 'concierge').current).toBe(true);
    expect(initialIndex(c)).toBe(0);
  });

  it('/conversation sem concierge disponível cai no comportamento antigo (nota)', () => {
    expect(menuStepFor('conversation', { ...BASE, conciergeAvailable: false })).toBeNull();
  });

  it('/notify', () => {
    const s = step('notify', { notify: 'off' });
    expect(s.items.map((i) => i.label)).toEqual(['tudo', 'só atenção', 'nada']);
    expect(s.items.map((i) => argsOf(i.outcome)[0])).toEqual(['all', 'attention', 'off']);
    expect(initialIndex(s)).toBe(2);
  });

  it('/statusline traz a prévia de cada modo e marca o atual', () => {
    const s = step('statusline', { statusline: 'compact' });
    expect(s.items.map((i) => argsOf(i.outcome)[0])).toEqual(['full', 'compact', 'hidden']);
    expect(s.items.every((i) => (i.hint ?? '').length > 0)).toBe(true);
    expect(item(s, 'compact').current).toBe(true);
  });

  it('/suggest e /split', () => {
    const sug = step('suggest', { suggestionsOn: false });
    expect(sug.items.map((i) => argsOf(i.outcome)[0])).toEqual(['on', 'off']);
    expect(item(sug, 'off').current).toBe(true);
    const sp = step('split', { splitOn: true });
    expect(sp.items.map((i) => argsOf(i.outcome)[0])).toEqual(['on', 'off']);
    expect(item(sp, 'on').current).toBe(true);
  });

  it('/window: tamanhos prontos + "outro valor" preenche o composer', () => {
    const s = step('window');
    expect(s.items.slice(0, 5).map((i) => argsOf(i.outcome)[0])).toEqual([
      '32k',
      '64k',
      '128k',
      '200k',
      '1M',
    ]);
    expect(item(s, 'custom').outcome).toEqual({ kind: 'prefill', text: '/window ' });
  });

  it('/clear: só a conversa roda sem argumento; as destrutivas pedem confirmação e roda 2x', async () => {
    const s = step('clear');
    expect(argsOf(item(s, 'session').outcome)).toEqual(['']);
    for (const [id, verb] of [
      ['full', 'full'],
      ['memory', 'memory'],
    ] as const) {
      const o = item(s, id).outcome;
      expect(o.kind).toBe('next'); // nunca roda direto
      const conf = await nextOf(o);
      expect(argsOf(item(conf, 'yes').outcome)).toEqual([verb, verb]); // arma + confirma
      expect(item(conf, 'no').outcome).toEqual({ kind: 'close' });
    }
  });

  it('/telegram: allow/deny pedem o id (prefill); logout confirma', async () => {
    const s = step('telegram');
    expect(argsOf(item(s, 'status').outcome)).toEqual(['status']);
    expect(item(s, 'allow').outcome).toEqual({ kind: 'prefill', text: '/telegram allow ' });
    expect(item(s, 'deny').outcome).toEqual({ kind: 'prefill', text: '/telegram deny ' });
    const conf = await nextOf(item(s, 'logout').outcome);
    expect(argsOf(item(conf, 'yes').outcome)).toEqual(['logout']);
  });
});

describe('seletores por modo/estado', () => {
  it('/cycle só abre com ciclo ativo', () => {
    expect(menuStepFor('cycle', BASE)).toBeNull();
    const s = step('cycle', { cycleActive: true });
    expect(s.items.map((i) => i.id)).toEqual(['status', 'pause', 'resume', 'edit', 'stop']);
    expect(argsOf(item(s, 'stop').outcome)).toEqual(['stop']);
    expect(item(s, 'edit').outcome).toEqual({ kind: 'prefill', text: '/cycle edit ' });
  });

  it('/task: tarefa → ação (ver detalhe / parar); parar todas só com 2+ vivas', async () => {
    const tasks = [
      { id: 't1', goal: 'refatore A', statusLabel: 'rodando', live: true },
      { id: 't2', goal: 'teste B', statusLabel: 'concluída', live: false },
    ];
    const s = step('task', { tasks });
    expect(s.items.map((i) => i.id)).toEqual(['t1', 't2']); // 1 viva ⇒ sem "parar todas"
    const a1 = await nextOf(item(s, 't1').outcome);
    expect(a1.items.map((i) => argsOf(i.outcome)[0])).toEqual(['show t1', 'stop t1']);
    const a2 = await nextOf(item(s, 't2').outcome);
    expect(a2.items.map((i) => argsOf(i.outcome)[0])).toEqual(['show t2']); // concluída: sem parar
    const two = step('task', { tasks: [...tasks, { ...tasks[0]!, id: 't3' }] });
    expect(argsOf(item(two, 'all').outcome)).toEqual(['stop all']);
  });

  it('/task fora do concierge (sem lista) cai na nota antiga', () => {
    expect(menuStepFor('task', BASE)).toBeNull();
  });

  it('/approve e /deny: o caminho rápido (0 ou 1 pedido) não muda; 2+ escolhe', async () => {
    expect(menuStepFor('approve', BASE)).toBeNull();
    expect(
      menuStepFor('approve', { ...BASE, pending: [{ taskId: 't1', summary: 'x' }] }),
    ).toBeNull();
    const pending = [
      { taskId: 't1', summary: 'run_command npm test' },
      { taskId: 't2', summary: 'edit_file a.ts' },
    ];
    const ap = step('approve', { pending });
    const acts = await nextOf(item(ap, 't2').outcome);
    expect(acts.items.map((i) => argsOf(i.outcome)[0])).toEqual(['t2', 's t2']);
    expect(acts.items.map((i) => i.label)).toEqual(['aprovar', 'aprovar para a sessão']);
    const dn = step('deny', { pending });
    expect(argsOf(item(dn, 't1').outcome)).toEqual(['t1']);
  });
});

describe('seletores de listas (item → ação, sem decorar id)', () => {
  it('sem leitor injetado o comando segue como antes', () => {
    for (const id of [
      'memory',
      'todo',
      'cron',
      'plugin',
      'workflows',
      'service',
      'subagent',
      'rooms',
      'secret',
    ])
      expect(menuStepFor(id, BASE), id).toBeNull();
  });

  it('/memory: fixar/desafixar conforme o estado, editar pede texto, esquecer confirma', async () => {
    const s = await asyncStep('memory', {
      data: {
        memory: async () => [
          { id: 'a1', label: 'fato um', flag: false },
          { id: 'b2', label: 'fato dois', flag: true },
        ],
      },
    });
    const acts1 = await nextOf(item(s, 'a1').outcome);
    expect(acts1.items.map((i) => i.id)).toEqual(['edit', 'pin', 'forget']);
    expect(acts1.items[0]!.outcome).toEqual({ kind: 'prefill', text: '/memory edit a1 ' });
    expect(argsOf(item(acts1, 'pin').outcome)).toEqual(['pin a1']);
    const acts2 = await nextOf(item(s, 'b2').outcome);
    expect(argsOf(item(acts2, 'unpin').outcome)).toEqual(['unpin b2']);
    const conf = await nextOf(item(acts1, 'forget').outcome);
    expect(argsOf(item(conf, 'yes').outcome)).toEqual(['forget a1']);
  });

  it('/todo: escolher o pendente conclui; os já feitos não fazem nada; "remover os feitos"', async () => {
    const s = await asyncStep('todo', {
      data: {
        todo: async () => [
          { id: 'x1', label: '○ escrever teste', flag: false },
          { id: 'x2', label: '✓ feito', flag: true },
        ],
      },
    });
    expect(argsOf(item(s, 'x1').outcome)).toEqual(['done x1']);
    expect(item(s, 'x2').outcome).toEqual({ kind: 'close' });
    expect(argsOf(item(s, 'clear').outcome)).toEqual(['clear']);
  });

  it('/cron: ativar↔desativar conforme o estado, remover confirma', async () => {
    const s = await asyncStep('cron', {
      data: {
        cron: async () => [
          { id: 'j1', label: '0 9 * * * · lint', flag: true },
          { id: 'j2', label: '0 8 * * * · build', flag: false },
        ],
      },
    });
    const on = await nextOf(item(s, 'j1').outcome);
    expect(argsOf(item(on, 'disable').outcome)).toEqual(['disable j1']);
    const off = await nextOf(item(s, 'j2').outcome);
    expect(argsOf(item(off, 'enable').outcome)).toEqual(['enable j2']);
    const conf = await nextOf(item(on, 'rm').outcome);
    expect(argsOf(item(conf, 'yes').outcome)).toEqual(['rm j1']);
  });

  it('/plugin, /workflows, /service, /subagent, /rooms', async () => {
    const d = (id: string, flag?: boolean) => async () => [
      { id, label: id, ...(flag !== undefined ? { flag } : {}) },
    ];
    const plug = await asyncStep('plugin', { data: { plugins: d('p1', true) } });
    expect(argsOf(item(await nextOf(item(plug, 'p1').outcome), 'disable').outcome)).toEqual([
      'disable p1',
    ]);
    const wf = await asyncStep('workflows', { data: { workflows: d('deploy') } });
    const wfActs = await nextOf(item(wf, 'deploy').outcome);
    expect(wfActs.items.map((i) => argsOf(i.outcome)[0])).toEqual(['run deploy', 'use deploy']);
    const sv = await asyncStep('service', { data: { services: d('bot') } });
    const svActs = await nextOf(item(sv, 'bot').outcome);
    expect(svActs.items.map((i) => argsOf(i.outcome)[0])).toEqual([
      'status bot',
      'start bot',
      'stop bot',
      'attach bot',
    ]);
    const sa = await asyncStep('subagent', { data: { subagents: d('revisor') } });
    expect(argsOf(item(sa, 'revisor').outcome)).toEqual(['revisor']);
    const rm = await asyncStep('rooms', { data: { rooms: d('abc123') } });
    expect(argsOf(item(rm, 'new').outcome)).toEqual(['new']);
    const rmActs = await nextOf(item(rm, 'abc123').outcome);
    expect(rmActs.items.map((i) => argsOf(i.outcome)[0])).toEqual(['read abc123', 'watch abc123']);
  });

  it('/secret: lista nomes, remove com confirmação, novo preenche o composer (valor nunca aqui)', async () => {
    const s = await asyncStep('secret', {
      data: { secrets: async () => [{ id: 'GH_TOKEN', label: 'GH_TOKEN', hint: 'salvo' }] },
    });
    expect(argsOf(item(s, 'list').outcome)).toEqual(['list']);
    expect(item(s, 'new').outcome).toEqual({ kind: 'prefill', text: '/secret ' });
    const names = await nextOf(item(s, 'remove').outcome);
    expect(names.items.map((i) => i.id)).toEqual(['GH_TOKEN']);
    const conf = await nextOf(item(names, 'GH_TOKEN').outcome);
    expect(argsOf(item(conf, 'yes').outcome)).toEqual(['remove GH_TOKEN']);
  });

  it('comando sem seletor devolve null', () => {
    expect(menuStepFor('theme', BASE)).toBeNull();
    expect(menuStepFor('quit', BASE)).toBeNull();
  });
});
