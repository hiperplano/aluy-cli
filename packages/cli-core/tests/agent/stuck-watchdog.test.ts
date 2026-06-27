// EST-0969 (watchdog de TRAVAMENTO · pausa-pede-direção) — testes UNITÁRIOS do
// detector portável `StuckWatchdog`: cada série (mesma tool / mesmo erro / turnos
// vazios / sem-progresso) dispara no limiar; PROGRESSO REAL (tool nova, sucesso,
// conteúdo novo, redirect) RESETA; limiares por env. SEM modelo/loop — só o detector.
import { describe, expect, it } from 'vitest';
import {
  StuckWatchdog,
  newStuckWatchdog,
  resolveWatchdogConfig,
  isWatchdogEnabled,
  DEFAULT_MAX_SAME_TOOL_CALL,
  DEFAULT_MAX_SAME_TOOL_ERROR,
  DEFAULT_MAX_EMPTY_TURNS,
  WATCHDOG_SAME_TOOL_CALL_ENV,
  WATCHDOG_DISABLE_ENV,
} from '../../src/agent/stuck-watchdog.js';

describe('EST-0969 · StuckWatchdog — séries de travamento', () => {
  it('mesma tool-call (name+input) 4× ⇒ alerta same-tool-call (default 4)', () => {
    const wd = new StuckWatchdog();
    expect(DEFAULT_MAX_SAME_TOOL_CALL).toBe(4);
    for (let i = 0; i < 3; i++) {
      wd.noteToolCall('run_command', { command: 'ls' });
      expect(wd.take()).toBeUndefined(); // ainda não cruzou o limiar
    }
    wd.noteToolCall('run_command', { command: 'ls' }); // 4ª
    const a = wd.take();
    expect(a?.kind).toBe('same-tool-call');
    expect(a?.count).toBe(4);
    expect(a?.sample).toBe('run_command'); // NUNCA o input cru
  });

  it('mesmo ERRO de tool 3× seguidas ⇒ alerta same-tool-error (default 3)', () => {
    const wd = new StuckWatchdog();
    expect(DEFAULT_MAX_SAME_TOOL_ERROR).toBe(3);
    // o caso do Tiago: "run_command requer command" repetido.
    for (let i = 0; i < 2; i++) {
      wd.noteToolResult('run_command', false, 'run_command requer command');
      expect(wd.take()).toBeUndefined();
    }
    wd.noteToolResult('run_command', false, 'run_command requer command'); // 3ª
    const a = wd.take();
    expect(a?.kind).toBe('same-tool-error');
    expect(a?.count).toBe(3);
    expect(a?.sample).toContain('run_command');
    expect(a?.sample).toContain('requer command');
  });

  it('turnos vazios consecutivos ⇒ alerta empty-turns (default 3)', () => {
    const wd = new StuckWatchdog();
    expect(DEFAULT_MAX_EMPTY_TURNS).toBe(3);
    wd.noteEmptyTurn();
    wd.noteEmptyTurn();
    expect(wd.take()).toBeUndefined();
    wd.noteEmptyTurn(); // 3º
    expect(wd.take()?.kind).toBe('empty-turns');
  });

  it('iterações sem progresso real ⇒ alerta no-progress (default 6)', () => {
    const wd = new StuckWatchdog();
    for (let i = 0; i < 5; i++) {
      wd.noteIteration();
      expect(wd.take()).toBeUndefined();
    }
    wd.noteIteration(); // 6ª volta estéril
    expect(wd.take()?.kind).toBe('no-progress');
  });
});

describe('EST-0969 · StuckWatchdog — ANTI-FALSO-POSITIVO (progresso reseta)', () => {
  it('SUCESSO de tool no meio RESETA a série de erro (não dispara)', () => {
    const wd = new StuckWatchdog();
    wd.noteToolResult('grep', false, 'no match');
    wd.noteToolResult('grep', false, 'no match');
    wd.noteToolResult('grep', true, 'achei 3 linhas'); // PROGRESSO REAL
    // o erro recomeça do zero: dois novos erros NÃO cruzam o limiar (3).
    wd.noteToolResult('grep', false, 'no match');
    wd.noteToolResult('grep', false, 'no match');
    expect(wd.take()).toBeUndefined();
  });

  it('tool-call DIFERENTE no meio RESETA a repetição (não dispara)', () => {
    const wd = new StuckWatchdog();
    wd.noteToolCall('run_command', { command: 'ls' });
    wd.noteToolCall('run_command', { command: 'ls' });
    wd.noteToolCall('read_file', { path: 'a.ts' }); // DIFERENTE = exploração
    wd.noteToolCall('run_command', { command: 'ls' });
    wd.noteToolCall('run_command', { command: 'ls' });
    expect(wd.take()).toBeUndefined();
  });

  it('input DIFERENTE na mesma tool NÃO conta como repetição', () => {
    const wd = new StuckWatchdog();
    wd.noteToolCall('run_command', { command: 'ls a' });
    wd.noteToolCall('run_command', { command: 'ls b' });
    wd.noteToolCall('run_command', { command: 'ls c' });
    wd.noteToolCall('run_command', { command: 'ls d' });
    expect(wd.take()).toBeUndefined(); // 4 calls, mas todas DIFERENTES
  });

  it('tarefa longa com tools DIFERENTES avançando NUNCA dispara', () => {
    const wd = new StuckWatchdog();
    const tools = ['read_file', 'grep', 'edit_file', 'run_command', 'read_file', 'write_file'];
    for (let i = 0; i < tools.length; i++) {
      wd.noteIteration();
      wd.noteToolCall(tools[i]!, { n: i });
      wd.noteToolResult(tools[i]!, true, `ok ${i}`); // tudo sucesso
      expect(wd.take()).toBeUndefined();
    }
  });

  it('CONTEÚDO novo do modelo RESETA a série de turno vazio', () => {
    const wd = new StuckWatchdog();
    wd.noteEmptyTurn();
    wd.noteEmptyTurn();
    wd.noteModelContent('aqui vai a explicação...'); // progresso
    wd.noteEmptyTurn();
    expect(wd.take()).toBeUndefined(); // só 1 vazio após o reset
  });

  it('noteRedirect() zera TODAS as séries', () => {
    const wd = new StuckWatchdog();
    wd.noteToolCall('x', { a: 1 });
    wd.noteToolCall('x', { a: 1 });
    wd.noteToolCall('x', { a: 1 });
    wd.noteRedirect(); // nova direção do usuário
    wd.noteToolCall('x', { a: 1 });
    expect(wd.take()).toBeUndefined();
  });

  // EST-MON-1 — evento de MONITOR drenado = algo do MUNDO chegou ao contexto: é
  // PROGRESSO desta volta (zera stale/empty/erro), NÃO uma volta estéril a mais.
  it('noteProgress() RESETA a série de stale (evento do mundo = progresso, não estéril)', () => {
    const wd = new StuckWatchdog(); // maxStaleIterations default 6
    for (let i = 0; i < 5; i++) wd.noteIteration(); // 5 voltas estéreis (ainda não dispara)
    expect(wd.take()).toBeUndefined();
    wd.noteProgress(); // evento do mundo chegou ⇒ zera o stale
    // recomeçando do zero: 5 voltas estéreis NÃO cruzam o limiar (6).
    for (let i = 0; i < 5; i++) wd.noteIteration();
    expect(wd.take()).toBeUndefined();
  });

  it('noteProgress() NÃO zera a série de CALL (não é redirect do dono)', () => {
    const wd = new StuckWatchdog(); // maxSameToolCall default 4
    wd.noteToolCall('run_command', { command: 'ls' });
    wd.noteToolCall('run_command', { command: 'ls' });
    wd.noteToolCall('run_command', { command: 'ls' });
    wd.noteProgress(); // progresso de ambiente NÃO é redirect: a repetição de call segue
    wd.noteToolCall('run_command', { command: 'ls' }); // 4ª consecutiva ⇒ DISPARA
    expect(wd.take()?.kind).toBe('same-tool-call');
  });

  it('chave de input é ESTÁVEL p/ ordem de propriedades', () => {
    const wd = new StuckWatchdog();
    // {a,b} e {b,a} são a MESMA chamada (chaves ordenadas) ⇒ contam juntas.
    wd.noteToolCall('t', { a: 1, b: 2 });
    wd.noteToolCall('t', { b: 2, a: 1 });
    wd.noteToolCall('t', { a: 1, b: 2 });
    wd.noteToolCall('t', { b: 2, a: 1 });
    expect(wd.take()?.kind).toBe('same-tool-call');
  });

  // 2ª caça do watchdog: o replacer-array do JSON.stringify era allowlist
  // RECURSIVA e APAGAVA tudo aninhado ⇒ inputs que diferiam só num sub-objeto
  // colidiam na mesma chave ⇒ FALSO-POSITIVO (afetava tools MCP / input aninhado).
  it('input que difere SÓ num sub-objeto NÃO conta como repetição (falso-positivo)', () => {
    const wd = new StuckWatchdog();
    // mesmo nome de tool, mesma chave de topo `opts`, mas conteúdo ANINHADO
    // diferente em cada call ⇒ o agente está PROGREDINDO, não travado.
    wd.noteToolCall('mcp_tool', { opts: { a: 1 } });
    wd.noteToolCall('mcp_tool', { opts: { a: 2 } });
    wd.noteToolCall('mcp_tool', { opts: { a: 3 } });
    wd.noteToolCall('mcp_tool', { opts: { a: 4 } });
    expect(wd.take()).toBeUndefined(); // 4 calls, todas com aninhado DIFERENTE
  });

  // FIX EST-0969 (falso-positivo same-tool-error): 3 comandos DIFERENTES que por
  // acaso falham com a MESMA 1a linha generica (`exit=1`) NAO sao "o mesmo erro em
  // loop" — sao exploracao de depuracao. Antes do fix, a chave do erro era so
  // `name`+1a-linha, entao `run_command exit=1` colidia entre comandos distintos e
  // disparava um alerta espurio. Agora a chave inclui a IDENTIDADE da call
  // (lastCallKey = name+input do noteToolCall anterior) — calls distintas nao
  // colidem. Cada call PRECISA do noteToolCall antes (igual ao loop real).
  it('comandos DIFERENTES que falham com a MESMA 1a linha NAO disparam same-tool-error', () => {
    const wd = new StuckWatchdog();
    const cmds = ['grep alfa', 'grep beta', 'grep gama'];
    for (const command of cmds) {
      wd.noteToolCall('run_command', { command }); // o loop SEMPRE nota a call antes
      wd.noteToolResult('run_command', false, 'exit=1\nstdout: (vazio)\nstderr: (vazio)');
      expect(wd.take()).toBeUndefined(); // inputs distintos => series nao acumula
    }
  });

  it('a MESMA call falhando com a mesma 1a linha AINDA dispara same-tool-error (real intacto)', () => {
    const wd = new StuckWatchdog();
    for (let i = 0; i < 2; i++) {
      wd.noteToolCall('run_command', { command: 'npm test' }); // IDENTICA
      wd.noteToolResult('run_command', false, 'exit=1\nstdout: (vazio)\nstderr: erro X');
      expect(wd.take()).toBeUndefined();
    }
    wd.noteToolCall('run_command', { command: 'npm test' }); // 3a IDENTICA
    wd.noteToolResult('run_command', false, 'exit=1\nstdout: (vazio)\nstderr: erro X');
    const a = wd.take();
    expect(a?.kind).toBe('same-tool-error');
    expect(a?.count).toBe(3);
  });

  it('campos aninhados PROFUNDOS distintos não colidem (deep)', () => {
    const wd = new StuckWatchdog();
    wd.noteToolCall('t', { a: { b: { c: 1 } }, extra: 'x' });
    wd.noteToolCall('t', { a: { b: { c: 2 } }, extra: 'x' });
    wd.noteToolCall('t', { a: { b: { c: 3 } }, extra: 'x' });
    wd.noteToolCall('t', { a: { b: { c: 4 } }, extra: 'x' });
    expect(wd.take()).toBeUndefined();
  });

  it('itens de ARRAY aninhado distintos não colidem', () => {
    const wd = new StuckWatchdog();
    wd.noteToolCall('t', { items: [{ id: 1 }] });
    wd.noteToolCall('t', { items: [{ id: 2 }] });
    wd.noteToolCall('t', { items: [{ id: 3 }] });
    wd.noteToolCall('t', { items: [{ id: 4 }] });
    expect(wd.take()).toBeUndefined();
  });

  it('input ANINHADO IDÊNTICO N× AINDA dispara (detecção real intacta · #122)', () => {
    const wd = new StuckWatchdog();
    const input = { opts: { a: 1, nested: { deep: 'v' } }, command: 'go' };
    for (let i = 0; i < 3; i++) {
      wd.noteToolCall('mcp_tool', { ...input, opts: { ...input.opts } });
      expect(wd.take()).toBeUndefined();
    }
    wd.noteToolCall('mcp_tool', { ...input, opts: { ...input.opts } }); // 4ª idêntica
    expect(wd.take()?.kind).toBe('same-tool-call');
  });

  it('input ANINHADO é ESTÁVEL p/ ordem de chaves em QUALQUER nível', () => {
    const wd = new StuckWatchdog();
    // mesmo conteúdo, ordem de chaves trocada no topo E no aninhado ⇒ MESMA call.
    wd.noteToolCall('t', { a: 1, opts: { x: 1, y: 2 } });
    wd.noteToolCall('t', { opts: { y: 2, x: 1 }, a: 1 });
    wd.noteToolCall('t', { a: 1, opts: { x: 1, y: 2 } });
    wd.noteToolCall('t', { opts: { y: 2, x: 1 }, a: 1 });
    expect(wd.take()?.kind).toBe('same-tool-call');
  });
});

describe('EST-0969 · StuckWatchdog — limiares por env + toggle', () => {
  it('reset() limpa o alerta pendente (após [c] continuar)', () => {
    const wd = new StuckWatchdog();
    for (let i = 0; i < 4; i++) wd.noteToolCall('x', {});
    wd.reset(); // [c] continuar: zera p/ não re-disparar
    expect(wd.take()).toBeUndefined();
  });

  it('env baixa o limiar de same-tool-call', () => {
    const wd = newStuckWatchdog({ [WATCHDOG_SAME_TOOL_CALL_ENV]: '2' })!;
    wd.noteToolCall('x', {});
    expect(wd.take()).toBeUndefined();
    wd.noteToolCall('x', {});
    expect(wd.take()?.kind).toBe('same-tool-call');
  });

  it('valor de env inválido/≤0 cai no default (NUNCA desarma por engano)', () => {
    expect(resolveWatchdogConfig({ [WATCHDOG_SAME_TOOL_CALL_ENV]: '0' }).maxSameToolCall).toBe(
      DEFAULT_MAX_SAME_TOOL_CALL,
    );
    expect(resolveWatchdogConfig({ [WATCHDOG_SAME_TOOL_CALL_ENV]: 'abc' }).maxSameToolCall).toBe(
      DEFAULT_MAX_SAME_TOOL_CALL,
    );
    // piso: um '1' minúsculo vira o piso (≥2), não falso-positivo na 1ª repetição.
    expect(resolveWatchdogConfig({ [WATCHDOG_SAME_TOOL_CALL_ENV]: '1' }).maxSameToolCall).toBe(2);
  });

  it('ALUY_STUCK_OFF desliga o watchdog (newStuckWatchdog ⇒ undefined)', () => {
    expect(isWatchdogEnabled({ [WATCHDOG_DISABLE_ENV]: '1' })).toBe(false);
    expect(newStuckWatchdog({ [WATCHDOG_DISABLE_ENV]: 'true' })).toBeUndefined();
    expect(newStuckWatchdog({})).toBeInstanceOf(StuckWatchdog); // ligado por default
  });

  it('só UM alerta pendente por vez (o 1º a cruzar; take() o drena)', () => {
    const wd = new StuckWatchdog();
    for (let i = 0; i < 4; i++) wd.noteToolCall('x', {});
    // empilhar mais não troca o alerta nem o duplica.
    for (let i = 0; i < 4; i++) wd.noteEmptyTurn();
    const a = wd.take();
    expect(a?.kind).toBe('same-tool-call'); // o 1º que cruzou
    expect(wd.take()).toBeUndefined(); // drenado
  });
});
