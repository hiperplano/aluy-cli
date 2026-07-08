// ADR-0147 · CLI-SEC-3 — testes do ROTEAMENTO na engine p/ `session_command`:
//   (1) a tool em si SEMPRE passa direto (allow) no ponto único — o roteamento por
//       classe acontece na PORTA concreta (fora do core; testado no `@hiperplano/aluy-cli`);
//   (2) o RE-PASSE destrutivo (`SESSION_COMMAND_DESTRUCTIVE_CALL_NAME`) força
//       `ask`/`always-ask:destructive`, SEMPRE — inclusive sob `--yolo`/`--unsafe`
//       (a invariante do dono: destrutivo de SESSÃO nunca auto-aprova, nem no bypass
//       total — ao contrário das categorias sempre-ask "normais", que o YOLO derruba
//       por ADR-0072).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  SESSION_COMMAND_TOOL_NAME,
  SESSION_COMMAND_DESTRUCTIVE_CALL_NAME,
  type ToolCall,
} from '../../src/index.js';

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

describe('ADR-0147 — session_command (a tool) sempre passa direto no ponto único', () => {
  it('allow em modo normal', () => {
    const engine = new PolicyPermissionEngine();
    const v = engine.decide(call(SESSION_COMMAND_TOOL_NAME, { command: 'doctor' }));
    expect(v.decision).toBe('allow');
  });

  it('em modo Plan, é negado como qualquer outro efeito (fora da allow-list de leitura)', () => {
    const engine = new PolicyPermissionEngine({ mode: 'plan' });
    const v = engine.decide(call(SESSION_COMMAND_TOOL_NAME, { command: 'doctor' }));
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('mode:plan-deny');
  });
});

describe('ADR-0147 · CLI-SEC-3 — RE-PASSE destrutivo (session_command:destructive)', () => {
  it('força ask/always-ask:destructive em modo normal', () => {
    const engine = new PolicyPermissionEngine();
    const v = engine.decide(
      call(SESSION_COMMAND_DESTRUCTIVE_CALL_NAME, {
        command: 'clear',
        args: 'full',
        exact: 'apaga 3 fatos — IRREVERSÍVEL',
      }),
    );
    expect(v.decision).toBe('ask');
    expect(v.category).toBe('always-ask:destructive');
    expect(v.effect?.exact).toContain('apaga 3 fatos — IRREVERSÍVEL');
  });

  it('NÃO relaxa sob --yolo/--unsafe (decisão do dono, ADR-0147) — ao contrário das categorias sempre-ask "normais"', () => {
    const unsafe = new PolicyPermissionEngine({ unsafe: true });
    // controle: sob --yolo, um efeito destrutivo NORMAL (rm -rf) VIRA allow (ADR-0072).
    const normal = unsafe.decide(call('run_command', { command: 'rm -rf /tmp/x' }));
    expect(normal.decision).toBe('allow');
    // mas o RE-PASSE destrutivo de session_command CONTINUA pedindo confirmação.
    const v = unsafe.decide(
      call(SESSION_COMMAND_DESTRUCTIVE_CALL_NAME, {
        command: 'logout',
        args: '',
        exact: 'revoga a credencial — IRREVERSÍVEL',
      }),
    );
    expect(v.decision).toBe('ask');
    expect(v.category).toBe('always-ask:destructive');
  });

  it('sobrevive mesmo em modo Plan (defensivo — a porta nunca chega lá de qualquer forma, pois a tool já é negada em Plan)', () => {
    const plan = new PolicyPermissionEngine({ mode: 'plan' });
    const v = plan.decide(
      call(SESSION_COMMAND_DESTRUCTIVE_CALL_NAME, { command: 'clear', args: 'memory', exact: 'x' }),
    );
    // Plan roda ANTES do re-passe destrutivo na ordem de precedência — mas o resultado
    // segue NUNCA sendo `allow` (fail-safe, seja qual for a categoria).
    expect(v.decision).not.toBe('allow');
  });
});
