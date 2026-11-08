// Seletores dos comandos (revisão de UX dos menus, §6.2): rodar o comando SEM argumento abre
// uma lista em vez de imprimir um texto de ajuda ou alternar às cegas.
//
// Regras:
//  - PURO: este módulo só monta DADO (passos e itens). Quem abre/desenha/escolhe é a App
//    (`useMenuPicker` + `<MenuPicker>` sobre o `<PickerFrame>`).
//  - Todo item resolve para argumentos que o comando JÁ aceita digitados (`/notify off`,
//    `/memory forget <id>`…). O seletor nunca tem caminho próprio de efeito: roda o mesmo
//    `runCommand(comando, args)`, então script e usuário avançado seguem como hoje.
//  - Rótulos PT-BR; os valores (args) seguem em inglês, como o comando os define.
//  - Listas de itens (tarefas, fatos, jobs…) seguem "escolha o item, depois a ação", para
//    ninguém decorar id. Ações destrutivas ganham um passo de confirmação.
//  - O valor ATUAL vem marcado (`current`) e a seleção já nasce nele.

/** O que acontece ao confirmar um item. */
export type MenuOutcome =
  /** Roda `runCommand(comando, args[i])`, em ordem (mais de um só p/ confirmar destrutivos). */
  | { readonly kind: 'run'; readonly args: readonly string[] }
  /** Escreve texto no composer (o comando precisa de texto livre: id novo, nome, tamanho…). */
  | { readonly kind: 'prefill'; readonly text: string }
  /** Abre outro passo (item → ação). */
  | { readonly kind: 'next'; readonly step: MenuStep | Promise<MenuStep> }
  /** Só informa (ex.: "nenhum item"); fecha sem rodar nada. */
  | { readonly kind: 'close' };

export interface MenuItem {
  readonly id: string;
  /** Rótulo PT-BR. */
  readonly label: string;
  /** Explicação curta, esmaecida ao lado. */
  readonly hint?: string;
  /** É o valor em vigor? (marcado com ●; a seleção nasce nele.) */
  readonly current?: boolean;
  readonly outcome: MenuOutcome;
}

export interface MenuStep {
  readonly title: string;
  readonly items: readonly MenuItem[];
  /** Mensagem quando `items` está vazio. */
  readonly empty?: string;
}

/** Uma linha de dado vinda das lojas (memória, jobs, plugins…). */
export interface MenuDatum {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** Ligado/fixado/feito, conforme a lista. */
  readonly flag?: boolean;
}

/** Leitores assíncronos das listas que o seletor mostra. Ausente ⇒ o comando segue como hoje. */
export interface MenuDataPort {
  readonly memory?: () => Promise<readonly MenuDatum[]>;
  readonly todo?: () => Promise<readonly MenuDatum[]>;
  readonly cron?: () => Promise<readonly MenuDatum[]>;
  readonly plugins?: () => Promise<readonly MenuDatum[]>;
  readonly workflows?: () => Promise<readonly MenuDatum[]>;
  readonly services?: () => Promise<readonly MenuDatum[]>;
  readonly subagents?: () => Promise<readonly MenuDatum[]>;
  readonly rooms?: () => Promise<readonly MenuDatum[]>;
  readonly secrets?: () => Promise<readonly MenuDatum[]>;
}

export interface MenuTaskLite {
  readonly id: string;
  readonly goal: string;
  readonly statusLabel: string;
  readonly live: boolean;
}

export interface MenuPendingLite {
  readonly taskId: string;
  readonly summary: string;
}

/** O que o seletor precisa saber da sessão. Tudo opcional: faltou ⇒ sem aquele seletor. */
export interface MenuCtx {
  readonly conversation: 'concierge' | 'classic';
  readonly conciergeAvailable: boolean;
  /** `all` | `attention` | `off`; ausente ⇒ o valor atual não é conhecido. */
  readonly notify?: 'all' | 'attention' | 'off';
  readonly statusline: 'full' | 'compact' | 'hidden';
  readonly suggestionsOn: boolean;
  readonly splitOn: boolean;
  readonly tasks?: readonly MenuTaskLite[];
  readonly pending?: readonly MenuPendingLite[];
  readonly cycleActive?: boolean;
  readonly data?: MenuDataPort;
}

const run = (...args: string[]): MenuOutcome => ({ kind: 'run', args });
const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Passo "tem certeza?" para ação irreversível. */
export function confirmStep(title: string, hint: string, yes: MenuOutcome): MenuStep {
  return {
    title,
    items: [
      { id: 'yes', label: 'sim, confirmar', hint, outcome: yes },
      { id: 'no', label: 'cancelar', outcome: { kind: 'close' } },
    ],
  };
}

/** Passo de uma lista de dado: cada linha leva ao passo de ações que `then` monta. */
function listStep(
  title: string,
  empty: string,
  load: () => Promise<readonly MenuDatum[]>,
  then: (d: MenuDatum) => MenuOutcome,
  extra: readonly MenuItem[] = [],
): Promise<MenuStep> {
  return load().then((rows) => ({
    title,
    empty,
    items: [
      ...rows.map<MenuItem>((d) => ({
        id: d.id,
        label: d.label,
        ...(d.hint !== undefined ? { hint: d.hint } : {}),
        outcome: then(d),
      })),
      ...extra,
    ],
  }));
}

const next = (title: string, items: readonly MenuItem[]): MenuOutcome => ({
  kind: 'next',
  step: { title, items },
});

/**
 * Monta o passo inicial do seletor do comando `id`, ou `null` quando o comando não tem
 * seletor (ou não há como montá-lo agora) — nesse caso o comando roda como sempre.
 * Pode devolver uma Promise (listas lidas de disco).
 */
export function menuStepFor(id: string, ctx: MenuCtx): MenuStep | Promise<MenuStep> | null {
  switch (id) {
    case 'conversation':
      // Sem o runtime do concierge o comando só explica a indisponibilidade (nota existente).
      if (!ctx.conciergeAvailable) return null;
      return {
        title: 'modo de conversa',
        items: [
          {
            id: 'concierge',
            label: 'concierge',
            hint: 'a conversa nunca espera o trabalho',
            current: ctx.conversation === 'concierge',
            outcome: run('concierge'),
          },
          {
            id: 'classic',
            label: 'clássico',
            hint: 'um laço só, como antes',
            current: ctx.conversation === 'classic',
            outcome: run('classic'),
          },
        ],
      };

    case 'notify':
      return {
        title: 'quando o aluy avisa',
        items: [
          {
            id: 'all',
            label: 'tudo',
            hint: 'avisa quando precisa de você e quando conclui um turno longo',
            current: ctx.notify === 'all',
            outcome: run('all'),
          },
          {
            id: 'attention',
            label: 'só atenção',
            hint: 'só quando precisa de você',
            current: ctx.notify === 'attention',
            outcome: run('attention'),
          },
          {
            id: 'off',
            label: 'nada',
            hint: 'sem som nem notificação',
            current: ctx.notify === 'off',
            outcome: run('off'),
          },
        ],
      };

    case 'statusline':
      return {
        title: 'rodapé',
        items: [
          {
            id: 'full',
            label: 'completo',
            hint: 'painel de 3 linhas: sessão, estado e uso',
            current: ctx.statusline === 'full',
            outcome: run('full'),
          },
          {
            id: 'compact',
            label: 'compacto',
            hint: '1 linha com o essencial',
            current: ctx.statusline === 'compact',
            outcome: run('compact'),
          },
          {
            id: 'hidden',
            label: 'oculto',
            hint: 'sem rodapé (F2 volta)',
            current: ctx.statusline === 'hidden',
            outcome: run('hidden'),
          },
        ],
      };

    case 'suggest':
      return {
        title: 'sugestão do próximo prompt',
        items: [
          {
            id: 'on',
            label: 'ligada',
            hint: 'Tab aceita a sugestão',
            current: ctx.suggestionsOn,
            outcome: run('on'),
          },
          {
            id: 'off',
            label: 'desligada',
            current: !ctx.suggestionsOn,
            outcome: run('off'),
          },
        ],
      };

    case 'split':
      return {
        title: 'painel de log ao lado do chat',
        items: [
          {
            id: 'on',
            label: 'mostrar log',
            hint: 'Ctrl+L alterna',
            current: ctx.splitOn,
            outcome: run('on'),
          },
          { id: 'off', label: 'ocultar log', current: !ctx.splitOn, outcome: run('off') },
        ],
      };

    case 'window':
      return {
        title: 'janela de contexto do modelo',
        items: [
          ...['32k', '64k', '128k', '200k', '1M'].map<MenuItem>((v) => ({
            id: v,
            label: v,
            outcome: run(v),
          })),
          {
            id: 'custom',
            label: 'outro valor',
            hint: 'digitar no composer',
            outcome: { kind: 'prefill', text: '/window ' },
          },
        ],
      };

    case 'clear':
      return {
        title: 'limpar',
        items: [
          {
            id: 'session',
            label: 'só a conversa',
            hint: 'a memória do agente fica',
            outcome: run(''),
          },
          {
            id: 'full',
            label: 'conversa + memória',
            hint: 'apaga também a memória do agente',
            outcome: next('apagar a conversa E a memória?', [
              {
                id: 'yes',
                label: 'sim, apagar tudo',
                hint: 'não dá para desfazer',
                outcome: run('full', 'full'),
              },
              { id: 'no', label: 'cancelar', outcome: { kind: 'close' } },
            ]),
          },
          {
            id: 'memory',
            label: 'só a memória',
            hint: 'a conversa continua',
            outcome: next('apagar a memória do agente?', [
              {
                id: 'yes',
                label: 'sim, apagar a memória',
                hint: 'não dá para desfazer',
                outcome: run('memory', 'memory'),
              },
              { id: 'no', label: 'cancelar', outcome: { kind: 'close' } },
            ]),
          },
        ],
      };

    case 'telegram':
      return {
        title: 'Telegram',
        items: [
          {
            id: 'status',
            label: 'status',
            hint: 'ver o que está conectado',
            outcome: run('status'),
          },
          {
            id: 'allow',
            label: 'liberar um chat',
            hint: 'digitar o id do chat',
            outcome: { kind: 'prefill', text: '/telegram allow ' },
          },
          {
            id: 'deny',
            label: 'bloquear um chat',
            hint: 'digitar o id do chat',
            outcome: { kind: 'prefill', text: '/telegram deny ' },
          },
          {
            id: 'logout',
            label: 'desconectar',
            hint: 'remove o bot desta máquina',
            outcome: next('desconectar o Telegram?', [
              { id: 'yes', label: 'sim, desconectar', outcome: run('logout') },
              { id: 'no', label: 'cancelar', outcome: { kind: 'close' } },
            ]),
          },
        ],
      };

    case 'cycle':
      // Sem ciclo ativo o `/cycle` sem argumento só explica o uso — segue assim.
      if (ctx.cycleActive !== true) return null;
      return {
        title: '/cycle em execução',
        items: [
          { id: 'status', label: 'ver status', outcome: run('status') },
          { id: 'pause', label: 'pausar', hint: 'Esc ainda para', outcome: run('pause') },
          { id: 'resume', label: 'retomar', outcome: run('resume') },
          {
            id: 'edit',
            label: 'editar',
            hint: 'vale na próxima volta',
            outcome: { kind: 'prefill', text: '/cycle edit ' },
          },
          { id: 'stop', label: 'parar', outcome: run('stop') },
        ],
      };

    case 'task': {
      const tasks = ctx.tasks;
      if (tasks === undefined) return null;
      const live = tasks.filter((t) => t.live);
      return {
        title: 'tarefas em segundo plano',
        empty: 'nenhuma tarefa nesta sessão',
        items: [
          ...tasks.map<MenuItem>((t) => ({
            id: t.id,
            label: `${t.id}  ${clip(t.goal, 48)}`,
            hint: t.statusLabel,
            outcome: next(`${t.id} · ${clip(t.goal, 40)}`, [
              { id: 'show', label: 'ver detalhe', outcome: run(`show ${t.id}`) },
              ...(t.live
                ? [{ id: 'stop', label: 'parar', outcome: run(`stop ${t.id}`) } as MenuItem]
                : []),
            ]),
          })),
          ...(live.length > 1
            ? [
                {
                  id: 'all',
                  label: 'parar todas',
                  hint: `${live.length} em andamento`,
                  outcome: run('stop all'),
                } as MenuItem,
              ]
            : []),
        ],
      };
    }

    case 'approve':
    case 'deny': {
      const pend = ctx.pending ?? [];
      // Com 0 ou 1 pedido o comando age direto, como sempre (`/a` e `/n` são o caminho rápido).
      if (pend.length < 2) return null;
      const approve = id === 'approve';
      return {
        title: approve ? 'aprovar qual pedido?' : 'negar qual pedido?',
        items: pend.map<MenuItem>((p) => ({
          id: p.taskId,
          label: `${p.taskId}  ${clip(p.summary, 56)}`,
          outcome: approve
            ? next(`${p.taskId} · ${clip(p.summary, 40)}`, [
                { id: 'once', label: 'aprovar', outcome: run(p.taskId) },
                {
                  id: 'session',
                  label: 'aprovar para a sessão',
                  hint: 'não pergunta de novo o mesmo pedido',
                  outcome: run(`s ${p.taskId}`),
                },
              ])
            : run(p.taskId),
        })),
      };
    }

    case 'memory': {
      const load = ctx.data?.memory;
      if (load === undefined) return null;
      return listStep('memória do agente', 'a memória está vazia', load, (d) =>
        next(clip(d.label, 50), [
          {
            id: 'edit',
            label: 'editar',
            outcome: { kind: 'prefill', text: `/memory edit ${d.id} ` },
          },
          d.flag === true
            ? { id: 'unpin', label: 'desafixar', outcome: run(`unpin ${d.id}`) }
            : { id: 'pin', label: 'fixar', hint: 'não expira', outcome: run(`pin ${d.id}`) },
          {
            id: 'forget',
            label: 'esquecer',
            outcome: {
              kind: 'next',
              step: confirmStep(
                'esquecer este fato?',
                'não dá para desfazer',
                run(`forget ${d.id}`),
              ),
            },
          },
        ]),
      );
    }

    case 'todo': {
      const load = ctx.data?.todo;
      if (load === undefined) return null;
      return listStep(
        'pedidos anotados',
        'nada anotado',
        load,
        (d) => (d.flag === true ? { kind: 'close' } : run(`done ${d.id}`)),
        [{ id: 'clear', label: 'remover os já feitos', outcome: run('clear') }],
      );
    }

    case 'cron': {
      const load = ctx.data?.cron;
      if (load === undefined) return null;
      return listStep('agendamentos', 'nenhum agendamento', load, (d) =>
        next(clip(d.label, 50), [
          {
            id: 'edit',
            label: 'editar',
            outcome: { kind: 'prefill', text: `/cron edit ${d.id} ` },
          },
          d.flag === true
            ? { id: 'disable', label: 'desativar', outcome: run(`disable ${d.id}`) }
            : { id: 'enable', label: 'ativar', outcome: run(`enable ${d.id}`) },
          {
            id: 'rm',
            label: 'remover',
            outcome: {
              kind: 'next',
              step: confirmStep(
                'remover este agendamento?',
                'não dá para desfazer',
                run(`rm ${d.id}`),
              ),
            },
          },
        ]),
      );
    }

    case 'plugin': {
      const load = ctx.data?.plugins;
      if (load === undefined) return null;
      return listStep('plugins', 'nenhum plugin instalado', load, (d) =>
        d.flag === true
          ? next(d.label, [{ id: 'disable', label: 'desligar', outcome: run(`disable ${d.id}`) }])
          : next(d.label, [{ id: 'enable', label: 'ligar', outcome: run(`enable ${d.id}`) }]),
      );
    }

    case 'workflows': {
      const load = ctx.data?.workflows;
      if (load === undefined) return null;
      return listStep('fluxos de trabalho', 'nenhum fluxo salvo', load, (d) =>
        next(d.label, [
          { id: 'run', label: 'executar', outcome: run(`run ${d.id}`) },
          {
            id: 'use',
            label: 'ativar',
            hint: 'os próximos pedidos seguem este fluxo',
            outcome: run(`use ${d.id}`),
          },
        ]),
      );
    }

    case 'service': {
      const load = ctx.data?.services;
      if (load === undefined) return null;
      return listStep('serviços', 'nenhum serviço instalado', load, (d) =>
        next(d.label, [
          { id: 'status', label: 'ver status', outcome: run(`status ${d.id}`) },
          { id: 'start', label: 'iniciar', outcome: run(`start ${d.id}`) },
          { id: 'stop', label: 'parar', outcome: run(`stop ${d.id}`) },
          { id: 'attach', label: 'ver estado e log', outcome: run(`attach ${d.id}`) },
        ]),
      );
    }

    case 'subagent': {
      const load = ctx.data?.subagents;
      if (load === undefined) return null;
      return listStep('sub-agentes', 'nenhum sub-agente (.md) disponível', load, (d) => run(d.id));
    }

    case 'rooms': {
      const load = ctx.data?.rooms;
      if (load === undefined) return null;
      return listStep(
        'salas',
        'nenhuma sala ainda',
        load,
        (d) =>
          next(d.label, [
            { id: 'read', label: 'ler', outcome: run(`read ${d.id}`) },
            { id: 'watch', label: 'acompanhar ao vivo', outcome: run(`watch ${d.id}`) },
          ]),
        [{ id: 'new', label: 'nova sala', outcome: run('new') }],
      );
    }

    case 'secret': {
      const load = ctx.data?.secrets;
      if (load === undefined) return null;
      return {
        title: 'segredos',
        items: [
          { id: 'list', label: 'listar os nomes salvos', outcome: run('list') },
          {
            id: 'remove',
            label: 'remover um segredo',
            outcome: {
              kind: 'next',
              step: listStep('remover qual segredo?', 'nenhum segredo salvo', load, (d) => ({
                kind: 'next',
                step: confirmStep(
                  `remover ${d.label}?`,
                  'não dá para desfazer',
                  run(`remove ${d.id}`),
                ),
              })),
            },
          },
          {
            id: 'new',
            label: 'guardar um novo',
            hint: 'digitar o NOME; o valor vai num campo mascarado',
            outcome: { kind: 'prefill', text: '/secret ' },
          },
        ],
      };
    }

    default:
      return null;
  }
}

/** Índice inicial de um passo: o item marcado como atual, senão o primeiro. */
export function initialIndex(step: MenuStep): number {
  const i = step.items.findIndex((it) => it.current === true);
  return i >= 0 ? i : 0;
}
