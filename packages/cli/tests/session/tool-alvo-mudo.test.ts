// ALVO-MUDO (dogfooding real) — no `runner.log` do serviço do dono, uma delegação
// falhada aparecia como
//
//   [tool] spawn_agent  → err
//
// Note os DOIS espaços: o alvo era string vazia. Ele sabia QUE uma delegação falhou e
// nunca QUAL — num serviço que despacha macro→quant→data-engineer→backtest em cadeia,
// é a diferença entre um log diagnosticável e um log inútil. `targetOf` só conhecia
// `command`/`path`/`pattern`/`question`, e o input do `spawn_agent` é
// `{ agents: [{ label?, goal, agent? }] }` — nenhum deles.
//
// O segundo achado: `controller.targetOfCall` (que rotula a linha VIVA `◌`) era uma
// CÓPIA desta lógica, com um comentário jurando "MESMA regra do tool-reporter.targetOf".
// A cópia já tinha DIVERGIDO — faltava o ramo de `question`. Como a resolução é
// IN-PLACE, um alvo diferente entre o start e o fim é uma linha que troca de identidade
// na frente do dono. Agora é UMA função; estes testes travam as duas coisas.

import { describe, expect, it } from 'vitest';
import { targetOf } from '../../src/session/tool-reporter.js';

describe('targetOf — spawn_agent diz QUAL agente', () => {
  it('um agente ⇒ o nome dele (o bug: string vazia)', () => {
    expect(targetOf({ agents: [{ agent: 'data-engineer', goal: 'garantir dados frescos' }] })).toBe(
      'data-engineer',
    );
  });

  it('sem `agent`, usa o `label` — curto, feito p/ identificar', () => {
    expect(targetOf({ agents: [{ label: 'macro', goal: 'ler o calendário econômico' }] })).toBe(
      'macro',
    );
  });

  it('só com `goal`, usa o goal clampado a UMA linha (último recurso)', () => {
    const t = targetOf({ agents: [{ goal: 'linha um\nlinha dois\nlinha três' }] });
    expect(t).toContain('linha um');
    expect(t).not.toContain('linha dois'); // clampado — o alvo identifica, não reproduz.
    expect(t.split('\n')).toHaveLength(1);
  });

  it('lote ⇒ conta + nomes (o serviço despacha em cadeia)', () => {
    expect(
      targetOf({
        agents: [{ agent: 'macro' }, { agent: 'quant' }, { agent: 'backtest' }].map((a) => ({
          ...a,
          goal: 'x',
        })),
      }),
    ).toBe('3 agentes: macro, quant, backtest');
  });

  it('`tasks` (tolerância retro do schema) funciona igual', () => {
    expect(targetOf({ tasks: [{ agent: 'quant', goal: 'x' }] })).toBe('quant');
  });

  it('lote vazio/sujo degrada p/ vazio sem quebrar — nunca "undefined"', () => {
    expect(targetOf({ agents: [] })).toBe('');
    expect(targetOf({ agents: [null, 42, {}] })).toBe('');
    expect(targetOf({ agents: 'não é array' })).toBe('');
  });

  it('goal só-espaço não vira alvo em branco disfarçado', () => {
    expect(targetOf({ agents: [{ goal: '   ' }] })).toBe('');
  });
});

describe('targetOf — os alvos que já funcionavam não regrediram', () => {
  it('command / path / pattern / question', () => {
    expect(targetOf({ command: 'npm test' })).toBe('npm test');
    expect(targetOf({ path: 'src/a.ts' })).toBe('src/a.ts');
    expect(targetOf({ pattern: 'TODO' })).toBe('/TODO/');
    expect(targetOf({ question: 'Qual stack?' })).toBe('"Qual stack?"');
  });

  it('heredoc multi-linha continua clampado a 1 linha', () => {
    const t = targetOf({ command: 'cat <<EOF\nlinha1\nlinha2\nEOF' });
    expect(t.split('\n')).toHaveLength(1);
    expect(t).toContain('cat');
  });

  it('`agents` tem precedência sobre um `command` que venha junto', () => {
    // Não é caso real do schema, mas trava a ORDEM: se um dia um input carregar os dois,
    // o alvo de um spawn_agent é o AGENTE — é o que identifica a ação.
    expect(targetOf({ agents: [{ agent: 'macro', goal: 'x' }], command: 'ls' })).toBe('macro');
  });
});
