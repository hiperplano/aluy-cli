// EGRESS-FAMILIA — o `fetch` pinado tenta TODOS os endereços validados, não só o primeiro.
//
// Achado em campo, no servidor do dono: `openrouter.ai` resolve para IPv6 PRIMEIRO, e
// aquela máquina tem rota IPv6 ANUNCIADA E MORTA (o `ip -6 route get` responde, o tráfego
// não passa). Medido lá: `curl -4` em 0,15s, `curl -6` falhando com código 7. O CLI ficava
// inteiramente inutilizável — instalação e sessão — com IPv4 saudável a um endereço de
// distância.
//
// Por que ninguém viu antes: `curl`, `aluy models` e o `fetch` do Node fazem Happy
// Eyeballs (tentam as duas famílias). Só o caminho PINADO não tentava — e ele existe
// justamente para conectar ao IP que validou, sem re-resolver (anti-SSRF PROV-SEC-1).
// Resultado: todo teste "prova que a rede está boa" passava, e o produto falhava.
//
// A GARANTIA que este arquivo protege junto: só endereços VALIDADOS são tentados. O
// conserto não pode virar "tenta outro IP quando o primeiro é recusado pela denylist".

import { describe, expect, it } from 'vitest';
import { createPinnedStreamFetch } from '../../src/model/local/pinned-stream-fetch.js';

/** Resolvedor de teste: devolve os endereços na ordem pedida. */
const resolverCom = (ips: readonly string[]) => ({
  resolve: async (): Promise<readonly string[]> => ips,
});

/** O egress CANONICALIZA o IP antes de pinar (`2606:4700::x` vira a forma expandida).
 *  Comparar pela forma crua deixaria o teste passar sem exercitar nada — a primeira
 *  conexão "morta" seria tratada como viva. */
const CANON_V6 = '2606:4700:0:0:0:0:6812:273';

/** Simula `https.request`: falha nos IPs listados, responde 200 nos demais. */
function requestQueFalhaEm(mortos: readonly string[], tentados: string[]) {
  return ((opts: Record<string, unknown>, cb: (res: unknown) => void) => {
    const emitter = {
      on(ev: string, fn: (e?: unknown) => void) {
        if (ev === 'error') this._err = fn;
        return this;
      },
      end() {
        // A opção `lookup` do agent é quem carrega o IP pinado.
        const lookup = (opts.lookup ??
          (opts.agent as { options?: { lookup?: unknown } })?.options?.lookup) as
          | ((h: string, o: unknown, c: (e: unknown, a: string, f: number) => void) => void)
          | undefined;
        let ip = '';
        lookup?.('h', {}, (_e, a) => {
          ip = a;
        });
        tentados.push(ip);
        if (mortos.includes(ip)) {
          setImmediate(() =>
            this._err?.(Object.assign(new Error('ENETUNREACH'), { code: 'ENETUNREACH' })),
          );
          return;
        }
        setImmediate(() =>
          cb({
            statusCode: 200,
            headers: {},
            on() {
              return this;
            },
            resume() {},
            pipe() {},
            [Symbol.asyncIterator]: async function* () {},
          }),
        );
      },
      destroy() {},
      setTimeout() {},
      write() {},
      _err: undefined as ((e?: unknown) => void) | undefined,
    };
    return emitter;
  }) as never;
}

describe('egress pinado — família que não conecta não derruba a chamada', () => {
  it('IPv6 morto + IPv4 vivo ⇒ CONECTA (o caso real do servidor do dono)', async () => {
    const tentados: string[] = [];
    const f = createPinnedStreamFetch({
      resolver: resolverCom(['2606:4700::6812:273', '104.18.3.115']),
      httpsRequestFn: requestQueFalhaEm([CANON_V6], tentados),
    });
    const r = await f('https://openrouter.ai/api/v1/models', { method: 'GET', headers: {} });
    expect(r.status).toBe(200);
    // Provou a ORDEM: tentou o IPv6 primeiro (como o DNS mandou) e caiu para o IPv4.
    expect(tentados).toEqual([CANON_V6, '104.18.3.115']);
  });

  it('TODOS mortos ⇒ erro que NOMEIA os endereços e as famílias', async () => {
    const tentados: string[] = [];
    const f = createPinnedStreamFetch({
      resolver: resolverCom(['2606:4700::6812:273', '104.18.3.115']),
      httpsRequestFn: requestQueFalhaEm([CANON_V6, '104.18.3.115'], tentados),
    });
    await expect(
      f('https://openrouter.ai/api/v1/models', { method: 'GET', headers: {} }),
    ).rejects.toThrow(/\(IPv6\)[\s\S]*104\.18\.3\.115 \(IPv4\)/);
    expect(tentados).toHaveLength(2);
  });

  it('só UM endereço ⇒ comportamento de sempre (não-regressão)', async () => {
    const tentados: string[] = [];
    const f = createPinnedStreamFetch({
      resolver: resolverCom(['104.18.3.115']),
      httpsRequestFn: requestQueFalhaEm([], tentados),
    });
    expect((await f('https://x.example/v1', { method: 'GET', headers: {} })).status).toBe(200);
    expect(tentados).toEqual(['104.18.3.115']);
  });

  // A INVARIANTE DE SEGURANÇA: IP interno reprova o CONJUNTO — nunca "tenta o próximo".
  it('um IP interno na lista REPROVA tudo (anti-SSRF intacto)', async () => {
    const tentados: string[] = [];
    const f = createPinnedStreamFetch({
      resolver: resolverCom(['104.18.3.115', '169.254.169.254']),
      httpsRequestFn: requestQueFalhaEm([], tentados),
    });
    await expect(f('https://x.example/v1', { method: 'GET', headers: {} })).rejects.toThrow(
      /egress recusado|IP interno/,
    );
    expect(tentados).toEqual([]); // NENHUMA conexão foi tentada
  });
});
