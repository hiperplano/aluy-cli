// GS-MD7 (recarga viva) — teste do `parseAgentsRefresh`: parseia `/agents refresh`
// (sinônimo `reload`, o MESMO verbo do `/mcp`). PURO (sem disco, sem modelo).
//
// Existe porque a descoberta de agentes `.md` rodava SÓ no boot. Relato do dono: o Aluy
// criou `~/.aluy/agents/ux-frontend.md` com `write_file` (sucesso) e o `spawn_agent`
// seguinte foi RECUSADO ("agente desconhecido — GS-MD7"); sair e reabrir a sessão era o
// único caminho, e custou o contexto do trabalho. O `/mcp reload` já tinha resolvido
// esta MESMA classe de problema para os servers MCP — aqui a porta é a mesma, na outra
// fonte de `.md`.

import { describe, expect, it } from 'vitest';
import { parseAgentsRefresh } from '../../src/slash/handlers.js';
import { NATIVE_COMMANDS } from '../../src/slash/commands.js';

describe('parseAgentsRefresh', () => {
  it('"refresh" e "reload" (o verbo do /mcp) casam', () => {
    expect(parseAgentsRefresh('refresh')).toBe(true);
    expect(parseAgentsRefresh('reload')).toBe(true);
  });

  it('tolera espaço em volta e é case-insensitive', () => {
    expect(parseAgentsRefresh('  refresh  ')).toBe(true);
    expect(parseAgentsRefresh('ReFresh')).toBe(true);
    expect(parseAgentsRefresh('RELOAD')).toBe(true);
  });

  it('`/agents` puro (sem arg) NÃO é refresh — segue listando (não-regressão)', () => {
    expect(parseAgentsRefresh('')).toBe(false);
    expect(parseAgentsRefresh('   ')).toBe(false);
  });

  it('não inventa subcomando: prefixo parcial / verbo alheio ⇒ false', () => {
    expect(parseAgentsRefresh('refr')).toBe(false);
    expect(parseAgentsRefresh('rel')).toBe(false);
    expect(parseAgentsRefresh('refresh all')).toBe(false);
    expect(parseAgentsRefresh('reconnect')).toBe(false);
    expect(parseAgentsRefresh('list')).toBe(false);
  });
});

describe('GS-MD7 — o `/agents refresh` é DESCOBRÍVEL no menu', () => {
  it('o registro nativo declara o subcomando `refresh` em /agents', () => {
    const agents = NATIVE_COMMANDS.find((c) => c.id === 'agents');
    expect(agents).toBeDefined();
    expect(agents!.subcommands?.map((s) => s.name)).toContain('refresh');
    // Não é leitura pura: relê o disco e TROCA o registro da sessão (reversível).
    expect(agents!.subcommandEffects?.['refresh']).toBe('session-effect');
  });
});
