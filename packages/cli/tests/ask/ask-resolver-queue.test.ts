// PEDIDOS DE APROVAÇÃO SIMULTÂNEOS NÃO PODEM SE PERDER.
//
// Visto pelo dono em 16/09: dois sub-agentes "rodando" há ~26 minutos, sem timeout e sem
// nenhum pedido na tela. O resolver guardava UM pedido (`current`): quando dois filhos pediam
// ao mesmo tempo, o segundo SOBRESCREVIA o primeiro — o primeiro nunca aparecia e a promessa
// dele nunca resolvia. Antes, o heartbeat matava esse filho aos 5 min (e mascarava o bug);
// com o relógio suspenso durante a espera por aprovação, ele ficava pendurado para sempre.
// Agora os pedidos formam uma FILA: a tela mostra um por vez, na ordem de chegada.
import { describe, expect, it } from 'vitest';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { AskRequest, AskResolution } from '@hiperplano/aluy-cli-core';

const req = (tag: string): AskRequest =>
  ({
    call: { name: 'run_command', input: { command: tag } },
    effect: { kind: 'exec', exact: tag },
    reason: `pedido ${tag}`,
  }) as unknown as AskRequest;

const exactOf = (r: TuiAskResolver): string | undefined =>
  (r.pending?.request.effect as { exact?: string } | undefined)?.exact;

describe('TuiAskResolver — fila de pedidos simultâneos', () => {
  it('o segundo pedido espera o primeiro; cada um recebe a SUA resposta', async () => {
    const r = new TuiAskResolver();
    const a = r.resolve(req('A'));
    const b = r.resolve(req('B'));
    expect(exactOf(r)).toBe('A');

    r.pending!.resolve({ kind: 'approve-once' });
    expect(exactOf(r)).toBe('B');
    r.pending!.resolve({ kind: 'deny', reason: 'não' } as AskResolution);

    expect((await a).kind).toBe('approve-once');
    expect((await b).kind).toBe('deny');
    expect(r.pending).toBeNull();
  });

  it('o observador vê a fila andar (A → B → nada)', async () => {
    const r = new TuiAskResolver();
    const seen: Array<string | null> = [];
    r.subscribe((p) => seen.push((p?.request.effect as { exact?: string })?.exact ?? null));
    const a = r.resolve(req('A'));
    const b = r.resolve(req('B'));
    r.pending!.resolve({ kind: 'approve-once' });
    r.pending!.resolve({ kind: 'approve-once' });
    await Promise.all([a, b]);
    expect(seen.filter((x, i) => x !== seen[i - 1])).toEqual([null, 'A', 'B', null]);
  });

  it('abortar um pedido que ainda está na FILA nega só ele; o da tela segue', async () => {
    const r = new TuiAskResolver();
    const ac = new AbortController();
    const a = r.resolve(req('A'));
    const b = r.resolve(req('B'), ac.signal);
    ac.abort();
    expect((await b).kind).toBe('deny');
    expect(exactOf(r)).toBe('A');
    r.pending!.resolve({ kind: 'approve-once' });
    expect((await a).kind).toBe('approve-once');
    expect(r.pending).toBeNull();
  });

  it('abortar o pedido da TELA passa a vez ao próximo', async () => {
    const r = new TuiAskResolver();
    const ac = new AbortController();
    const a = r.resolve(req('A'), ac.signal);
    const b = r.resolve(req('B'));
    ac.abort();
    expect((await a).kind).toBe('deny');
    expect(exactOf(r)).toBe('B');
    r.pending!.resolve({ kind: 'approve-once' });
    expect((await b).kind).toBe('approve-once');
  });

  it('uma resposta atrasada de um pedido já encerrado não mexe no próximo', async () => {
    const r = new TuiAskResolver();
    const a = r.resolve(req('A'));
    const first = r.pending!;
    r.resolve(req('B'));
    first.resolve({ kind: 'approve-once' });
    first.resolve({ kind: 'deny', reason: 'tarde' } as AskResolution); // repetido: ignorado
    expect((await a).kind).toBe('approve-once');
    expect(exactOf(r)).toBe('B');
  });
});
