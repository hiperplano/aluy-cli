// EST-0982 — `run_command` ABORTÁVEL + STREAMING no CORE (tool portável).
//
// Prova, sem modelo (input sintético direto na tool), que a `runCommandTool`:
//   • PROPAGA o `signal` do ctx à porta de shell (kill dirigido pelo loop/root-flow);
//   • PROPAGA o `onShellChunk` do ctx (streaming) à porta;
//   • REDIGE (CLI-SEC-6) a saída STREAMADA por chunk E o corpo agregado final — o
//     `onShellChunk` que o chamador recebe NUNCA carrega segredo em claro (DoD-f);
//   • reporta o encerramento por abort (`aborted`) como DADO acionável ao modelo;
//   • sem ctx, roda IDÊNTICO (não-regressão).

import { describe, expect, it } from 'vitest';
import { runCommandTool } from '../../src/agent/tools/native.js';
import { REDACTED } from '../../src/agent/journal/redact.js';
import { RecordingShell, StreamingShell, makePorts } from './helpers.js';
import type { ShellChunk } from '../../src/agent/tools/types.js';

describe('EST-0982 — runCommandTool: propagação de signal + onShellChunk', () => {
  it('propaga o signal do ctx à porta de shell (kill dirigido pelo loop)', async () => {
    const shell = new RecordingShell(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ shell });
    const ac = new AbortController();
    await runCommandTool.run({ command: 'ls' }, ports, { signal: ac.signal });
    expect(shell.lastSignal[0]).toBe(ac.signal); // o MESMO signal chegou à porta
  });

  it('propaga o onShellChunk do ctx à porta (streaming ligado)', async () => {
    const shell = new RecordingShell(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ shell });
    await runCommandTool.run({ command: 'ls' }, ports, { onShellChunk: () => {} });
    expect(shell.lastHadOnChunk[0]).toBe(true);
  });

  it('sem ctx ⇒ nem signal nem onChunk vão à porta (não-regressão)', async () => {
    const shell = new RecordingShell(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ shell });
    await runCommandTool.run({ command: 'ls' }, ports);
    expect(shell.lastSignal[0]).toBeUndefined();
    expect(shell.lastHadOnChunk[0]).toBe(false);
  });
});

describe('EST-0982 — runCommandTool: REDAÇÃO (CLI-SEC-6) da saída streamada/observada', () => {
  it('(f) cada chunk streamado é REDIGIDO antes de chegar ao chamador', async () => {
    // A porta entrega chunks BRUTOS com segredo em claro; a tool tem de redigir.
    const raw: ShellChunk[] = [
      { stream: 'stdout', text: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n' },
      { stream: 'stdout', text: 'Authorization: Bearer sk-super-secret-abcdef123456\n' },
    ];
    const shell = new StreamingShell(raw, {
      stdout: raw.map((c) => c.text).join(''),
      stderr: '',
      exitCode: 0,
    });
    const { ports } = makePorts({ shell });
    const received: ShellChunk[] = [];
    const r = await runCommandTool.run({ command: 'env' }, ports, {
      onShellChunk: (c) => received.push(c),
    });
    // O chamador recebeu chunks JÁ redigidos — nenhum token em claro.
    const streamed = received.map((c) => c.text).join('');
    expect(streamed).toContain(REDACTED);
    expect(streamed).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(streamed).not.toContain('sk-super-secret-abcdef123456');
    // E o corpo agregado (observação ao modelo) também está redigido.
    expect(r.observation).toContain(REDACTED);
    expect(r.observation).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(r.observation).not.toContain('sk-super-secret-abcdef123456');
  });

  it('o corpo agregado final é redigido mesmo SEM streaming (onChunk ausente)', async () => {
    const shell = new RecordingShell(() => ({
      stdout: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcdefghijklmnopqrstuvwxyz12',
      stderr: 'curl --password hunter2trustno1',
      exitCode: 0,
    }));
    const { ports } = makePorts({ shell });
    const r = await runCommandTool.run({ command: 'env' }, ports);
    expect(r.observation).toContain(REDACTED);
    expect(r.observation).not.toContain('wJalrXUtnFEMIabcdefghijklmnopqrstuvwxyz12');
    expect(r.observation).not.toContain('hunter2trustno1');
  });
});

describe('EST-0982 — runCommandTool: resultado de abort vira DADO acionável', () => {
  it('result.aborted ⇒ a observação avisa "interrompido pelo usuário" (não erro)', async () => {
    const shell = new RecordingShell(() => ({
      stdout: 'parcial',
      stderr: '',
      exitCode: 130,
      aborted: true,
    }));
    const { ports } = makePorts({ shell });
    const r = await runCommandTool.run({ command: 'sleep 30' }, ports, {});
    expect(r.ok).toBe(false); // exit != 0
    expect(r.observation).toMatch(/interrompido pelo usuário/i);
    expect(r.observation).toContain('exit=130');
    expect(r.observation).toContain('parcial'); // o parcial coletado é preservado
  });
});
