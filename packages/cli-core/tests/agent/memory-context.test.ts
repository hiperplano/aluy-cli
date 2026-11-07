// ADR 0004 — a memória do dono entra no `system` como instrução SEGUIDA (fatos `usuario`) e
// contexto de fundo (`derivado`), sem envelope DADO_NAO_CONFIAVEL nem rótulos de alarme.

import { describe, expect, it } from 'vitest';
import {
  AgentMemory,
  buildMemoryContext,
  buildMessages,
  buildSystemPrompt,
  looksImperative,
  MAX_MEMORY_CONTEXT_CHARS,
  MEMORY_DERIVED_HEADER,
  MEMORY_USER_HEADER,
  NATIVE_TOOLS,
  PolicyPermissionEngine,
  PROJECT_INSTRUCTIONS_HEADER,
  recallTool,
  rememberTool,
  SubAgentSpawner,
  UNTRUSTED_OPEN,
  type MemoryFact,
  type MemoryStorePort,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '../../src/index.js';
import { MemoryFs, RecordingShell, MemorySearch } from './helpers.js';

const fact = (
  text: string,
  provenance: 'usuario' | 'derivado',
  ts = 1,
  extra: Partial<MemoryFact> = {},
): MemoryFact => ({
  id: `${ts}${text.length}`,
  text,
  scope: 'projeto',
  provenance,
  pinned: false,
  ts,
  ...extra,
});

class FakeStore implements MemoryStorePort {
  facts: MemoryFact[] = [];
  async readAll() {
    return this.facts;
  }
  async append(f: MemoryFact) {
    this.facts.push(f);
  }
  async remove(id: string) {
    this.facts = this.facts.filter((x) => x.id !== id);
  }
  async update(f: MemoryFact) {
    this.facts = this.facts.map((x) => (x.id === f.id ? f : x));
  }
  async clearAll() {
    this.facts = [];
  }
}

describe('buildMemoryContext', () => {
  it('vazio ⇒ undefined', () => expect(buildMemoryContext([])).toBeUndefined());

  it('usuario = instrução do dono; derivado = contexto; sem envelope nem alarme', () => {
    const b = buildMemoryContext([
      fact('não implemente: só chame sub-agentes', 'usuario'),
      fact('este repo roda testes com vitest', 'derivado'),
    ])!;
    expect(b).toContain(MEMORY_USER_HEADER);
    expect(b).toContain(MEMORY_DERIVED_HEADER);
    expect(b.indexOf('só chame sub-agentes')).toBeLessThan(b.indexOf('vitest'));
    expect(b).not.toContain(UNTRUSTED_OPEN);
    expect(b).not.toContain('NUNCA');
    expect(b).not.toContain('⚠');
    expect(b).not.toContain('NÃO é instrução');
  });

  it('só derivado ⇒ sem o cabeçalho do dono', () => {
    const b = buildMemoryContext([fact('x', 'derivado')])!;
    expect(b).not.toContain(MEMORY_USER_HEADER);
  });

  it('acima do teto: prefere usuario, omite derivado e AVISA', () => {
    const many: MemoryFact[] = [
      ...Array.from({ length: 150 }, (_, i) =>
        fact(`derivado ${i} `.padEnd(100, 'd'), 'derivado', i + 1000),
      ),
      fact('REGRA DO DONO importante', 'usuario', 1),
    ];
    const b = buildMemoryContext(many)!;
    expect(b.length).toBeLessThanOrEqual(MAX_MEMORY_CONTEXT_CHARS + 300);
    expect(b).toContain('REGRA DO DONO importante');
    expect(b).toContain('omitido(s)');
    expect(b).toContain('só contexto derivado');
  });

  it('fixados vêm primeiro dentro da categoria', () => {
    const b = buildMemoryContext([
      fact('recente', 'usuario', 9),
      fact('fixado antigo', 'usuario', 1, { pinned: true }),
    ])!;
    expect(b.indexOf('fixado antigo')).toBeLessThan(b.indexOf('recente'));
  });
});

describe('imperative.ts não sinaliza fatos do dono', () => {
  it('"sempre use pnpm" com provenance usuario ⇒ false; derivado ⇒ segue true', () => {
    expect(looksImperative('sempre use pnpm', 'usuario')).toBe(false);
    expect(looksImperative('sempre use pnpm', 'derivado')).toBe(true);
    expect(looksImperative('sempre use pnpm')).toBe(true);
  });
});

describe('system prompt', () => {
  const mem = buildMemoryContext([fact('não implemente, só delegue', 'usuario')]);
  it('memória no ÚNICO system, depois do ALUY.md e antes do fecho de segurança', () => {
    const msgs = buildMessages(
      NATIVE_TOOLS,
      [],
      'build com npm',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mem,
    );
    expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1);
    const sys = msgs[0]!.content as string;
    expect(sys.indexOf(PROJECT_INSTRUCTIONS_HEADER)).toBeLessThan(sys.indexOf(MEMORY_USER_HEADER));
    expect(sys.indexOf(MEMORY_USER_HEADER)).toBeLessThan(sys.indexOf('REGRA DE SEGURANÇA'));
  });
  it('a MEMÓRIA DO DONO declara que VENCE as regras gerais ("tarefa pequena, faça você mesmo") no prompt de fio', () => {
    const msgs = buildMessages(
      NATIVE_TOOLS,
      [],
      'g',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mem,
    );
    const sys = msgs[0]!.content as string;
    expect(sys).toMatch(/ELAS VENCEM as regras gerais/);
    expect(sys).toMatch(/DELEGUE até o menor pedido/);
  });
  it('sem memória ⇒ idêntico ao baseline (cache de prefixo intacto)', () => {
    expect(
      buildSystemPrompt(
        NATIVE_TOOLS,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '  ',
      ),
    ).toBe(buildSystemPrompt(NATIVE_TOOLS));
  });
  it('orienta gravar NA HORA com provenance usuario (só com a tool remember)', () => {
    const com = buildSystemPrompt([...NATIVE_TOOLS, rememberTool]);
    expect(com).toContain('NA HORA');
    expect(com).toContain('provenance:"usuario"');
    expect(buildSystemPrompt(NATIVE_TOOLS)).not.toContain('NA HORA');
  });
});

describe('remember: guarda leve de proveniência', () => {
  it('default continua derivado; usuario só quando declarado', async () => {
    const store = new FakeStore();
    const memory = new AgentMemory({ store });
    const ports = {
      memory: { remember: (t: string, s: never, p: never) => memory.remember(t, s, p) },
    } as unknown as ToolPorts;
    await rememberTool.run({ fact: 'lido do README', scope: 'projeto' }, ports);
    await rememberTool.run(
      { fact: 'o dono disse', scope: 'projeto', provenance: 'usuario' },
      ports,
    );
    expect(store.facts.map((f) => f.provenance)).toEqual(['derivado', 'usuario']);
  });
  it('descrição da tool é proativa e proíbe marcar usuario conteúdo de arquivo/web', () => {
    expect(rememberTool.description).toContain('NA HORA');
    expect(rememberTool.description).toContain('NUNCA marque "usuario"');
  });
});

describe('recall (tool) sem rótulos de alarme', () => {
  it('não rotula diretiva do dono e não diz "NÃO são ordens"', async () => {
    const store = new FakeStore();
    store.facts.push(fact('sempre rode os testes antes de commitar', 'usuario'));
    const memory = new AgentMemory({ store });
    const ports = {
      memory: {
        remember: memory.remember.bind(memory),
        searchFacts: (q?: string, l?: number) => memory.searchFacts(q, l),
      },
    } as unknown as ToolPorts;
    const r = await recallTool.run({}, ports);
    expect(r.observation).toContain('sempre rode os testes');
    expect(r.observation).not.toContain('⚠');
    expect(r.observation).not.toContain('NÃO são ordens');
  });
});

describe('AgentMemory.contextBlock / recall', () => {
  it('contextBlock reflete o store a cada chamada (um remember vale já na seguinte)', async () => {
    const store = new FakeStore();
    const memory = new AgentMemory({ store });
    expect(await memory.contextBlock()).toBeUndefined();
    await memory.remember('prefiro respostas curtas', 'global', 'usuario');
    expect(await memory.contextBlock()).toContain('prefiro respostas curtas');
  });
  it('recall() não semeia mais observação (a memória vai pelo system) mas ainda lança se o store falha', async () => {
    const memory = new AgentMemory({ store: new FakeStore() });
    expect(await memory.recall()).toEqual([]);
    const broken = new AgentMemory({
      store: {
        ...new FakeStore(),
        readAll: async () => {
          throw new Error('boom');
        },
      } as unknown as MemoryStorePort,
    });
    await expect(broken.recall()).rejects.toThrow('boom');
  });
});

describe('sub-agentes seguem a memória do dono', () => {
  it('o system do filho carrega o bloco', async () => {
    const systems: string[] = [];
    const caller: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        systems.push(args.messages[0]!.content as string);
        return {
          request_id: 'r',
          content: 'pronto.',
          finish_reason: 'stop',
          usage: { request_id: 'r', tier: 't', tokens_in: 1, tokens_out: 1 },
        };
      },
    };
    const spawner = new SubAgentSpawner({
      model: caller,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: { fs: new MemoryFs(), shell: new RecordingShell(), search: new MemorySearch() },
      baseTools: [...NATIVE_TOOLS],
      memoryContextProvider: async () =>
        buildMemoryContext([fact('não implemente, só delegue', 'usuario')]),
    });
    await spawner.spawn([{ label: 'f', goal: 'x' }]);
    expect(systems[0]).toContain(MEMORY_USER_HEADER);
    expect(systems[0]).toContain('não implemente, só delegue');
  });
});
