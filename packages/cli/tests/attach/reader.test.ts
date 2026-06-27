// EST-0957 · CA-3/CA-4 · CLI-SEC-4/6 + confinamento — leitor de anexos `@arquivo`.
//
// Cobre o ponto onde TODA trava do canal `@` converge: confinamento (rejeita
// `..`/symlink/absoluto que escapa), path-deny (.env/.ssh), truncamento de arquivo
// grande, e a ROTULAGEM como dado (observation `[arquivo: path]`).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_TOOL_NAME, buildMessages, type NativeTool } from '@hiperplano/aluy-cli-core';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { NodeFileSystemPort } from '../../src/io/fs-port.js';
import { AttachReader } from '../../src/attach/reader.js';

describe('AttachReader — confinamento + path-deny + truncamento + rótulo', () => {
  let base: string;
  let root: string;

  function reader(maxChars?: number): AttachReader {
    const workspace = new NodeWorkspace({ root });
    const fs = new NodeFileSystemPort({ workspace });
    return new AttachReader({
      workspace,
      fs,
      ...(maxChars !== undefined ? { maxChars } : {}),
    });
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-attach-'));
    root = join(base, 'project');
    mkdirSync(join(root, 'src', 'auth'), { recursive: true });
    writeFileSync(join(root, 'src', 'auth', 'session.ts'), 'export const SESSION = 1;\n');
    writeFileSync(join(root, '.env'), 'SECRET=shhh\n');
    writeFileSync(join(base, 'outside.txt'), 'FORA DO WORKSPACE\n');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('CA-3 — anexa um arquivo DENTRO da raiz como observation rotulada', async () => {
    const res = await reader().attach('src/auth/session.ts');
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.path).toBe('src/auth/session.ts');
    expect(res.item.role).toBe('observation');
    expect(res.item.toolName).toBe(ATTACHMENT_TOOL_NAME);
    expect(res.item.text).toContain('[arquivo: src/auth/session.ts]');
    expect(res.item.text).toContain('export const SESSION = 1;');
  });

  it('CA-3 — o anexo entra como DADO envelopado (user), NUNCA como system/instrução', async () => {
    const res = await reader().attach('src/auth/session.ts');
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    const tools: readonly NativeTool[] = [];
    const messages = buildMessages(tools, [res.item, { role: 'goal', text: 'analise' }]);
    // o conteúdo do arquivo NÃO está no system (canal de instrução).
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).not.toContain('SESSION');
    // está num `user` ENVELOPADO como não-confiável (CLI-SEC-4).
    const envelope = messages.find(
      (m) => m.role === 'user' && m.content.includes('DADO_NAO_CONFIAVEL'),
    );
    expect(envelope).toBeDefined();
    expect(envelope!.content).toContain('[arquivo: src/auth/session.ts]');
    expect(envelope!.content).toContain('SESSION');
  });

  it('CA-4 — REJEITA caminho que escapa a raiz (`..`)', async () => {
    const res = await reader().attach('../outside.txt');
    expect(res.kind).toBe('rejected');
    if (res.kind !== 'rejected') return;
    expect(res.reason).toMatch(/fora do workspace/i);
  });

  it('CA-4 — REJEITA caminho absoluto fora da raiz', async () => {
    const res = await reader().attach(join(base, 'outside.txt'));
    expect(res.kind).toBe('rejected');
  });

  it('CA-4 — REJEITA symlink que aponta p/ FORA do workspace', async () => {
    symlinkSync(join(base, 'outside.txt'), join(root, 'link.txt'));
    const res = await reader().attach('link.txt');
    expect(res.kind).toBe('rejected');
  });

  it("CA-4 — REJEITA caminho relativo vazio (`.`) que resolve p/ raiz (confinamento, rel === '' )", async () => {
    const res = await reader().attach('.');
    expect(res.kind).toBe('rejected');
    if (res.kind !== 'rejected') return;
    expect(res.reason).toMatch(/inválido/i);
  });

  it('CA-4 — `.env` segue path-deny: rejeitado sem confirmação', async () => {
    const res = await reader().attach('.env');
    expect(res.kind).toBe('rejected');
    if (res.kind !== 'rejected') return;
    expect(res.reason).toMatch(/sensível|\.env/i);
  });

  it('CA-4 — `.env` NÃO vaza segredo: o conteúdo nunca é lido sem confirmar', async () => {
    const res = await reader().attach('.env');
    // nada do segredo no resultado de rejeição.
    expect(JSON.stringify(res)).not.toContain('shhh');
  });

  it('truncamento — arquivo grande é cortado e AVISADO (não estoura a janela)', async () => {
    const big = 'x'.repeat(50_000);
    writeFileSync(join(root, 'big.txt'), big);
    const res = await reader(1000).attach('big.txt');
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.truncated).toBe(true);
    expect(res.item.text.length).toBeLessThan(big.length);
    expect(res.item.text).toMatch(/truncado/i);
  });

  it('CA-4 — material de chave (`.key`) é DENY: nunca lê, mesmo confirmando', async () => {
    writeFileSync(join(root, 'server.key'), 'PRIVATE_KEY\n');
    const res = await reader().attach('server.key', { confirmSensitive: true });
    expect(res.kind).toBe('rejected');
    if (res.kind !== 'rejected') return;
    expect(res.reason).toMatch(/bloqueado/i);
    expect(JSON.stringify(res)).not.toContain('PRIVATE_KEY');
  });

  it('sensível (`.env`) COM confirmação explícita: anexa (canal guiado pelo usuário)', async () => {
    const res = await reader().attach('.env', { confirmSensitive: true });
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.item.text).toContain('[arquivo: .env]');
    expect(res.item.text).toContain('SECRET=shhh');
  });

  it('arquivo inexistente ⇒ rejeitado (fail-safe, sem throw)', async () => {
    const res = await reader().attach('nao-existe.ts');
    expect(res.kind).toBe('rejected');
  });

  // EST-1010 (BUG-0021) — @image.png / binário: NUL nos primeiros KB ⇒ REJEITA
  // (não despeja mojibake/NUL no contexto). Mesma heurística do grep.
  it('@ de BINÁRIO (com NUL) ⇒ rejeitado "arquivo binário", NÃO injeta o cru', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x1a, 0xff, 0x00]);
    writeFileSync(join(root, 'image.png'), bytes);
    const res = await reader().attach('image.png');
    expect(res.kind).toBe('rejected');
    if (res.kind !== 'rejected') return;
    expect(res.reason).toMatch(/binário/i);
    // nenhum byte NUL nem a assinatura crua (0x89 'PNG') vaza no resultado.
    const serialized = JSON.stringify(res);
    expect(serialized.includes(String.fromCharCode(0))).toBe(false);
    expect(serialized).not.toContain('PNG');
  });

  // BUG-0021 (correção) — BINÁRIO com CABEÇALHO ASCII LONGO: o NUL só aparece
  // DEPOIS dos 8 KiB do sniff de prefixo (WAV/firmware/dumps padronizados). Antes,
  // o sniff de 8 KiB dava `false` e o `readFile` (também 8 KiB) decodificava o cru
  // ⇒ NUL/mojibake despejado no contexto. A janela do sniff/leitura agora cobre
  // todo o teto de leitura, então é REJEITADO como binário (nada cru vaza).
  it('@ de BINÁRIO com NUL só APÓS 8 KiB ⇒ REJEITA, NÃO injeta o cru (janela = teto de leitura)', async () => {
    const header = Buffer.from('A'.repeat(9000), 'ascii'); // > BINARY_SNIFF_BYTES (8 KiB)
    const tail = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(join(root, 'late-nul.bin'), Buffer.concat([header, tail]));
    const res = await reader().attach('late-nul.bin');
    expect(res.kind).toBe('rejected');
    if (res.kind !== 'rejected') return;
    expect(res.reason).toMatch(/binário/i);
    // nenhum byte NUL cru vaza no resultado da rejeição.
    expect(JSON.stringify(res).includes(String.fromCharCode(0))).toBe(false);
  });

  it('@ de TEXTO com acentos (UTF-8, sem NUL) ⇒ anexa normalmente (não falso-positivo)', async () => {
    writeFileSync(join(root, 'doc.md'), '# Título\n\nConteúdo com ação e coração.\n', 'utf8');
    const res = await reader().attach('doc.md');
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.item.text).toContain('Conteúdo com ação');
  });
});
