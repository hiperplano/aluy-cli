// EST-0970 (UX MCP) — o prompt ensina o agente a rodar `aluy mcp add …` via
// run_command. Esta bateria PROVA a premissa do prompt na catraca:
//   • `aluy mcp add <nome> -- <command> [args...]` é um exec NORMAL — NÃO é DENY
//     (o comando não NOMEIA nenhum path de `~/.aluy/`; quem escreve a config é o
//     processo `aluy` separado, ato equivalente ao do usuário). Em modo normal o
//     veredito é o de qualquer exec (ask — confirmação), nunca bloqueio.
//   • a ESCRITA DIRETA em `~/.aluy/mcp.json` (echo >, tee, edit_file) SEGUE DENY
//     (E-B1 intocado) — é exatamente o que o prompt manda o agente NÃO fazer.

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, classifyAlwaysAsk, type ToolCall } from '../../src/index.js';

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

const ADD_CMD = 'aluy mcp add playwright -- npx -y @playwright/mcp';

describe('EST-0970 · `aluy mcp add` via run_command NÃO é bloqueado (premissa do prompt)', () => {
  const engine = new PolicyPermissionEngine();

  it('o exec não cai em NENHUMA categoria de DENY (nenhum path ~/.aluy no texto)', () => {
    const matches = classifyAlwaysAsk('run_command', { command: ADD_CMD });
    expect(matches.some((m) => m.deny === true)).toBe(false);
  });

  it('em modo normal o veredito é ask/allow (confirmação normal de exec) — nunca deny', () => {
    const v = engine.decide(call('run_command', { command: ADD_CMD }));
    expect(v.decision).not.toBe('deny');
  });

  it('outros comandos `aluy mcp` de leitura também não são deny (list/search)', () => {
    for (const cmd of ['aluy mcp list', 'aluy mcp search playwright']) {
      expect(engine.decide(call('run_command', { command: cmd })).decision).not.toBe('deny');
    }
  });

  it('CONTRASTE — escrever ~/.aluy/mcp.json DIRETO segue DENY (E-B1, o prompt avisa)', () => {
    const direct = engine.decide(call('run_command', { command: 'echo "{}" > ~/.aluy/mcp.json' }));
    expect(direct.decision).toBe('deny');
    const edit = engine.decide(
      call('edit_file', { path: '~/.aluy/mcp.json', content: '{"mcpServers":{}}' }),
    );
    expect(edit.decision).toBe('deny');
  });
});
