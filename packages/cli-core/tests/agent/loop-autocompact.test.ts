// EST-0973 — AUTO-COMPACTAÇÃO da JANELA dentro do LOOP (mockado, sem modelo real).
//
// PROVAS (loop mockado + porta de compactação mockada):
//  1. a janela cruza ~85% (mock do `tokens_in`) ⇒ o loop CHAMA a porta de
//     auto-compactação ANTES da próxima chamada do modelo, e CONTINUA (não pausa,
//     não pede confirmação) — a chamada seguinte já vê o histórico COMPACTADO;
//  2. `AUTOCOMPACT_OFF` (at:0) ⇒ NUNCA compacta (baseline puro);
//  3. ANTI-LOOP: se a janela continua cheia mesmo após compactar, o loop NÃO
//     compacta infinito — após `maxConsecutive` tentativas DESISTE (give-up) e segue
//     no baseline (o turno termina normalmente, sem travar);
//  4. observador: a UX é notificada (onStart/onDone/onGiveUp) — o usuário VÊ.

import { describe, expect, it } from 'vitest';
import { AgentLoop, type AutoCompactPort, type AutoCompactObserver } from '../../src/agent/loop.js';
import { AUTOCOMPACT_OFF, type AutoCompactConfig } from '../../src/agent/auto-compact.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { HistoryItem } from '../../src/agent/context.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import {
  MemoryFs,
  ScriptedModelCaller,
  allowAllEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

/** FS in-memory com um arquivo lido sempre disponível (read_file nunca falha). */
function fsWith(content = 'conteúdo'): MemoryFs {
  return new MemoryFs(
    new Map([
      ['README.md', content],
      ['x', content],
    ]),
  );
}

function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

const WINDOW = 200_000;
const AT = 0.85; // 85% ⇒ 170_000 tokens
const FULL = 180_000; // > limiar
const FREE = 20_000; // bem abaixo

function autoCompactCfg(over: Partial<AutoCompactConfig> = {}): AutoCompactConfig {
  return { at: AT, contextWindow: WINDOW, maxConsecutive: 2, ...over };
}

/** Marca, no histórico, que houve compactação (sumário sintético no topo). */
const COMPACTED_MARK = '[[compactado]]';

describe('EST-0973 — auto-compactação da janela no loop', () => {
  it('cruza 85% ⇒ compacta AUTOMÁTICO e CONTINUA o loop (próxima chamada vê o sumário)', async () => {
    // Turno 0: lê (tokens_in alto = janela cheia). Turno 1 (após auto-compact): final.
    const model = new ScriptedModelCaller([
      { text: `vou ler.\n${toolCallBlock('read_file', { path: 'README.md' })}`, tokensIn: FULL },
      { text: 'pronto.', tokensIn: FREE },
    ]);
    const { ports } = makePorts({ fs: fsWith() });

    const compacted: HistoryItem[] = [
      { role: 'observation', toolName: 'resumo-da-conversa', text: COMPACTED_MARK },
      { role: 'goal', text: 'faça a tarefa' },
    ];
    let portCalls = 0;
    const port: AutoCompactPort = async () => {
      portCalls += 1;
      return { history: compacted, summarizedTurns: 5 };
    };
    const events: string[] = [];
    const observer: AutoCompactObserver = {
      onStart: () => events.push('start'),
      onDone: () => events.push('done'),
      onGiveUp: () => events.push('give-up'),
    };

    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-ac',
      autoCompact: autoCompactCfg(),
      autoCompactPort: port,
      autoCompactObserver: observer,
    });

    const res = await loop.run('faça a tarefa');

    // CONTINUOU até o final (não pausou, não pediu confirmação).
    expect(res.stop.kind).toBe('final');
    // A porta foi chamada UMA vez (a janela cruzou o limiar no topo do 2º turno).
    expect(portCalls).toBe(1);
    // A UX viu a auto-compactação.
    expect(events).toContain('start');
    expect(events).toContain('done');
    // A 2ª chamada do modelo (pós-compact) já carrega o SUMÁRIO no contexto.
    expect(model.calls[1]!.messages.some((m) => m.content.includes(COMPACTED_MARK))).toBe(true);
  });

  it('OFF (at:0) ⇒ NUNCA compacta, mesmo com a janela cheia (baseline)', async () => {
    const model = new ScriptedModelCaller([
      { text: `lendo.\n${toolCallBlock('read_file', { path: 'x' })}`, tokensIn: FULL },
      { text: 'fim.', tokensIn: FULL },
    ]);
    const { ports } = makePorts({ fs: fsWith() });
    let portCalls = 0;
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      autoCompact: AUTOCOMPACT_OFF,
      autoCompactPort: async () => {
        portCalls += 1;
        return undefined;
      },
    });
    const res = await loop.run('tarefa');
    expect(res.stop.kind).toBe('final');
    expect(portCalls).toBe(0); // nunca chamou a porta (OFF)
  });

  it('ANTI-LOOP: janela cheia SEM progresso ⇒ NÃO compacta infinito (give-up, segue)', async () => {
    // Caso patológico do "stalla em 100%": a janela fica SEMPRE cheia e o modelo NÃO
    // faz progresso real — cada turno tenta ler um arquivo INEXISTENTE (a tool FALHA ⇒
    // `outcome.ok=false`, NÃO reseta o anti-loop) e a compactação não libera nada. Sem
    // o anti-loop, isto compactaria a CADA iteração p/ sempre. Com ele, após
    // `maxConsecutive` tentativas seguidas o loop DESISTE e segue no baseline.
    const lots: { text: string; tokensIn: number }[] = [];
    for (let i = 0; i < 8; i++) {
      lots.push({
        text: `passo ${i}.\n${toolCallBlock('read_file', { path: 'inexistente.txt' })}`,
        tokensIn: FULL,
      });
    }
    const model = new ScriptedModelCaller([...lots, { text: 'fim.', tokensIn: FULL }]);
    // FS sem o arquivo pedido ⇒ read_file FALHA todo turno (sem progresso real).
    const { ports } = makePorts({ fs: new MemoryFs(new Map()) });

    // A porta SEMPRE devolve um histórico "compactado" que continua cheio (compactação
    // que não libera o bastante): o `tokens_in` segue FULL ⇒ a janela nunca baixa.
    let portCalls = 0;
    const port: AutoCompactPort = async (h) => {
      portCalls += 1;
      return { history: [...h], summarizedTurns: 1 };
    };
    let gaveUp = 0;
    const observer: AutoCompactObserver = { onGiveUp: () => (gaveUp += 1) };

    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      autoCompact: autoCompactCfg({ maxConsecutive: 2 }),
      autoCompactPort: port,
      autoCompactObserver: observer,
    });

    const res = await loop.run('tarefa');
    // O turno TERMINA (não trava em loop infinito de compactar-compactar).
    expect(res.stop.kind).toBe('final');
    // Compactou no MÁXIMO `maxConsecutive` vezes; depois DESISTIU e NÃO compactou mais.
    expect(portCalls).toBe(2);
    expect(gaveUp).toBe(1); // avisou o usuário UMA vez (firstTime)
  });

  it('REGRESSÃO (fix dogfood): tools de SUCESSO entre iterações NÃO impedem o give-up', async () => {
    // O FURO original: o loop zerava `autoCompactState.consecutive` a CADA tool de
    // SUCESSO ("progresso real"). Como o agente roda tools de sucesso entre as
    // iterações, o contador NUNCA chegava a `maxConsecutive` ⇒ o give-up JAMAIS
    // disparava ⇒ loop infinito de skip a ~87% (o bug do dono no dogfood). Aqui a
    // janela fica SEMPRE cheia (FULL), a compactação NÃO ajuda (port devolve história
    // ainda cheia), MAS cada iteração roda uma tool de SUCESSO (lê um arquivo que
    // EXISTE ⇒ outcome.ok=TRUE). HOJE (antes do fix) isto NÃO desistia (consecutive
    // sempre 0). COM o fix, só a folga de janela zera o anti-loop ⇒ o give-up dispara.
    const lots: { text: string; tokensIn: number }[] = [];
    for (let i = 0; i < 8; i++) {
      lots.push({
        // README.md EXISTE no fsWith() ⇒ a tool tem SUCESSO (outcome.ok=true).
        text: `passo ${i}.\n${toolCallBlock('read_file', { path: 'README.md' })}`,
        tokensIn: FULL,
      });
    }
    const model = new ScriptedModelCaller([...lots, { text: 'fim.', tokensIn: FULL }]);
    const { ports } = makePorts({ fs: fsWith() });

    // Compactação que NUNCA libera a janela (history segue cheio ⇒ tokens_in FULL).
    let portCalls = 0;
    const port: AutoCompactPort = async (h) => {
      portCalls += 1;
      return { history: [...h], summarizedTurns: 1 };
    };
    let gaveUp = 0;
    let successfulToolsObserved = 0;
    const observer: AutoCompactObserver = { onGiveUp: () => (gaveUp += 1) };

    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      autoCompact: autoCompactCfg({ maxConsecutive: 2 }),
      autoCompactPort: port,
      autoCompactObserver: observer,
      // Conta as tools que terminaram com SUCESSO (ok=true) — o cenário que ANTES
      // mascarava o bug (cada sucesso zerava o anti-loop).
      toolObserver: {
        onToolEnd: (_call, ok) => {
          if (ok) successfulToolsObserved += 1;
        },
      },
    });

    const res = await loop.run('tarefa');
    // O turno TERMINA (não trava em loop infinito) — esta é a garantia do bounding.
    expect(res.stop.kind).toBe('final');
    // Houve tools de SUCESSO entre as iterações (o cenário que ANTES mascarava o bug).
    expect(successfulToolsObserved).toBeGreaterThanOrEqual(2);
    // Mesmo ASSIM, o anti-loop acumulou e o give-up disparou EXATAMENTE 1× (firstTime).
    expect(gaveUp).toBe(1);
    // Compactou no MÁXIMO `maxConsecutive` vezes (depois desistiu) — não infinito.
    expect(portCalls).toBe(2);
  });

  it('recuperação: a janela BAIXA do limiar ⇒ zera o anti-loop (não regride)', async () => {
    // Compacta 1×, a janela CAI abaixo do limiar (FREE) e o ramo `none` zera o
    // anti-loop; a janela enche DE NOVO mais tarde ⇒ compacta OUTRA vez do zero (o
    // give-up NÃO dispara, porque houve progresso de janela real no meio).
    const model = new ScriptedModelCaller([
      { text: `lê.\n${toolCallBlock('read_file', { path: 'README.md' })}`, tokensIn: FULL },
      // pós-1ª compactação a janela folgou (FREE) ⇒ consecutive zera; roda tool ok.
      { text: `lê2.\n${toolCallBlock('read_file', { path: 'README.md' })}`, tokensIn: FREE },
      // janela enche de novo ⇒ compacta OUTRA vez (do zero, sem give-up).
      { text: `lê3.\n${toolCallBlock('read_file', { path: 'README.md' })}`, tokensIn: FULL },
      { text: 'fim.', tokensIn: FREE },
    ]);
    const { ports } = makePorts({ fs: fsWith() });
    let portCalls = 0;
    // A compactação SEMPRE funciona: devolve história curta (a janela do PRÓXIMO turno
    // é ditada pelo `tokensIn` roteirizado acima — FREE após cada compactação útil).
    const compacted: HistoryItem[] = [
      { role: 'observation', toolName: 'resumo-da-conversa', text: COMPACTED_MARK },
      { role: 'goal', text: 'faça a tarefa' },
    ];
    const port: AutoCompactPort = async () => {
      portCalls += 1;
      return { history: [...compacted], summarizedTurns: 3 };
    };
    let gaveUp = 0;
    let dones = 0;
    const observer: AutoCompactObserver = {
      onGiveUp: () => (gaveUp += 1),
      onDone: () => (dones += 1),
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      autoCompact: autoCompactCfg({ maxConsecutive: 2 }),
      autoCompactPort: port,
      autoCompactObserver: observer,
    });
    const res = await loop.run('faça a tarefa');
    expect(res.stop.kind).toBe('final');
    // Compactou DUAS vezes NÃO-consecutivas (janela folgou no meio) — give-up NÃO dispara.
    expect(portCalls).toBe(2);
    expect(dones).toBe(2);
    expect(gaveUp).toBe(0);
  });

  it('sem porta ⇒ auto-compactação inerte (não quebra, segue baseline)', async () => {
    const model = new ScriptedModelCaller([{ text: 'oi.', tokensIn: FULL }]);
    const { ports } = makePorts();
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      autoCompact: autoCompactCfg(), // ligada, mas SEM porta
    });
    const res = await loop.run('tarefa');
    expect(res.stop.kind).toBe('final');
  });

  it('porta devolve undefined (nada a compactar/broker) ⇒ onSkip e o loop SEGUE (gracioso)', async () => {
    const model = new ScriptedModelCaller([
      { text: `lendo.\n${toolCallBlock('read_file', { path: 'README.md' })}`, tokensIn: FULL },
      { text: 'segui mesmo assim.', tokensIn: FULL },
    ]);
    const { ports } = makePorts({ fs: fsWith() });
    let skips = 0;
    let dones = 0;
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      autoCompact: autoCompactCfg(),
      autoCompactPort: async () => undefined, // não compactou
      autoCompactObserver: { onSkip: () => (skips += 1), onDone: () => (dones += 1) },
    });
    const res = await loop.run('tarefa');
    // o loop CONTINUOU (não quebrou) mesmo sem compactar.
    expect(res.stop.kind).toBe('final');
    expect(skips).toBeGreaterThanOrEqual(1); // a UI foi RESTAURADA (sem spinner pendurado)
    expect(dones).toBe(0); // nunca houve compactação de fato
  });
});
