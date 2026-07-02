// EST-0948 — wrapper que reporta a linha `⏺` (verbo/alvo/resultado quantificado).

import { describe, expect, it } from 'vitest';
import type { NativeTool, ToolPorts, ToolResult } from '@hiperplano/aluy-cli-core';
import { withToolReport } from '../../src/session/tool-reporter.js';
import type { ToolLineBlock } from '../../src/session/model.js';

const ports = {} as ToolPorts;

function fakeTool(name: string, result: ToolResult): NativeTool<ToolPorts> {
  return {
    name,
    effect: 'read',
    description: '',
    async run() {
      return result;
    },
  };
}

function capture(): { reporter: { report: (l: ToolLineBlock) => void }; lines: ToolLineBlock[] } {
  const lines: ToolLineBlock[] = [];
  return { reporter: { report: (l) => lines.push(l) }, lines };
}

describe('withToolReport — quantifica o resultado por tool', () => {
  it('read_file ⇒ "N linhas"', async () => {
    const { reporter, lines } = capture();
    const tool = withToolReport(
      fakeTool('read_file', { ok: true, observation: 'a\nb\nc' }),
      reporter,
    );
    await tool.run({ path: 'a.ts' }, ports);
    expect(lines[0]).toMatchObject({
      verb: 'read',
      target: 'a.ts',
      result: '3 linhas',
      status: 'ok',
    });
  });

  it('perguntar ⇒ alvo é a pergunta e resultado é SÓ a escolha (pedido do dono)', async () => {
    const { reporter, lines } = capture();
    const tool = withToolReport(
      fakeTool('perguntar', {
        ok: true,
        observation: 'O usuário respondeu à pergunta "Qual stack?" escolhendo: React',
        display: 'React',
      }),
      reporter,
    );
    await tool.run({ question: 'Qual stack?', options: ['React', 'Vue'] }, ports);
    expect(lines[0]).toMatchObject({
      verb: 'perguntar',
      target: '"Qual stack?"',
      result: '→ React',
      status: 'ok',
    });
  });

  it('run_command ⇒ "0 erros" no exit 0, "exit N" caso contrário', async () => {
    const { reporter, lines } = capture();
    const ok = withToolReport(
      fakeTool('run_command', { ok: true, observation: 'exit=0\nstdout: hi' }),
      reporter,
    );
    await ok.run({ command: 'echo hi' }, ports);
    expect(lines[0]).toMatchObject({ verb: 'bash', result: '0 erros', status: 'ok' });

    const bad = withToolReport(
      fakeTool('run_command', { ok: false, observation: 'exit=2\nstderr: boom' }),
      reporter,
    );
    await bad.run({ command: 'false' }, ports);
    expect(lines[1]).toMatchObject({ verb: 'bash', result: 'exit 2', status: 'err' });
    expect(lines[1]!.output).toContain('exit=2');
  });

  it('run_command com batch/heredoc de 100+ linhas ⇒ alvo clampado a 1 linha (anti-despejo)', async () => {
    const { reporter, lines } = capture();
    const tool = withToolReport(
      fakeTool('run_command', { ok: true, observation: 'exit=0' }),
      reporter,
    );
    const batch = `cat > relatorio.md <<'EOF'\n${'conteúdo do arquivo\n'.repeat(120)}EOF`;
    await tool.run({ command: batch }, ports);
    const target = lines[0]!.target;
    expect(target).toBe("cat > relatorio.md <<'EOF' … (+121 linhas)");
    expect(target).not.toContain('\n');
  });

  it('grep ⇒ "N hits" / "0 hits"', async () => {
    const { reporter, lines } = capture();
    const hit = withToolReport(
      fakeTool('grep', { ok: true, observation: 'a.ts:1: x\nb.ts:2: x' }),
      reporter,
    );
    await hit.run({ pattern: 'x' }, ports);
    expect(lines[0]).toMatchObject({ result: '2 hits', target: '/x/' });

    const none = withToolReport(
      fakeTool('grep', { ok: true, observation: 'nenhum acerto para /z/ em .' }),
      reporter,
    );
    await none.run({ pattern: 'z' }, ports);
    expect(lines[1]!.result).toBe('0 hits');
  });

  it('edit_file ⇒ aplicado/falhou', async () => {
    const { reporter, lines } = capture();
    const ok = withToolReport(
      fakeTool('edit_file', { ok: true, observation: 'arquivo criado: x' }),
      reporter,
    );
    await ok.run({ path: 'x', content: 'y' }, ports);
    expect(lines[0]!.result).toBe('aplicado');
  });

  it('EST-0982 — edit_file deriva DIFFSTAT (+/−) do diff unificado do `display`', async () => {
    const { reporter, lines } = capture();
    // O `display` do edit_file é um diff unificado (CLI-SEC-9). O reporter conta `+`/`−`
    // ignorando os cabeçalhos (`+++`/`---`).
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@', '-velha', '+nova1', '+nova2', ' igual'].join(
      '\n',
    );
    const tool = withToolReport(
      fakeTool('edit_file', { ok: true, observation: 'arquivo atualizado: x.ts', display: diff }),
      reporter,
    );
    await tool.run({ path: 'x.ts', content: '...' }, ports);
    expect(lines[0]!.added).toBe(2);
    expect(lines[0]!.removed).toBe(1);
  });

  it('EST-0982 — diffstat DEGRADA: read/grep/run não carregam +/− (campo ausente)', async () => {
    const { reporter, lines } = capture();
    const tool = withToolReport(fakeTool('read_file', { ok: true, observation: 'a\nb' }), reporter);
    await tool.run({ path: 'a.ts' }, ports);
    expect(lines[0]!.added).toBeUndefined();
    expect(lines[0]!.removed).toBeUndefined();
  });

  it('tool desconhecida ⇒ ok/erro genérico + verbo = nome', async () => {
    const { reporter, lines } = capture();
    const t = withToolReport(fakeTool('mcp_foo', { ok: false, observation: 'x' }), reporter);
    await t.run({}, ports);
    expect(lines[0]).toMatchObject({ verb: 'mcp_foo', result: 'erro', status: 'err' });
  });

  it('NÃO altera o ToolResult devolvido (transparente ao loop)', async () => {
    const { reporter } = capture();
    const original: ToolResult = { ok: true, observation: 'mesmo', display: '$ x' };
    const t = withToolReport(fakeTool('run_command', original), reporter);
    const r = await t.run({ command: 'x' }, ports);
    expect(r).toEqual(original);
  });
});
