// SUB-AGENTE EM SEGUNDO PLANO não é falha nem "concluiu".
//
// Visto pelo dono em 16/09: ESC com agentes rodando ⇒ o bloco do `spawn_agent` saía VERMELHO
// ("erro ✘"), cada filho "(error, sem sucesso)", o cabeçalho dizia que "concluíram" — e a
// sugestão do composer virava "tente outra abordagem — o erro foi…". Os filhos seguiam
// trabalhando (medido com provider falso: terminaram o `sleep` depois do ESC).
import { describe, expect, it } from 'vitest';
import { formatSubAgentResults, type SubAgentOutcome } from '../../src/agent/index.js';

const usage = { iterations: 0, toolCalls: 0, tokens: 0 };
const finished: SubAgentOutcome = { label: 'a', ok: true, result: 'feito.', stop: 'final', usage };
const detachedCount: SubAgentOutcome = {
  label: 'b',
  ok: true,
  result: 'segue rodando.',
  stop: 'final',
  usage,
  detached: true,
};

describe('formatSubAgentResults com filhos em segundo plano', () => {
  it('filho desacoplado aparece como "em segundo plano" — nunca "(final)" nem "sem sucesso"', () => {
    const txt = formatSubAgentResults([detachedCount]);
    expect(txt).toContain('── resultado do sub-agente "b" (segue em segundo plano) ──');
    expect(txt).not.toMatch(/sem sucesso|\(final\)|concluíram/);
    expect(txt).toMatch(/^1 sub-agente\(s\) seguem em segundo plano\./);
  });

  it('lote misto separa quem concluiu de quem segue', () => {
    const txt = formatSubAgentResults([finished, detachedCount]);
    expect(txt).toMatch(/^1 sub-agente\(s\) concluíram e 1 seguem em segundo plano\./);
    expect(txt).toContain('"a" (final)');
  });

  it('sem desacoplados o texto é o de sempre', () => {
    expect(formatSubAgentResults([finished])).toMatch(/^1 sub-agente\(s\) concluíram\. Os textos/);
  });
});
