// O teto de saída do Concierge não pode voltar a ser pequeno: com 700 tokens a resposta parava no meio
// da palavra quando o dono pedia uma tabela (relato live), e modelos que raciocinam gastavam tudo
// pensando. A brevidade vem do prompt.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('wiring — teto de saída do Concierge', () => {
  it('maxTokens do caller do Concierge é >= 2000', () => {
    const src = readFileSync(new URL('../../src/session/wiring.ts', import.meta.url), 'utf8');
    const a = src.indexOf('const conciergeStream = new StreamingModelCaller({');
    expect(a).toBeGreaterThan(0);
    const m = /maxTokens:\s*(\d+)/.exec(src.slice(a, a + 1500));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2000);
  });
});
