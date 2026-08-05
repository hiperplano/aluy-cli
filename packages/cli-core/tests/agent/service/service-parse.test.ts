// ADR-0158 §1/§3/§8.3/§8.5 — PARSER de `service.md` (FALHA FECHADA RES-MD-3).
//
// Bateria: exemplo completo do ADR (frontmatter + orquestrador); comentário inline
// com aspas (`"0 9 * * 1-5"     # …`); tunável com faixa válida/inválida; circuit
// breaker sem faixa; `autonomy: ask`/`autonomy: yolo-scoped` aceitos, qualquer
// outro valor REJEITADO; e o ponto-chave RES-MD-3 — sem `name`/corpo vazio NÃO
// vira "serviço sem orquestrador".

import { describe, expect, it } from 'vitest';
import {
  parseServiceManifest,
  isServiceManifestError,
  isSafeGroupLabel,
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
  'activity-timeout: sem-teto   # teto por atividade — default 30min, sem-teto remove',
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
    expect(m.activityTimeout).toBe('sem-teto');
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

  it('autonomy diferente de "ask"/"yolo-scoped" ⇒ erro (fail-closed)', () => {
    const reason = fail(
      'service.md',
      '---\nname: trader\nautonomy: sempre-executa\n---\nOrquestrador.',
    );
    expect(reason).toMatch(/autonomy.*não é suportado/);
  });

  it('autonomy: ask (case-insensitive/trim) ⇒ aceito', () => {
    const m = ok('service.md', '---\nname: trader\nautonomy:  ASK  \n---\nOrquestrador.');
    expect(m.autonomy).toBe('ask');
  });

  it('autonomy: yolo-scoped (case-insensitive/trim) ⇒ aceito — o modo autônomo confinado', () => {
    const m = ok('service.md', '---\nname: trader\nautonomy:  YOLO-SCOPED  \n---\nOrquestrador.');
    expect(m.autonomy).toBe('yolo-scoped');
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

  it('tunável com valor INICIAL exatamente NO limite (min ou max) ⇒ ACEITO (faixa é inclusiva)', () => {
    // A validação é `value < min || value > max` — sem isto, um mutante que
    // troca por `<=`/`>=` (limite EXCLUSIVO) passa despercebido, já que os
    // outros testes só cobrem valor estritamente DENTRO (2 em [1..5]) ou
    // estritamente FORA (9 em [1..5]), nunca exatamente NO limite.
    const atMin = ok('service.md', '---\nname: trader\ntamanho-posicao: 1 [1..5]\n---\nOrquestrador.');
    expect(atMin.tunables.find((t) => t.key === 'tamanho-posicao')).toEqual({
      key: 'tamanho-posicao',
      value: 1,
      min: 1,
      max: 5,
    });
    const atMax = ok('service.md', '---\nname: trader\ntamanho-posicao: 5 [1..5]\n---\nOrquestrador.');
    expect(atMax.tunables.find((t) => t.key === 'tamanho-posicao')).toEqual({
      key: 'tamanho-posicao',
      value: 5,
      min: 1,
      max: 5,
    });
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
  it('sem description/schedule/until/workflow/channel/budget/activity-timeout/autonomy ⇒ todos undefined', () => {
    const m = ok('service.md', '---\nname: pesquisador\n---\nLê fontes, memoriza achados.');
    expect(m.description).toBeUndefined();
    expect(m.schedule).toBeUndefined();
    expect(m.until).toBeUndefined();
    expect(m.workflow).toBeUndefined();
    expect(m.channel).toBeUndefined();
    expect(m.budget).toBeUndefined();
    expect(m.activityTimeout).toBeUndefined();
    expect(m.autonomy).toBeUndefined();
    expect(m.immediate).toBeUndefined();
    expect(m.tunables).toEqual([]);
    expect(m.ignoredFrontmatterKeys).toEqual([]);
  });

  it('"activity-timeout: 45m" ⇒ campo cru pass-through (parsing semântico é do runner)', () => {
    const m = ok('service.md', '---\nname: trader\nactivity-timeout: 45m\n---\nOrquestrador.');
    expect(m.activityTimeout).toBe('45m');
  });

  it('"activity-timeout:" é chave CONHECIDA — nunca vira tunável, mesmo com valor não-numérico', () => {
    const m = ok('service.md', '---\nname: trader\nactivity-timeout: sem-teto\n---\nOrquestrador.');
    expect(m.tunables).toEqual([]);
    expect(m.activityTimeout).toBe('sem-teto');
  });

  it('chave desconhecida com valor NÃO-numérico é ignorada (forward-compat, não é erro) — mas aparece em ignoredFrontmatterKeys', () => {
    const m = ok('service.md', '---\nname: trader\nestrategia: momentum-v2\n---\nOrquestrador.');
    expect(m.tunables).toEqual([]);
    expect(m.ignoredFrontmatterKeys).toEqual(['estrategia']);
  });

  it('sem frontmatter nenhum ⇒ tudo vira corpo ⇒ sem name ⇒ erro', () => {
    const reason = fail('service.md', 'Só prosa, sem frontmatter.');
    expect(reason).toMatch(/sem "name"/);
  });
});

// Descoberta entre serviços (`group:`) — como um maestro acha seus irmãos de mesa
// (`aluy service list/start/stop --group`). RÓTULO puro: sem semântica de execução.
describe('parseServiceManifest — group: (descoberta entre serviços)', () => {
  it('"group: mesa-trading" ⇒ campo cru pass-through', () => {
    const m = ok('service.md', '---\nname: trader\ngroup: mesa-trading\n---\nOrquestrador.');
    expect(m.group).toBe('mesa-trading');
  });

  it('sem "group:" ⇒ undefined (zero regressão p/ quem não usa)', () => {
    const m = ok('service.md', '---\nname: trader\n---\nOrquestrador.');
    expect(m.group).toBeUndefined();
  });

  it('"group:" com "/" ⇒ erro (fail-closed, não é identificador simples)', () => {
    const reason = fail('service.md', '---\nname: trader\ngroup: mesa/trading\n---\nOrquestrador.');
    expect(reason).toMatch(/group/);
  });

  it('"group:" com ".." ⇒ erro (fail-closed)', () => {
    const reason = fail('service.md', '---\nname: trader\ngroup: ../mesa\n---\nOrquestrador.');
    expect(reason).toMatch(/group/);
  });

  it('"group:" com byte nulo ⇒ erro (fail-closed)', () => {
    const reason = fail('service.md', '---\nname: trader\ngroup: mesa\0x\n---\nOrquestrador.');
    expect(reason).toMatch(/group/);
  });

  it('"group:" vazio (só espaços) ⇒ tratado como ausente, não erro', () => {
    const m = ok('service.md', '---\nname: trader\ngroup:    \n---\nOrquestrador.');
    expect(m.group).toBeUndefined();
  });
});

describe('isSafeGroupLabel', () => {
  it('aceita identificador simples', () => {
    expect(isSafeGroupLabel('mesa-trading')).toBe(true);
    expect(isSafeGroupLabel('mesa_2')).toBe(true);
  });
  it('recusa vazio/"/"/".."/ byte nulo', () => {
    expect(isSafeGroupLabel('')).toBe(false);
    expect(isSafeGroupLabel('  ')).toBe(false);
    expect(isSafeGroupLabel('a/b')).toBe(false);
    expect(isSafeGroupLabel('a..b')).toBe(false);
    expect(isSafeGroupLabel('a\0b')).toBe(false);
  });
});

// `model:` — fixa o modelo do TURNO do serviço (não depende do default global).
describe('parseServiceManifest — model: (modelo fixo por serviço)', () => {
  it('"model: xiaomi/mimo-v2.5-pro" ⇒ campo cru pass-through (slug com "/")', () => {
    const m = ok('service.md', '---\nname: trader\nmodel: xiaomi/mimo-v2.5-pro\n---\nOrquestrador.');
    expect(m.model).toBe('xiaomi/mimo-v2.5-pro');
  });

  it('sem "model:" ⇒ undefined (zero regressão — runner usa o default global)', () => {
    const m = ok('service.md', '---\nname: trader\n---\nOrquestrador.');
    expect(m.model).toBeUndefined();
  });

  it('"model:" com byte de controle ⇒ erro (fail-closed)', () => {
    const reason = fail('service.md', '---\nname: trader\nmodel: "bad\x01slug"\n---\nOrquestrador.');
    expect(reason).toMatch(/model/);
  });

  it('"model:" vazio (só espaços) ⇒ tratado como ausente, não erro', () => {
    const m = ok('service.md', '---\nname: trader\nmodel:    \n---\nOrquestrador.');
    expect(m.model).toBeUndefined();
  });

  it('"model:" NUNCA vira tunável mesmo com valor que parece número', () => {
    // "model: 4" teria "cara de número" se não fosse chave CONHECIDA — confere que
    // o switch intercepta ANTES do fallback pra `extras`/tunáveis.
    const m = ok('service.md', '---\nname: trader\nmodel: 4\n---\nOrquestrador.');
    expect(m.model).toBe('4');
    expect(m.tunables).toEqual([]);
  });
});

// `immediate:` — dispara UM turno já no start/reinício, antes do 1º ciclo de
// cron (semântica de runtime é do runner; aqui só a FORMA booleana).
describe('parseServiceManifest — immediate: (turno já no start/reinício)', () => {
  it('"immediate: true" ⇒ campo booleano true', () => {
    const m = ok('service.md', '---\nname: trader\nimmediate: true\n---\nOrquestrador.');
    expect(m.immediate).toBe(true);
  });

  it('"immediate: false" ⇒ campo booleano false (declarado, não omitido)', () => {
    const m = ok('service.md', '---\nname: trader\nimmediate: false\n---\nOrquestrador.');
    expect(m.immediate).toBe(false);
  });

  it('"immediate:" case-insensitive/trim ("  TRUE  ") ⇒ aceito', () => {
    const m = ok('service.md', '---\nname: trader\nimmediate:   TRUE  \n---\nOrquestrador.');
    expect(m.immediate).toBe(true);
  });

  it('sem "immediate:" ⇒ undefined (zero regressão — comportamento de hoje)', () => {
    const m = ok('service.md', '---\nname: trader\n---\nOrquestrador.');
    expect(m.immediate).toBeUndefined();
  });

  it('"immediate:" com valor não-booleano ⇒ erro FAIL-CLOSED (nunca vira false em silêncio)', () => {
    const reason = fail('service.md', '---\nname: trader\nimmediate: yes\n---\nOrquestrador.');
    expect(reason).toMatch(/immediate.*não é suportado/);
  });

  it('"immediate: 1" (não é "true"/"false" literal) ⇒ erro FAIL-CLOSED', () => {
    const reason = fail('service.md', '---\nname: trader\nimmediate: 1\n---\nOrquestrador.');
    expect(reason).toMatch(/immediate/);
  });

  it('"immediate:" NUNCA vira tunável mesmo com valor numérico — chave CONHECIDA intercepta antes', () => {
    const reason = fail('service.md', '---\nname: trader\nimmediate: 1\n---\nOrquestrador.');
    expect(reason).toMatch(/immediate/); // não "erro de faixa" — é erro de booleano.
  });
});

// O problema que motivou tudo isto: o dono escreveu `immediate: true` ANTES do
// campo existir, instalou, e nada indicou que a linha não fazia nada (mesmo
// destino de um typo tipo `activty-timeout:`). `ignoredFrontmatterKeys` dá
// VISIBILIDADE sem recusar o manifesto (forward-compat continua valendo).
describe('parseServiceManifest — ignoredFrontmatterKeys (visibilidade de chave ignorada)', () => {
  it('chave desconhecida SEM cara de tunável ⇒ aparece em ignoredFrontmatterKeys', () => {
    const m = ok('service.md', '---\nname: trader\nactivty-timeout: 45m\n---\nOrquestrador.');
    expect(m.ignoredFrontmatterKeys).toEqual(['activty-timeout']);
    expect(m.tunables).toEqual([]);
  });

  it('tunável numérico válido NÃO aparece em ignoredFrontmatterKeys (ele TEM efeito, não foi ignorado)', () => {
    const m = ok(
      'service.md',
      '---\nname: trader\nperda-maxima-dia: 500\ntamanho-posicao: 2 [1..5]\n---\nOrquestrador.',
    );
    expect(m.ignoredFrontmatterKeys).toEqual([]);
    expect(m.tunables).toHaveLength(2);
  });

  it('manifesto sem nenhuma chave estranha ⇒ ignoredFrontmatterKeys vazio (zero ruído)', () => {
    const m = ok(
      'service.md',
      '---\nname: trader\nschedule: "* * * * *"\nautonomy: ask\n---\nOrquestrador.',
    );
    expect(m.ignoredFrontmatterKeys).toEqual([]);
  });

  it('mistura: uma chave ignorada + um tunável válido ⇒ só a ignorada aparece na lista', () => {
    const m = ok(
      'service.md',
      '---\nname: trader\nestrategia: momentum-v2\nperda-maxima-dia: 500\n---\nOrquestrador.',
    );
    expect(m.ignoredFrontmatterKeys).toEqual(['estrategia']);
    expect(m.tunables).toEqual([{ key: 'perda-maxima-dia', value: 500 }]);
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
