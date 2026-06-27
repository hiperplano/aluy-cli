// HUNT-RESUME (integridade da reconstrução de sessão) — RETOMAR outra sessão AO VIVO
// (`/history` dentro de uma sessão que já teve turnos) NÃO pode vazar o contexto da
// conversa ANTERIOR na sessão retomada.
//
// O bug: `applyResumeRecord` semeava o `pendingSeed` da sessão ESCOLHIDA via
// `seedHistory(blocksToHistory(record.blocks))`, mas o contexto de CONTINUAÇÃO da
// sessão corrente (`lastRunHistory`/`compactedSeed`/`budgetResumeHistory`) seguia
// setado. No próximo `submit`, `runResolvedTurn` prependava o seed de continuação
// (`takeCompactedSeed() ?? lastRunHistory`) ALÉM do `pendingSeed` — o modelo via a
// conversa ANTERIOR **e** a retomada misturadas (vazamento entre sessões). Pior: um
// `compactedSeed` pendente VENCERIA a retomada inteira (`?? `).
//
// O fix: `applyResumeRecord` zera o contexto de continuação (`resetContinuation` →
// `controller.resetResumeContext()`) ANTES de semear a retomada — a única semente do
// próximo turno passa a ser a sessão escolhida. Espionamos as MENSAGENS que chegam ao
// caller (o contexto que o modelo VÊ), sem modelo real.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { applyResumeRecord } from '../../src/session/history.js';
import type { SessionRecord } from '../../src/io/index.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

function fakePorts(): ToolPorts {
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
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

/** Caller que CAPTURA o texto concatenado das mensagens de cada chamada (o contexto). */
function capturingCaller(): { caller: ModelCaller; lastPromptText: () => string } {
  let last = '';
  const caller: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      last = args.messages.map((m) => m.content).join('\n');
      return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
    },
  };
  return { caller, lastPromptText: () => last };
}

function buildController(model: ModelCaller): SessionController {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

/** Um record de sessão retomada com UM `you` que carrega o "marcador" da conversa B. */
function recordB(marker: string): SessionRecord {
  return {
    id: 'sessionB',
    version: 1,
    createdAt: 1,
    updatedAt: 2,
    cwd: '/proj',
    tier: 'aluy-flux',
    blocks: [{ kind: 'you', text: marker }],
  };
}

/** As deps de `applyResumeRecord` ligadas a um controller real (espelha o run.tsx). */
function resumeDeps(c: SessionController) {
  return {
    restoreBlocks: (blocks: SessionRecord['blocks']) => c.restoreBlocks(blocks),
    seedHistory: (items: Parameters<SessionController['seedHistory']>[0]) => c.seedHistory(items),
    resetContinuation: () => c.resetResumeContext(),
    switchSession: () => {},
    clearScreen: () => {},
  };
}

describe('HUNT-RESUME — /history AO VIVO não vaza a conversa anterior na sessão retomada', () => {
  it('após um turno na sessão A, retomar a sessão B NÃO carrega o contexto de A', async () => {
    const { caller, lastPromptText } = capturingCaller();
    const c = buildController(caller);
    c.dismissBoot();

    // Sessão A: um turno REAL — popula `lastRunHistory` com o fato "Apple".
    await c.submit('talk about Apple');
    expect(lastPromptText()).toContain('Apple');

    // Retoma a sessão B AO VIVO (mesmo par do `/history`: applyResumeRecord).
    applyResumeRecord(recordB('Banana from session B'), resumeDeps(c));

    // Próximo turno após a retomada:
    await c.submit('continue');
    const prompt = lastPromptText();
    // a retomada (B) está presente; a conversa anterior (A) NÃO vaza.
    expect(prompt).toContain('Banana from session B');
    expect(prompt).not.toContain('Apple');
  });

  it('a conversa ACUMULADA (vários turnos) some por inteiro ao retomar outra sessão', async () => {
    // Defesa-em-profundidade: não é só o último turno — TODO o histórico acumulado de
    // A (fato A1 + fato A2 + respostas) deve desaparecer na retomada de B.
    const { caller, lastPromptText } = capturingCaller();
    const c = buildController(caller);
    c.dismissBoot();

    await c.submit('fato A1: o céu é azul');
    await c.submit('fato A2: a grama é verde');
    // confirma que A acumulou (o 2º turno via o 1º).
    expect(lastPromptText()).toContain('fato A1: o céu é azul');

    applyResumeRecord(recordB('conversa B totalmente nova'), resumeDeps(c));
    await c.submit('continue');
    const prompt = lastPromptText();
    expect(prompt).toContain('conversa B totalmente nova');
    expect(prompt).not.toContain('fato A1: o céu é azul');
    expect(prompt).not.toContain('fato A2: a grama é verde');
  });

  it('sem resetContinuation (dep ausente) o vazamento REAPARECE — guarda contra regressão', async () => {
    // Prova que o reset é o que conserta: as MESMAS deps SEM `resetContinuation`
    // reproduzem o bug original (A vaza na retomada de B). Trava o fix no lugar.
    const { caller, lastPromptText } = capturingCaller();
    const c = buildController(caller);
    c.dismissBoot();

    await c.submit('talk about Apple');

    const deps = resumeDeps(c);
    // omite o `resetContinuation` (simula o caminho ANTES do fix): o vazamento volta.
    const depsNoReset = { ...deps, resetContinuation: undefined };
    applyResumeRecord(recordB('Banana from session B'), depsNoReset);

    await c.submit('continue');
    // SEM o reset, a conversa anterior (A) vaza junto da retomada (B) — o bug.
    expect(lastPromptText()).toContain('Apple');
  });
});
