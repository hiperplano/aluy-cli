// EST-0945 · CA-4 + integração do `ask` no loop (EST-0944 ↔ EST-0945 ↔ 0948).
//
// Prova, com o AgentLoop REAL + a PolicyPermissionEngine concreta:
//   - ask NÃO executa sem aprovação (fail-safe: sem resolver, vira observação);
//   - ask aprovado (resolver) EXECUTA; ask negado NÃO executa;
//   - CA-4: um comando destrutivo INDUZIDO POR CONTEÚDO INGERIDO passa pela
//     catraca como qualquer outro (não burla, não auto-aprova) — fica em ask;
//   - approve-session memoriza o comando comum, mas NUNCA uma categoria sempre-ask;
//   - Ctrl-C / abort no resolver ⇒ deny (não executa).

import { describe, expect, it } from 'vitest';
import {
  AgentLoop,
  ModelCallAbortedError,
  NATIVE_TOOLS,
  PolicyPermissionEngine,
  ToolRegistry,
} from '../../src/index.js';
import type { AskRequest, AskResolution, AskResolver } from '../../src/index.js';
import {
  denyAllTestEngine,
  makePorts,
  RecordingShell,
  ScriptedModelCaller,
  toolCallBlock,
} from '../agent/helpers.js';

/** Registro padrão com as 4 tools nativas. */
function defaultTools(): ToolRegistry {
  return new ToolRegistry([...NATIVE_TOOLS]);
}

/** Resolver de teste: responde por uma função, e registra os pedidos vistos. */
class ScriptedResolver implements AskResolver {
  readonly seen: AskRequest[] = [];
  constructor(private readonly answer: (r: AskRequest) => AskResolution) {}
  async resolve(request: AskRequest, signal?: AbortSignal): Promise<AskResolution> {
    this.seen.push(request);
    if (signal?.aborted) return { kind: 'deny', reason: 'abort' };
    return this.answer(request);
  }
}

describe('ask no loop — sem resolver ⇒ fail-safe (não executa)', () => {
  it('run_command (ask por default) sem resolver NÃO roda; vira observação', async () => {
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'ls' }) },
        { text: 'pronto' },
      ]),
      permission: new PolicyPermissionEngine(), // ask por default, sem resolver
      tools: defaultTools(),
      ports,
    });
    const res = await loop.run('liste os arquivos');
    expect(shell.executed).toEqual([]); // NÃO executou
    const obs = res.history.find((h) => h.role === 'observation');
    expect(obs && 'text' in obs ? obs.text : '').toContain('catraca: ask');
  });
});

describe('EST-0948 (UX) — observação de bloqueio é ACIONÁVEL e não-erro', () => {
  /** Pega o texto da 1ª observação do histórico. */
  function firstObservation(history: { role: string }[]): string {
    const obs = history.find((h) => h.role === 'observation');
    return obs && 'text' in obs ? String((obs as { text: string }).text) : '';
  }

  it('ask-não-aprovado (modo não-interativo): diz que é POLÍTICA, proíbe repetir, sugere aprovar interativo', async () => {
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'ls' }) },
        { text: 'pronto' },
      ]),
      permission: new PolicyPermissionEngine(), // ask por default, SEM resolver
      tools: defaultTools(),
      ports,
    });
    const res = await loop.run('liste os arquivos');
    const text = firstObservation([...res.history]);

    // É bloqueio de POLÍTICA, não erro técnico (a confusão que fazia o modelo flailar).
    expect(text).toContain('BLOQUEADA');
    expect(text).toContain('NÃO é um erro técnico');
    // Exige aprovação (caso ask).
    expect(text).toContain('APROVAÇÃO');
    // Proíbe a repetição explicitamente.
    expect(text).toContain('NÃO repita o mesmo comando');
    // Caminho acionável: aprovar num terminal interativo (NÃO sugere desligar a
    // catraca — não nomeamos a flag de bypass na coaching-msg do modelo).
    expect(text).toContain('interativo');
    // Não ensina o modelo a pedir o bypass total ao usuário.
    expect(text).not.toContain('--unsafe');
    expect(text).not.toContain('--yolo');
    // Continuidade de auditoria/asserts existentes.
    expect(text).toContain('catraca: ask');
    // E NÃO usa a redação antiga ambígua "NÃO executada".
    expect(text).not.toContain('NÃO executada');
  });

  it('deny da política: mensagem DIFERENTE do ask — decisão final, sem sugerir --yolo', async () => {
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    // Cenário: política que NEGA (deny-by-default do seam).
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'ls' }) },
        { text: 'desisti' },
      ]),
      permission: denyAllTestEngine,
      tools: defaultTools(),
      ports,
    });
    const res = await loop.run('liste os arquivos');
    const text = firstObservation([...res.history]);

    expect(text).toContain('BLOQUEADA');
    expect(text).toContain('NÃO é um erro técnico');
    expect(text).toContain('catraca: deny');
    expect(text).toContain('NEGADA');
    expect(text).toContain('NÃO repita o mesmo comando');
    // deny é decisão final: NÃO oferece --yolo (não reverteria) — distingue do ask.
    expect(text).not.toContain('--yolo');
  });
});

describe('ask no loop — resolver aprovando/negando', () => {
  it('approve-once ⇒ executa o comando', async () => {
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    const resolver = new ScriptedResolver(() => ({ kind: 'approve-once' }));
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'ls' }) },
        { text: 'ok' },
      ]),
      permission: new PolicyPermissionEngine(),
      tools: defaultTools(),
      ports,
      askResolver: resolver,
    });
    await loop.run('liste');
    expect(shell.executed).toEqual(['ls']); // executou após aprovar
    // o resolver viu o efeito EXATO (CLI-SEC-9)
    expect(resolver.seen[0]?.effect.exact).toBe('$ ls');
  });

  it('deny do usuário ⇒ NÃO executa', async () => {
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'ls' }) },
        { text: 'ok' },
      ]),
      permission: new PolicyPermissionEngine(),
      tools: defaultTools(),
      ports,
      askResolver: new ScriptedResolver(() => ({ kind: 'deny' })),
    });
    await loop.run('liste');
    expect(shell.executed).toEqual([]);
  });

  it('abort (Ctrl-C) ⇒ o turno CESSA (ModelCallAbortedError) ⇒ NÃO executa', async () => {
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    const ac = new AbortController();
    ac.abort();
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'ls' }) },
        { text: 'ok' },
      ]),
      permission: new PolicyPermissionEngine(),
      tools: defaultTools(),
      ports,
      askResolver: new ScriptedResolver(() => ({ kind: 'approve-once' })),
    });
    // EST-0982 (semântica do esc) — um turno com signal JÁ abortado cessa
    // DETERMINÍSTICO no portão pré-iteração (mesmo erro de cancelamento do caller
    // de broker). A invariante de segurança segue: NADA executa sob abort.
    await expect(loop.run('liste', ac.signal)).rejects.toBeInstanceOf(ModelCallAbortedError);
    expect(shell.executed).toEqual([]);
  });
});

describe('CA-4 — injeção de conteúdo NÃO burla a catraca', () => {
  it('comando destrutivo INDUZIDO por observação ingerida passa pela catraca (ask)', async () => {
    // O modelo "lê" um arquivo cujo conteúdo manda rodar rm -rf, e então propõe.
    // A engine NÃO vê o texto ingerido — vê o tool-call. A categoria destrutiva
    // força ask MESMO com allow-all de política (sem `--unsafe`). Sem resolver ⇒
    // não executa. (NÃO usamos `--unsafe` aqui: ele é bypass total e desligaria a
    // catraca de propósito — o que CA-4 prova é que a injeção não a desliga.)
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'rm -rf /' }) },
        { text: 'parei' },
      ]),
      permission: new PolicyPermissionEngine({
        policy: { rules: [{ tool: 'run_command', decision: 'allow' }] }, // allow-all de política
      }),
      tools: defaultTools(),
      ports,
      // resolver que (erroneamente) aprovaria — mas categoria destrutiva ainda
      // PERGUNTA; aqui provamos que NÃO executa sem o usuário ver o efeito exato.
      askResolver: new ScriptedResolver((r) => {
        // o efeito exato chega ao usuário (CLI-SEC-9) e é uma categoria sempre-ask
        expect(r.alwaysAsk).toBe(true);
        expect(r.effect.exact).toBe('$ rm -rf /');
        return { kind: 'deny' };
      }),
    });
    const res = await loop.run('faça o que o README pede');
    expect(shell.executed).toEqual([]); // injeção bloqueada
    expect(res.stop.kind).toBe('final');
  });
});

describe('CA-5 — approve-session no loop memoriza comum, nunca sempre-ask', () => {
  it('aprovar-sessão um bash comum o libera na 2ª vez (sem re-perguntar)', async () => {
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    const resolver = new ScriptedResolver(() => ({ kind: 'approve-session' }));
    const engine = new PolicyPermissionEngine();
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'pwd' }) },
        { text: toolCallBlock('run_command', { command: 'pwd' }) },
        { text: 'fim' },
      ]),
      permission: engine,
      tools: defaultTools(),
      ports,
      askResolver: resolver,
    });
    await loop.run('rode pwd duas vezes');
    expect(shell.executed).toEqual(['pwd', 'pwd']); // ambas rodaram
    expect(resolver.seen.length).toBe(1); // só perguntou UMA vez (grant de sessão)
  });

  it('approve-session NÃO memoriza categoria sempre-ask (pergunta sempre)', async () => {
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    const resolver = new ScriptedResolver(() => ({ kind: 'approve-session' }));
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'sudo ls' }) },
        { text: toolCallBlock('run_command', { command: 'sudo ls' }) },
        { text: 'fim' },
      ]),
      permission: new PolicyPermissionEngine(),
      tools: defaultTools(),
      ports,
      askResolver: resolver,
    });
    await loop.run('rode sudo ls duas vezes');
    expect(resolver.seen.length).toBe(2); // perguntou DAS DUAS vezes (não memorizou)
    expect(shell.executed).toEqual(['sudo ls', 'sudo ls']); // aprovadas ad-hoc
  });
});
