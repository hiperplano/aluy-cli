// EST-0996 — capacidade de tool-calling NATIVO + DEGRADE no 422 + conversão de schema.
//
// Prova:
//  • `NativeToolsCapability`: decide mandar tools, e DESLIGA após um 422 TOOLS_UNSUPPORTED;
//  • `BrokerModelCaller`: 1ª chamada COM tools; num 422 TOOLS_UNSUPPORTED, REPETE 1× SEM
//    tools (fallback p/ texto, #99) e a sessão segue sem tools;
//  • `toToolFunctionSchemas`: NativeTool → schema de função (usa `parameters` ou permissivo).

import { describe, expect, it } from 'vitest';
import { NativeToolsCapability } from '../../src/agent/native-tools.js';
import { toToolFunctionSchemas } from '../../src/agent/tools/native-schema.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import { BrokerModelCaller } from '../../src/agent/model-caller.js';
import { BrokerModelClient } from '../../src/model/broker-client.js';
import { BrokerError } from '../../src/model/errors.js';
import type { ToolFunctionSchema } from '../../src/model/types.js';
import type { NativeTool } from '../../src/agent/tools/types.js';
import { makeBrokerFetch, sseBody } from '../model/helpers.js';
import { editFileTool, runCommandTool, grepTool, globTool } from '../../src/agent/tools/native.js';
import {
  makePorts,
  MemoryFs,
  RecordingShell,
  MemorySearch,
  MemorySearchWithGlob,
} from './helpers.js';

const BASE = 'https://broker.test';
const token = async (): Promise<string> => 'eyJhbGciOiJ.payload.sig';

const SCHEMA: readonly ToolFunctionSchema[] = [
  {
    type: 'function',
    function: { name: 'edit_file', description: 'x', parameters: { type: 'object' } },
  },
];

describe('EST-0996 — toToolFunctionSchemas', () => {
  it('converte as tools nativas (read/edit/write/run/grep/change_dir) com parameters', () => {
    const schemas = toToolFunctionSchemas(NATIVE_TOOLS);
    const byName = new Map(schemas.map((s) => [s.function.name, s]));
    expect(byName.has('read_file')).toBe(true);
    expect(byName.has('edit_file')).toBe(true);
    expect(byName.has('write_file')).toBe(true);
    expect(byName.has('run_command')).toBe(true);
    // EST-0944 — o schema do edit_file (str_replace) exige path+old_string+new_string.
    const edit = byName.get('edit_file')!.function.parameters as Record<string, unknown>;
    expect(edit.required).toEqual(['path', 'old_string', 'new_string']);
    // O write_file (full content) exige path+content (sobrescreve-tudo legítimo).
    const write = byName.get('write_file')!.function.parameters as Record<string, unknown>;
    expect(write.required).toEqual(['path', 'content']);
  });

  it('tool SEM parameters ⇒ schema permissivo (objeto livre)', () => {
    const noSchema: NativeTool = {
      name: 'mcp__x__y',
      effect: 'read',
      description: 'mcp',
      async run() {
        return { ok: true, observation: '' };
      },
    };
    const [s] = toToolFunctionSchemas([noSchema]);
    expect(s!.function.parameters).toMatchObject({ type: 'object', additionalProperties: true });
  });
});

describe('EST-0996 — NativeToolsCapability', () => {
  it('manda tools quando há catálogo e suportado a priori', () => {
    const cap = new NativeToolsCapability({ tools: SCHEMA });
    expect(cap.shouldSendTools()).toBe(true);
    expect(cap.requestFields().tool_choice).toBe('auto');
  });

  it('supports_tools=false ⇒ NEM tenta (vai direto p/ texto)', () => {
    const cap = new NativeToolsCapability({ tools: SCHEMA, supportsTools: false });
    expect(cap.shouldSendTools()).toBe(false);
  });

  it('catálogo vazio ⇒ nunca manda', () => {
    expect(new NativeToolsCapability({ tools: [] }).shouldSendTools()).toBe(false);
    expect(new NativeToolsCapability().shouldSendTools()).toBe(false);
  });

  it('degrade no 422 TOOLS_UNSUPPORTED ⇒ desliga (não re-bate)', () => {
    const cap = new NativeToolsCapability({ tools: SCHEMA });
    const err = new BrokerError({ status: 422, code: 'TOOLS_UNSUPPORTED' });
    expect(cap.degradeOnUnsupported(err)).toBe(true);
    expect(cap.isDisabled).toBe(true);
    expect(cap.shouldSendTools()).toBe(false);
    // Outro erro NÃO desliga.
    const cap2 = new NativeToolsCapability({ tools: SCHEMA });
    expect(cap2.degradeOnUnsupported(new BrokerError({ status: 429, code: 'RATE_LIMITED' }))).toBe(
      false,
    );
    expect(cap2.isDisabled).toBe(false);
  });
});

describe('EST-0996 — BrokerModelCaller: degrade gracioso no 422', () => {
  const okSse = sseBody([
    { event: 'start', data: { request_id: 'r1', tier: 'aluy-strata' } },
    { event: 'delta', data: { content: 'ok' } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ]);

  it('1ª chamada COM tools; num 422 TOOLS_UNSUPPORTED repete SEM tools (1 retry) e prossegue', async () => {
    let attempt = 0;
    const { fetch, calls } = makeBrokerFetch((call) => {
      attempt += 1;
      const hadTools = (call.body as Record<string, unknown>)?.tools !== undefined;
      // 1ª (com tools) ⇒ 422 TOOLS_UNSUPPORTED; 2ª (sem tools) ⇒ 200 texto.
      if (hadTools) {
        return {
          status: 422,
          json: { status: 422, code: 'TOOLS_UNSUPPORTED', detail: 'sem tools' },
        };
      }
      return { status: 200, sse: okSse };
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const cap = new NativeToolsCapability({ tools: SCHEMA });
    const caller = new BrokerModelCaller({ client, tier: 'aluy-strata', nativeTools: cap });

    const res = await caller.call({
      messages: [{ role: 'user', content: 'oi' }],
      idempotencyKey: 'k1',
    });

    // Resultado é o da 2ª passada (sem tools) — degrade gracioso, sem travar.
    expect(res.content).toBe('ok');
    expect(attempt).toBe(2);
    expect((calls[0]!.body as Record<string, unknown>).tools).toBeDefined();
    expect((calls[1]!.body as Record<string, unknown>).tools).toBeUndefined();
    // A sessão DESLIGOU o nativo: a PRÓXIMA chamada já não manda tools (1 só passada).
    const before = calls.length;
    const res2 = await caller.call({
      messages: [{ role: 'user', content: 'd' }],
      idempotencyKey: 'k2',
    });
    expect(res2.content).toBe('ok');
    expect(calls.length - before).toBe(1);
    expect((calls[calls.length - 1]!.body as Record<string, unknown>).tools).toBeUndefined();
  });

  it('sem capacidade ⇒ NUNCA manda tools (baseline)', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: okSse });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const caller = new BrokerModelCaller({ client, tier: 'aluy-strata' });
    await caller.call({ messages: [{ role: 'user', content: 'oi' }], idempotencyKey: 'k' });
    expect((calls[0]!.body as Record<string, unknown>).tools).toBeUndefined();
  });
});

describe('EST-1014 — catches de erro nas tools nativas (error-paths determinísticos)', () => {
  it('editFileTool — CATCH de escrita: ports.fs.writeFile lança ⇒ ok:false + "falha ao editar"', async () => {
    // Cria um MemoryFs onde writeFile lança, mas readFile/exists funcionam.
    const inner = new Map([['foo.ts', 'conteúdo original']]);
    const fs: MemoryFs = new (class extends MemoryFs {
      async writeFile(): Promise<void> {
        throw new Error('disco cheio');
      }
    })(inner);
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run(
      { path: 'foo.ts', old_string: 'original', new_string: 'modificado' },
      ports,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('falha ao editar');
    expect(r.observation).toContain('disco cheio');
  });

  it('runCommandTool — CATCH de execução: ports.shell.exec lança ⇒ ok:false + "falha ao executar"', async () => {
    const shell = new (class extends RecordingShell {
      async exec(): Promise<import('../../src/agent/tools/types.js').ShellResult> {
        throw new Error('permissão negada');
      }
    })();
    const { ports } = makePorts({ shell });
    const r = await runCommandTool.run({ command: 'echo x' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('falha ao executar');
    expect(r.observation).toContain('permissão negada');
  });

  it('grepTool — CATCH de busca: ports.search.search lança ⇒ ok:false + "falha ao buscar"', async () => {
    const search = new (class extends MemorySearch {
      async search(): Promise<readonly import('../../src/agent/tools/types.js').SearchMatch[]> {
        throw new Error('permissão de leitura');
      }
    })();
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'x', path: '.' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('falha ao buscar');
    expect(r.observation).toContain('permissão de leitura');
  });

  // ── EST-0944 — globTool (espelha o grep: contrato, degradação honesta, truncamento) ─

  it('globTool — lista os caminhos casados (display limpo, efeito read)', async () => {
    const search = new MemorySearchWithGlob(['src/a.ts', 'src/b.ts']);
    const { ports } = makePorts({ search });
    const r = await globTool.run({ pattern: '**/*.ts', path: '.' }, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toBe('src/a.ts\nsrc/b.ts');
    expect(r.display).toBe('glob "**/*.ts" .');
    expect(globTool.effect).toBe('read');
  });

  it('globTool — pattern ausente ⇒ erro de input claro (não chama a porta)', async () => {
    const { ports } = makePorts({ search: new MemorySearchWithGlob([]) });
    const r = await globTool.run({}, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('glob requer "pattern"');
  });

  it('globTool — 0 acertos ⇒ observação CLARA (não silêncio)', async () => {
    const search = new MemorySearchWithGlob([]); // nada casou
    const { ports } = makePorts({ search });
    const r = await globTool.run({ pattern: '**/*.rs', path: 'src' }, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('nenhum arquivo casou "**/*.rs" em src');
  });

  it('globTool — truncamento ⇒ NOTA honesta de scan parcial anexada', async () => {
    const search = new MemorySearchWithGlob(['a.ts', 'b.ts'], { byMaxResults: true });
    const { ports } = makePorts({ search });
    const r = await globTool.run({ pattern: '**/*.ts', path: '.' }, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('a.ts');
    expect(r.observation).toContain('⚠ scan parcial');
    expect(r.observation).toContain('teto de resultados');
  });

  it('globTool — truncamento por varredura ⇒ nota de arquivos não testados', async () => {
    const search = new MemorySearchWithGlob([], { byMaxScanned: true });
    const { ports } = makePorts({ search });
    const r = await globTool.run({ pattern: '**/*.ts', path: '.' }, ports);
    // 0 acertos MAS varredura parcial ⇒ a nota acompanha a linha "nenhum arquivo".
    expect(r.observation).toContain('nenhum arquivo casou');
    expect(r.observation).toContain('teto de arquivos varridos');
  });

  it('globTool — porta SEM glob (fake só com search) ⇒ erro CLARO, nunca quebra', async () => {
    // MemorySearch NÃO implementa glob (a maioria dos fakes) — a tool degrada.
    const { ports } = makePorts({ search: new MemorySearch() });
    const r = await globTool.run({ pattern: '**/*.ts', path: '.' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('glob) indisponível');
  });

  it('globTool — padrão INVÁLIDO (GlobSyntaxError) ⇒ erro VISÍVEL, não "0 acertos"', async () => {
    // Porta que delega ao matcher REAL (compileGlob lança em padrão inválido).
    const search = new (class extends MemorySearch {
      async glob(pattern: string): Promise<import('../../src/agent/tools/types.js').GlobOutcome> {
        const { compileGlob } = await import('../../src/agent/tools/glob-match.js');
        compileGlob(pattern); // lança GlobSyntaxError
        return { paths: [], truncated: {} };
      }
    })();
    const { ports } = makePorts({ search });
    const r = await globTool.run({ pattern: 'a[bc', path: '.' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('glob: padrão inválido');
  });

  it('globTool — CATCH genérico: a porta lança ⇒ ok:false + "falha ao buscar arquivos"', async () => {
    const search = new (class extends MemorySearch {
      async glob(): Promise<import('../../src/agent/tools/types.js').GlobOutcome> {
        throw new Error('disco fora');
      }
    })();
    const { ports } = makePorts({ search });
    const r = await globTool.run({ pattern: '*', path: '.' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('falha ao buscar arquivos');
    expect(r.observation).toContain('disco fora');
  });
});
