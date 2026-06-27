// EST-1110 · ADR-0114 — tool `perguntar` (pergunta do agente ao usuário): normalização
// do input do modelo (não-confiável, tolerante à forma), formatação da resposta como
// observação (DADO) e o run da tool (porta `question` opcional + fail-safe não-pendura).
// PURO/determinístico — sem Ink/IO.

import { describe, expect, it, vi } from 'vitest';
import {
  QUESTION_TOOL,
  QUESTION_TOOL_NAME,
  normalizeQuestionInput,
  formatQuestionAnswer,
  MAX_OPTIONS,
  type QuestionAnswer,
  type QuestionPort,
  type QuestionSpec,
} from '../../src/agent/tools/question.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';

function portsWith(question?: QuestionPort): ToolPorts {
  return {
    fs: {
      async readFile() {
        return '';
      },
      async writeFile() {},
      async exists() {
        return false;
      },
    },
    shell: {
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
    ...(question ? { question } : {}),
  } as ToolPorts;
}

/** Porta que devolve uma resposta FIXA (registra a spec recebida p/ asserção). */
function stubPort(answer: QuestionAnswer): QuestionPort & { lastSpec?: QuestionSpec } {
  const port: QuestionPort & { lastSpec?: QuestionSpec } = {
    async ask(spec) {
      port.lastSpec = spec;
      return answer;
    },
  };
  return port;
}

describe('perguntar — normalizeQuestionInput (input do modelo, não-confiável)', () => {
  it('single: aceita options string/objeto e infere kind quando ausente', () => {
    const r = normalizeQuestionInput({
      question: 'Qual stack?',
      options: ['Next', { label: 'Remix', description: 'web fullstack' }],
    });
    expect('spec' in r).toBe(true);
    if (!('spec' in r)) throw new Error('parse falhou');
    expect(r.spec.kind).toBe('single'); // inferido (há options)
    expect(r.spec.options?.map((o) => o.label)).toEqual(['Next', 'Remix']);
    expect(r.spec.options?.[1]?.description).toBe('web fullstack');
    expect(r.spec.allowOther).toBe(true); // default
  });

  it('text: sem options infere kind text', () => {
    const r = normalizeQuestionInput({ question: 'Descreva o bug' });
    if (!('spec' in r)) throw new Error('parse falhou');
    expect(r.spec.kind).toBe('text');
    expect(r.spec.options).toBeUndefined();
  });

  it('multi: respeita kind explícito e allowOther:false', () => {
    const r = normalizeQuestionInput({
      kind: 'multi',
      question: 'Quais checks?',
      options: ['lint', 'test', 'build'],
      allowOther: false,
    });
    if (!('spec' in r)) throw new Error('parse falhou');
    expect(r.spec.kind).toBe('multi');
    expect(r.spec.allowOther).toBe(false);
  });

  it('aceita aliases de campo (prompt/choices)', () => {
    const r = normalizeQuestionInput({ prompt: 'P?', choices: ['a', 'b'] });
    if (!('spec' in r)) throw new Error('parse falhou');
    expect(r.spec.question).toBe('P?');
    expect(r.spec.options?.length).toBe(2);
  });

  it('CA-6: sem question ⇒ erro acionável', () => {
    const r = normalizeQuestionInput({ options: ['a'] });
    expect('error' in r).toBe(true);
  });

  it('CA-6: kind inválido ⇒ erro acionável', () => {
    const r = normalizeQuestionInput({ kind: 'radio', question: 'x', options: ['a'] });
    expect('error' in r && r.error.includes('kind')).toBe(true);
  });

  it('CA-6: single/multi sem options ⇒ erro acionável', () => {
    const r = normalizeQuestionInput({ kind: 'single', question: 'x' });
    expect('error' in r).toBe(true);
  });

  it('CA-6: option sem label ⇒ erro acionável', () => {
    const r = normalizeQuestionInput({ question: 'x', options: [{}] });
    expect('error' in r).toBe(true);
  });

  it('rejeita mais que o teto de opções', () => {
    const many = Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `o${i}`);
    const r = normalizeQuestionInput({ question: 'x', options: many });
    expect('error' in r).toBe(true);
  });
});

describe('perguntar — formatQuestionAnswer (resposta vira observação = DADO)', () => {
  const spec: QuestionSpec = {
    kind: 'single',
    question: 'Qual stack?',
    options: [],
    allowOther: true,
  };

  it('CA-1: choice ⇒ observação com a opção, ok:true', () => {
    const r = formatQuestionAnswer(spec, { kind: 'choice', index: 1, label: 'Remix' });
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('Remix');
  });

  it('CA-2: choices ⇒ observação lista todas, ok:true', () => {
    const r = formatQuestionAnswer(
      { ...spec, kind: 'multi' },
      { kind: 'choices', indices: [0, 1], labels: ['lint', 'test'] },
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('lint');
    expect(r.observation).toContain('test');
  });

  it('CA-3/CA-4: text ⇒ observação devolve o texto livre, ok:true', () => {
    const r = formatQuestionAnswer(
      { ...spec, kind: 'text' },
      { kind: 'text', text: 'um parágrafo' },
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('um parágrafo');
  });

  it('CA-5: unavailable ⇒ erro ACIONÁVEL ok:false (não re-tentar)', () => {
    const r = formatQuestionAnswer(spec, { kind: 'unavailable', reason: 'sem terminal' });
    expect(r.ok).toBe(false);
    expect(r.observation.toLowerCase()).toContain('prossiga');
  });
});

describe('perguntar — QUESTION_TOOL.run (porta opcional + fail-safe)', () => {
  it('effect read + nome estável', () => {
    expect(QUESTION_TOOL.name).toBe(QUESTION_TOOL_NAME);
    expect(QUESTION_TOOL.effect).toBe('read');
  });

  it('CA-1: chama a porta e devolve a escolha como observação', async () => {
    const port = stubPort({ kind: 'choice', index: 0, label: 'Next' });
    const r = await QUESTION_TOOL.run(
      { question: 'Qual stack?', options: ['Next', 'Remix'] },
      portsWith(port),
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('Next');
    expect(port.lastSpec?.kind).toBe('single');
  });

  it('CA-4: "Outro" (texto livre) volta como a resposta', async () => {
    const port = stubPort({ kind: 'text', text: 'GraphQL puro' });
    const r = await QUESTION_TOOL.run(
      { kind: 'single', question: 'Qual stack?', options: ['Next'] },
      portsWith(port),
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('GraphQL puro');
  });

  it('CA-5: SEM porta (não-interativo) ⇒ erro acionável, NÃO pendura', async () => {
    const r = await QUESTION_TOOL.run({ question: 'x', options: ['a'] }, portsWith(undefined));
    expect(r.ok).toBe(false);
    expect(r.observation.toLowerCase()).toContain('não foi possível');
  });

  it('CA-5: porta resolve unavailable (abort) ⇒ erro acionável', async () => {
    const port = stubPort({ kind: 'unavailable', reason: 'cancelado' });
    const r = await QUESTION_TOOL.run({ question: 'x', options: ['a'] }, portsWith(port));
    expect(r.ok).toBe(false);
  });

  it('CA-6: input inválido ⇒ ok:false, NUNCA lança', async () => {
    const port = stubPort({ kind: 'text', text: 'x' });
    const r = await QUESTION_TOOL.run({}, portsWith(port));
    expect(r.ok).toBe(false);
    expect(port.lastSpec).toBeUndefined(); // nem chegou a chamar a porta
  });

  it('porta que LANÇA ⇒ vira erro acionável (defesa em profundidade)', async () => {
    const port: QuestionPort = {
      ask: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const r = await QUESTION_TOOL.run({ question: 'x', options: ['a'] }, portsWith(port));
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('boom');
  });

  it('propaga o signal do contexto à porta', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const port: QuestionPort = {
      async ask(_spec, signal) {
        seen = signal;
        return { kind: 'text', text: 'ok' };
      },
    };
    await QUESTION_TOOL.run({ question: 'x' }, portsWith(port), { signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });
});
