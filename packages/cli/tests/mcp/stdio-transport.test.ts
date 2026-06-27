// EST-1013 — HARDENING: cobertura de linhas marginais no StdioMcpTransport.
//
//   (A) callTool SEM conexão (linhas 159-160): chama callTool antes de connect()
//       e afirma que devolve { ok: false, content } com mensagem "não conectado".
//
//   (B) extractTextContent com bloco NÃO-texto (linhas 192-193, OPCIONAL): quando o
//       server devolve um bloco de type != 'text' (ex.: 'image'), a função produz o
//       placeholder '[conteúdo MCP "image" omitido]'. Exercitado aqui via um server
//       real que devolve um bloco de tipo não-texto.

import { describe, expect, it, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { StdioMcpTransport } from '../../src/mcp/stdio-transport.js';

describe('StdioMcpTransport — hardening (EST-1013)', () => {
  let transport: StdioMcpTransport | undefined;
  afterEach(async () => {
    await transport?.close();
    transport = undefined;
  });

  // ── (A) callTool SEM conexão (linhas 159-160) ──────────────────────────────
  it('callTool sem connect() devolve ok=false com "não conectado" (linhas 159-160)', async () => {
    transport = new StdioMcpTransport({ parentEnv: process.env });
    // NÃO chama connect() — client interno é null.
    const result = await transport.callTool('qualquer', {});
    expect(result.ok).toBe(false);
    expect(result.content).toContain('não conectado');
  });

  // ── (B) extractTextContent com bloco não-texto (linhas 192-193) ────────────
  // Para exercitar o placeholder de bloco não-texto via callTool, precisamos de
  // um server que devolva um content com block type != 'text' (ex.: 'image').
  // O fixture echo-env-server só devolve blocos 'text'. Criamos um server
  // inline que devolve um bloco 'image' (simulado: sem binário real, só o type
  // diferente) — isso faz extractTextContent entrar no else-if que gera o
  // placeholder.
  it('bloco MCP de tipo não-texto vira placeholder "[conteúdo MCP "…" omitido]" (linhas 192-193)', async () => {
    // Server minimalista que devolve um bloco 'image' (sem binário real).
    const serverScript = fileURLToPath(
      new URL('./fixtures/image-block-server.mjs', import.meta.url),
    );
    transport = new StdioMcpTransport({ parentEnv: process.env });
    await transport.connect({
      name: 'image-server',
      command: process.execPath,
      args: [serverScript],
      env: {},
    });
    const result = await transport.callTool('give_image', {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain('omitido');
    expect(result.content).toContain('image');
  });
});
