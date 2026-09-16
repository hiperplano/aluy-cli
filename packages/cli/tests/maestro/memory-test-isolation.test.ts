// A SUÍTE NÃO PODE GRAVAR NA MEMÓRIA REAL DO DONO.
//
// Achado em 16/09: 802 memórias no escopo do próprio repo, quase todas literais de teste
// ("Diga olá em uma palavra." 28×, "faça algo / pronto." 112×) — e o recall as entregava ao
// modelo, que respondia "o que vc fez" com uma conversa que não aconteceu. O `vitest.config`
// aponta o sidecar para `127.0.0.1:1`, mas os testes de sessão passam um `env` PRÓPRIO
// (`{ HOME, NO_COLOR }`), que SUBSTITUI o `process.env` — a guarda sumia e a URL caía no
// sidecar de verdade (`127.0.0.1:11435`).
import { describe, expect, it } from 'vitest';
import { resolveMemory } from '../../src/maestro/wiring.js';

const urlOf = (m: unknown): string => (m as { mem0Url: string }).mem0Url;

describe('resolveMemory — isolamento sob teste', () => {
  it('env injetado SEM as chaves de memória ainda respeita o ALUY_MEM0_URL do processo', () => {
    expect(process.env.ALUY_MEM0_URL).toBe('http://127.0.0.1:1'); // vem do vitest.config
    const r = resolveMemory({ env: { HOME: '/tmp/x', NO_COLOR: '1' }, cwd: '/tmp/x' });
    if (r !== undefined) expect(urlOf(r.memory)).toBe('http://127.0.0.1:1');
  });

  it('ALUY_MEM_OFF do processo também vale com env injetado', () => {
    const before = process.env.ALUY_MEM_OFF;
    process.env.ALUY_MEM_OFF = '1';
    try {
      expect(resolveMemory({ env: { HOME: '/tmp/x' }, cwd: '/tmp/x' })).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.ALUY_MEM_OFF;
      else process.env.ALUY_MEM_OFF = before;
    }
  });

  it('uma URL explícita no env injetado continua valendo (quem testa o engine de propósito)', () => {
    const r = resolveMemory({
      env: { HOME: '/tmp/x', ALUY_MEM0_URL: 'http://127.0.0.1:4567' },
      cwd: '/tmp/x',
    });
    expect(r).toBeDefined();
    expect(urlOf(r!.memory)).toBe('http://127.0.0.1:4567');
  });
});
