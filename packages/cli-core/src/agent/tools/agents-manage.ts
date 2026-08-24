// GESTÃO DE SUB-AGENTES — ver, relatar e parar.
//
// Pedido do dono, depois de perguntar ao Aluy se ele conseguia acompanhar os filhos e
// ouvir "não tenho como": "crie tools de gestão dos agentes, todas as necessárias" e
// "todos os agentes deveriam passar um status".
//
// O Aluy estava CERTO — não havia ferramenta nenhuma. E a assimetria era o defeito: o
// DONO já podia ver e parar (`Ctrl+T → P`, `F8`), porque a árvore de fluxo registra o
// estado de cada filho em tempo real. Quem precisava da informação para agir — o próprio
// agente — não alcançava. É a mesma forma de vários defeitos desta base: a máquina sabe,
// e quem usa não.
//
// SÃO TRÊS, e a divisão é deliberada:
//   · `agents_status` — LEITURA. Sem efeito, sem catraca. Responde "o que estão fazendo"
//     com o que a árvore já sabe (fase, tokens, tools, duração, tool EM CURSO) mais o
//     relato que o filho tenha dado.
//   · `report_status` — o FILHO conta o que está fazendo. A árvore só conhece o mecânico
//     ("rodando run_command: npm test"); o conceitual ("analisando o schema") só o filho
//     sabe. Sem isto o `agents_status` responde metade da pergunta.
//   · `agents_stop` — EFEITO. Passa pela catraca como qualquer efeito: parar trabalho que
//     o dono pediu não pode ser decisão silenciosa do modelo.

import type { NativeTool, ToolPorts, ToolResult } from './types.js';
import { desembrulhaInput } from './input-shape.js';

/** Porta de gestão — o locus concreto liga na árvore de fluxo da sessão. */
export interface AgentsControlPort {
  /** Os filhos do turno corrente E os desacoplados, vivos ou já concluídos. */
  list(): readonly {
    readonly label: string;
    readonly phase: string;
    readonly tokens: number;
    readonly toolCalls: number;
    readonly durationMs?: number;
    readonly activity?: { readonly tool: string; readonly target: string };
    readonly note?: string;
  }[];
  /** Para UM filho pelo rótulo. `false` se não existe ou já terminou. */
  stop(label: string): boolean;
  /** Anota o relato do filho corrente (usado por `report_status` dentro do filho). */
  report?(nota: string): boolean;
}

function linha(c: {
  label: string;
  phase: string;
  tokens: number;
  toolCalls: number;
  durationMs?: number;
  activity?: { tool: string; target: string };
  note?: string;
}): string {
  const partes = [`${c.label}: ${c.phase}`];
  // O RELATO do filho vem primeiro quando existe — é a resposta mais próxima da
  // pergunta "o que ele está fazendo". A atividade mecânica complementa.
  if (c.note !== undefined && c.note !== '') partes.push(`"${c.note}"`);
  if (c.activity) partes.push(`agora: ${c.activity.tool}(${c.activity.target})`);
  partes.push(`${c.tokens} tokens`);
  if (c.toolCalls > 0) partes.push(`${c.toolCalls} tools`);
  if (c.durationMs !== undefined) partes.push(`${Math.round(c.durationMs / 1000)}s`);
  return `  · ${partes.join(' · ')}`;
}

export const AGENTS_STATUS_TOOL_NAME = 'agents_status';

export const agentsStatusTool: NativeTool<ToolPorts> = {
  name: AGENTS_STATUS_TOOL_NAME,
  effect: 'read',
  group: 'delegacao',
  parameters: Object.freeze({ type: 'object', properties: {} }),
  description:
    'Mostra o que os sub-agentes estão fazendo AGORA: rótulo, fase (rodando/pronto/falhou), ' +
    'a tool em curso com o alvo, tokens, nº de tools e duração — mais o relato que cada um ' +
    'tenha dado via `report_status`. Sem argumentos. Use ANTES de afirmar que não sabe o ' +
    'estado deles, e para responder "o que os agentes estão fazendo?". Leitura pura: não ' +
    'para nada, não altera nada.',
  async run(_input, ports): Promise<ToolResult> {
    const port = (ports as ToolPorts & { agentsControl?: AgentsControlPort }).agentsControl;
    if (!port) {
      return {
        ok: false,
        observation: 'agents_status indisponível: sem porta de gestão neste locus.',
      };
    }
    const filhos = port.list();
    if (filhos.length === 0) {
      return { ok: true, observation: 'nenhum sub-agente nesta sessão (nem vivo, nem concluído).' };
    }
    const vivos = filhos.filter((c) => c.phase === 'running').length;
    return {
      ok: true,
      observation:
        `${filhos.length} sub-agente(s), ${vivos} rodando:\n` + filhos.map(linha).join('\n'),
    };
  },
};

export const REPORT_STATUS_TOOL_NAME = 'report_status';

export const reportStatusTool: NativeTool<ToolPorts> = {
  name: REPORT_STATUS_TOOL_NAME,
  effect: 'read', // só escreve um rótulo de UI; nenhum efeito no mundo
  group: 'delegacao',
  parameters: Object.freeze({
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description:
          'Uma linha curta dizendo o que você está fazendo agora. Ex.: "lendo o schema".',
      },
    },
    required: ['status'],
  }),
  description:
    'Conta, em UMA linha, o que você está fazendo agora — some quem pediu a tarefa vê isso ' +
    'no `agents_status` sem precisar esperar você terminar. Use ao começar e a cada virada ' +
    'de etapa em tarefas longas. Não interrompe seu trabalho e não produz efeito nenhum.',
  async run(input, ports): Promise<ToolResult> {
    const port = (ports as ToolPorts & { agentsControl?: AgentsControlPort }).agentsControl;
    const bruto = desembrulhaInput(input);
    const nota = typeof bruto['status'] === 'string' ? bruto['status'].trim() : '';
    if (nota === '')
      return { ok: false, observation: 'report_status requer "status" (texto curto).' };
    const ok = port?.report?.(nota) ?? false;
    return ok
      ? { ok: true, observation: `status anotado: ${nota}` }
      : { ok: false, observation: 'report_status indisponível aqui (só dentro de um sub-agente).' };
  },
};

export const AGENTS_STOP_TOOL_NAME = 'agents_stop';

export const agentsStopTool: NativeTool<ToolPorts> = {
  name: AGENTS_STOP_TOOL_NAME,
  effect: 'exec', // PASSA pela catraca: parar trabalho do dono não é decisão silenciosa
  group: 'delegacao',
  parameters: Object.freeze({
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'Rótulo do sub-agente a parar (o mesmo que aparece no `agents_status`).',
      },
    },
    required: ['label'],
  }),
  description:
    'Para UM sub-agente pelo rótulo. Os irmãos seguem trabalhando. Passa pela catraca de ' +
    'permissão como qualquer efeito — parar trabalho que o usuário pediu não é decisão sua ' +
    'sozinha. Use só quando o usuário pedir, ou quando o sub-agente estiver claramente ' +
    'travado/em loop. Cessar NÃO é concluir: o que ele já produziu não vira resultado.',
  async run(input, ports): Promise<ToolResult> {
    const port = (ports as ToolPorts & { agentsControl?: AgentsControlPort }).agentsControl;
    if (!port) {
      return {
        ok: false,
        observation: 'agents_stop indisponível: sem porta de gestão neste locus.',
      };
    }
    const bruto = desembrulhaInput(input);
    const label = typeof bruto['label'] === 'string' ? bruto['label'].trim() : '';
    if (label === '')
      return { ok: false, observation: 'agents_stop requer "label" (o rótulo do agente).' };
    const parou = port.stop(label);
    return parou
      ? { ok: true, observation: `sub-agente "${label}" parado. Os irmãos seguem.` }
      : {
          ok: false,
          observation:
            `não parei "${label}": ele não existe nesta sessão ou já terminou. ` +
            'Veja os rótulos com `agents_status`.',
        };
  },
};
