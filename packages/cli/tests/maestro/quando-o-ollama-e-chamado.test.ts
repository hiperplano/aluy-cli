// QUANDO o Ollama é de fato consultado — a matriz completa, contando as chamadas.
//
// A PERGUNTA QUE ORIGINOU ESTE ARQUIVO (dono, 20/09/2026): "pq quase não vejo chamadas
// ao ollama?". A resposta estava no `rege`, e não havia teste nenhum que a fixasse:
//
//   if (toggles.has('ollama') && signals.length >= 2) { ... judge.judge(...) }
//
// O juiz LLM só arbitra CONFLITO. O motor-a (heurística pura) decide sempre; o modelo
// entra quando há DOIS OU MAIS sinais no mesmo turno. Sessão saudável não produz isso,
// então o sidecar fica LIGADO E OCIOSO — que é um estado legítimo, e é justamente o que
// o chip de sidecars distingue de "desligado".
//
// MEDIDO no log do Ollama desta máquina (16/09 a 20/09, `server.log`): 57 chamadas a
// `/api/embeddings` (a memória) e ZERO a `/api/chat` (o juiz). O comportamento acima
// explica o zero por completo — não havia fio solto.
//
// Este arquivo trava esse desenho. Sem ele, mexer no gate (ou no toggle) não reprova
// nada, e o juiz passa a ser chamado — ou deixa de ser — em silêncio.
import { describe, expect, it } from 'vitest';
import {
  createSignal,
  type JudgeEngine,
  type JudgeInput,
  type JudgeResult,
  type SupervisorSignal,
} from '@hiperplano/aluy-cli-core';
import { resolveMaestro } from '../../src/maestro/wiring.js';

// ─── Stub que CONTA ────────────────────────────────────────────────────────

interface SpyJudge extends JudgeEngine {
  /** Quantas vezes `judge()` foi efetivamente chamado. */
  readonly chamadas: () => number;
  /** O último input recebido (undefined se nunca chamado). */
  readonly ultimoInput: () => JudgeInput | undefined;
}

function spyJudge(chosen = 'continuar', mode: 'llm' | 'heuristic' = 'llm'): SpyJudge {
  let n = 0;
  let last: JudgeInput | undefined;
  return {
    async judge(input: JudgeInput): Promise<JudgeResult> {
      n += 1;
      last = input;
      return {
        chosen,
        confidence: 0.5,
        reasons: [{ optionId: chosen, rationale: 'spy' }],
        mode,
      };
    },
    chamadas: () => n,
    ultimoInput: () => last,
  };
}

/** Judge que EXPLODE — para provar que o Maestro nunca derruba o turno (CA-MA8). */
function judgeQueExplode(): SpyJudge {
  let n = 0;
  return {
    async judge(): Promise<JudgeResult> {
      n += 1;
      throw new Error('ollama fora do ar');
    },
    chamadas: () => n,
    ultimoInput: () => undefined,
  };
}

const ON = { ALUY_MAESTRO: '1' } as const;

function sinal(origin: string): SupervisorSignal {
  return createSignal(origin, 'warning', Date.now(), { limitKind: 'tokens' });
}

/** n sinais distintos no mesmo turno. */
function sinais(n: number): SupervisorSignal[] {
  return Array.from({ length: n }, (_, i) => sinal(`origem-${i}`));
}

// ─── A matriz ──────────────────────────────────────────────────────────────

describe('quando o Ollama (juiz) é chamado — matriz de disparo', () => {
  it('ZERO sinais ⇒ NÃO chama o Ollama (motor-a resolve sozinho)', async () => {
    const judge = spyJudge();
    const m = resolveMaestro({ env: ON, judge });
    await m!.rege([]);
    expect(judge.chamadas()).toBe(0);
  });

  // Este é o caso que responde a pergunta do dono: um sinal sozinho NÃO é conflito.
  it('UM sinal ⇒ NÃO chama o Ollama — é o gate que explica o sidecar ocioso', async () => {
    const judge = spyJudge();
    const m = resolveMaestro({ env: ON, judge });
    await m!.rege(sinais(1));
    expect(judge.chamadas()).toBe(0);
  });

  it('DOIS sinais ⇒ chama o Ollama EXATAMENTE uma vez', async () => {
    const judge = spyJudge();
    const m = resolveMaestro({ env: ON, judge });
    await m!.rege(sinais(2));
    expect(judge.chamadas()).toBe(1);
  });

  it('TRÊS sinais ⇒ continua sendo UMA chamada por turno, não uma por sinal', async () => {
    const judge = spyJudge();
    const m = resolveMaestro({ env: ON, judge });
    await m!.rege(sinais(3));
    expect(judge.chamadas()).toBe(1);
  });

  it('dois turnos com conflito ⇒ duas chamadas (uma por turno)', async () => {
    const judge = spyJudge();
    const m = resolveMaestro({ env: ON, judge });
    await m!.rege(sinais(2));
    await m!.rege(sinais(2));
    expect(judge.chamadas()).toBe(2);
  });
});

describe('quando o Ollama NÃO é chamado — desligamentos', () => {
  it('toggle `ALUY_MAESTRO_OLLAMA=0` ⇒ conflito existe, mas o juiz não é consultado', async () => {
    const judge = spyJudge();
    const m = resolveMaestro({ env: { ...ON, ALUY_MAESTRO_OLLAMA: '0' }, judge });
    const decisao = await m!.rege(sinais(2));
    expect(judge.chamadas()).toBe(0);
    // E o turno segue: motor-a decidiu sozinho.
    expect(decisao.action).toBeTruthy();
  });

  it('`ALUY_MAESTRO=0` ⇒ não há Maestro, logo não há caminho até o Ollama', () => {
    expect(resolveMaestro({ env: { ALUY_MAESTRO: '0' }, judge: spyJudge() })).toBeUndefined();
  });

  it('kill-switch `ALUY_MAESTRO_OFF` ⇒ idem, mesmo com a flag ligada', () => {
    expect(
      resolveMaestro({ env: { ...ON, ALUY_MAESTRO_OFF: '1' }, judge: spyJudge() }),
    ).toBeUndefined();
  });
});

describe('o que é enviado quando ele É chamado', () => {
  it('o input do juiz carrega a pergunta e as opções de regência', async () => {
    const judge = spyJudge();
    const m = resolveMaestro({ env: ON, judge });
    await m!.rege(sinais(2));
    const input = judge.ultimoInput();
    expect(input).toBeDefined();
    expect(input!.question).toBeTruthy();
    // As quatro opções de regência, com ids estáveis — é sobre elas que o schema
    // enviado ao Ollama monta o `enum` (ver `judgeResponseSchema`).
    expect(input!.options.map((o) => o.id)).toEqual([
      'continuar',
      'pausar',
      'recuperar',
      'parar',
    ]);
  });
});

describe('o Ollama caindo nunca derruba o turno (CA-MA8)', () => {
  it('juiz que lança ⇒ foi chamado, e mesmo assim sai decisão do motor-a', async () => {
    const judge = judgeQueExplode();
    const m = resolveMaestro({ env: ON, judge });
    const decisao = await m!.rege(sinais(2));
    expect(judge.chamadas()).toBe(1);
    expect(decisao.action).toBeTruthy();
  });

  it('juiz que degrada (mode:heuristic) ⇒ chamado, e o motor-a é mantido', async () => {
    const judge = spyJudge('parar', 'heuristic');
    const m = resolveMaestro({ env: ON, judge });
    const decisao = await m!.rege(sinais(2));
    expect(judge.chamadas()).toBe(1);
    // `parar` veio do juiz degradado e NÃO pode virar a decisão.
    expect(decisao.action).not.toBe('parar');
  });
});
