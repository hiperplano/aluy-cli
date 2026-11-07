// F-TETO-DE-SAÍDA — o que o loop faz quando o provider CORTA o turno no `max_tokens`
// (`finish_reason: 'length'`).
//
// Medido em 21/09/2026 (glm-5.3 na z.ai): 8189 de 8192 tokens gastos em RACIOCÍNIO e nada
// de resposta. Ninguém lia o `finish_reason`: o turno vazio entrava no histórico como uma
// mensagem de assistente em branco, o loop rodava de novo, e o modelo degenerava a partir
// dali — sem uma palavra ao dono. Dois casos, duas respostas:
//   · sobrou FALA (cortada) ⇒ sinal `truncated` p/ a UX avisar; o loop segue como sempre;
//   · NÃO sobrou nada (nem fala, nem tool-call) ⇒ fim LIMPO com uma nota acionável —
//     continuar seria alimentar o modelo com o próprio silêncio.
import { describe, expect, it } from 'vitest';
import { AgentLoop, type ProgressSignal } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import type { ModelCallResult, ModelCaller } from '../../src/model/types.js';
import { allowAllEngine, makePorts } from './helpers.js';

/** Caller que devolve, em ordem, os `(content, finish_reason)` do roteiro. */
function callerCom(roteiro: readonly { content: string; finish: string }[]): ModelCaller {
  let i = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const item = roteiro[Math.min(i, roteiro.length - 1)]!;
      i += 1;
      return {
        request_id: 'r',
        content: item.content,
        finish_reason: item.finish,
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
      };
    },
  };
}

function loopCom(model: ModelCaller, onProgress?: (s: ProgressSignal) => void): AgentLoop {
  const { ports } = makePorts();
  return new AgentLoop({
    model,
    permission: allowAllEngine,
    tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
    ports,
    ...(onProgress ? { onProgress } : {}),
  });
}

describe('F-TETO-DE-SAÍDA · finish_reason=length no loop', () => {
  it('turno VAZIO cortado ⇒ fim limpo com nota acionável (não roda de novo às cegas)', async () => {
    const sinais: ProgressSignal[] = [];
    let chamadas = 0;
    const base = callerCom([{ content: '', finish: 'length' }]);
    const model: ModelCaller = {
      call: async (a) => {
        chamadas += 1;
        return base.call(a);
      },
    };
    const r = await loopCom(model, (s) => sinais.push(s)).run('analise o projeto');

    expect(chamadas).toBe(1); // NÃO alimentou o modelo com o próprio silêncio.
    expect(r.stop.kind).toBe('final');
    const answer = r.stop.kind === 'final' ? r.stop.answer : '';
    expect(answer).toContain('teto de saída');
    expect(answer).toContain('--max-output-tokens');
    expect(sinais).toContainEqual({ kind: 'truncated', hadContent: false });
    // A nota entra no histórico como OBSERVAÇÃO (dado), não como fala do modelo.
    expect(r.history.some((h) => h.role === 'observation' && h.text.includes('teto de saída'))).toBe(
      true,
    );
  });

  it('fala CORTADA ⇒ sinal com hadContent=true e o loop segue (a fala não se perde)', async () => {
    const sinais: ProgressSignal[] = [];
    const model = callerCom([{ content: 'metade da resposta que ia', finish: 'length' }]);
    const r = await loopCom(model, (s) => sinais.push(s)).run('explique');

    expect(sinais).toContainEqual({ kind: 'truncated', hadContent: true });
    expect(r.stop.kind).toBe('final');
    const answer = r.stop.kind === 'final' ? r.stop.answer : '';
    expect(answer).toContain('metade da resposta que ia');
  });

  it('finish_reason=stop ⇒ nenhum sinal de truncamento (não-regressão)', async () => {
    const sinais: ProgressSignal[] = [];
    await loopCom(callerCom([{ content: 'pronto.', finish: 'stop' }]), (s) => sinais.push(s)).run(
      'oi',
    );
    expect(sinais.some((s) => s.kind === 'truncated')).toBe(false);
  });
});
