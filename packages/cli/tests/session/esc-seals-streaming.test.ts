// EST-0965 (REGRESSÃO de render reportada em uso real) — INTERROMPER (esc) durante o
// streaming SELA o turno `aluy` parcial (`streaming:false`), em vez de deixá-lo VIVO
// para sempre. O bug: sem selar, o bloco fica `streaming:true` ⇒ NUNCA migra p/ o
// `<Static>` (isLiveBlock o trata como vivo) ⇒ PERMANECE na região viva. Ao submeter a
// PRÓXIMA mensagem, um 2º `aluy` streaming é empurrado ⇒ DOIS blocos vivos ⇒ a fala
// parcial aparece DUPLICADA, com 2 cursores `▏`, e a região viva nunca assenta (o
// flicker base do #95 volta porque o frame vivo não para de crescer/repintar).
//
// Esta é a causa-raiz dos 3 sintomas (log dobrado · flicker de volta · 3 cursores) e é
// INDEPENDENTE do overwrite-in-place (provado no harness de bytes): o overwrite só
// repinta fielmente a região viva — que estava ERRADA. O conserto é no controller
// (onError), onde o esc converge: selar o parcial como `onDone` faria.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  ModelCallAbortedError,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { isLiveBlock } from '../../src/session/render-split.js';

function fakePorts(): ToolPorts {
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
  };
}

/**
 * Caller FIEL ao StreamingModelCaller: emite onStart+onDelta (cria o bloco `aluy`
 * streaming), segura o turno até `release()`. Em ABORT (esc) LANÇA `ModelCallAbortedError`
 * — exatamente como a stream do broker rejeita ao ser cancelada — ⇒ o loop cai no
 * onError(aborted). Em release normal, chama onDone (sela) e retorna.
 */
// `holder.ctrl` é preenchido logo após `build()` — o caller só roda no `submit`, bem
// depois (sem TDZ). Evita o forward-ref de uma var `let`.
function heldStreamingCaller(holder: { ctrl: SessionController | null }): {
  caller: ModelCaller;
  release(): void;
} {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  const caller: ModelCaller = {
    async call({ signal }): Promise<ModelCallResult> {
      holder.ctrl!.sink.onStart();
      holder.ctrl!.sink.onDelta('resposta PARCIAL em curso');
      await new Promise<void>((res, rej) => {
        if (signal?.aborted) return rej(new ModelCallAbortedError());
        signal?.addEventListener('abort', () => rej(new ModelCallAbortedError()), { once: true });
        void gate.then(() => res());
      });
      holder.ctrl!.sink.onDone?.();
      return { request_id: 'r', content: 'resposta PARCIAL em curso', finish_reason: 'stop' };
    },
  };
  return { caller, release: () => resolve() };
}

function build(caller: ModelCaller): SessionController {
  return new SessionController({
    model: caller,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor: condição não assentou');
    await sleep(5);
  }
}

describe('EST-0965 — esc no streaming SELA o turno aluy parcial', () => {
  it('interromper com streaming aberto ⇒ o bloco aluy fica streaming:false (sai da região viva)', async () => {
    const holder: { ctrl: SessionController | null } = { ctrl: null };
    const held = heldStreamingCaller(holder);
    const controller = build(held.caller);
    holder.ctrl = controller;
    controller.dismissBoot();

    void controller.submit('explique o repo');
    await waitFor(() => controller.current.phase === 'streaming');
    const liveAluy = controller.current.blocks.find((b) => b.kind === 'aluy');
    expect(liveAluy?.kind).toBe('aluy');
    if (liveAluy?.kind === 'aluy') expect(liveAluy.streaming).toBe(true); // vivo durante o stream

    controller.interrupt(); // esc
    await waitFor(() => controller.current.phase === 'idle');

    const sealed = controller.current.blocks.filter((b) => b.kind === 'aluy');
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.kind === 'aluy' && sealed[0].streaming).toBe(false);
    // E ele NÃO é mais um bloco VIVO ⇒ migra p/ o <Static> (escrito 1×, sem flicker).
    expect(controller.current.blocks.every((b) => !isLiveBlock(b))).toBe(true);
  });

  it('esc no streaming + NOVA mensagem ⇒ NÃO duplica (só 1 bloco vivo, sem log dobrado)', async () => {
    // Caller MULTI-TURNO: cada `call` abre o aluy, emite 1 delta e SEGURA até o próximo
    // `release()`; em abort, rejeita (esc). 1º turno: interrompido. 2º: segue vivo.
    let release: (() => void) | null = null;
    const controller = build({
      async call({ signal }): Promise<ModelCallResult> {
        const gate = new Promise<void>((res, rej) => {
          release = res;
          signal?.addEventListener('abort', () => rej(new ModelCallAbortedError()), { once: true });
        });
        controller.sink.onStart();
        controller.sink.onDelta('resposta parcial em curso');
        await gate;
        controller.sink.onDone?.();
        return { request_id: 'r', content: 'resposta parcial em curso', finish_reason: 'stop' };
      },
    });
    controller.dismissBoot();

    void controller.submit('primeira pergunta');
    await waitFor(() => controller.current.phase === 'streaming');
    controller.interrupt(); // esc no 1º turno
    await waitFor(() => controller.current.phase === 'idle');

    void controller.submit('segunda pergunta');
    await waitFor(() => controller.current.phase === 'streaming');

    // No MÁXIMO UM bloco aluy é VIVO (streaming) — o anterior foi selado.
    const liveAluys = controller.current.blocks.filter((b) => b.kind === 'aluy' && isLiveBlock(b));
    expect(liveAluys).toHaveLength(1);
    // O log NÃO dobra: 2 blocos aluy no total (1 selado + 1 vivo), não 2 vivos.
    const allAluys = controller.current.blocks.filter((b) => b.kind === 'aluy');
    expect(allAluys).toHaveLength(2);
    expect(allAluys.filter((b) => b.kind === 'aluy' && b.streaming === true)).toHaveLength(1);

    release?.();
    await waitFor(() => controller.current.phase === 'done');
  });

  it('turno PARCIAL VAZIO (esc antes do 1º token) ⇒ o bloco aluy vazio é descartado', async () => {
    // Caller que abre o aluy (onStart) mas NÃO emite delta antes do esc.
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => (resolveGate = r));
    const controller = build({
      async call({ signal }): Promise<ModelCallResult> {
        controller.sink.onStart(); // cria o bloco aluy vazio
        await new Promise<void>((res, rej) => {
          signal?.addEventListener('abort', () => rej(new ModelCallAbortedError()), { once: true });
          void gate.then(() => res());
        });
        return { request_id: 'r', content: '', finish_reason: 'stop' };
      },
    });
    controller.dismissBoot();
    void controller.submit('pergunta');
    await waitFor(() => controller.current.blocks.some((b) => b.kind === 'aluy'));
    controller.interrupt();
    await waitFor(() => controller.current.phase === 'idle');
    // bloco aluy VAZIO é removido (não vira fantasma vazio na região viva).
    expect(controller.current.blocks.some((b) => b.kind === 'aluy')).toBe(false);
    resolveGate();
  });
});
