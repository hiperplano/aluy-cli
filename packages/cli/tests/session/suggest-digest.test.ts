// F197 — testes da PONTE blocos→digest (`buildTurnDigest`) e do RESOLVER i18n
// (`resolveSuggestionText`). Prova que os blocos da sessão viram os fatos certos e que a
// sugestão de topo é a frase localizada esperada. Puro (sem TTY).

import { describe, expect, it } from 'vitest';
import type { SessionBlock } from '../../src/session/model.js';
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
const testrun = (passed: number, failed: number): SessionBlock => ({
  kind: 'testrun',
  score: { passed, failed, total: passed + failed, unknownFormat: false, failures: [] },
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
