import { describe, expect, it, vi } from 'vitest';
import { BrokerModelClient } from '../../src/model/broker-client.js';
import { BrokerError, BrokerTransportError } from '../../src/model/errors.js';
import { BrokerModelCaller } from '../../src/agent/model-caller.js';
import { NativeToolsCapability } from '../../src/agent/native-tools.js';
import { makeBrokerFetch, sseBody } from '../model/helpers.js';
import type { ModelCallRequest, ModelCallResult } from '../../src/model/types.js';

function happySse(sessionId = 'sess-broker'): string {
  return sseBody([
    { event: 'start', data: { request_id: 'r1', session_id: sessionId } },
    { event: 'delta', data: { content: 'oi' } },
    { event: 'usage', data: { request_id: 'r1', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ]);
}

describe('EST-0944 · BrokerModelCaller — Idempotency-Key no header', () => {
  it('repassa a key que o LOOP gerou no header Idempotency-Key', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: happySse() });
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch,
    });
    const caller = new BrokerModelCaller({ client, tier: 'aluy-flux' });

    await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'sess-A:0' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['idempotency-key']).toBe('sess-A:0');
  });

  it('RETRY de transporte reusa a MESMA key (dedup de billing)', async () => {
    let n = 0;
    const { fetch, calls } = makeBrokerFetch(() => {
      n += 1;
      if (n === 1) throw new TypeError('network down'); // falha de transporte
      return { status: 200, sse: happySse() };
    });
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch,
    });
    const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', transportRetries: 2 });

    const res = await caller.call({
      messages: [{ role: 'user', content: 'oi' }],
      idempotencyKey: 'sess-A:0',
    });

    expect(res.content).toBe('oi');
    // duas tentativas de transporte, AMBAS com a mesma key
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers['idempotency-key']).toBe('sess-A:0');
    expect(calls[1]!.headers['idempotency-key']).toBe('sess-A:0');
  });

  it('sem retry (default), falha de transporte sobe como BrokerTransportError', async () => {
    const { fetch } = makeBrokerFetch(() => {
      throw new TypeError('network down');
    });
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch,
    });
    const caller = new BrokerModelCaller({ client, tier: 'aluy-flux' });
    await expect(
      caller.call({ messages: [{ role: 'user', content: 'x' }], idempotencyKey: 'k:0' }),
    ).rejects.toBeInstanceOf(BrokerTransportError);
  });

  it('EST-0948 — SEM maxTokens ⇒ o corpo NÃO leva max_tokens (broker decide o teto de output)', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: happySse() });
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch,
    });
    const caller = new BrokerModelCaller({ client, tier: 'aluy-flux' });

    await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

    const body = calls[0]!.body as { max_tokens?: number };
    expect(body.max_tokens).toBeUndefined();
  });

  it('EST-0948 — COM maxTokens ⇒ o corpo leva max_tokens (override de output; vale p/ sub-agentes)', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: happySse() });
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch,
    });
    // O caller dos SUB-AGENTES é construído assim (wiring): com o maxTokens de output
    // resolvido. Provar aqui que o número viaja no corpo prova a propagação aos filhos.
    const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', maxTokens: 16384 });

    await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

    const body = calls[0]!.body as { max_tokens?: number };
    expect(body.max_tokens).toBe(16384);
  });

  // EST-0962 (Custom · bug do sub-agente) — a pista de modelo DINÂMICA (`tierSource`):
  // o caller dos FILHOS lê o tier + slug Custom CORRENTE do PAI, e o `model` só
  // viaja sob `tier:'custom'` (trava dupla, espelha `buildChatBody`). HG-2: o slug é
  // CHAVE de catálogo, não credencial — nenhum provider/api_key/base_url sai.
  describe('EST-0962 · tierSource — pista de modelo CORRENTE do pai (sub-agente)', () => {
    function clientOf(): {
      client: BrokerModelClient;
      calls: ReturnType<typeof makeBrokerFetch>['calls'];
    } {
      const { fetch, calls } = makeBrokerFetch({ status: 200, sse: happySse() });
      const client = new BrokerModelClient({
        baseUrl: 'https://broker.test',
        getAccessToken: async () => 'tok',
        fetch,
      });
      return { client, calls };
    }

    it('pai em tier:custom + slug ⇒ o request do FILHO inclui model:<slug>', async () => {
      const { client, calls } = clientOf();
      // `tierSource` é uma referência VIVA (o StreamingModelCaller do pai a satisfaz).
      const parent = { tier: 'custom' as const, model: 'meta-llama/llama-3.3-70b' };
      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', tierSource: parent });

      await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

      const body = calls[0]!.body as { tier?: string; model?: string };
      expect(body.tier).toBe('custom');
      expect(body.model).toBe('meta-llama/llama-3.3-70b');
    });

    it('ADR-0076 (bug do sub-agente) — pai em custom + model + PROVIDER ⇒ o FILHO inclui provider', async () => {
      const { client, calls } = clientOf();
      // Reproduz o bug do Tiago: `--provider deepseek --model deepseek-v4-pro`. ANTES do
      // fix, o filho herdava model mas NÃO o provider ⇒ ia ao default (OpenRouter) ⇒
      // "deepseek-v4-pro não existe no catálogo".
      const parent = { tier: 'custom' as const, model: 'deepseek-v4-pro', provider: 'deepseek' };
      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', tierSource: parent });

      await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

      const body = calls[0]!.body as { tier?: string; model?: string; provider?: string };
      expect(body.tier).toBe('custom');
      expect(body.model).toBe('deepseek-v4-pro');
      expect(body.provider).toBe('deepseek');
    });

    it('ADR-0076 — provider SÓ acompanha custom+model (tier canônico ⇒ sem provider)', async () => {
      const { client, calls } = clientOf();
      const parent = { tier: 'aluy-deep' as const, model: undefined, provider: 'deepseek' };
      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', tierSource: parent });

      await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

      const body = calls[0]!.body as { provider?: string };
      expect(body.provider).toBeUndefined();
    });

    it('pai em tier CANÔNICO ⇒ o FILHO NÃO manda model (HG-2 nos tiers normais)', async () => {
      const { client, calls } = clientOf();
      const parent = { tier: 'aluy-deep' as const, model: undefined };
      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', tierSource: parent });

      await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

      const body = calls[0]!.body as { tier?: string; model?: string };
      // o tier corrente do PAI vence o tier fixo de construção (dinâmico)
      expect(body.tier).toBe('aluy-deep');
      expect(body.model).toBeUndefined();
    });

    it('LEITURA DINÂMICA: trocar o custom model no pai ⇒ o PRÓXIMO call usa o novo slug', async () => {
      const { client, calls } = clientOf();
      // `parent` MUTÁVEL simula o StreamingModelCaller cujo `/model` troca o slug.
      const parent: { tier: string; model: string | undefined } = {
        tier: 'custom',
        model: 'slug-antigo',
      };
      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', tierSource: parent });

      await caller.call({ messages: [{ role: 'user', content: '1' }], idempotencyKey: 'k:0' });
      // o usuário troca o Custom no pai EM RUNTIME (entre dois spawns):
      parent.model = 'slug-novo';
      await caller.call({ messages: [{ role: 'user', content: '2' }], idempotencyKey: 'k:1' });

      expect((calls[0]!.body as { model?: string }).model).toBe('slug-antigo');
      expect((calls[1]!.body as { model?: string }).model).toBe('slug-novo');
    });

    it('LEITURA DINÂMICA: pai sai de custom p/ canônico ⇒ o FILHO para de mandar model', async () => {
      const { client, calls } = clientOf();
      const parent: { tier: string; model: string | undefined } = {
        tier: 'custom',
        model: 'slug-x',
      };
      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', tierSource: parent });

      await caller.call({ messages: [{ role: 'user', content: '1' }], idempotencyKey: 'k:0' });
      // o usuário volta p/ um tier canônico no pai:
      parent.tier = 'aluy-strata';
      parent.model = undefined;
      await caller.call({ messages: [{ role: 'user', content: '2' }], idempotencyKey: 'k:1' });

      expect((calls[0]!.body as { tier?: string; model?: string }).model).toBe('slug-x');
      const b2 = calls[1]!.body as { tier?: string; model?: string };
      expect(b2.tier).toBe('aluy-strata');
      expect(b2.model).toBeUndefined();
    });

    it('TRAVA DUPLA: slug presente mas tier canônico ⇒ model NÃO sai (defesa em profundidade)', async () => {
      const { client, calls } = clientOf();
      // estado incoerente (slug com tier não-custom): a trava do caller não o deixa vazar.
      const parent = { tier: 'aluy-flux' as const, model: 'slug-fantasma' };
      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', tierSource: parent });

      await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

      const body = calls[0]!.body as { tier?: string; model?: string };
      expect(body.tier).toBe('aluy-flux');
      expect(body.model).toBeUndefined();
    });

    it('HG-2: o corpo do FILHO NUNCA carrega provider/api_key/base_url', async () => {
      const { client, calls } = clientOf();
      const parent = { tier: 'custom' as const, model: 'algum/slug' };
      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', tierSource: parent });

      await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

      const body = calls[0]!.body as Record<string, unknown>;
      expect(body.provider).toBeUndefined();
      expect(body.api_key).toBeUndefined();
      expect(body.base_url).toBeUndefined();
      // só a pista sancionada (tier + model) viaja
      expect(body.tier).toBe('custom');
      expect(body.model).toBe('algum/slug');
    });

    it('SEM tierSource (default) ⇒ usa o tier FIXO e não manda model (não-regressão)', async () => {
      const { client, calls } = clientOf();
      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux' });

      await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

      const body = calls[0]!.body as { tier?: string; model?: string };
      expect(body.tier).toBe('aluy-flux');
      expect(body.model).toBeUndefined();
    });
  });

  it('mantém o session_id do broker entre turnos (ADR-0034)', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: happySse('S1') });
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch,
    });
    const caller = new BrokerModelCaller({ client, tier: 'aluy-flux' });

    await caller.call({ messages: [{ role: 'user', content: '1' }], idempotencyKey: 'k:0' });
    await caller.call({ messages: [{ role: 'user', content: '2' }], idempotencyKey: 'k:1' });

    // o 2º request reusa o session_id devolvido pelo 1º
    const body2 = calls[1]!.body as { session_id?: string };
    expect(body2.session_id).toBe('S1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EST-1014 — endurecimento: attachNativeTools, memo de session_id,
  //            retry de transporte e degrade 422
  // ─────────────────────────────────────────────────────────────────────────

  describe('EST-1014 · endurecimento — attachNativeTools, memo, retry, degrade', () => {
    /**
     * Client fake que grava os requests recebidos e devolve um result controlado.
     * Útil p/ testes que precisam inspecionar o request (ex.: session_id, tools)
     * sem passar pelo BrokerModelClient real + makeBrokerFetch.
     */
    class FakeClient {
      readonly calls: ModelCallRequest[] = [];
      private result: ModelCallResult;
      private behavior: 'always-ok' | 'throw-once' | 'throw-422-once';
      private throwOnceError: unknown;
      private throw422Error: unknown;
      private throwCount = 0;

      constructor(result: ModelCallResult) {
        this.result = result;
        this.behavior = 'always-ok';
        this.throwOnceError = undefined;
        this.throw422Error = undefined;
      }

      /** Configura p/ lançar `err` na 1ª chamada, ok na 2ª. */
      setThrowOnce(err: unknown): void {
        this.behavior = 'throw-once';
        this.throwOnceError = err;
        this.throwCount = 0;
      }

      /** Configura p/ lançar `err` na 1ª chamada (só quando tools presentes), ok na 2ª. */
      setThrow422Once(err: unknown): void {
        this.behavior = 'throw-422-once';
        this.throw422Error = err;
        this.throwCount = 0;
      }

      async call(args: { request: ModelCallRequest }): Promise<ModelCallResult> {
        this.calls.push(args.request);

        if (this.behavior === 'throw-once' && this.throwCount === 0) {
          this.throwCount++;
          throw this.throwOnceError;
        }

        if (
          this.behavior === 'throw-422-once' &&
          this.throwCount === 0 &&
          args.request.tools !== undefined &&
          args.request.tools.length > 0
        ) {
          this.throwCount++;
          throw this.throw422Error;
        }

        return this.result;
      }
    }

    it('(1) attachNativeTools — attach + call manda tools no request', async () => {
      const fake = new FakeClient({
        request_id: 'r1',
        content: 'ok',
        finish_reason: 'stop',
        session_id: 'sess-1',
      });
      // Precisamos de um BrokerModelClient fake que use o FakeClient internamente.
      // Mas o BrokerModelCaller recebe um BrokerModelClient, não um FakeClient.
      // Vamos criar um BrokerModelClient que delega ao FakeClient.
      const client = new BrokerModelClient({
        baseUrl: 'https://broker.test',
        getAccessToken: async () => 'tok',
        fetch: async () => {
          throw new Error('não deve chegar ao fetch');
        },
      });
      // Substituímos o método call do client pelo do fake
      client.call = vi.fn((args: { request: ModelCallRequest }) => fake.call(args));

      const cap = new NativeToolsCapability({
        tools: [
          {
            type: 'function',
            function: { name: 'ping', description: 'ping', parameters: { type: 'object' } },
          },
        ],
        supportsTools: true,
      });

      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux' });
      // ANTES do attach, shouldSendTools() é false (cap não attachada)
      // Após attach, a próxima call deve mandar tools
      caller.attachNativeTools(cap);

      await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k:0' });

      expect(fake.calls).toHaveLength(1);
      const req = fake.calls[0]!;
      expect(req.tools).toBeDefined();
      expect(req.tools).toHaveLength(1);
      expect(req.tools![0]!.function.name).toBe('ping');
      expect(req.tool_choice).toBe('auto');
    });

    it('(2) MEMO de session_id — 2º call reenvia o session_id do 1º result', async () => {
      const fake = new FakeClient({
        request_id: 'r1',
        content: 'ok',
        finish_reason: 'stop',
        session_id: 'sess-1',
      });
      const client = new BrokerModelClient({
        baseUrl: 'https://broker.test',
        getAccessToken: async () => 'tok',
        fetch: async () => {
          throw new Error('não deve chegar ao fetch');
        },
      });
      client.call = vi.fn((args: { request: ModelCallRequest }) => fake.call(args));

      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux' });

      // 1º call — sem session_id no request (broker cria)
      await caller.call({ messages: [{ role: 'user', content: '1' }], idempotencyKey: 'k:0' });
      // 2º call — deve incluir session_id: 'sess-1' (memorizado do result do 1º)
      await caller.call({ messages: [{ role: 'user', content: '2' }], idempotencyKey: 'k:1' });

      expect(fake.calls).toHaveLength(2);
      // 1º request: NÃO tem session_id (primeiro turno)
      expect(fake.calls[0]!.session_id).toBeUndefined();
      // 2º request: TEM session_id memorizado
      expect(fake.calls[1]!.session_id).toBe('sess-1');
    });

    it('(3) RETRY de transporte — 1ª falha, 2ª sucesso, client chamado 2×', async () => {
      const fake = new FakeClient({
        request_id: 'r1',
        content: 'ok',
        finish_reason: 'stop',
      });
      fake.setThrowOnce(new BrokerTransportError('rede caiu'));

      const client = new BrokerModelClient({
        baseUrl: 'https://broker.test',
        getAccessToken: async () => 'tok',
        fetch: async () => {
          throw new Error('não deve chegar ao fetch');
        },
      });
      client.call = vi.fn((args: { request: ModelCallRequest }) => fake.call(args));

      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux', transportRetries: 2 });

      const res = await caller.call({
        messages: [{ role: 'user', content: 'oi' }],
        idempotencyKey: 'k:0',
      });

      expect(res.content).toBe('ok');
      expect(fake.calls).toHaveLength(2);
    });

    it('(4) DEGRADE no 422 — 1ª com tools falha 422, 2ª sem tools sucede', async () => {
      const toolsUnsupportedErr = new BrokerError({
        status: 422,
        code: 'TOOLS_UNSUPPORTED',
        title: 'Tools unsupported',
        detail: 'modelo não suporta function-calling nativo',
      });

      const fake = new FakeClient({
        request_id: 'r1',
        content: 'ok sem tools',
        finish_reason: 'stop',
      });
      fake.setThrow422Once(toolsUnsupportedErr);

      const client = new BrokerModelClient({
        baseUrl: 'https://broker.test',
        getAccessToken: async () => 'tok',
        fetch: async () => {
          throw new Error('não deve chegar ao fetch');
        },
      });
      client.call = vi.fn((args: { request: ModelCallRequest }) => fake.call(args));

      const cap = new NativeToolsCapability({
        tools: [
          {
            type: 'function',
            function: { name: 'ping', description: 'ping', parameters: { type: 'object' } },
          },
        ],
        supportsTools: true,
      });

      const caller = new BrokerModelCaller({ client, tier: 'aluy-flux' });
      caller.attachNativeTools(cap);

      const res = await caller.call({
        messages: [{ role: 'user', content: 'oi' }],
        idempotencyKey: 'k:0',
      });

      expect(res.content).toBe('ok sem tools');
      // O caller foi chamado 2×: 1ª com tools (422), 2ª sem tools (sucesso)
      expect(fake.calls).toHaveLength(2);
      // 1ª chamada: tinha tools
      expect(fake.calls[0]!.tools).toBeDefined();
      expect(fake.calls[0]!.tools!.length).toBeGreaterThan(0);
      // 2ª chamada: NÃO tem tools (degradou)
      expect(fake.calls[1]!.tools).toBeUndefined();
      // A capacidade foi desligada
      expect(cap.isDisabled).toBe(true);
    });
  });
});
