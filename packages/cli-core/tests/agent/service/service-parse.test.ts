// ADR-0158 §1/§3/§8.3/§8.5 — PARSER de `service.md` (FALHA FECHADA RES-MD-3).
//
// Bateria: exemplo completo do ADR (frontmatter + orquestrador); comentário inline
// com aspas (`"0 9 * * 1-5"     # …`); tunável com faixa válida/inválida; circuit
// breaker sem faixa; `autonomy: ask` aceito, qualquer outro valor REJEITADO
// (v1 só `ask`); e o ponto-chave RES-MD-3 — sem `name`/corpo vazio NÃO vira
// "serviço sem orquestrador".

import { describe, expect, it } from 'vitest';
import {
  parseServiceManifest,
  isServiceManifestError,
  normalizeServiceName,
  type ServiceManifest,
} from '../../../src/index.js';

/** Atalho: parseia e exige sucesso. */
function ok(basename: string, raw: string): ServiceManifest {
  const p = parseServiceManifest(basename, raw);
  if (isServiceManifestError(p)) throw new Error(`esperava manifesto, veio erro: ${p.reason}`);
  return p;
}

/** Atalho: parseia e exige ERRO (RES-MD-3), devolvendo o motivo. */
function fail(basename: string, raw: string): string {
  const p = parseServiceManifest(basename, raw);
  if (!isServiceManifestError(p)) throw new Error(`esperava erro, veio manifesto válido`);
  return p.reason;
}

const ADR_EXAMPLE = [
  '---',
  'name: trader',
  'description: Opera contas MT5 no intradiário',
  'schedule: "0 9 * * 1-5"     # cron expr (reusa validateCronExpr de commands/cron.ts)',
  'until: "17:30"               # fim do expediente — ENFORÇADO pelo runner',
  'workflow: turno              # rotina do turno (workflows/turno.md do próprio serviço)',
  'channel: telegram:12345      # onde reporta e onde pergunta (ADR-0154)',
  'budget: 200k/turno           # teto de tokens (reusa limits.ts)',
  'autonomy: ask                # ask | yolo-scoped',
  'perda-maxima-dia: 500        # circuit breaker — atingiu ⇒ runner ENCERRA o turno (§8.3)',
  'tamanho-posicao: 2 [1..5]    # tunável com FAIXA — a retro ajusta só dentro dela (§8.5)',
  '---',
  'Você rege, não opera. Abre o turno lendo a memória do serviço e o contexto do dia;',
  'despacha as atividades da rotina; avalia na sala o que os estudos trazem; a execução',
  'é do [risco], a análise é dos estudos. Cobra fechamento, escreve o reporte no canal,',
  'roda a retro de sexta. Fora da rotina, escale pelo canal — nunca improvise execução.',
  'Sucesso num dia: operações dentro do plano, reporte enviado, nada fora do cercado.',
].join('\n');

describe('parseServiceManifest — exemplo completo do ADR-0158 §1', () => {
  it('parseia TODOS os campos do manifesto "trader" do ADR, com comentário inline', () => {
    const m = ok('service.md', ADR_EXAMPLE);
    expect(m.name).toBe('trader');
    expect(m.description).toBe('Opera contas MT5 no intradiário');
    // O valor entre aspas é extraído SEM o comentário (`# cron expr…`) colado.
    expect(m.schedule).toBe('0 9 * * 1-5');
    expect(m.until).toBe('17:30');
    expect(m.workflow).toBe('turno');
    expect(m.channel).toBe('telegram:12345');
    expect(m.budget).toBe('200k/turno');
    expect(m.autonomy).toBe('ask');
    expect(m.orchestrator).toContain('Você rege, não opera.');
    expect(m.orchestrator).toContain('Sucesso num dia');
  });

  it('circuit breaker SEM faixa (perda-maxima-dia) — min/max undefined', () => {
    const m = ok('service.md', ADR_EXAMPLE);
    const cb = m.tunables.find((t) => t.key === 'perda-maxima-dia');
    expect(cb).toEqual({ key: 'perda-maxima-dia', value: 500 });
  });

  it('tunável COM faixa (tamanho-posicao) — value/min/max capturados', () => {
    const m = ok('service.md', ADR_EXAMPLE);
    const t = m.tunables.find((t) => t.key === 'tamanho-posicao');
    expect(t).toEqual({ key: 'tamanho-posicao', value: 2, min: 1, max: 5 });
  });
});

describe('parseServiceManifest — FALHA FECHADA (RES-MD-3)', () => {
  it('sem "name" ⇒ erro, manifesto rejeitado', () => {
    const reason = fail('service.md', '---\ndescription: sem nome\n---\nOrquestrador aqui.');
    expect(reason).toMatch(/sem "name"/);
  });

  it('corpo (orquestrador) vazio ⇒ erro — mesmo com name válido', () => {
    const reason = fail('service.md', '---\nname: trader\n---\n');
    expect(reason).toMatch(/corpo vazio|sem orquestrador/);
  });

  it('autonomy diferente de "ask" ⇒ erro (v1 só aceita ask)', () => {
    const reason = fail(
      'service.md',
      '---\nname: trader\nautonomy: yolo-scoped\n---\nOrquestrador.',
    );
    expect(reason).toMatch(/autonomy.*não é suportado|v1 do ADR-0158 só aceita/);
  });

  it('autonomy: ask (case-insensitive/trim) ⇒ aceito', () => {
    const m = ok('service.md', '---\nname: trader\nautonomy:  ASK  \n---\nOrquestrador.');
    expect(m.autonomy).toBe('ask');
  });

  it('tunável com faixa malformada (min > max) ⇒ erro', () => {
    const reason = fail(
      'service.md',
      '---\nname: trader\ntamanho-posicao: 2 [5..1]\n---\nOrquestrador.',
    );
    expect(reason).toMatch(/faixa malformada/);
  });

  it('tunável com valor INICIAL fora da própria faixa ⇒ erro', () => {
    const reason = fail(
      'service.md',
      '---\nname: trader\ntamanho-posicao: 9 [1..5]\n---\nOrquestrador.',
    );
    expect(reason).toMatch(/fora da própria faixa/);
  });

  it('until fora do formato HH:MM ⇒ erro', () => {
    const reason = fail('service.md', '---\nname: trader\nuntil: "5:30pm"\n---\nOrquestrador.');
    expect(reason).toMatch(/HH:MM/);
  });

  it('channel sem a forma <conector>:<alvo> ⇒ erro', () => {
    const reason = fail('service.md', '---\nname: trader\nchannel: telegram\n---\nOrquestrador.');
    expect(reason).toMatch(/conector.*alvo|channel/);
  });
});

describe('parseServiceManifest — campos opcionais e forward-compat', () => {
  it('sem description/schedule/until/workflow/channel/budget/autonomy ⇒ todos undefined', () => {
    const m = ok('service.md', '---\nname: pesquisador\n---\nLê fontes, memoriza achados.');
    expect(m.description).toBeUndefined();
    expect(m.schedule).toBeUndefined();
    expect(m.until).toBeUndefined();
    expect(m.workflow).toBeUndefined();
    expect(m.channel).toBeUndefined();
    expect(m.budget).toBeUndefined();
    expect(m.autonomy).toBeUndefined();
    expect(m.tunables).toEqual([]);
  });

  it('chave desconhecida com valor NÃO-numérico é ignorada (forward-compat, não é erro)', () => {
    const m = ok('service.md', '---\nname: trader\nestrategia: momentum-v2\n---\nOrquestrador.');
    expect(m.tunables).toEqual([]);
  });

  it('sem frontmatter nenhum ⇒ tudo vira corpo ⇒ sem name ⇒ erro', () => {
    const reason = fail('service.md', 'Só prosa, sem frontmatter.');
    expect(reason).toMatch(/sem "name"/);
  });
});

describe('normalizeServiceName', () => {
  it('minúsculas + só [a-z0-9_-], bordas aparadas', () => {
    expect(normalizeServiceName('  Trader BR!! ')).toBe('trader-br');
  });
  it('vazio após normalizar ⇒ string vazia', () => {
    expect(normalizeServiceName('!!!')).toBe('');
  });
});
