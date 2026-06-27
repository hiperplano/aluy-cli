// EST-1000 · ADR-0076 §4 / CLI-SEC-6 / RES-C-1 — GATE de redação do `/export` (o teste
// OBRIGATÓRIO do `seguranca`): exportar uma sessão que conteve um segredo ⇒ o transcript
// NÃO contém o segredo em claro. Cobre o corpo (buildTranscript) E o store no disco.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTranscript } from '../../src/session/export-transcript.js';
import { ExportStore } from '../../src/io/export-store.js';
import type { SessionBlock } from '../../src/session/model.js';

// Segredos SINTÉTICOS (token de provider "nu" + Authorization header + env-inline).
// MONTADOS em runtime (concatenação) p/ o gitleaks NÃO flagrar um literal de alta-entropia
// no FONTE — o objetivo do teste é provar a REDAÇÃO, não plantar uma chave que pareça real.
// As funções `redact*` reconhecem a FORMA `sk-…`/`Bearer …`/`*_TOKEN=…` igual a um real.
const SECRET = 'sk-' + 'TESTONLY' + 'fixturefixturefixture';
const TOKEN_VAL = 'gh' + 'p_' + 'fixturefixturefixturefixture';
const AUTH = 'Authorization: Bearer ' + TOKEN_VAL;
const TOKEN_VAL2 = 'gh' + 'p_' + 'anotherfixturefixturefixture';
const ENV = 'GITHUB_TOKEN=' + TOKEN_VAL2;

function sessionWithSecret(): SessionBlock[] {
  return [
    { kind: 'you', text: `use a chave ${SECRET} por favor` },
    { kind: 'aluy', text: `não posso colar segredos, mas ok`, streaming: false },
    {
      kind: 'tool',
      verb: 'bash',
      target: `curl -H "${AUTH}" https://api.example.com`,
      result: 'ok',
      status: 'ok',
      output: `respondeu com ${SECRET}`,
    },
    { kind: 'bang', command: `export ${ENV}`, status: 'ok', output: `set ${ENV}` },
    { kind: 'note', title: 'env', lines: [`vi um ${SECRET} no log`] },
  ];
}

describe('buildTranscript — RES-C-1: nenhum segredo cru no transcript', () => {
  it('redige o token nu (sk-…), o Authorization e o env-inline', () => {
    const md = buildTranscript(sessionWithSecret(), {
      sessionId: 's-1',
      tier: 'aluy-granito',
      exportedAt: '2026-06-10T12:00:00.000Z',
    });
    // O GATE: o segredo cru NÃO aparece em lugar nenhum do transcript.
    expect(md).not.toContain(SECRET);
    expect(md).not.toContain(TOKEN_VAL);
    expect(md).not.toContain(TOKEN_VAL2);
    // mas o transcript EXISTE e é legível (a conversa redigida, não vazia).
    expect(md).toContain('## você');
    expect(md).toContain('## aluy');
    expect(md).toContain('‹redigido›'); // o marcador de redação está presente.
  });

  it('turnos de auto-verificação (selfCheck) NÃO entram no transcript', () => {
    const md = buildTranscript([
      { kind: 'aluy', text: 'verificando evidência…', streaming: false, selfCheck: true },
      { kind: 'aluy', text: 'pronto', streaming: false },
    ]);
    expect(md).not.toContain('verificando evidência');
    expect(md).toContain('pronto');
  });

  it('inclui a SAÍDA AO VIVO (liveOutput) de uma tool/bang `running` — re-redigida no sink', () => {
    // HUNT EST-1000 — ctrl+s no cockpit COM um comando em voo: a saída visível mora em
    // `liveOutput` (não `output`, que só existe ao resolver). Antes o export DESCARTAVA
    // silencioso esse conteúdo. Agora ele entra E passa pela redação do sink: mesmo um
    // segredo CRU em `liveOutput` (simulando um que escapou da redação por-chunk do core)
    // é re-redigido antes de tocar o arquivo — nada de segredo no transcript.
    const md = buildTranscript([
      {
        kind: 'tool',
        verb: 'bash',
        target: 'curl https://api.example.com',
        result: 'rodando…',
        status: 'running',
        liveOutput: `baixando… token=${SECRET}`,
      },
      {
        kind: 'bang',
        command: 'tail -f app.log',
        status: 'running',
        liveOutput: `linha de log com ${AUTH}`,
      },
    ]);
    // a saída ao vivo APARECE no transcript (fidelidade — não foi descartada).
    expect(md).toContain('baixando…');
    expect(md).toContain('linha de log com');
    // …mas o segredo cru NÃO (re-redigido no sink, defesa-em-profundidade).
    expect(md).not.toContain(SECRET);
    expect(md).not.toContain(TOKEN_VAL);
    expect(md).toContain('‹redigido›');
  });

  it('NÃO duplica: quando `output` existe, `liveOutput` não é usado', () => {
    // `output` e `liveOutput` são mutuamente exclusivos (ao resolver, o live é descartado).
    // O fallback `output ?? liveOutput` prefere o `output` final — sem dupla emissão.
    const md = buildTranscript([
      {
        kind: 'tool',
        verb: 'bash',
        target: 'echo oi',
        result: 'ok',
        status: 'ok',
        output: 'OUTPUT_FINAL',
        liveOutput: 'PREVIA_VIVA_NAO_DEVE_APARECER',
      },
    ]);
    expect(md).toContain('OUTPUT_FINAL');
    expect(md).not.toContain('PREVIA_VIVA_NAO_DEVE_APARECER');
  });

  it('é determinístico com exportedAt injetado', () => {
    const a = buildTranscript([{ kind: 'you', text: 'oi' }], { exportedAt: 'X' });
    const b = buildTranscript([{ kind: 'you', text: 'oi' }], { exportedAt: 'X' });
    expect(a).toBe(b);
  });
});

describe('ExportStore — grava 0600 em ~/.aluy/exports/, segredo NÃO no arquivo', () => {
  it('grava o transcript redigido num arquivo 0600 sem o segredo cru', () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-export-'));
    const store = new ExportStore({ baseDir: base, now: () => new Date('2026-06-10T12:00:00Z') });
    const md = buildTranscript(sessionWithSecret(), { sessionId: 's-1' });
    const res = store.write(md, { sessionId: 's-1' });
    expect(res.ok).toBe(true);
    expect(res.path).toBeDefined();
    // o arquivo está DENTRO de ~/.aluy/exports/ (confinado).
    expect(res.path!.startsWith(join(base, 'exports'))).toBe(true);
    // permissão restrita 0600 (espelha session-store).
    expect(statSync(res.path!).mode & 0o777).toBe(0o600);
    // o GATE no disco: o conteúdo gravado NÃO tem o segredo cru.
    const onDisk = readFileSync(res.path!, 'utf8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain('‹redigido›');
  });

  it('sanitiza o nome dado pelo usuário (nega path traversal)', () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-export-'));
    const store = new ExportStore({ baseDir: base });
    const res = store.write('# x\n', { fileName: '../../etc/evil' });
    expect(res.ok).toBe(true);
    // ficou DENTRO do dir de exports (sem escapar com ../).
    expect(res.path!.startsWith(join(base, 'exports'))).toBe(true);
    expect(res.path!).not.toContain('etc/evil');
    expect(res.path!.endsWith('.md')).toBe(true);
  });
});
