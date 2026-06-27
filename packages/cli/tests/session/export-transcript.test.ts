// EST-1013 — cobre KINDS de bloco que o switch blockToLines ainda não testava
// (deny/subagents/broker-error/note/inject/doctor/bang) + GATE de redação CLI-SEC-6.
//
// O teste de REDAÇÃO já cobre a função buildTranscript no disco
// (export-redaction.test.ts). Aqui cobrimos a SAÍDA FORMATADA de cada kind
// individualmente (o que a linha MARKDOWN produz) + mais um teste de redação
// no corpo (CLI-SEC-6) para garantir que os campos passam por redact().

import { describe, expect, it } from 'vitest';
import { buildTranscript } from '../../src/session/export-transcript.js';
import type { SessionBlock } from '../../src/session/model.js';

// Segredo sintético para o teste de redação — construído em runtime para o
// gitleaks não flagrar. O redact reconhece a forma `sk-…` igual a um real.
const SECRET = 'sk-' + 'TESTONLY' + 'fixturefixturefixture';

describe('buildTranscript — blockToLines kinds descobertos (EST-1013)', () => {
  it('deny: saída contém (negado)', () => {
    const blocks: SessionBlock[] = [{ kind: 'deny', verb: 'run_command', exact: 'rm -rf /' }];
    const md = buildTranscript(blocks);
    expect(md).toContain('(negado)');
    expect(md).toContain('`run_command rm -rf /`');
  });

  it('aluy: o RACIOCÍNIO `<think>` NÃO entra no transcript (bate com o display #358)', () => {
    const blocks: SessionBlock[] = [
      { kind: 'aluy', text: '<think>deliberando internamente</think>Resposta final ao usuário.' },
    ];
    const md = buildTranscript(blocks);
    expect(md).toContain('Resposta final ao usuário.');
    expect(md).not.toContain('<think>');
    expect(md).not.toContain('deliberando internamente');
  });

  it('subagents: lista os filhos com label e status', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'subagents',
        children: [
          { label: 'rust', status: 'done' },
          { label: 'go', status: 'fail' },
          { label: 'zig', status: 'running' },
        ],
      },
    ];
    const md = buildTranscript(blocks);
    expect(md).toContain('sub-agentes:');
    expect(md).toContain('rust (done)');
    expect(md).toContain('go (fail)');
    expect(md).toContain('zig (running)');
  });

  it('broker-error: saída contém erro de broker:', () => {
    const blocks: SessionBlock[] = [
      { kind: 'broker-error', message: 'connection refused', headline: 'broker down' },
    ];
    const md = buildTranscript(blocks);
    expect(md).toContain('erro de broker:');
    expect(md).toContain('broker down'); // headline tem precedência
  });

  it('broker-error: usa message quando headline é undefined', () => {
    const blocks: SessionBlock[] = [{ kind: 'broker-error', message: 'timeout após 30s' }];
    const md = buildTranscript(blocks);
    expect(md).toContain('erro de broker: timeout após 30s');
  });

  it('note: saída contém título e linhas como citação (> )', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'note',
        title: '/help — comandos disponíveis',
        lines: ['/help   mostra esta ajuda', '/model troca de tier'],
      },
    ];
    const md = buildTranscript(blocks);
    expect(md).toContain('> /help — comandos disponíveis');
    expect(md).toContain('> /help   mostra esta ajuda');
    expect(md).toContain('> /model troca de tier');
  });

  it('inject: saída contém (encaixado)', () => {
    const blocks: SessionBlock[] = [{ kind: 'inject', text: 'na verdade tenta com --force' }];
    const md = buildTranscript(blocks);
    expect(md).toContain('(encaixado)');
    expect(md).toContain('na verdade tenta com --force');
  });

  it('doctor: saída contém doctor: e os checks', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'doctor',
        checks: [
          { id: '1', label: 'node', status: 'ok' },
          { id: '2', label: 'npm', status: 'warn' },
          { id: '3', label: 'git', status: 'fail' },
        ],
      },
    ];
    const md = buildTranscript(blocks);
    expect(md).toContain('doctor:');
    expect(md).toContain('node ok');
    expect(md).toContain('npm warn');
    expect(md).toContain('git fail');
  });

  it('bang: saída contém o comando com prefixo !', () => {
    const blocks: SessionBlock[] = [
      { kind: 'bang', command: 'ls -la', status: 'ok', output: 'total 42\ndir1' },
    ];
    const md = buildTranscript(blocks);
    expect(md).toContain('! ls -la');
    expect(md).toContain('(ok)');
    // O output aparece como bloco de código
    expect(md).toContain('total 42');
    expect(md).toContain('dir1');
  });

  it('bang sem output: não gera bloco de código', () => {
    const blocks: SessionBlock[] = [{ kind: 'bang', command: 'echo oi', status: 'ok' }];
    const md = buildTranscript(blocks);
    expect(md).toContain('! echo oi');
    expect(md).toContain('(ok)');
    // Não deve ter ``` já que output é undefined
    expect(md).not.toContain('```');
  });
});

describe('buildTranscript — CLI-SEC-6: redação de segredo em campos de bloco', () => {
  it('redige segredo no campo text de um inject', () => {
    const blocks: SessionBlock[] = [{ kind: 'inject', text: `usa a chave ${SECRET} aqui` }];
    const md = buildTranscript(blocks);
    expect(md).not.toContain(SECRET);
    expect(md).toContain('‹redigido›');
  });

  it('redige segredo no campo command de um bang', () => {
    const blocks: SessionBlock[] = [
      { kind: 'bang', command: `export GITHUB_TOKEN=${SECRET}`, status: 'blocked' },
    ];
    const md = buildTranscript(blocks);
    expect(md).not.toContain(SECRET);
    expect(md).toContain('‹redigido›');
  });

  it('redige segredo no campo label de um child de subagents', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'subagents',
        children: [{ label: `token-${SECRET}`, status: 'done' }],
      },
    ];
    const md = buildTranscript(blocks);
    expect(md).not.toContain(SECRET);
    expect(md).toContain('‹redigido›');
  });

  it('redige segredo em headline/message de broker-error', () => {
    const blocks: SessionBlock[] = [
      { kind: 'broker-error', message: `token ${SECRET} inválido`, headline: `chave ${SECRET}` },
    ];
    const md = buildTranscript(blocks);
    expect(md).not.toContain(SECRET);
    expect(md).toContain('‹redigido›');
  });

  it('redige segredo em title/lines de note', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'note',
        title: `segredo: ${SECRET}`,
        lines: [`linha com ${SECRET}`],
      },
    ];
    const md = buildTranscript(blocks);
    expect(md).not.toContain(SECRET);
    expect(md).toContain('‹redigido›');
  });

  it('redige segredo no campo label de um check de doctor', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'doctor',
        checks: [{ id: '1', label: `secret-key-${SECRET}`, status: 'ok' }],
      },
    ];
    const md = buildTranscript(blocks);
    expect(md).not.toContain(SECRET);
    expect(md).toContain('‹redigido›');
  });
});
