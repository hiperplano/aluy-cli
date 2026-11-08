// `2>/dev/null` / `> /dev/stderr` / fd dups NÃO escrevem em arquivo: não são "fora do workspace".
// Relato do dono: depois de `/a!` (aprovar sempre) o comando abaixo ainda perguntava — a categoria
// era `always-ask:outside-workspace`, disparada pelo token `/dev/null` + o `>` do redirect.
import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine } from '../../src/permission/engine.js';
import { classifyAlwaysAsk } from '../../src/index.js';

const CMD =
  'ls -la && cat test_calc.py 2>/dev/null | head -60 && python3 -m unittest -v 2>&1 && python3 calc.py && echo "EXIT_CALC=$?"';
const run = (command: string) => ({ name: 'run_command', input: { command } });
const cats = (command: string): string[] =>
  classifyAlwaysAsk('run_command', { command }).map((m) => m.category);

describe('redirect para sumidouro não é escrita fora do workspace', () => {
  it('o comando exato do relato não cai em nenhuma categoria always-ask', () => {
    expect(cats(CMD)).toEqual([]);
  });

  it('decide() do comando exato: a categoria NÃO é always-ask (é ela que faz o /a! ainda perguntar)', () => {
    const d = new PolicyPermissionEngine().decide(run(CMD));
    expect(d.category.startsWith('always-ask')).toBe(false);
  });

  it.each([
    'make 2>/dev/null',
    'make > /dev/null 2>&1',
    'echo erro >&2',
    'echo x > /dev/stderr',
    'echo x > /dev/stdout',
    'cmd 3>/dev/fd/3',
  ])('`%s` não pergunta', (c) => {
    expect(cats(c)).not.toContain('always-ask:outside-workspace');
  });

  it.each([
    'echo x > /etc/x',
    'echo x > ~/x',
    'echo x > /dev/sda',
    'echo x > /dev/null/../../etc/x',
    'echo x 2>/dev/null > /etc/x',
    'cp a /home/fulano/b',
  ])('`%s` continua perguntando (escrita fora do workspace de verdade)', (c) => {
    expect(cats(c)).toContain('always-ask:outside-workspace');
  });

  it('decide() de escrita fora do workspace segue sendo always-ask:outside-workspace', () => {
    const d = new PolicyPermissionEngine().decide(run('echo x > /etc/x'));
    expect(d.decision).toBe('ask');
    expect(d.category).toBe('always-ask:outside-workspace');
  });
});
