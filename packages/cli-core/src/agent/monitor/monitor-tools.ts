// EST-MON-5 · ADR-0079 (APR-0084) — os TOOLS do Monitor que o agente arma/lista/cancela.
// Factory com CLOSURE sobre o MonitorStore + a EventQueue da sessão (não polui o ToolPorts).
// Efeito `read`: armar/listar/cancelar um vigia é OBSERVAÇÃO read-only (file-watch e
// process-wait NÃO mutam o filesystem do usuário) ⇒ não passa pela catraca. Quando um
// monitor dispara, o evento chega ao loop como DADO (observation, CLI-SEC-4) ENTRE turnos
// — o trabalho em curso não para.

import type { EventQueue } from './event-queue.js';
import type { MonitorStore } from './monitor-store.js';
import type { CommandSpawnHandle } from './triggers.js';
import type { NativeTool, ToolResult } from '../tools/types.js';

/**
 * Constrói os 4 tools do monitor (`monitor` / `monitors` / `monitor_cancel` /
 * `watch_command`) ligados ao `store` + `queue` da sessão. `now` é a fonte de
 * timestamp (injetável p/ teste). `spawnFn` é injetado pelo `@hiperplano/aluy-cli` (o
 * `cli-core` NÃO importa `child_process`).
 */
export function buildMonitorTools(
  store: MonitorStore,
  queue: EventQueue,
  now: () => string,
  spawnFn?: (command: string) => CommandSpawnHandle,
): NativeTool[] {
  const monitor: NativeTool = {
    name: 'monitor',
    effect: 'read',
    group: 'assincrono', // ADR-0145 (frente d) — agrupamento no menu do `capabilities`.
    description:
      'Arma um VIGIA assíncrono read-only. type "file-watch": avisa quando um arquivo/dir muda (campo path). type "process-wait": avisa quando um PID encerra (campo pid). Quando dispara, você recebe o evento como DADO entre os turnos — sem parar o trabalho em curso. Retorna o id do monitor (use em monitor_cancel).',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['file-watch', 'process-wait'],
          description: 'O tipo de vigia.',
        },
        label: {
          type: 'string',
          description: 'Rótulo curto legível (ex.: "build", "espera-csv", "pid-123").',
        },
        path: { type: 'string', description: 'Caminho a vigiar (OBRIGATÓRIO p/ file-watch).' },
        pid: {
          type: 'number',
          description: 'PID a aguardar encerrar (OBRIGATÓRIO p/ process-wait).',
        },
      },
      required: ['type', 'label'],
    },
    async run(input): Promise<ToolResult> {
      const type = input.type;
      const label = String(input.label ?? '').trim();
      if (label === '')
        return { ok: false, observation: 'monitor: o campo "label" é obrigatório.' };
      try {
        let id: string;
        if (type === 'file-watch') {
          const path = String(input.path ?? '').trim();
          if (path === '')
            return { ok: false, observation: 'monitor file-watch: o campo "path" é obrigatório.' };
          id = store.arm({ type: 'file-watch', label, path, queue, now });
        } else if (type === 'process-wait') {
          const pid = Number(input.pid);
          if (!Number.isInteger(pid) || pid <= 0)
            return {
              ok: false,
              observation: 'monitor process-wait: "pid" deve ser um inteiro > 0.',
            };
          id = store.arm({ type: 'process-wait', label, pid, queue, now });
        } else {
          return {
            ok: false,
            observation: `monitor: type desconhecido "${String(type)}" — use "file-watch" ou "process-wait".`,
          };
        }
        return {
          ok: true,
          observation: `monitor armado: ${id} ("${label}", ${String(type)}). Você será avisado quando disparar.`,
        };
      } catch (err) {
        // Ex.: cap de monitores atingido (anti-runaway §7).
        return {
          ok: false,
          observation: `monitor: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };

  const monitors: NativeTool = {
    name: 'monitors',
    effect: 'read',
    group: 'assincrono', // ADR-0145 (frente d) — agrupamento no menu do `capabilities`.
    description: 'Lista os monitores ativos (id · rótulo · tipo).',
    parameters: { type: 'object', properties: {} },
    async run(): Promise<ToolResult> {
      const list = store.list();
      if (list.length === 0) return { ok: true, observation: 'nenhum monitor ativo.' };
      return {
        ok: true,
        observation: list.map((m) => `${m.monitorId} · ${m.label} · ${m.type}`).join('\n'),
      };
    },
  };

  const monitorCancel: NativeTool = {
    name: 'monitor_cancel',
    effect: 'read',
    group: 'assincrono', // ADR-0145 (frente d) — agrupamento no menu do `capabilities`.
    description: 'Cancela um monitor ativo pelo id (para o vigia).',
    parameters: {
      type: 'object',
      properties: { monitorId: { type: 'string', description: 'O id do monitor a cancelar.' } },
      required: ['monitorId'],
    },
    async run(input): Promise<ToolResult> {
      const id = String(input.monitorId ?? '').trim();
      const removed = store.cancel(id);
      return {
        ok: removed,
        observation: removed
          ? `monitor ${id} cancelado.`
          : `monitor ${id} não encontrado (já disparou/cancelado?).`,
      };
    },
  };

  const watchCommand: NativeTool = {
    name: 'watch_command',
    effect: 'exec',
    group: 'assincrono', // ADR-0145 (frente d) — agrupamento no menu do `capabilities`.
    description:
      'Roda um comando de shell em background (detached, stdio próprio) e te avisa quando ele terminar, com o exit code. Diferente de run_command, NÃO bloqueia — o comando roda solto e você recebe o resultado como um evento de monitor entre os turnos. Use para atividades longas (build, teste, deploy) que você quer disparar e continuar trabalhando. Input: { "command": string (obrigatório), "label": string (obrigatório) }. O label aparece no evento de conclusão para você identificar qual comando terminou.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'O comando de shell a rodar em background (ex.: "npm test", "sleep 30 && echo done").',
        },
        label: {
          type: 'string',
          description:
            'Rótulo curto legível (ex.: "build", "testes"). Aparece no evento de conclusão.',
        },
      },
      required: ['command', 'label'],
    },
    async run(input): Promise<ToolResult> {
      const command = String(input.command ?? '').trim();
      if (command === '')
        return { ok: false, observation: 'watch_command: o campo "command" é obrigatório.' };

      const label = String(input.label ?? '').trim();
      if (label === '')
        return { ok: false, observation: 'watch_command: o campo "label" é obrigatório.' };

      if (!spawnFn)
        return {
          ok: false,
          observation: 'watch_command: spawn não disponível neste ambiente (CLI não injetou).',
        };

      try {
        const id = store.arm({
          type: 'command',
          label,
          command,
          queue,
          now,
          spawnFn,
        });
        return {
          ok: true,
          observation: `watch_command armado: ${id} ("${label}") — você será avisado quando "${command}" terminar (com o exit code).`,
        };
      } catch (err) {
        return {
          ok: false,
          observation: `watch_command: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };

  return [monitor, monitors, monitorCancel, watchCommand];
}
