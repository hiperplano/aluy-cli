// BUG-SCHEMA-PERDIDO (22/09/2026, medido em campo) — o wrapper da linha `⏺` da TUI
// reconstruía a tool campo a campo e o `parameters` ficava para trás. TODA tool da sessão
// interativa ia ao provider com o schema livre (`{type:'object',additionalProperties:true}`).
//
// O SINTOMA: com um provider que monta os argumentos A PARTIR do schema (z.ai), 100% das
// tool-calls voltavam `arguments: "{}"` — `run_command requer "command". Recebi: nenhum
// argumento`, até o supervisor encerrar o turno. Provider tolerante (OpenRouter) mascarava
// o defeito, e o headless (`-p`) não passa por este wrapper — por isso só a TUI quebrava.
//
// Como foi isolado: replay do corpo exato da requisição da TUI pelo headless, trocando uma
// parte por vez. Corpo da TUI + `tools` do headless ⇒ funciona; o resto não mudava nada.
import { describe, expect, it, vi } from 'vitest';
import { withToolReport } from '../../src/session/tool-reporter.js';
import { toToolFunctionSchema, NATIVE_TOOLS } from '@hiperplano/aluy-cli-core';
import type { NativeTool, ToolPorts } from '@hiperplano/aluy-cli-core';

const reporter = { report: vi.fn() };

const toolCom = (extra: Partial<NativeTool<ToolPorts>> = {}): NativeTool<ToolPorts> =>
  ({
    name: 'run_command',
    effect: 'exec',
    description: 'roda um comando',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
    run: async () => ({ ok: true, observation: 'ok' }),
    ...extra,
  }) as NativeTool<ToolPorts>;

describe('withToolReport — o wrapper é TRANSPARENTE ao schema', () => {
  it('preserva `parameters` (a regressão exata)', () => {
    const original = toolCom();
    const embrulhada = withToolReport(original, reporter);
    expect(embrulhada.parameters).toEqual(original.parameters);
  });

  // O que de fato vai no fio: o schema de função montado a partir da tool embrulhada.
  it('o schema enviado ao provider leva `properties` e `required`', () => {
    const schema = toToolFunctionSchema(withToolReport(toolCom(), reporter));
    const params = schema.function.parameters as Record<string, unknown>;
    expect(params.properties).toEqual({ command: { type: 'string' } });
    expect(params.required).toEqual(['command']);
    // O schema livre é o sintoma — se ele aparecer aqui, o wrapper voltou a perder o campo.
    expect(params.additionalProperties).not.toBe(true);
  });

  // A armadilha de origem era copiar campo a campo: o PRÓXIMO campo novo de `NativeTool`
  // sumiria do mesmo jeito. Um campo desconhecido tem de atravessar o wrapper.
  it('campo que o wrapper não conhece também atravessa', () => {
    const original = toolCom({ campoDoFuturo: 42 } as never);
    const embrulhada = withToolReport(original, reporter) as unknown as Record<string, unknown>;
    expect(embrulhada.campoDoFuturo).toBe(42);
  });

  it('o `run` continua delegando e reportando (não-regressão do propósito do wrapper)', async () => {
    const run = vi.fn(async () => ({ ok: true, observation: 'feito' }));
    const rep = { report: vi.fn() };
    const r = await withToolReport(toolCom({ run }), rep).run({ command: 'ls' }, {} as ToolPorts);
    expect(run).toHaveBeenCalledOnce();
    expect(r.observation).toBe('feito');
    expect(rep.report).toHaveBeenCalledOnce();
  });

  // Varre o catálogo REAL: toda tool nativa que declara `parameters` tem de sair do
  // wrapper com ele. Pega o defeito em qualquer tool, não só na do fixture.
  it('TODAS as tools nativas do catálogo mantêm o schema depois de embrulhadas', () => {
    const comSchema = NATIVE_TOOLS.filter((t) => t.parameters !== undefined);
    expect(comSchema.length).toBeGreaterThan(0);
    for (const t of comSchema) {
      const e = withToolReport(t as NativeTool<ToolPorts>, reporter);
      expect(e.parameters, `tool ${t.name} perdeu o schema`).toEqual(t.parameters);
    }
  });
});
