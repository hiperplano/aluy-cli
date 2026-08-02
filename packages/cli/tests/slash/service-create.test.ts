// ADR-0158 §10 (FASE 5) — `slash/service-create.ts`: o PROMPT-GUIA da criação
// CONVERSACIONAL. PURA (mesmo padrão de `buildScaffoldSystemPrompt`, testado em
// `slash/init.test.ts`) — sem I/O, sem rede, sem modelo: só monta uma string a
// partir da descrição do dono. O smoke test do binário real não consegue exercer
// o fluxo de verdade com um modelo FAKE (a entrevista/escrita depende de um LLM);
// este arquivo é a evidência de que o TEXTO do comando está correto — a fumaça
// (relatório da missão) cobre o resto: staging → install → start.
import { describe, expect, it } from 'vitest';
import { buildServiceCreateSystemPrompt, SERVICE_DRAFTS_DIRNAME } from '../../src/slash/service-create.js';

describe('SERVICE_DRAFTS_DIRNAME', () => {
  it('é um nome de diretório RELATIVO simples, sem prefixo `.aluy`', () => {
    expect(SERVICE_DRAFTS_DIRNAME).toBe('aluy-services-drafts');
    expect(SERVICE_DRAFTS_DIRNAME.startsWith('.aluy')).toBe(false);
    expect(SERVICE_DRAFTS_DIRNAME.startsWith('/')).toBe(false);
    expect(SERVICE_DRAFTS_DIRNAME.startsWith('~')).toBe(false);
  });
});

describe('buildServiceCreateSystemPrompt — PURA', () => {
  it('é determinística (mesma entrada ⇒ mesma saída)', () => {
    const a = buildServiceCreateSystemPrompt('um trader de MT5');
    const b = buildServiceCreateSystemPrompt('um trader de MT5');
    expect(a).toBe(b);
  });

  it('inclui a descrição do dono (aparada)', () => {
    const prompt = buildServiceCreateSystemPrompt('  um pesquisador que lê fontes toda manhã  ');
    expect(prompt).toContain('um pesquisador que lê fontes toda manhã');
    // não deixa os espaços crus da entrada colados no fim do prompt.
    expect(prompt.trimEnd().endsWith('manhã')).toBe(true);
  });

  it('apara espaço/quebra à ESQUERDA da descrição também (não só à direita)', () => {
    // `trimEnd()` (teste acima) mascara um `.trim()` incompleto — ele some com
    // QUALQUER whitespace à direita da string inteira, mutante ou não. Este
    // teste isola a linha exata da descrição p/ garantir que a ESQUERDA
    // também foi aparada (mata o mutante que troca `descricao.trim()` por
    // `descricao` cru em `buildServiceCreateSystemPrompt`).
    const prompt = buildServiceCreateSystemPrompt('   um pesquisador que lê fontes toda manhã');
    const descLine = prompt.split('\n').find((l) => l.includes('um pesquisador que lê fontes toda manhã'));
    expect(descLine).toBe('um pesquisador que lê fontes toda manhã');
  });

  it('instrui ENTREVISTAR o que faltar (schedule/canal/autonomia/funil) via `perguntar`', () => {
    const prompt = buildServiceCreateSystemPrompt('um serviço qualquer');
    expect(prompt).toContain('ENTREVISTE');
    expect(prompt).toContain('perguntar');
    expect(prompt.toLowerCase()).toContain('schedule');
    expect(prompt.toLowerCase()).toContain('channel');
    expect(prompt.toLowerCase()).toContain('funil');
  });

  it('NUNCA orienta escrever em `~/.aluy/services/` — só no diretório de STAGING', () => {
    const prompt = buildServiceCreateSystemPrompt('um serviço qualquer');
    expect(prompt).toContain(`${SERVICE_DRAFTS_DIRNAME}/<nome>/`);
    expect(prompt).toContain('NUNCA em `~/.aluy/services/');
    expect(prompt).toContain('aluy-config-write-deny');
  });

  it('explica a topologia de FUNIL (§4): só o decisor leva a skill de execução no tools:', () => {
    const prompt = buildServiceCreateSystemPrompt('um serviço qualquer');
    expect(prompt).toContain('TOPOLOGIA DE FUNIL');
    expect(prompt).toMatch(/tools:/);
    expect(prompt.toLowerCase()).toContain('decisor');
  });

  it('distingue regra de JULGAMENTO (rules.md) × regra DURA (frontmatter) — §3', () => {
    const prompt = buildServiceCreateSystemPrompt('um serviço qualquer');
    expect(prompt).toContain('rules.md');
    expect(prompt).toContain('Regra dura nunca é prompt');
  });

  it('a v1 só aceita "autonomy: ask" — o prompt não oferece outra opção', () => {
    const prompt = buildServiceCreateSystemPrompt('um serviço qualquer');
    expect(prompt).toContain('autonomy: ask');
    expect(prompt).toContain('SÓ aceita `ask`');
  });

  it('termina com CRIAR NÃO É LIGAR: PARADO + próximos passos (install → start)', () => {
    const prompt = buildServiceCreateSystemPrompt('um serviço qualquer');
    expect(prompt).toContain('CRIAR NÃO É LIGAR');
    expect(prompt).toContain('PARADO');
    expect(prompt).toContain('aluy service install');
    expect(prompt).toContain('aluy service start');
  });

  it('instrui só criar skeleton de skills — nunca o script de verdade do dono', () => {
    const prompt = buildServiceCreateSystemPrompt('um serviço qualquer');
    expect(prompt).toContain('SKILL.md');
    expect(prompt.toLowerCase()).toContain('esqueleto');
    expect(prompt).toContain('NÃO');
  });

  it('NÃO vaza jargão de governança interna (ADR/§) — o prompt vira bloco "you" na tela (controller.submit → pushBlock kind:\'you\'), visível ao dono; "ADR-0158" não significa nada para quem usa o produto', () => {
    const prompt = buildServiceCreateSystemPrompt('um serviço qualquer');
    expect(prompt).not.toContain('ADR-');
    expect(prompt).not.toMatch(/§\d/);
  });
});
