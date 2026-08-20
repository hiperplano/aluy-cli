// F197 — testes da PONTE blocos→digest (`buildTurnDigest`) e do RESOLVER i18n
// (`resolveSuggestionText`). Prova que os blocos da sessão viram os fatos certos e que a
// sugestão de topo é a frase localizada esperada. Puro (sem TTY).
//
// F199 — testes dos FATOS (nome de arquivo/teste/comando/erro): o digest os extrai dos
// blocos, o resolver os interpola na frase i18n (`suggest.*Named`) quando presentes e cai
// na genérica quando ausentes (não-regressão). Cobre truncamento de fato longo e ausência
// de saída crua (segredo) na frase final.

import { describe, expect, it } from 'vitest';
import type { SessionBlock } from '../../src/session/model.js';
import type { TestFailure } from '@hiperplano/aluy-cli-core';
import { buildTurnDigest } from '../../src/session/suggest-digest.js';
import { resolveSuggestionText } from '../../src/session/suggest.js';
import { i18n } from '../../src/i18n/index.js';

const t = i18n('pt-BR').t;

// Fábricas curtas de blocos.
const you = (text: string): SessionBlock => ({ kind: 'you', text });
const aluy = (text: string): SessionBlock => ({ kind: 'aluy', text, streaming: false });
const tool = (
  verb: string,
  status: 'ok' | 'err' | 'running' = 'ok',
  extra: Partial<Extract<SessionBlock, { kind: 'tool' }>> = {},
): SessionBlock => ({ kind: 'tool', verb, target: 't', result: 'r', status, ...extra });
const testrun = (
  passed: number,
  failed: number,
  failures: readonly TestFailure[] = [],
): SessionBlock => ({
  kind: 'testrun',
  score: { passed, failed, total: passed + failed, unknownFormat: false, failures },
  startedAt: 0,
  running: false,
});

describe('F197 · buildTurnDigest (blocos → fatos)', () => {
  it('sem par pergunta→resposta ⇒ hasConversation=false (não sugere)', () => {
    expect(buildTurnDigest([]).hasConversation).toBe(false);
    expect(buildTurnDigest([you('oi')]).hasConversation).toBe(false); // só usuário
  });

  it('você + aluy ⇒ hasConversation=true', () => {
    expect(buildTurnDigest([you('faça'), aluy('pronto')]).hasConversation).toBe(true);
  });

  it('tool edit ⇒ editedFiles', () => {
    const d = buildTurnDigest([you('edite'), tool('edit'), aluy('feito')]);
    expect(d.editedFiles).toBe(true);
    expect(d.explorationOnly).toBe(false);
  });

  it('só read/grep (sem edição) ⇒ explorationOnly', () => {
    const d = buildTurnDigest([you('procure'), tool('read'), tool('grep'), aluy('achei')]);
    expect(d.editedFiles).toBe(false);
    expect(d.explorationOnly).toBe(true);
  });

  it('testrun com falhas ⇒ ranTests + testsFailed + hadError', () => {
    const d = buildTurnDigest([you('teste'), tool('edit'), testrun(3, 2), aluy('ih')]);
    expect(d.ranTests).toBe(true);
    expect(d.testsFailed).toBe(true);
    expect(d.hadError).toBe(true);
  });

  it('testrun verde ⇒ ranTests, sem testsFailed/hadError', () => {
    const d = buildTurnDigest([you('teste'), tool('edit'), testrun(5, 0), aluy('ok')]);
    expect(d.ranTests).toBe(true);
    expect(d.testsFailed).toBe(false);
    expect(d.hadError).toBe(false);
  });

  it('tool com status err ⇒ hadError', () => {
    expect(buildTurnDigest([you('rode'), tool('bash', 'err'), aluy('erro')]).hadError).toBe(true);
  });

  it('deny (catraca negou) ⇒ hadError', () => {
    const deny: SessionBlock = { kind: 'deny', verb: 'bash', exact: 'rm -rf /' };
    expect(buildTurnDigest([you('apague'), deny, aluy('neguei')]).hadError).toBe(true);
  });

  it('olha SÓ o ÚLTIMO turno: um erro de turno ANTERIOR não conta', () => {
    const d = buildTurnDigest([
      you('turno 1'),
      tool('bash', 'err'), // erro no turno 1
      aluy('falhou'),
      you('turno 2'), // novo turno começa aqui
      tool('read'),
      aluy('ok'),
    ]);
    expect(d.hadError).toBe(false); // o erro do turno 1 ficou fora da janela
    expect(d.explorationOnly).toBe(true);
  });
});

describe('F197 · resolveSuggestionText (digest → frase i18n)', () => {
  it('sem conversa ⇒ undefined (nada a mostrar)', () => {
    expect(resolveSuggestionText([], t)).toBeUndefined();
  });

  it('editou sem testar ⇒ frase de RODAR os testes', () => {
    const txt = resolveSuggestionText([you('edite'), tool('edit'), aluy('feito')], t);
    expect(txt).toBe(t('suggest.runTests'));
  });

  it('testes falharam ⇒ frase de CORRIGIR as falhas', () => {
    const txt = resolveSuggestionText([you('teste'), tool('edit'), testrun(1, 1), aluy('ih')], t);
    expect(txt).toBe(t('suggest.fixFailing'));
  });

  it('turno de conversa puro ⇒ fallback próximo passo', () => {
    expect(resolveSuggestionText([you('oi'), aluy('olá')], t)).toBe(t('suggest.nextStep'));
  });
});

describe('F199 · buildTurnDigest — FATOS (arquivo/teste/comando/erro)', () => {
  it('2 arquivos editados ⇒ editedFileNames NA ORDEM, sem repetir', () => {
    const d = buildTurnDigest([
      you('edite'),
      tool('edit', 'ok', { target: 'a.ts' }),
      tool('edit', 'ok', { target: 'b.ts' }),
      tool('edit', 'ok', { target: 'a.ts' }), // repetido — não duplica
      aluy('feito'),
    ]);
    expect(d.editedFileNames).toEqual(['a.ts', 'b.ts']);
  });

  it('testrun com falha NOMEADA ⇒ failingTestName é a 1ª falha do placar', () => {
    const d = buildTurnDigest([
      you('teste'),
      tool('edit'),
      testrun(1, 2, [
        { name: 'soma deve dar 4', message: 'expected 4, got 3' },
        { name: 'subtração deve dar 1', message: 'expected 1, got 0' },
      ]),
      aluy('ih'),
    ]);
    expect(d.failingTestName).toBe('soma deve dar 4');
  });

  it('testrun com falha mas SEM nome (placar sem detalhe) ⇒ failingTestName ausente', () => {
    const d = buildTurnDigest([you('teste'), tool('edit'), testrun(1, 1), aluy('ih')]);
    expect(d.failingTestName).toBeUndefined();
  });

  it('bash de teste reconhecido ⇒ testCommand é o alvo do bloco', () => {
    const d = buildTurnDigest([
      you('rode'),
      tool('edit', 'ok', { target: 'a.ts' }),
      tool('bash', 'ok', { target: 'npm test' }),
      aluy('ok'),
    ]);
    expect(d.testCommand).toBe('npm test');
  });

  it('erro de tool ⇒ errorSummary vem da saída (output), curto', () => {
    const d = buildTurnDigest([
      you('rode'),
      tool('bash', 'err', { output: 'ECONNREFUSED 127.0.0.1:5432' }),
      aluy('deu erro'),
    ]);
    expect(d.errorSummary).toBe('ECONNREFUSED 127.0.0.1:5432');
  });

  it('deny ⇒ errorSummary é o alvo negado (dado, sem palavra hardcoded)', () => {
    const deny: SessionBlock = { kind: 'deny', verb: 'bash', exact: 'rm -rf /tmp/x' };
    const d = buildTurnDigest([you('apague'), deny, aluy('neguei')]);
    expect(d.errorSummary).toBe('rm -rf /tmp/x');
  });

  it('erro SEM saída nenhuma (bang bloqueado sem output) ⇒ errorSummary ausente', () => {
    const bang: SessionBlock = { kind: 'bang', command: 'rm -rf /', status: 'blocked' };
    const d = buildTurnDigest([you('!rm -rf /'), bang, aluy('bloqueei')]);
    expect(d.errorSummary).toBeUndefined();
  });

  it('fato longo entra no digest sem estourar (cap generoso, o core reclampa depois)', () => {
    const longOutput = 'E'.repeat(5000);
    const d = buildTurnDigest([
      you('rode'),
      tool('bash', 'err', { output: longOutput }),
      aluy('x'),
    ]);
    expect(d.errorSummary?.length).toBeLessThanOrEqual(200);
  });

  it('SEGREDO na saída de erro é REDIGIDO já no digest (defesa em camada)', () => {
    const withSecret = 'token: AKIAABCDEFGHIJKLMNOP vazou no log';
    const d = buildTurnDigest([
      you('rode'),
      tool('bash', 'err', { output: withSecret }),
      aluy('x'),
    ]);
    expect(d.errorSummary).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });
});

describe('F199 · resolveSuggestionText — sugestão PARAMETRIZADA (fato do turno)', () => {
  it('editou 2 arquivos e testes PASSARAM ⇒ "revise as mudanças em a.ts, b.ts"', () => {
    const txt = resolveSuggestionText(
      [
        you('edite os dois'),
        tool('edit', 'ok', { target: 'a.ts' }),
        tool('edit', 'ok', { target: 'b.ts' }),
        testrun(5, 0),
        aluy('feito'),
      ],
      t,
    );
    expect(txt).toBe(t('suggest.summarizeNamed', { files: 'a.ts, b.ts' }));
    expect(txt).toContain('a.ts');
    expect(txt).toContain('b.ts');
    expect(txt).not.toBe(t('suggest.summarize')); // não é mais a frase genérica
  });

  it('teste FALHOU com nome ⇒ "investigue por que "<teste>" falhou"', () => {
    const txt = resolveSuggestionText(
      [
        you('rode os testes'),
        tool('edit'),
        testrun(2, 1, [{ name: 'login rejeita senha vazia', message: 'AssertionError' }]),
        aluy('ih, quebrou'),
      ],
      t,
    );
    expect(txt).toBe(t('suggest.fixFailingNamed', { test: 'login rejeita senha vazia' }));
    expect(txt).toContain('login rejeita senha vazia');
  });

  it('SEM fato específico (placar sem nome de falha) ⇒ frase GENÉRICA (não regride)', () => {
    const txt = resolveSuggestionText(
      [you('rode'), tool('edit'), testrun(1, 1), aluy('ih')], // falha sem `failures` nomeadas
      t,
    );
    expect(txt).toBe(t('suggest.fixFailing'));
  });

  it('erro SEM saída (nada a citar) ⇒ frase GENÉRICA de retry (não regride)', () => {
    const bang: SessionBlock = { kind: 'bang', command: 'algo', status: 'blocked' };
    const txt = resolveSuggestionText([you('!algo'), bang, aluy('bloqueei')], t);
    expect(txt).toBe(t('suggest.retryDifferent'));
  });

  it('nome de teste LONGO ⇒ a frase final vem TRUNCADA (composer é 1 linha)', () => {
    const longName = 'expect isso e aquilo e mais aquilo outro '.repeat(6); // > 200 chars
    const txt = resolveSuggestionText(
      [you('rode'), tool('edit'), testrun(1, 1, [{ name: longName, message: 'x' }]), aluy('ih')],
      t,
    );
    expect(txt).toBeDefined();
    expect(txt).not.toContain(longName); // a versão CRUA não aparece
    expect(txt?.length).toBeLessThan(150);
    expect(txt).not.toContain('\n');
  });

  it('SEGREDO na mensagem de erro NUNCA aparece cru na sugestão (CLI-SEC-4/6)', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    const brokerError: SessionBlock = {
      kind: 'broker-error',
      message: `falhou ao autenticar com ${secret}`,
    };
    const txt = resolveSuggestionText([you('tente de novo'), brokerError, aluy('deu erro')], t);
    expect(txt).toBeDefined();
    expect(txt).not.toContain(secret);
  });
});
