// GESTÃO DE SUB-AGENTES — ver, relatar e parar.
//
// Pedido do dono depois de perguntar ao Aluy se ele conseguia acompanhar os filhos e
// ouvir "não tenho como matar um sub-agente" e "não tenho como inspecionar progresso".
// Ele estava CERTO: não havia ferramenta nenhuma. E a assimetria era o defeito — o DONO
// já podia ver e parar (`Ctrl+T → P`, `F8`), porque a árvore de fluxo registra tudo; só
// quem precisava agir não alcançava.

import { describe, expect, it } from 'vitest';
import {
  agentsStatusTool,
  agentsStopTool,
  reportStatusTool,
} from '../../../src/agent/tools/agents-manage.js';
import type { ToolPorts } from '../../../src/agent/tools/types.js';

const portsBase = {
  fs: {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  },
  shell: {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
} as unknown as ToolPorts;

const comControle = (ctrl: unknown): ToolPorts =>
  ({ ...portsBase, agentsControl: ctrl }) as unknown as ToolPorts;

describe('agents_status — o que os filhos estão fazendo', () => {
  it('mostra a tool EM CURSO e o relato do filho (a resposta que faltava)', async () => {
    const r = await agentsStatusTool.run(
      {},
      comControle({
        list: () => [
          {
            label: 'pesquisador',
            phase: 'running',
            tokens: 1200,
            toolCalls: 3,
            activity: { tool: 'run_command', target: 'npm test' },
            note: 'rodando a suíte de testes',
          },
        ],
        stop: () => false,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('pesquisador');
    expect(r.observation).toContain('rodando a suíte de testes'); // o relato
    expect(r.observation).toContain('run_command(npm test)'); // o mecânico
  });

  it('sem sub-agentes ⇒ diz isso, em vez de "não tenho como saber"', async () => {
    const r = await agentsStatusTool.run({}, comControle({ list: () => [], stop: () => false }));
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('nenhum sub-agente');
  });

  // Degradação honesta: sem a porta, a tool DIZ que está indisponível — nunca finge.
  it('sem a porta ⇒ indisponível explícito', async () => {
    const r = await agentsStatusTool.run({}, portsBase);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('indisponível');
  });
});

describe('agents_stop — parar UM filho', () => {
  it('para pelo rótulo e diz que os irmãos seguem', async () => {
    const parados: string[] = [];
    const r = await agentsStopTool.run(
      { label: 'travado' },
      comControle({
        list: () => [],
        stop: (l: string) => {
          parados.push(l);
          return true;
        },
      }),
    );
    expect(parados).toEqual(['travado']);
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('irmãos seguem');
  });

  // NUNCA afirmar que parou algo que não parou — é a mentira que este projeto persegue.
  it('rótulo inexistente ⇒ diz que NÃO parou, e como descobrir os rótulos', async () => {
    const r = await agentsStopTool.run(
      { label: 'fantasma' },
      comControle({ list: () => [], stop: () => false }),
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('não parei');
    expect(r.observation).toContain('agents_status');
  });

  it('é efeito EXEC — passa pela catraca como qualquer outro', () => {
    expect(agentsStopTool.effect).toBe('exec');
    // E o status é LEITURA: perguntar não pode pedir confirmação.
    expect(agentsStatusTool.effect).toBe('read');
  });

  it('input EMBRULHADO em string também funciona (modelo barato)', async () => {
    const r = await agentsStopTool.run(
      { input: JSON.stringify({ label: 'x' }) },
      comControle({ list: () => [], stop: () => true }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('report_status — o filho conta o que está fazendo', () => {
  it('anota o relato', async () => {
    const notas: string[] = [];
    const r = await reportStatusTool.run(
      { status: 'lendo o schema' },
      comControle({
        list: () => [],
        stop: () => false,
        report: (n: string) => {
          notas.push(n);
          return true;
        },
      }),
    );
    expect(notas).toEqual(['lendo o schema']);
    expect(r.ok).toBe(true);
  });

  it('status vazio ⇒ recusa (não anota linha em branco)', async () => {
    const r = await reportStatusTool.run(
      { status: '   ' },
      comControle({ list: () => [], stop: () => false, report: () => true }),
    );
    expect(r.ok).toBe(false);
  });
});
