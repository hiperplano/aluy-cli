// EST-0972 — funções puras do registro de sessão: saneamento de blocos e a
// reconstrução do histórico p/ o loop ao retomar (separação de canais CLI-SEC-4).

import { describe, expect, it } from 'vitest';
import { sanitizeBlock, sanitizeBlocks, blocksToHistory } from '../../src/io/session-record.js';
import type { SessionBlock } from '../../src/session/model.js';

describe('sanitizeBlock — valida a forma de cada bloco', () => {
  it('aceita um you/aluy válidos (aluy normalizado p/ não-streaming)', () => {
    expect(sanitizeBlock({ kind: 'you', text: 'oi' })).toEqual({ kind: 'you', text: 'oi' });
    expect(sanitizeBlock({ kind: 'aluy', text: 'ola', streaming: true })).toEqual({
      kind: 'aluy',
      text: 'ola',
      streaming: false, // restaurado é estático.
    });
  });

  it('normaliza tool/bang RUNNING ⇒ err (não há efeito em voo restaurado)', () => {
    expect(
      sanitizeBlock({ kind: 'tool', verb: 'bash', target: 'ls', result: '', status: 'running' }),
    ).toMatchObject({ kind: 'tool', status: 'err' });
    expect(sanitizeBlock({ kind: 'bang', command: 'ls', status: 'running' })).toMatchObject({
      kind: 'bang',
      status: 'err',
    });
  });

  it('descarta kind desconhecido e bloco mal-formado', () => {
    expect(sanitizeBlock({ kind: 'xpto', a: 1 })).toBeNull();
    expect(sanitizeBlock({ kind: 'you' })).toBeNull(); // sem text.
    expect(sanitizeBlock({ kind: 'note', title: 't' })).toBeNull(); // sem lines.
    expect(sanitizeBlock(null)).toBeNull();
    expect(sanitizeBlock('texto')).toBeNull();
  });

  it('preserva campos opcionais válidos (output/verbGerund) e ignora os inválidos', () => {
    expect(
      sanitizeBlock({
        kind: 'tool',
        verb: 'bash',
        target: 'npm test',
        result: '2 ok',
        status: 'ok',
        output: 'saida',
        verbGerund: 'rodando',
      }),
    ).toEqual({
      kind: 'tool',
      verb: 'bash',
      target: 'npm test',
      result: '2 ok',
      status: 'ok',
      output: 'saida',
      verbGerund: 'rodando',
    });
  });

  it('HUNT-PERSIST: tool PRESERVA o diffstat added/removed (era descartado no round-trip)', () => {
    // Um edit_file gravado com `+12/−3` (EST-0982). Antes, sanitizeBlock NÃO listava
    // added/removed ⇒ a sessão retomada perdia o diffstat (mostrava +0/−0 no
    // ActivityLog/FlowTree). Agora round-trippa fiel.
    expect(
      sanitizeBlock({
        kind: 'tool',
        verb: 'edit',
        target: 'src/app.ts',
        result: '+12 −3',
        status: 'ok',
        added: 12,
        removed: 3,
      }),
    ).toEqual({
      kind: 'tool',
      verb: 'edit',
      target: 'src/app.ts',
      result: '+12 −3',
      status: 'ok',
      added: 12,
      removed: 3,
    });
  });

  it('HUNT-PERSIST: added/removed inválidos (negativo/fracionário/string) são IGNORADOS', () => {
    // Defesa anti-record adulterado: só inteiros >= 0 são aceitos; o resto cai fora
    // (o bloco sobrevive sem o campo inválido — não inventa contagem nem propaga lixo).
    const sane = sanitizeBlock({
      kind: 'tool',
      verb: 'edit',
      target: 'x.ts',
      result: 'ok',
      status: 'ok',
      added: -1,
      removed: 2.5,
    });
    expect(sane).toEqual({
      kind: 'tool',
      verb: 'edit',
      target: 'x.ts',
      result: 'ok',
      status: 'ok',
    });
    // `removed: '4'` (string) também é descartado.
    expect(
      sanitizeBlock({
        kind: 'tool',
        verb: 'edit',
        target: 'x.ts',
        result: 'ok',
        status: 'ok',
        removed: '4',
      }),
    ).not.toHaveProperty('removed');
  });
});

describe('sanitizeBlocks — lista', () => {
  it('descarta os inválidos e mantém a ordem', () => {
    const raw = [
      { kind: 'you', text: 'a' },
      { kind: 'lixo' },
      { kind: 'aluy', text: 'b', streaming: true },
    ];
    expect(sanitizeBlocks(raw)).toEqual([
      { kind: 'you', text: 'a' },
      { kind: 'aluy', text: 'b', streaming: false },
    ]);
  });

  it('não-array ⇒ []', () => {
    expect(sanitizeBlocks('x')).toEqual([]);
    expect(sanitizeBlocks(null)).toEqual([]);
  });
});

describe('blocksToHistory — reconstrói o contexto do loop (CLI-SEC-4)', () => {
  it('you→goal, aluy→model; mantém a ordem', () => {
    const blocks: SessionBlock[] = [
      { kind: 'you', text: 'objetivo 1' },
      { kind: 'aluy', text: 'resposta 1', streaming: false },
      { kind: 'you', text: 'objetivo 2' },
    ];
    expect(blocksToHistory(blocks)).toEqual([
      { role: 'goal', text: 'objetivo 1' },
      { role: 'model', text: 'resposta 1' },
      { role: 'goal', text: 'objetivo 2' },
    ]);
  });

  it('tool/bang viram OBSERVATION (dado — envelopado depois por buildMessages)', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'tool',
        verb: 'read',
        target: 'a.ts',
        result: '10 linhas',
        status: 'ok',
        output: 'conteudo',
      },
      { kind: 'bang', command: 'ls', status: 'ok', output: 'a.ts b.ts' },
    ];
    const h = blocksToHistory(blocks);
    expect(h).toHaveLength(2);
    expect(h[0]!.role).toBe('observation');
    expect(h[1]!.role).toBe('observation');
    // o conteúdo ingerido está lá (vira dado), com a procedência rotulada.
    expect((h[0] as { text: string }).text).toContain('conteudo');
    expect((h[1] as { text: string }).text).toContain('a.ts b.ts');
  });

  it('note/deny NÃO entram no contexto do modelo (são UI/sistema)', () => {
    const blocks: SessionBlock[] = [
      { kind: 'note', title: 'help', lines: ['x'] },
      { kind: 'deny', verb: 'bash', exact: 'rm -rf /' },
      { kind: 'you', text: 'oi' },
    ];
    expect(blocksToHistory(blocks)).toEqual([{ role: 'goal', text: 'oi' }]);
  });

  it('aluy vazio (turno só-tool) NÃO vira mensagem de model', () => {
    expect(blocksToHistory([{ kind: 'aluy', text: '   ', streaming: false }])).toEqual([]);
  });
});

// ── HUNT-PERSIST (round-trip infiel — blocos VISÍVEIS sumiam no save→load) ──────────
// `inject` (nota "↳ encaixado" do mid-turn) e `doctor` (checklist do /doctor) são blocos
// VISÍVEIS da transcrição. Antes do fix faltavam em KNOWN_KINDS ⇒ sanitizeBlocks os
// DESCARTAVA silenciosamente no round-trip e a sessão retomada perdia esse conteúdo.
describe('HUNT-PERSIST — inject/doctor round-trippam (não somem na sanitização)', () => {
  it('inject sobrevive ao sanitizeBlock (era descartado)', () => {
    expect(sanitizeBlock({ kind: 'inject', text: 'btw use o arquivo X' })).toEqual({
      kind: 'inject',
      text: 'btw use o arquivo X',
    });
    // texto ausente ⇒ descarta (conservador).
    expect(sanitizeBlock({ kind: 'inject' })).toBeNull();
  });

  it('doctor sobrevive, com status NORMALIZADO p/ terminal (pending ⇒ warn)', () => {
    const out = sanitizeBlock({
      kind: 'doctor',
      checks: [
        { id: 'mcp', label: 'MCP', status: 'ok', detail: '23 tools' },
        { id: 'cred', label: 'credencial', status: 'pending' }, // sem probe vivo ⇒ terminal.
        { id: 'cfg', label: 'config', status: 'warn', fix: 'rode /doctor' },
      ],
      summary: '2 ok · 1 aviso',
    });
    expect(out).toEqual({
      kind: 'doctor',
      checks: [
        { id: 'mcp', label: 'MCP', status: 'ok', detail: '23 tools' },
        { id: 'cred', label: 'credencial', status: 'warn' }, // pending normalizado.
        { id: 'cfg', label: 'config', status: 'warn', fix: 'rode /doctor' },
      ],
      summary: '2 ok · 1 aviso',
    });
  });

  it('doctor sem nenhum check válido ⇒ descartado (não bloco vazio)', () => {
    expect(sanitizeBlock({ kind: 'doctor', checks: [{ label: 'sem id' }] })).toBeNull();
    expect(sanitizeBlock({ kind: 'doctor', checks: 'nao-array' })).toBeNull();
  });

  it('ROUND-TRIP completo via sanitizeBlocks: inject+doctor preservados na ORDEM', () => {
    const blocks: SessionBlock[] = [
      { kind: 'you', text: 'oi' },
      { kind: 'inject', text: 'btw' },
      { kind: 'doctor', checks: [{ id: 'a', label: 'A', status: 'ok' }] },
      { kind: 'aluy', text: 'feito', streaming: false },
    ];
    // simula o que o store faz: JSON.stringify (persist) → JSON.parse (load) → sanitize.
    const fromDisk: unknown = JSON.parse(JSON.stringify(blocks));
    const out = sanitizeBlocks(fromDisk);
    expect(out.map((b) => b.kind)).toEqual(['you', 'inject', 'doctor', 'aluy']);
  });

  it('doctor é UI — NÃO vira mensagem p/ o modelo (blocksToHistory)', () => {
    // `inject` foi separado no F193 (agora vira `goal`); `doctor` segue UI (dropado).
    const blocks: SessionBlock[] = [
      { kind: 'doctor', checks: [{ id: 'a', label: 'A', status: 'ok' }] },
      { kind: 'you', text: 'oi' },
    ];
    expect(blocksToHistory(blocks)).toEqual([{ role: 'goal', text: 'oi' }]);
  });
});

// ── F193 (integridade de contexto na RETOMADA) — inject volta ao contexto do modelo ──
// A causa-raiz do "display OK, contexto quebrado": um `inject` (fala do dono encaixada
// mid-turn) era DESCARTADO por `blocksToHistory`. Numa sessão morta logo após um "btw",
// a retomada reconstruía o objetivo + a resposta do modelo SEM o redirecionamento que a
// motivou — o modelo "perdia a própria referência". Agora o inject volta como `goal`.
describe('F193 — inject (fala do dono mid-turn) vira `goal` no contexto retomado', () => {
  it('inject→goal, na ordem, entre o objetivo e a resposta do modelo', () => {
    // Cenário REAL (session ca42f228): objetivo longo → o dono redireciona → aluy responde
    // ao redirecionamento. Sem o inject no contexto, model("56") não casa com goal("texto").
    const blocks: SessionBlock[] = [
      { kind: 'you', text: 'escreva um texto bem longo sobre a história da computação' },
      { kind: 'inject', text: 'na verdade so me diga: quanto é 7 vezes 8?' },
      { kind: 'aluy', text: '7 vezes 8 é 56.', streaming: false },
    ];
    expect(blocksToHistory(blocks)).toEqual([
      { role: 'goal', text: 'escreva um texto bem longo sobre a história da computação' },
      { role: 'goal', text: 'na verdade so me diga: quanto é 7 vezes 8?' },
      { role: 'model', text: '7 vezes 8 é 56.' },
    ]);
  });

  it('inject vazio/só-espaço NÃO vira mensagem (conservador, como o aluy vazio)', () => {
    expect(blocksToHistory([{ kind: 'inject', text: '   ' }])).toEqual([]);
  });
});
