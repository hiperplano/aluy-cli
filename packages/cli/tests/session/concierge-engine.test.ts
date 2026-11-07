// ADR 0006 — o motor mapeia o estado de uma sessão em eventos do registro; o runtime persiste
// e restaura (resume). Sessões falsas: nada de rede.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskRegistry, type AskResolution, type ConciergeModel } from '@hiperplano/aluy-cli-core';
import { ControllerTaskEngine, type TaskSession } from '../../src/session/concierge-engine.js';
import { ConciergeRuntime, type ConversationSink } from '../../src/session/concierge-runtime.js';
import type { SessionState } from '../../src/session/model.js';

class FakeSession implements TaskSession {
  state: Partial<SessionState> = { blocks: [], phase: 'idle' };
  observers = new Set<(s: SessionState) => void>();
  toolObs: {
    onToolStart?(c: { name: string }): void;
    onToolEnd?(c: { name: string }, ok: boolean): void;
  }[] = [];
  injected: string[] = [];
  interrupted = 0;
  resolved: AskResolution[] = [];
  private done!: () => void;
  get current(): SessionState {
    return this.state as SessionState;
  }
  subscribe(o: (s: SessionState) => void) {
    this.observers.add(o);
    return () => this.observers.delete(o);
  }
  addToolObserver(o: (typeof this.toolObs)[number]) {
    this.toolObs.push(o);
    return () => {};
  }
  submit(): Promise<void> {
    return new Promise((r) => (this.done = r));
  }
  injectInput(_n: string, i: string) {
    this.injected.push(i);
    return true;
  }
  interrupt() {
    this.interrupted++;
  }
  resolveAsk(r: AskResolution) {
    this.resolved.push(r);
    this.set({ pendingAsk: undefined, phase: 'streaming' });
  }
  set(p: Partial<SessionState>) {
    this.state = { ...this.state, ...p };
    for (const o of this.observers) o(this.current);
  }
  finish(blocks: SessionState['blocks'], phase: SessionState['phase'] = 'done') {
    this.state = { ...this.state, blocks: [...(this.state.blocks ?? []), ...blocks], phase };
    this.done();
  }
}

const ask = (name = 'run_command') =>
  ({
    request: { call: { name, input: {} }, effect: { exact: '$ echo oi' } },
  }) as unknown as SessionState['pendingAsk'];

function setup() {
  const registry = new TaskRegistry();
  const main = new FakeSession();
  const headless: FakeSession[] = [];
  const engine = new ControllerTaskEngine({
    registry,
    main,
    createHeadless: () => {
      const h = new FakeSession();
      headless.push(h);
      return h;
    },
  });
  return { registry, main, headless, engine };
}

describe('ControllerTaskEngine — estado da sessão vira evento do registro', () => {
  it('pedido de aprovação ⇒ waiting_approval só da tarefa dona; responder volta a running', async () => {
    const { registry, main, headless, engine } = setup();
    const t1 = registry.create({ goal: 'a', kind: 'main' });
    const t2 = registry.create({ goal: 'b', kind: 'detached' });
    engine.start(t1);
    engine.start(t2);
    main.set({ pendingAsk: ask(), phase: 'asking' });
    expect(registry.get('t1')!.status).toBe('waiting_approval');
    expect(registry.get('t2')!.status).toBe('running'); // só ela espera
    expect(engine.pendingApprovals().map((p) => p.taskId)).toEqual(['t1']);
    expect(engine.resolveApproval('t2', { kind: 'approve-once' })).toBeUndefined(); // t2 não pediu
    expect(engine.resolveApproval(undefined, { kind: 'approve-once' })).toBe('t1');
    expect(main.resolved).toHaveLength(1);
    expect(headless[0]!.resolved).toHaveLength(0);
    expect(registry.get('t1')!.status).toBe('running');
  });

  it('cota pausada ⇒ paused_quota na tarefa; as outras seguem', () => {
    const { registry, main, engine } = setup();
    engine.start(registry.create({ goal: 'a', kind: 'main' }));
    engine.start(registry.create({ goal: 'b', kind: 'detached' }));
    main.set({ quotaPause: { reason: 'cota 5h' } as SessionState['quotaPause'] });
    expect(registry.get('t1')!.status).toBe('paused_quota');
    expect(registry.get('t2')!.status).toBe('running');
    main.set({ quotaPause: undefined });
    expect(registry.get('t1')!.status).toBe('running');
  });

  it('tool start/end viram eventos e passos', () => {
    const { registry, main, engine } = setup();
    engine.start(registry.create({ goal: 'a', kind: 'main' }));
    main.toolObs[0]!.onToolStart!({ name: 'read_file' });
    expect(registry.get('t1')!.phase).toBe('tool');
    main.toolObs[0]!.onToolEnd!({ name: 'read_file' }, true);
    expect(registry.get('t1')!.steps).toBe(1);
    expect(registry.get('t1')!.phase).toBe('idle');
  });

  it('fim do turno ⇒ done com o resumo da última fala; erro ⇒ failed; parada ⇒ stopped', async () => {
    const a = setup();
    a.engine.start(a.registry.create({ goal: 'a', kind: 'main' }));
    a.main.finish([{ kind: 'aluy', text: 'refatorei tudo', streaming: false } as never]);
    await new Promise((r) => setTimeout(r, 5));
    expect(a.registry.get('t1')!.status).toBe('done');
    expect(a.registry.get('t1')!.summary).toBe('refatorei tudo');

    const b = setup();
    b.engine.start(b.registry.create({ goal: 'a', kind: 'main' }));
    b.main.finish([{ kind: 'broker-error', message: 'sem crédito' } as never], 'error');
    await new Promise((r) => setTimeout(r, 5));
    expect(b.registry.get('t1')!.status).toBe('failed');

    const c = setup();
    const t = c.registry.create({ goal: 'a', kind: 'main' });
    c.engine.start(t);
    c.engine.stop(t);
    c.main.finish([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(c.main.interrupted).toBe(1);
    expect(c.registry.get('t1')!.status).toBe('stopped');
  });

  it('send entrega pela fila de injeção da sessão da tarefa (a certa, não a outra)', () => {
    const { registry, main, headless, engine } = setup();
    engine.start(registry.create({ goal: 'a', kind: 'main' }));
    const t2 = registry.create({ goal: 'b', kind: 'detached' });
    engine.start(t2);
    expect(engine.send(t2, 'corrige').delivered).toBe(true);
    expect(headless[0]!.injected).toEqual(['corrige']);
    expect(main.injected).toEqual([]);
  });

  it('sem sessão paralela disponível ⇒ a tarefa falha com motivo (não trava)', () => {
    const registry = new TaskRegistry();
    const engine = new ControllerTaskEngine({ registry, main: new FakeSession() });
    engine.start(registry.create({ goal: 'x', kind: 'detached' }));
    expect(registry.get('t1')!.status).toBe('failed');
  });
});

describe('ConciergeRuntime — persistência e --resume', () => {
  const sink = (): ConversationSink & { replies: string[][] } => {
    const s = new FakeSession() as unknown as ConversationSink & { replies: string[][] };
    s.replies = [];
    s.pushConciergeEcho = () => {};
    s.pushConciergeReply = (l) => void s.replies.push([...l]);
    s.conciergePendingStart = () => {};
    s.conciergePendingEnd = () => {};
    s.cancelAllFlows = () => {};
    return s;
  };
  const model: ConciergeModel = {
    call: async () => ({
      request_id: 'r',
      content: 'ok',
      finish_reason: 'stop',
      tool_calls: [{ id: '1', name: 'task_start', input: { goal: 'migrar o banco' } }],
    }),
  };

  it('grava tarefas e histórico (0600) e restaura: o que estava vivo volta interrompido', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conc-'));
    const path = join(dir, 'c', 's.json');
    const s1 = sink();
    const rt1 = new ConciergeRuntime({ sink: s1, model, storePath: () => path });
    await rt1.handleOwnerMessage('migre o banco');
    expect(rt1.registry.get('t1')!.status).toBe('running');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.tasks[0].goal).toBe('migrar o banco');

    const s2 = sink();
    const rt2 = new ConciergeRuntime({ sink: s2, model, storePath: () => path });
    expect(rt2.registry.get('t1')!.status).toBe('interrupted');
    expect(rt2.concierge.getHistory().length).toBe(2);
    expect(s2.replies.flat().join(' ')).toContain('interrompida');
    // ids novos não colidem com os restaurados
    expect(rt2.registry.create({ goal: 'x', kind: 'detached' }).id).toBe('t2');
  });

  it('arquivo corrompido não derruba: começa limpo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conc-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{nao json');
    const rt = new ConciergeRuntime({ sink: sink(), model, storePath: () => path });
    expect(rt.registry.list()).toHaveLength(0);
  });
});
