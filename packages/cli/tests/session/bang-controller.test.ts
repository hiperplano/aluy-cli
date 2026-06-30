// EST-0958 · CLI-SEC-3/4/9 — `!comando` no SessionController (integração TUI ↔
// catraca ↔ shell). Prova que o atalho:
//   - de leitura roda direto e vira um BLOCO DE SAÍDA `bang` (não turno do modelo);
//   - de efeito (sempre-ask) abre o AskDialog (phase `asking`) reusando o MESMO
//     TuiAskResolver — aprovar executa, negar não;
//   - em Plan ⇒ DENY (bloco `blocked`, shell não chamado);
//   - NÃO duplica a catraca (mesma engine/ports/resolver do loop do agente).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type AskResolver,
  type AskResolution,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { runLinear, type LinearOut } from '../../src/session/linear.js';

function fakePorts(): { ports: ToolPorts; ran: string[] } {
  const ran: string[] = [];
  const fs: FileSystemPort = {
    async readFile() {
      throw new Error('n/a');
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec(command) {
      ran.push(command);
      return { stdout: `saída de: ${command}`, stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { ports: { fs, shell, search }, ran };
}

/** Caller inerte — o `!comando` nunca chama o modelo. */
const inertCaller: ModelCaller = {
  async call(): Promise<ModelCallResult> {
    return { request_id: 'r', content: '', finish_reason: 'stop' };
  },
};

function build(opts: { engine?: PolicyPermissionEngine; askResolver?: TuiAskResolver } = {}): {
  controller: SessionController;
  ran: string[];
  resolver: TuiAskResolver;
} {
  const { ports, ran } = fakePorts();
  const engine = opts.engine ?? new PolicyPermissionEngine();
  const resolver = opts.askResolver ?? new TuiAskResolver();
  const controller = new SessionController({
    model: inertCaller,
    permission: engine,
    ports,
    askResolver: resolver,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  });
  return { controller, ran, resolver };
}

/** Espera a fila do ask publicar um pending (microtask spin). */
async function waitForAsk(controller: SessionController, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (controller.current.phase === 'asking') return;
    await Promise.resolve();
  }
}

describe('EST-0958 · runBang — leitura pura roda direto (bloco de saída)', () => {
  it('`!ls` (política allow) executa e vira bloco bang ok com a saída', async () => {
    const engine = new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
    });
    const { controller, ran } = build({ engine });
    await controller.runBang('ls');
    expect(ran).toEqual(['ls']);
    const bang = controller.current.blocks.find((b) => b.kind === 'bang');
    expect(bang?.kind).toBe('bang');
    if (bang?.kind === 'bang') {
      expect(bang.command).toBe('ls');
      expect(bang.status).toBe('ok');
      expect(bang.output).toContain('saída de: ls');
    }
    // NÃO é turno do modelo: nenhum bloco aluy/you criado pelo atalho.
    expect(controller.current.blocks.some((b) => b.kind === 'aluy')).toBe(false);
    expect(controller.current.phase).toBe('done');
  });
});

describe('EST-0958 · runBang — efeito (sempre-ask) abre o AskDialog e respeita a escolha', () => {
  it('`!rm -rf build` ⇒ phase asking; negar ⇒ bloco blocked, shell NÃO chamado', async () => {
    const { controller, ran } = build();
    const p = controller.runBang('rm -rf build'); // não await: precisa resolver o ask
    await waitForAsk(controller);
    expect(controller.current.phase).toBe('asking');
    // o AskDialog recebe o efeito EXATO + sempre-ask (CLI-SEC-9)
    expect(controller.current.pendingAsk?.request.effect.exact).toBe('$ rm -rf build');
    expect(controller.current.pendingAsk?.request.alwaysAsk).toBe(true);
    controller.resolveAsk({ kind: 'deny', reason: 'não' });
    await p;
    expect(ran).toEqual([]); // não executou
    const bang = controller.current.blocks.find((b) => b.kind === 'bang');
    expect(bang?.kind === 'bang' && bang.status).toBe('blocked');
    // volta ao composer (não fica preso em asking/streaming)
    expect(['idle', 'done']).toContain(controller.current.phase);
  });

  it('aprovar (approve-once) ⇒ executa e bloco vira ok', async () => {
    const { controller, ran } = build();
    const p = controller.runBang('rm -rf build');
    await waitForAsk(controller);
    controller.resolveAsk({ kind: 'approve-once' });
    await p;
    expect(ran).toEqual(['rm -rf build']);
    const bang = controller.current.blocks.find((b) => b.kind === 'bang');
    expect(bang?.kind === 'bang' && bang.status).toBe('ok');
  });
});

describe('#13 — runBang resolve IN-PLACE mesmo com bloco inserido antes do bang (anti DRIFT de índice)', () => {
  it('uma nota empurrada ENQUANTO o bang roda NÃO impede a resolução (bang vira ok, não fica running)', async () => {
    // RAIZ #2 do ghost "rodando": `runBang` capturava o índice do bang no início e
    // `updateBangBlock(idx)` resolvia POR esse índice. Um bloco paralelo inserido antes do
    // sufixo vivo (nota `↳ encaixado`/`turno interrompido`, sub-agente) DESLOCAVA o bang ⇒
    // o índice apontava p/ a nota ⇒ o guarda `kind==='bang'` falhava ⇒ a resolução era
    // DESCARTADA ⇒ o bang ficava `running` p/ sempre (ghost). O fix localiza o bang por
    // BUSCA (identidade). Aqui o shell é GATEADO p/ inserir a nota com o bang ainda vivo.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ran: string[] = [];
    const fs: FileSystemPort = {
      async readFile() {
        return '';
      },
      async writeFile() {},
      async exists() {
        return false;
      },
    };
    const shell: ShellPort = {
      async exec(command) {
        ran.push(command);
        await gate; // mantém o bang `running` até liberarmos
        return { stdout: `saída de: ${command}`, stderr: '', exitCode: 0 };
      },
    };
    const search: SearchPort = {
      async search() {
        return { matches: [], truncated: {} };
      },
    };
    const controller = new SessionController({
      model: inertCaller,
      permission: new PolicyPermissionEngine(),
      ports: { fs, shell, search },
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    });

    const p = controller.runBang('ls');
    await waitForAsk(controller);
    controller.resolveAsk({ kind: 'approve-once' });
    // espera o bang chegar a `running` (shell chamado, preso no gate).
    for (let i = 0; i < 100 && ran.length === 0; i++) await Promise.resolve();
    expect(controller.current.blocks.some((b) => b.kind === 'bang' && b.status === 'running')).toBe(
      true,
    );

    // empurra uma nota ENQUANTO o bang roda — desloca o índice do bang.
    controller.pushNote('↳ encaixado', ['oi durante o bang']);
    // a nota está ANTES do bang; o bang segue vivo no rabo.
    const idxNote = controller.current.blocks.findIndex((b) => b.kind === 'note');
    const idxBang = controller.current.blocks.findIndex((b) => b.kind === 'bang');
    expect(idxNote).toBeLessThan(idxBang);

    release();
    await p;

    // RESOLUÇÃO IN-PLACE: o MESMO bloco bang virou `ok` (não ficou `running` fantasma).
    const bang = controller.current.blocks.find((b) => b.kind === 'bang');
    expect(bang?.kind === 'bang' && bang.status).toBe('ok');
    expect(controller.current.blocks.some((b) => b.kind === 'bang' && b.status === 'running')).toBe(
      false,
    );
    expect(ran).toEqual(['ls']);
  });
});

describe('EST-0958 · runBang — Plan mode NEGA (efeito)', () => {
  it('em Plan, `!rm -rf` ⇒ bloco blocked, shell NÃO chamado, sem ask', async () => {
    const plan = new PolicyPermissionEngine({ mode: 'plan' });
    const { controller, ran } = build({ engine: plan });
    await controller.runBang('rm -rf build');
    expect(ran).toEqual([]);
    expect(controller.current.phase).not.toBe('asking'); // deny precede ask
    const bang = controller.current.blocks.find((b) => b.kind === 'bang');
    expect(bang?.kind === 'bang' && bang.status).toBe('blocked');
    if (bang?.kind === 'bang') {
      expect(bang.output).toContain('Plan'); // motivo da catraca
    }
  });
});

describe('EST-0958 · runBang — borda', () => {
  it('comando vazio (`!` sozinho) é no-op (nenhum bloco)', async () => {
    const { controller, ran } = build();
    await controller.runBang('   ');
    expect(ran).toEqual([]);
    expect(controller.current.blocks.length).toBe(0);
  });
});

describe('EST-0958 · não-TTY — `!comando` LITERAL passa pela catraca (sem ask interativo)', () => {
  function makeOut(): { out: LinearOut; text(): string } {
    const w: string[] = [];
    return { out: { write: (c) => void w.push(c) }, text: () => w.join('') };
  }

  it('`!ls` (política allow) roda e a saída sai linear como `[shell]`', async () => {
    const engine = new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
    });
    const { controller, ran } = build({ engine });
    const o = makeOut();
    await runLinear(controller, '!ls', o.out);
    expect(ran).toEqual(['ls']);
    expect(o.text()).toContain('[shell] $ ls');
    expect(o.text()).toContain('saída de: ls');
  });

  it('`!rm -rf` SEM TTY ⇒ ask sem aprovação ⇒ BLOQUEADO (catraca não cede)', async () => {
    // Sem TTY não há diálogo de ask interativo: o ambiente não-interativo NEGA por
    // fail-safe (nunca executa por inação). Modelamos isso com um AskResolver que
    // nega de imediato — exatamente o fail-safe que o não-TTY aplica. O controller
    // aceita um resolver não-Tui (o loop/bang o invocam direto), sem fila/UI.
    const denyResolver: AskResolver = {
      async resolve(): Promise<AskResolution> {
        return { kind: 'deny', reason: 'sem TTY (fail-safe)' };
      },
    };
    const { ports, ran } = fakePorts();
    const controller = new SessionController({
      model: inertCaller,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: denyResolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    });
    const o = makeOut();
    await runLinear(controller, '!rm -rf build', o.out);
    expect(ran).toEqual([]); // não executou (catraca pediu ask, ambiente negou)
    expect(o.text()).toContain('[shell] $ rm -rf build — bloqueado');
  });
});
