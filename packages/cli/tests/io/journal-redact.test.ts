// EST-SEC-HARDEN (F23) · AG-0008 — REDAÇÃO at-rest do conteúdo-de-arquivo no SINK do
// journal (parte PURA — o filtro de blocos, sem I/O).
//
// Provas (DoD):
//   1. `read`/`grep`/`attach` ⇒ `result`/`output`/`liveOutput` SAEM REDIGIDOS;
//   2. `bash` (run_command) e `edit` NÃO são tocados (já redigidos na origem / são
//      diff/metadados — não corromper);
//   3. blocos não-tool (`you`/`aluy`/`note`) INTOCADOS;
//   4. IDEMPOTÊNCIA: redigir 2× não muda (o `REDACTED` não re-casa);
//   5. NÃO MUTA a entrada (in-memory/in-session preservado) — devolve array novo;
//   6. sem segredo ⇒ devolve a MESMA referência (sem churn).

import { describe, expect, it } from 'vitest';
import { REDACTED } from '@aluy/cli-core';
import { redactFileContentForJournal } from '../../src/io/journal-redact.js';
import type { SessionBlock } from '../../src/session/model.js';

const SECRET = 'sk-ABCDEFGHIJKLMNOP1234567890';

/** Bloco `tool` de leitura com um segredo no `output`. */
function readBlock(output: string): SessionBlock {
  return { kind: 'tool', verb: 'read', target: '.env', result: '12 linhas', status: 'ok', output };
}

describe('F23 · redactFileContentForJournal', () => {
  it('read: redige o segredo no output (e result/liveOutput)', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'tool',
        verb: 'read',
        target: '.env',
        result: `API=${SECRET}`,
        status: 'ok',
        output: `linha: API_KEY=${SECRET}`,
        liveOutput: `tail: ${SECRET}`,
      },
    ];
    const out = redactFileContentForJournal(blocks);
    const b = out[0];
    expect(b?.kind).toBe('tool');
    if (b?.kind !== 'tool') throw new Error('esperado tool');
    expect(b.result).not.toContain(SECRET);
    expect(b.result).toContain(REDACTED);
    expect(b.output).not.toContain(SECRET);
    expect(b.output).toContain(REDACTED);
    expect(b.liveOutput).not.toContain(SECRET);
  });

  it('grep: redige o hit com a credencial', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'tool',
        verb: 'grep',
        target: '/token/',
        result: '1 hit',
        status: 'ok',
        output: `config.py:3: GITHUB_TOKEN=${SECRET}`,
      },
    ];
    const b = redactFileContentForJournal(blocks)[0];
    if (b?.kind !== 'tool') throw new Error('esperado tool');
    expect(b.output).not.toContain(SECRET);
    expect(b.output).toContain(REDACTED);
  });

  it('attach: redige o conteúdo anexado', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'tool',
        verb: 'attach',
        target: 'creds.txt',
        result: 'anexado',
        status: 'ok',
        output: `senha: --password=${SECRET}`,
      },
    ];
    const b = redactFileContentForJournal(blocks)[0];
    if (b?.kind !== 'tool') throw new Error('esperado tool');
    expect(b.output).not.toContain(SECRET);
  });

  it('bash BENIGNO (sem segredo no comando) — intocado, mesma referência', () => {
    // A SAÍDA do bash já é redigida na origem; o `target` benigno (`npm test`) não tem
    // segredo ⇒ `redactCommandSecrets` é no-op ⇒ a referência é preservada (sem churn).
    const bash: SessionBlock = {
      kind: 'tool',
      verb: 'bash',
      target: 'npm test',
      result: 'exit 0',
      status: 'ok',
      output: 'tudo verde',
    };
    const out = redactFileContentForJournal([bash]);
    expect(out[0]).toBe(bash); // MESMA referência — intocado.
  });

  it('F107 — bash com SEGREDO no `target` (linha de comando) é redigido at-rest', () => {
    const bash: SessionBlock = {
      kind: 'tool',
      verb: 'bash',
      target: `curl -H "Authorization: Bearer ${SECRET}"`,
      result: 'exit 0',
      status: 'ok',
      output: 'ok', // a saída já vem redigida da origem
    };
    const out = redactFileContentForJournal([bash])[0];
    expect(out).not.toBe(bash); // mudou (redigiu)
    expect((out as { target: string }).target).toContain(REDACTED);
    expect((out as { target: string }).target).not.toContain(SECRET);
  });

  it('F107 — `! bang` com SEGREDO no comando digitado é redigido at-rest (export já redige)', () => {
    const bang: SessionBlock = {
      kind: 'bang',
      command: `psql "postgresql://user:${SECRET}@db.host:5432/app"`,
      status: 'ok',
      output: 'rows: 0',
    };
    const out = redactFileContentForJournal([bang])[0];
    expect(out).not.toBe(bang);
    expect((out as { command: string }).command).not.toContain(SECRET);
  });

  it('F107 — `! bang` BENIGNO (sem segredo) — intocado, mesma referência', () => {
    const bang: SessionBlock = { kind: 'bang', command: 'ls -la', status: 'ok', output: '…' };
    expect(redactFileContentForJournal([bang])[0]).toBe(bang);
  });

  it('edit NÃO é tocado (diff/metadados — redigir corromperia)', () => {
    const edit: SessionBlock = {
      kind: 'tool',
      verb: 'edit',
      target: 'a.ts',
      result: '+3 −1',
      status: 'ok',
      output: `+ const k = "${SECRET}"`,
      added: 3,
      removed: 1,
    };
    const out = redactFileContentForJournal([edit]);
    expect(out[0]).toBe(edit); // intocado (mesmo com um literal no diff).
  });

  it('blocos não-tool (you/aluy/note) intocados', () => {
    const blocks: SessionBlock[] = [
      { kind: 'you', text: `meu token é ${SECRET}` },
      { kind: 'aluy', text: 'ok', streaming: false },
      { kind: 'note', title: 'x', lines: [SECRET] },
    ];
    const out = redactFileContentForJournal(blocks);
    expect(out).toBe(blocks); // nenhum tool de leitura ⇒ MESMA referência.
  });

  it('idempotência: redigir 2× é igual a 1×', () => {
    const blocks = [readBlock(`API_KEY=${SECRET}`)];
    const once = redactFileContentForJournal(blocks);
    const twice = redactFileContentForJournal(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('NÃO MUTA a entrada — o in-memory/in-session segue íntegro', () => {
    const original = readBlock(`API_KEY=${SECRET}`);
    const blocks = [original];
    const out = redactFileContentForJournal(blocks);
    // o objeto de saída é NOVO e redigido; o original ainda tem o segredo CRU:
    expect(out[0]).not.toBe(original);
    if (original.kind !== 'tool') throw new Error('esperado tool');
    expect(original.output).toContain(SECRET); // in-memory intacto (read→write_file não quebra).
  });

  it('sem segredo ⇒ devolve a MESMA referência do array (sem churn)', () => {
    const blocks: SessionBlock[] = [readBlock('arquivo limpo, sem nada')];
    expect(redactFileContentForJournal(blocks)).toBe(blocks);
  });

  it('result de read SEM segredo é preservado fiel (não estraga "12 linhas")', () => {
    const blocks: SessionBlock[] = [readBlock('conteúdo qualquer sem credencial')];
    const b = redactFileContentForJournal(blocks)[0];
    if (b?.kind !== 'tool') throw new Error('esperado tool');
    expect(b.result).toBe('12 linhas');
  });

  // EST-1075 · HR-SEC-5 (ADR-0108) — o `headroom_retrieve` re-materializa conteúdo do cache
  // CCR que pode ter um segredo dedupado; AT-REST tem de ser redigido igual a read/grep.
  it('headroom_retrieve: redige o segredo recuperado no result/output (HR-SEC-5)', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'tool',
        verb: 'headroom_retrieve',
        target: 'hash=abc123',
        result: `[headroom_retrieve · hash=abc123]\nAPI_KEY=${SECRET}`,
        status: 'ok',
        output: `recuperado: ${SECRET}`,
      },
    ];
    const b = redactFileContentForJournal(blocks)[0];
    if (b?.kind !== 'tool') throw new Error('esperado tool');
    expect(b.result).toContain(REDACTED);
    expect(b.result).not.toContain(SECRET);
    expect(b.output).not.toContain(SECRET);
  });
});
