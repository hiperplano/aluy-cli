import { describe, expect, it } from 'vitest';
import {
  cleanAluyForDisplay,
  formatObservation,
  parseModelTurn,
  stripThinkBlocksAndTrailingPrefix,
  stripToolCallBlock,
} from '../../src/agent/protocol.js';
import { altToolCallBlock, toolCallBlock } from './helpers.js';

describe('EST-0944 · protocolo de tool-call (parse determinístico)', () => {
  it('CA-1 — parseia um bloco de tool-call estruturado', () => {
    const text = `vou ler o arquivo.\n${toolCallBlock('read_file', { path: 'a.ts' })}`;
    const turn = parseModelTurn(text);
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call.name).toBe('read_file');
    expect(turn.call.input).toEqual({ path: 'a.ts' });
  });

  it('sem bloco ⇒ resposta final', () => {
    const turn = parseModelTurn('terminei: o arquivo tem 3 linhas.');
    expect(turn.kind).toBe('final');
  });

  it('🔴 SEGURANÇA — tool-call DENTRO de `<think>` é RACIOCÍNIO, NÃO executa (final)', () => {
    // Modelo de raciocínio (granito/MiMo) "considera" rodar algo e REJEITA. Sem o
    // descarte do <think>, o loop EXECUTARIA o comando rejeitado (em --yolo, sem barreira).
    const reasoned = `<think>vou considerar:\n${toolCallBlock('run_command', {
      command: 'rm -rf /',
    })}\nmas na verdade não preciso.</think>Pronto, não rodei nada.`;
    const turn = parseModelTurn(reasoned);
    expect(turn.kind).toBe('final');
  });

  it('SEGURANÇA — tool-call FORA do `<think>` (ação real, após `</think>`) ⇒ executa normal', () => {
    const acted = `<think>preciso ler o arquivo.</think>${toolCallBlock('read_file', {
      path: 'a.ts',
    })}`;
    const turn = parseModelTurn(acted);
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call.name).toBe('read_file');
    expect(turn.call.input).toEqual({ path: 'a.ts' });
  });

  it('SEGURANÇA — `<think>` aberto sem fechar contendo tool-call ⇒ não executa (raciocínio truncado)', () => {
    const open = `<think>estou pensando em ${toolCallBlock('run_command', { command: 'X' })}`;
    expect(parseModelTurn(open).kind).toBe('final');
  });

  it('bloco aberto sem fechamento ⇒ malformed (não fatal)', () => {
    const turn = parseModelTurn('<<<ALUY_TOOL_CALL\n{ "name": "x" }');
    expect(turn.kind).toBe('malformed');
  });

  it('JSON inválido no miolo ⇒ malformed', () => {
    const turn = parseModelTurn('<<<ALUY_TOOL_CALL\n{ não é json }\nALUY_TOOL_CALL>>>');
    expect(turn.kind).toBe('malformed');
  });

  it('bloco sem "name" ⇒ malformed', () => {
    const turn = parseModelTurn('<<<ALUY_TOOL_CALL\n{ "input": {} }\nALUY_TOOL_CALL>>>');
    expect(turn.kind).toBe('malformed');
  });

  it('input ausente ⇒ objeto vazio (não quebra)', () => {
    const turn = parseModelTurn(toolCallBlock('grep', {}).replace(',"input":{}', ''));
    // garante que mesmo sem input válido o parse não explode
    expect(['tool_call', 'malformed']).toContain(turn.kind);
  });

  it('#6 — input ARRAY ⇒ NÃO é castado a Record (normaliza p/ {})', () => {
    // `typeof [] === 'object'` fazia o array passar e ser usado como input cru.
    const turn = parseModelTurn(
      '<<<ALUY_TOOL_CALL\n{ "name": "grep", "input": [1,2] }\nALUY_TOOL_CALL>>>',
    );
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call.input).toEqual({});
  });

  it('só o PRIMEIRO bloco conta por turno (1 tool-call/iteração)', () => {
    const text = `${toolCallBlock('read_file', { path: 'a' })}\n${toolCallBlock('run_command', { command: 'rm -rf /' })}`;
    const turn = parseModelTurn(text);
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call.name).toBe('read_file');
  });

  it('formatObservation rotula status', () => {
    expect(formatObservation('grep', true, 'x')).toContain('status=ok');
    expect(formatObservation('grep', false, 'x')).toContain('status=erro');
  });
});

describe('EST-0944 · stripToolCallBlock — esconde o bloco CRU p/ exibição', () => {
  it('texto sem bloco ⇒ intacto (não esconde nada)', () => {
    expect(stripToolCallBlock('só prosa do assistente.')).toBe('só prosa do assistente.');
  });

  it('remove o bloco e PRESERVA a prosa antes dele', () => {
    const text = `Vou ler o arquivo agora.\n${toolCallBlock('read_file', { path: 'a.ts' })}`;
    const out = stripToolCallBlock(text);
    expect(out).toBe('Vou ler o arquivo agora.');
    expect(out).not.toContain('ALUY_TOOL_CALL');
    expect(out).not.toContain('read_file');
  });

  it('PRESERVA a prosa antes E depois do bloco (não engole texto legítimo)', () => {
    const text = `antes do bloco\n${toolCallBlock('grep', { pattern: 'x' })}\ndepois do bloco`;
    const out = stripToolCallBlock(text);
    expect(out).toBe('antes do bloco\ndepois do bloco');
    expect(out).not.toContain('ALUY_TOOL_CALL');
  });

  it('bloco AINDA ABERTO (stream a meio) ⇒ esconde do OPEN em diante (JSON parcial não vaza)', () => {
    const out = stripToolCallBlock('Vou rodar isto:\n<<<ALUY_TOOL_CALL\n{ "name": "run_comm');
    expect(out).toBe('Vou rodar isto:');
    expect(out).not.toContain('ALUY_TOOL_CALL');
    expect(out).not.toContain('run_comm');
  });

  it('só o bloco, sem prosa ⇒ string vazia (turno só-tool)', () => {
    expect(stripToolCallBlock(toolCallBlock('read_file', { path: 'a' }))).toBe('');
  });
});

describe('EST-0965 · cleanAluyForDisplay — esconde marcadores CRUS do protocolo no DISPLAY', () => {
  it('texto sem marcador ⇒ inalterado (idempotente, não esconde nada)', () => {
    const t = 'só prosa do assistente, sem ferramenta nenhuma.';
    expect(cleanAluyForDisplay(t)).toBe(t);
    // idempotência: aplicar 2× dá o mesmo
    expect(cleanAluyForDisplay(cleanAluyForDisplay(t))).toBe(t);
  });

  it('bloco COMPLETO ⇒ removido (sem JSON cru), prosa preservada', () => {
    const text = `Vou ler o arquivo.\n${toolCallBlock('read_file', { path: 'a.ts' })}`;
    const out = cleanAluyForDisplay(text);
    expect(out).toBe('Vou ler o arquivo.');
    expect(out).not.toContain('ALUY_TOOL_CALL');
    expect(out).not.toContain('<<<');
    expect(out).not.toContain('read_file');
  });

  it('marcador PARCIAL no tail (stream a meio) ⇒ escondido do prefixo em diante', () => {
    // O modelo começou a streamar `<<<ALUY_TOOL_CALL` mas só chegou `<<<ALUY_TOO`.
    const out = cleanAluyForDisplay('vou rodar isto: <<<ALUY_TOO');
    expect(out).toBe('vou rodar isto:');
    expect(out).not.toContain('<<<');
    expect(out).not.toContain('ALUY_TOO');
  });

  it('prefixo MÍNIMO no tail (`<<<`) ainda é escondido (não pisca o início do marcador)', () => {
    expect(cleanAluyForDisplay('texto antes <<<')).toBe('texto antes');
    expect(cleanAluyForDisplay('quase lá <<<ALUY')).toBe('quase lá');
  });

  it('texto ANTES do marcador (parcial ou completo) ⇒ preservado intacto', () => {
    expect(cleanAluyForDisplay('resposta importante. <<<ALUY_TOOL_C')).toBe('resposta importante.');
    const full = `linha 1\nlinha 2\n${toolCallBlock('grep', { pattern: 'x' })}`;
    expect(cleanAluyForDisplay(full)).toBe('linha 1\nlinha 2');
  });

  it('MÚLTIPLOS blocos completos ⇒ todos removidos, prosa em volta preservada', () => {
    const text =
      `antes\n${toolCallBlock('read_file', { path: 'a' })}\n` +
      `meio\n${toolCallBlock('grep', { pattern: 'y' })}\ndepois`;
    const out = cleanAluyForDisplay(text);
    expect(out).not.toContain('ALUY_TOOL_CALL');
    expect(out).not.toContain('<<<');
    expect(out).toContain('antes');
    expect(out).toContain('meio');
    expect(out).toContain('depois');
  });

  it('bloco completo SEGUIDO de marcador parcial no tail ⇒ ambos escondidos', () => {
    const text = `prosa\n${toolCallBlock('read_file', { path: 'a' })}\nmais prosa <<<ALUY_TOOL`;
    const out = cleanAluyForDisplay(text);
    expect(out).toBe('prosa\nmais prosa');
    expect(out).not.toContain('<<<');
    expect(out).not.toContain('ALUY_TOOL');
  });

  it('`<<<` SOLTO no MEIO da frase (não-protocolo) ⇒ NÃO esconde (texto legítimo)', () => {
    // O `<<<` não está colado no fim como prefixo do marcador, nem é o marcador
    // exato: é texto legítimo do usuário/assistente ⇒ preservado.
    const t = 'no shell, use <<< para here-strings e siga em frente.';
    expect(cleanAluyForDisplay(t)).toBe(t);
  });

  it('`ALUY_TOOL_CALL>>>` de fechamento SOZINHO (sem OPEN) ⇒ não esconde por engano', () => {
    // Sem o OPEN não há bloco; o CLOSE solto é prosa improvável mas legítima.
    const t = 'falando do marcador ALUY_TOOL_CALL>>> em prosa.';
    expect(cleanAluyForDisplay(t)).toBe(t);
  });

  it('bloco aberto sem fechar (JSON parcial após OPEN completo) ⇒ escondido do OPEN', () => {
    const out = cleanAluyForDisplay('Vou rodar:\n<<<ALUY_TOOL_CALL\n{ "name": "run_comm');
    expect(out).toBe('Vou rodar:');
    expect(out).not.toContain('ALUY_TOOL_CALL');
    expect(out).not.toContain('run_comm');
  });

  it('idempotente sobre entrada com bloco ⇒ aplicar 2× = aplicar 1×', () => {
    const text = `oi\n${toolCallBlock('read_file', { path: 'a' })}\ntchau <<<ALUY_TO`;
    const once = cleanAluyForDisplay(text);
    expect(cleanAluyForDisplay(once)).toBe(once);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DOGFOOD (granito/MiMo, modelo de RACIOCÍNIO) — `<think>…</think>` vazava cru na
// saída headless (`-p --output-format text`) E na TUI: o raciocínio + a tag
// `</think>` solta caíam no texto final. `cleanAluyForDisplay` agora remove o
// raciocínio ANTES do resto (não é a resposta).
// ──────────────────────────────────────────────────────────────────────────
describe('cleanAluyForDisplay — remove o RACIOCÍNIO `<think>…</think>` (dogfood)', () => {
  it('par COMPLETO `<think>…</think>` é removido, sobra só a resposta', () => {
    expect(cleanAluyForDisplay('<think>raciocínio interno</think>resposta')).toBe('resposta');
  });

  it('o CASO DO DOGFOOD: `</think>` solto (open consumido no stream) ⇒ raciocínio ANTES dele some', () => {
    const raw = 'Perfeito! O teste passou.\nVou só reportar.\n</think>\nVerde. ✅ Resposta final.';
    const out = cleanAluyForDisplay(raw).trim();
    expect(out).toBe('Verde. ✅ Resposta final.');
    expect(out).not.toContain('</think>');
    expect(out).not.toContain('Vou só reportar');
  });

  it('OPEN órfão `<think>` sem close (stream a meio do raciocínio) ⇒ esconde do marcador', () => {
    expect(cleanAluyForDisplay('resposta parcial<think>começando a pensar').trim()).toBe(
      'resposta parcial',
    );
  });

  it('MÚLTIPLOS pares são todos removidos', () => {
    expect(cleanAluyForDisplay('<think>a</think>R1<think>b</think>R2')).toBe('R1R2');
  });

  it('case-insensitive e multiline (`<THINK>`/quebras dentro)', () => {
    expect(cleanAluyForDisplay('<THINK>linha1\nlinha2</THINK>ok')).toBe('ok');
  });

  it('texto SEM `<think>` fica intacto (não redige demais)', () => {
    const t = 'resposta normal sem raciocínio.';
    expect(cleanAluyForDisplay(t)).toBe(t);
  });

  it('idempotente: aplicar 2× = aplicar 1×', () => {
    const raw = '<think>x</think>resp <<<ALUY_TO';
    const once = cleanAluyForDisplay(raw);
    expect(cleanAluyForDisplay(once)).toBe(once);
  });

  // EST-1015 — borda de stream INTERROMPIDO a meio da tag `<think>`.
  it('PREFIXO PARCIAL `<thi` no rabo (stream cortado mid-tag) ⇒ aparado (não vaza)', () => {
    // Simula: modelo gerou "resposta <thi" (interrompido antes de fechar <think>).
    expect(cleanAluyForDisplay('resposta útil <thi')).toBe('resposta útil');
  });

  it('PREFIXO PARCIAL `<think` no rabo (stream cortado quase na tag completa) ⇒ aparado', () => {
    expect(cleanAluyForDisplay('texto <think')).toBe('texto');
  });

  it('PREFIXO PARCIAL `</thi` do close (stream cortado mid-close) ⇒ aparado', () => {
    // Fechamento `</think>` parcial: `</thi` no rabo — também é fragmento de raciocínio.
    expect(cleanAluyForDisplay('resposta </thi')).toBe('resposta');
  });

  it('texto legítimo com `<` solitário (não prefixo de think) ⇒ intacto', () => {
    // `<` sozinho não é prefixo de `<think>` — não deve ser aparado.
    const t = 'use `a < b` na expressão';
    expect(cleanAluyForDisplay(t)).toBe(t);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// EST-1015 — stripThinkBlocksAndTrailingPrefix: borda de stream interrompido
// a meio de uma tag `<think>` ou `</think>`. O fragmento (`<thi`, `</thi` etc.)
// sobrevive no texto armazenado no histórico e polui o re-feed/compact/export.
// ──────────────────────────────────────────────────────────────────────────
describe('stripThinkBlocksAndTrailingPrefix — apara prefixo PARCIAL de tag de raciocínio', () => {
  it('🔴 BUG antes do fix: `<thi` no rabo sobrevivia a stripThinkBlocks, agora é aparado', () => {
    // Turno interrompido: texto acumulado termina em `<thi` (prefixo de `<think>`).
    // stripThinkBlocks NÃO aparava — stripThinkBlocksAndTrailingPrefix APARA.
    expect(stripThinkBlocksAndTrailingPrefix('resposta <thi')).toBe('resposta');
  });

  it('`<think` (quase completo) ⇒ aparado', () => {
    expect(stripThinkBlocksAndTrailingPrefix('texto <think')).toBe('texto');
  });

  it('`</thi` (prefixo do close) ⇒ aparado', () => {
    expect(stripThinkBlocksAndTrailingPrefix('resposta </thi')).toBe('resposta');
  });

  it('`</think` (close quase completo) ⇒ aparado', () => {
    expect(stripThinkBlocksAndTrailingPrefix('texto </think')).toBe('texto');
  });

  it('`<think>` COMPLETO (open órfão) ⇒ apara o open e tudo depois — comportamento do stripThinkBlocks', () => {
    // stripThinkBlocks deixa o espaço antes do marcador — o helper não o suprime
    // (só suprime o prefixo PARCIAL colado no fim, não espaço antes de marcador completo).
    expect(stripThinkBlocksAndTrailingPrefix('resp <think>raciocínio sem fechar').trim()).toBe(
      'resp',
    );
  });

  it('par COMPLETO `<think>…</think>` ⇒ remove o par (comportamento do stripThinkBlocks)', () => {
    expect(stripThinkBlocksAndTrailingPrefix('<think>x</think>resposta')).toBe('resposta');
  });

  it('turno SÓ-prefixo (`<thi`) ⇒ vira string vazia (caller deve tratar o fallback)', () => {
    expect(stripThinkBlocksAndTrailingPrefix('<thi').trim()).toBe('');
  });

  it('texto normal sem raciocínio ⇒ intacto', () => {
    const t = 'resposta sem raciocínio algum.';
    expect(stripThinkBlocksAndTrailingPrefix(t)).toBe(t);
  });

  it('idempotente: aplicar 2× = 1×', () => {
    const raw = 'res <thi';
    const once = stripThinkBlocksAndTrailingPrefix(raw);
    expect(stripThinkBlocksAndTrailingPrefix(once)).toBe(once);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// EST-0944 — TOLERÂNCIA a múltiplos formatos de tool-call. Modelos fortes
// (ex.: mimo-v2.5-pro) derrapam p/ o formato do TREINO `<tool_call>{json}
// </tool_call>` em vez do nativo. O parser e o hide de exibição reconhecem AMBOS
// a partir de UMA fonte de verdade (TOOL_CALL_FORMATS). O contrato interno
// `{name,input}` é o MESMO; a tool extraída passa pela MESMA catraca (decide()).
// ──────────────────────────────────────────────────────────────────────────
describe('EST-0944 · parseModelTurn — formato `<tool_call>` (treino de modelos abertos)', () => {
  it('o caso do Tiago (mimo): `<tool_call> {json} </tool_call>` ⇒ MESMO {name,input}', () => {
    const text = '<tool_call> {"name":"run_command","input":{"command":"ls -la"}} </tool_call>';
    const turn = parseModelTurn(text);
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call.name).toBe('run_command');
    expect(turn.call.input).toEqual({ command: 'ls -la' });
  });

  it('sem espaços em volta do JSON ⇒ parseia igual', () => {
    const turn = parseModelTurn(altToolCallBlock('run_command', { command: 'ls' }));
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call).toEqual({ name: 'run_command', input: { command: 'ls' } });
  });

  it('com prosa antes do bloco ⇒ extrai a tool-call', () => {
    const turn = parseModelTurn(`vou listar.\n${altToolCallBlock('grep', { pattern: 'x' })}`);
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call.name).toBe('grep');
  });

  it('`<tool_call>` aberto SEM fechamento ⇒ malformed honesto (não trava)', () => {
    const turn = parseModelTurn('<tool_call> {"name":"run_command","input":{"command":"ls');
    expect(turn.kind).toBe('malformed');
  });

  it('JSON malformado dentro de `<tool_call>` ⇒ malformed (erro honesto)', () => {
    const turn = parseModelTurn('<tool_call> { não é json } </tool_call>');
    expect(turn.kind).toBe('malformed');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// EST-1015 — BORDA de streaming PARCIAL de marcadores de RACIOCÍNIO.
// `stripThinkBlocks` usa regex e só casa o marcador COMPLETO; enquanto o stream
// ainda não entregou o marcador inteiro (chunk partido a meio), o fragmento
// piscava cru no display. `cleanAluyForDisplay` agora suprime prefixos de
// `<think>` e `</think>` no tail — análogo ao que já faz para os tool-calls.
// ──────────────────────────────────────────────────────────────────────────
describe('EST-1015 · cleanAluyForDisplay — prefixo PARCIAL de marcador de raciocínio no tail', () => {
  it('🔴 BUG: `<thi` no tail (stream cortado a meio do `<think>`) ⇒ NÃO vaza no display', () => {
    // Chunk acumulado: o modelo começou `<think>` mas só chegou `<thi`.
    // Antes do fix: resultado = 'resposta <thi' (pisca cru).
    const out = cleanAluyForDisplay('resposta <thi');
    expect(out).toBe('resposta');
    expect(out).not.toContain('<thi');
  });

  it('🔴 BUG: `<think` no tail (quase o marcador inteiro) ⇒ NÃO vaza', () => {
    const out = cleanAluyForDisplay('texto <think');
    expect(out).toBe('texto');
    expect(out).not.toContain('<think');
  });

  it('🔴 BUG: `</thi` no tail (stream cortado a meio do `</think>`) ⇒ NÃO vaza', () => {
    // Chunk acumulado: raciocínio chegou e o close estava parti-partido.
    const out = cleanAluyForDisplay('texto </thi');
    expect(out).toBe('texto');
    expect(out).not.toContain('</thi');
  });

  it('🔴 BUG: `</think` no tail (quase o close inteiro) ⇒ NÃO vaza', () => {
    const out = cleanAluyForDisplay('texto </think');
    expect(out).toBe('texto');
    expect(out).not.toContain('</think');
  });

  it('prefixo mínimo `<` sozinho NÃO é suprimido (texto legítimo "a < b")', () => {
    // `<` sozinho não é prefixo próprio de `<think>` de comprimento ≥ 1 do jeito
    // que está colado — na verdade É prefixo de 1 char; mas para `<` não seguido
    // de `t` o check de `trailingPrefixLen` retorna len=1 (o `<` inicial de
    // `<think>`). Garantimos que `<` SOZINHO no meio de frase legítima ("a < b")
    // só ativa a supressão quando está REALMENTE colado ao fim como prefixo.
    // "a < b" — o `<` ESTÁ no meio, não no fim ⇒ não ativa.
    const t = 'compare a < b e siga em frente.';
    expect(cleanAluyForDisplay(t)).toBe(t);
  });

  it('`<` no fim é suprimido (pode ser início de `<think>`)', () => {
    // `<` no rabo é um prefixo próprio de `<think>` (primeiro char). Suprime —
    // fail-safe: preferimos suprimir 1 char a piscar o início do marcador.
    const out = cleanAluyForDisplay('texto <');
    expect(out).toBe('texto');
  });

  it('par completo `<think>…</think>` seguido de prefixo `</thi` ⇒ ambos tratados', () => {
    // `stripThinkBlocks` remove o par completo; o fix remove o prefixo no tail.
    const out = cleanAluyForDisplay('<think>raciocínio</think>resposta </thi');
    expect(out).toBe('resposta');
    expect(out).not.toContain('</thi');
    expect(out).not.toContain('<think>');
  });

  it('idempotente com prefixo de marcador de raciocínio', () => {
    const raw = 'texto <thi';
    const once = cleanAluyForDisplay(raw);
    expect(cleanAluyForDisplay(once)).toBe(once);
  });

  it('texto normal sem nenhum marcador fica intacto (não suprime demais)', () => {
    const t = 'resposta normal sem raciocínio nem tool-call.';
    expect(cleanAluyForDisplay(t)).toBe(t);
  });
});

describe('EST-0944 · parseModelTurn — precedência entre formatos (o 1º no texto ganha)', () => {
  it('nativo continua parseando (não regrediu)', () => {
    const turn = parseModelTurn(toolCallBlock('read_file', { path: 'a.ts' }));
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call.name).toBe('read_file');
  });

  it('nativo ANTES de `<tool_call>` no mesmo texto ⇒ pega o nativo (vem 1º)', () => {
    const text = `${toolCallBlock('read_file', { path: 'a' })}\n${altToolCallBlock('run_command', { command: 'rm -rf /' })}`;
    const turn = parseModelTurn(text);
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call.name).toBe('read_file');
  });

  it('`<tool_call>` ANTES do nativo no mesmo texto ⇒ pega o `<tool_call>` (vem 1º)', () => {
    const text = `${altToolCallBlock('grep', { pattern: 'p' })}\n${toolCallBlock('run_command', { command: 'rm -rf /' })}`;
    const turn = parseModelTurn(text);
    expect(turn.kind).toBe('tool_call');
    if (turn.kind !== 'tool_call') throw new Error('esperava tool_call');
    expect(turn.call.name).toBe('grep');
  });
});

describe('EST-0944 · hide de exibição — `<tool_call>` também é escondido (#89)', () => {
  it('stripToolCallBlock esconde o `<tool_call>` completo, preserva a prosa', () => {
    const out = stripToolCallBlock(
      `Vou listar.\n${altToolCallBlock('run_command', { command: 'ls' })}`,
    );
    expect(out).toBe('Vou listar.');
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('run_command');
  });

  it('cleanAluyForDisplay esconde o `<tool_call>` completo', () => {
    const out = cleanAluyForDisplay(`ok.\n${altToolCallBlock('grep', { pattern: 'y' })}`);
    expect(out).toBe('ok.');
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('grep');
  });

  it('`<tool_call>` PARCIAL no tail (stream a meio) ⇒ escondido (não vaza cru)', () => {
    const out = cleanAluyForDisplay('vou rodar isto: <tool_c');
    expect(out).toBe('vou rodar isto:');
    expect(out).not.toContain('<tool_c');
  });

  it('`<tool_call>` aberto mas SEM fechar ⇒ escondido do OPEN em diante', () => {
    const out = cleanAluyForDisplay(
      'vou rodar:\n<tool_call> {"name":"run_command","input":{"command":"ls',
    );
    expect(out).toBe('vou rodar:');
    expect(out).not.toContain('<tool_call>');
    expect(out).not.toContain('run_command');
  });

  it('`<` solto legítimo no meio (ex.: "a < b") ⇒ NÃO esconde', () => {
    const t = 'compare a < b e siga.';
    expect(cleanAluyForDisplay(t)).toBe(t);
  });

  it('AMBOS os formatos no mesmo texto ⇒ ambos escondidos, prosa preservada', () => {
    const text =
      `antes\n${toolCallBlock('read_file', { path: 'a' })}\n` +
      `meio\n${altToolCallBlock('grep', { pattern: 'z' })}\ndepois`;
    const out = cleanAluyForDisplay(text);
    expect(out).not.toContain('ALUY_TOOL_CALL');
    expect(out).not.toContain('<tool_call>');
    expect(out).toContain('antes');
    expect(out).toContain('meio');
    expect(out).toContain('depois');
  });
});
