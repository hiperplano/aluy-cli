// EST-1010 — TIMEOUT + CAP no `callTool` do transport MCP (anti-hang / anti-OOM).
//
// Classe de bug (MCP-órfão/hang): um server MCP PENDURADO (callTool que nunca
// resolve) CONGELAVA o loop do agente; e um bloco de texto gigante materializava
// GB ANTES do clip de 20K do adapter (OOM upstream). Provas (sem processo real —
// fake do cliente MCP injetado):
//   • callTool que NUNCA resolve ⇒ o watchdog dispara no teto, devolve erro claro,
//     NÃO pendura (teste com fake-hang + timeout curto).
//   • o transport é RESETADO no timeout (o processo-server é fechado; a próxima
//     chamada falha limpo "server não conectado").
//   • bloco gigante ⇒ truncado por BYTES antes de concatenar (não materializa GB).
//   • server NORMAL ⇒ funciona igual (não regride).

import { describe, expect, it, vi } from 'vitest';
import {
  StdioMcpTransport,
  resolveMcpCallTimeoutMs,
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  extractTextContent,
  clipBytes,
  MAX_MCP_BLOCK_BYTES,
  type McpClientLike,
} from '../../src/mcp/stdio-transport.js';
import type { McpServerConfig } from '@aluy/cli-core';

const SERVER: McpServerConfig = { name: 'fake', command: 'node', args: [], env: {} };

/** Fake do cliente MCP: connect/listTools resolvem; callTool é configurável. */
function makeFakeClient(opts: {
  callTool: McpClientLike['callTool'];
  onClose?: () => void;
}): McpClientLike {
  return {
    async connect() {
      /* handshake ok */
    },
    async listTools() {
      return { tools: [{ name: 'do_thing', description: 'd' }] };
    },
    callTool: opts.callTool,
    async close() {
      opts.onClose?.();
    },
  };
}

describe('StdioMcpTransport.callTool — TIMEOUT (fail-soft, EST-1010)', () => {
  it('callTool que NUNCA resolve ⇒ watchdog dispara, devolve erro, NÃO pendura', async () => {
    // o fake-hang: a promise NUNCA assenta (simula server pendurado).
    const hang: McpClientLike['callTool'] = () => new Promise<Record<string, unknown>>(() => {});
    const transport = new StdioMcpTransport({
      callTimeoutMs: 30, // teto curtíssimo p/ não esperar 60s no teste.
      clientFactory: () => makeFakeClient({ callTool: hang }),
    });
    await transport.connect(SERVER);

    const started = Date.now();
    const res = await transport.callTool('do_thing', {});
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.content).toContain('não respondeu');
    expect(res.content).toContain('fail-soft');
    // destravou perto do teto (não pendurou): folga generosa p/ CI lento.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('no timeout, o transport é RESETADO (server fechado; próxima chamada falha limpo)', async () => {
    const onClose = vi.fn();
    const hang: McpClientLike['callTool'] = () => new Promise<Record<string, unknown>>(() => {});
    const transport = new StdioMcpTransport({
      callTimeoutMs: 30,
      clientFactory: () => makeFakeClient({ callTool: hang, onClose }),
    });
    await transport.connect(SERVER);

    const first = await transport.callTool('do_thing', {});
    expect(first.ok).toBe(false);
    // o reset matou o processo-server (close chamado).
    expect(onClose).toHaveBeenCalledTimes(1);

    // a PRÓXIMA chamada não empilha sobre um request travado — falha limpo.
    const second = await transport.callTool('do_thing', {});
    expect(second.ok).toBe(false);
    expect(second.content).toContain('não conectado');
  });

  it('erro do SDK (rejeição) ⇒ observação de erro, NÃO reseta o transport', async () => {
    const onClose = vi.fn();
    const boom: McpClientLike['callTool'] = async () => {
      throw new Error('MCP error -32001: Request timed out');
    };
    const transport = new StdioMcpTransport({
      callTimeoutMs: 1_000,
      clientFactory: () => makeFakeClient({ callTool: boom, onClose }),
    });
    await transport.connect(SERVER);

    const res = await transport.callTool('do_thing', {});
    expect(res.ok).toBe(false);
    expect(res.content).toContain('chamada falhou');
    // rejeição NÃO é um server pendurado ⇒ transport segue vivo (não fechou).
    expect(onClose).not.toHaveBeenCalled();
  });

  it('passa o teto NATIVO do SDK em `options.timeout` (dupla cinta)', async () => {
    const seen: { timeout?: number }[] = [];
    const ok: McpClientLike['callTool'] = async (_p, _s, options) => {
      seen.push({ ...(options ?? {}) });
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    const transport = new StdioMcpTransport({
      callTimeoutMs: 1234,
      clientFactory: () => makeFakeClient({ callTool: ok }),
    });
    await transport.connect(SERVER);
    await transport.callTool('do_thing', {});
    expect(seen[0]?.timeout).toBe(1234);
  });

  it('server NORMAL ⇒ funciona igual (não regride)', async () => {
    const ok: McpClientLike['callTool'] = async () => ({
      content: [{ type: 'text', text: 'resultado normal' }],
    });
    const transport = new StdioMcpTransport({
      clientFactory: () => makeFakeClient({ callTool: ok }),
    });
    await transport.connect(SERVER);
    const res = await transport.callTool('do_thing', { a: 1 });
    expect(res.ok).toBe(true);
    expect(res.content).toBe('resultado normal');
  });

  it('isError do server ⇒ ok:false (sem regressão do contrato)', async () => {
    const errResult: McpClientLike['callTool'] = async () => ({
      isError: true,
      content: [{ type: 'text', text: 'deu ruim no server' }],
    });
    const transport = new StdioMcpTransport({
      clientFactory: () => makeFakeClient({ callTool: errResult }),
    });
    await transport.connect(SERVER);
    const res = await transport.callTool('do_thing', {});
    expect(res.ok).toBe(false);
    expect(res.content).toBe('deu ruim no server');
  });

  it('BUG-0028 — abort (ESC/Ctrl-C) cancela a chamada EM VOO na HORA (não espera o teto)', async () => {
    const onClose = vi.fn();
    // server PENDURADO: callTool nunca resolve (o caso real do RPA travado).
    const hang: McpClientLike['callTool'] = () => new Promise<Record<string, unknown>>(() => {});
    const transport = new StdioMcpTransport({
      callTimeoutMs: 30_000, // teto GRANDE: sem o fix, o ESC esperaria 30s aqui.
      clientFactory: () => makeFakeClient({ callTool: hang, onClose }),
    });
    await transport.connect(SERVER);

    const ac = new AbortController();
    const started = Date.now();
    const p = transport.callTool('do_thing', {}, ac.signal);
    setTimeout(() => ac.abort(), 50); // usuário aperta ESC logo após começar
    const res = await p;
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.content).toContain('cancelada pelo usuário'); // CANCELAMENTO, não erro
    expect(elapsed).toBeLessThan(2_000); // destravou na hora — não nos 30s
    expect(onClose).toHaveBeenCalledTimes(1); // server (possível hung) foi reiniciado
  });

  it('BUG-0028 — signal JÁ abortado ⇒ NÃO chama nada (curto-circuito)', async () => {
    const spy = vi.fn(async () => ({ content: [{ type: 'text', text: 'x' }] }));
    const transport = new StdioMcpTransport({
      clientFactory: () => makeFakeClient({ callTool: spy as McpClientLike['callTool'] }),
    });
    await transport.connect(SERVER);
    const ac = new AbortController();
    ac.abort();
    const res = await transport.callTool('do_thing', {}, ac.signal);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('antes de iniciar');
    expect(spy).not.toHaveBeenCalled(); // nem spawnou a chamada
  });

  it('BUG-0028 — repassa o `signal` ao SDK (cancelamento NATIVO do request)', async () => {
    const seen: Array<{ signal?: unknown }> = [];
    const ok: McpClientLike['callTool'] = async (_p, _s, options) => {
      seen.push({ signal: (options as { signal?: unknown } | undefined)?.signal });
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    const transport = new StdioMcpTransport({
      clientFactory: () => makeFakeClient({ callTool: ok }),
    });
    await transport.connect(SERVER);
    const ac = new AbortController();
    await transport.callTool('do_thing', {}, ac.signal);
    expect(seen[0]?.signal).toBe(ac.signal); // o abort do ESC chega ao SDK
  });
});

describe('resolveMcpCallTimeoutMs — env ALUY_MCP_TIMEOUT_MS (EST-1010)', () => {
  it('default 60s quando ausente/vazio', () => {
    expect(resolveMcpCallTimeoutMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MCP_CALL_TIMEOUT_MS);
    expect(resolveMcpCallTimeoutMs({ ALUY_MCP_TIMEOUT_MS: '' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MCP_CALL_TIMEOUT_MS,
    );
  });

  it('lê valor válido', () => {
    expect(resolveMcpCallTimeoutMs({ ALUY_MCP_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)).toBe(
      5000,
    );
  });

  it('valor lixo/0/negativo ⇒ default', () => {
    expect(resolveMcpCallTimeoutMs({ ALUY_MCP_TIMEOUT_MS: 'abc' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MCP_CALL_TIMEOUT_MS,
    );
    expect(resolveMcpCallTimeoutMs({ ALUY_MCP_TIMEOUT_MS: '0' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MCP_CALL_TIMEOUT_MS,
    );
    expect(resolveMcpCallTimeoutMs({ ALUY_MCP_TIMEOUT_MS: '-9' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MCP_CALL_TIMEOUT_MS,
    );
  });

  it('clamp em [1s, 10min]', () => {
    expect(resolveMcpCallTimeoutMs({ ALUY_MCP_TIMEOUT_MS: '10' } as NodeJS.ProcessEnv)).toBe(1_000);
    expect(resolveMcpCallTimeoutMs({ ALUY_MCP_TIMEOUT_MS: '999999999' } as NodeJS.ProcessEnv)).toBe(
      600_000,
    );
  });
});

describe('extractTextContent / clipBytes — CAP POR-BLOCO antes de concatenar (anti-OOM, EST-1010)', () => {
  it('clipBytes não materializa o GB: corta um bloco gigante por bytes sem alocar tudo', () => {
    // 200 MB de texto ASCII numa string. clipBytes deve cortar SEM Buffer.byteLength
    // da string inteira (que alocaria centenas de MB). O teste só precisa terminar
    // rápido e cortar no teto.
    const giant = 'x'.repeat(200 * 1024 * 1024);
    const started = Date.now();
    const { text, truncated } = clipBytes(giant, MAX_MCP_BLOCK_BYTES);
    const elapsed = Date.now() - started;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_MCP_BLOCK_BYTES);
    expect(truncated).toBeGreaterThan(0);
    // se materializasse o GB inteiro p/ medir, levaria muito; deve ser ~instantâneo.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('clipBytes não corta strings que cabem', () => {
    const small = 'olá mundo';
    const { text, truncated } = clipBytes(small, MAX_MCP_BLOCK_BYTES);
    expect(text).toBe(small);
    expect(truncated).toBe(0);
  });

  it('clipBytes respeita fronteira de code point (UTF-8 multibyte, não corta no meio)', () => {
    // cada 😀 = 4 bytes (2 UTF-16 code units). Teto que cai no meio de um par.
    const emojis = '😀'.repeat(100);
    const { text } = clipBytes(emojis, 10); // 10 bytes ⇒ 2 emojis (8 bytes) cabem.
    // não deve haver code unit órfão (replacement char / surrogate solto).
    expect(text).not.toContain('�');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(10);
    expect(text).toBe('😀😀');
  });

  it('extractTextContent: bloco gigante é truncado ANTES de concatenar (com marcador)', () => {
    const giant = 'A'.repeat(50 * 1024 * 1024); // 50 MB num bloco.
    const out = extractTextContent([{ type: 'text', text: giant }]);
    // a saída NÃO carrega os 50MB — está perto do teto por-bloco + marcador.
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(MAX_MCP_BLOCK_BYTES + 500);
    expect(out).toContain('bloco MCP truncado');
  });

  it('extractTextContent: MILHÕES de blocos pequenos param no teto agregado', () => {
    // 100k blocos de 1KB = 100MB se concatenasse tudo. O teto agregado corta.
    const blocks = Array.from({ length: 100_000 }, () => ({
      type: 'text' as const,
      text: 'y'.repeat(1024),
    }));
    const out = extractTextContent(blocks);
    expect(out).toContain('limite agregado');
    // bem abaixo dos 100MB.
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(MAX_MCP_BLOCK_BYTES * 5);
  });

  it('extractTextContent: blocos normais passam inteiros (não regride)', () => {
    const out = extractTextContent([
      { type: 'text', text: 'linha 1' },
      { type: 'image', data: '...' },
      { type: 'text', text: 'linha 2' },
    ]);
    expect(out).toBe('linha 1\n[conteúdo MCP "image" omitido]\nlinha 2');
  });

  it('extractTextContent: content não-array ⇒ string vazia (defensivo)', () => {
    expect(extractTextContent(undefined)).toBe('');
    expect(extractTextContent('nope')).toBe('');
    expect(extractTextContent(null)).toBe('');
  });
});
