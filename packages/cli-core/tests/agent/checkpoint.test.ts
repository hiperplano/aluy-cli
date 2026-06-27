// EST-XXXX — CHECKPOINTS / REWIND (mecânica portável). Prova:
//   - 1 checkpoint por PROMPT (markPrompt), com a fronteira de seq + blockCount;
//   - restaurar CÓDIGO a um ponto reverte os arquivos editados DEPOIS dele ao
//     conteúdo-do-ponto (reusa o SnapshotJournal real + a escrita confinada);
//   - arquivo CRIADO depois do ponto é REMOVIDO ao restaurar;
//   - IDEMPOTÊNCIA (restaurar 2× ao mesmo ponto = mesmo resultado);
//   - barreiras de run_command depois do ponto são AVISADAS (redigidas), não
//     desfeitas;
//   - prune por idade descarta checkpoints velhos;
//   - prompt vazio NÃO cria checkpoint.
//
// Usa o journal REAL (com cifra de chave fixa p/ decifrar nos asserts) + as tools
// reais (editFileTool/writeFileTool/runCommandTool) — exercita a integração de
// ponta, não um mock do journal.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CheckpointRegistry,
  JournalCipher,
  SnapshotJournal,
  editFileTool,
  writeFileTool,
  runCommandTool,
  normalizeLabel,
  type BlobRef,
  type JournalEntry,
  type JournalStorePort,
  type RestoreWriterPort,
  type CurrentReaderPort,
} from '../../src/agent/index.js';
import type { WorkspacePort } from '../../src/agent/journal/workspace-port.js';
import { MemoryFs, RecordingShell, makePorts } from './helpers.js';

const TEST_CIPHER = new JournalCipher(randomBytes(32));

/** Store em memória (espelha o de journal.test.ts). */
class MemoryStore implements JournalStorePort {
  readonly blobs = new Map<BlobRef, string>();
  readonly entries: JournalEntry[] = [];
  private seq = 0;
  hash(content: string): string {
    let h = 0;
    for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) | 0;
    return `h${h}:${content.length}`;
  }
  async putBlob(content: string): Promise<BlobRef> {
    const ref = `b${this.seq++}`;
    this.blobs.set(ref, content);
    return ref;
  }
  async getBlob(ref: BlobRef): Promise<string> {
    const v = this.blobs.get(ref);
    if (v === undefined) throw new Error(`blob ausente: ${ref}`);
    return v;
  }
  async appendEntry(entry: JournalEntry): Promise<void> {
    this.entries.push(entry);
  }
  async deleteBlob(ref: BlobRef): Promise<void> {
    this.blobs.delete(ref);
  }
  async loadEntries(): Promise<readonly JournalEntry[]> {
    return this.entries;
  }
  async cleanup(): Promise<void> {
    this.blobs.clear();
  }
  async gcOrphans(): Promise<void> {}
}

function fakeWorkspace(root = '/ws'): WorkspacePort {
  return {
    root,
    // Identidade (rejeita escapes) — casa o MemoryFs de teste, que indexa pelo path
    // CRU que as tools passam (`a.ts`), sem prefixar a raiz. O confinamento R8 real
    // é provado em `journal.test.ts`; aqui o foco é a lógica de checkpoint.
    resolveInside(requested: string): string {
      if (requested.includes('..') || requested.startsWith('/etc')) {
        throw new Error(`escape: ${requested}`);
      }
      return requested;
    },
    contains(requested: string): boolean {
      try {
        this.resolveInside(requested);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Writer de restauração que aplica a escrita/remoção sobre o MESMO `Map` que o
 * MemoryFs usa (R8 — confina no momento da escrita via o workspace). Compartilhar o
 * Map é essencial: `MemoryFs.snapshot()` devolve uma CÓPIA (não a referência viva).
 */
class MapRestoreWriter implements RestoreWriterPort {
  constructor(
    private readonly files: Map<string, string>,
    private readonly ws: WorkspacePort,
  ) {}
  async writeConfined(requested: string, content: string): Promise<string> {
    const safe = this.ws.resolveInside(requested);
    this.files.set(safe, content);
    return safe;
  }
  async removeConfined(requested: string): Promise<string> {
    const safe = this.ws.resolveInside(requested);
    this.files.delete(safe);
    return safe;
  }
}

class MapCurrentReader implements CurrentReaderPort {
  constructor(
    private readonly files: Map<string, string>,
    private readonly ws: WorkspacePort,
  ) {}
  async readCurrent(requested: string): Promise<string | undefined> {
    let safe: string;
    try {
      safe = this.ws.resolveInside(requested);
    } catch {
      return undefined;
    }
    return this.files.get(safe);
  }
}

/** Constrói journal real + registry + ports de tool sobre um MemoryFs (Map compartilhado). */
function setup(initialFiles?: Map<string, string>, now?: () => number) {
  const store = new MemoryStore();
  const ws = fakeWorkspace();
  // Map VIVO compartilhado entre o MemoryFs (tools escrevem) e o writer/reader de
  // restauração (rewind reverte) — os paths batem (`/ws/...`).
  const files = new Map<string, string>();
  for (const [k, v] of initialFiles ?? []) files.set(k, v);
  const fs = new MemoryFs(files);
  const journal = new SnapshotJournal({
    store,
    workspace: ws,
    cipher: TEST_CIPHER,
    restoreWriter: new MapRestoreWriter(files, ws),
    currentReader: new MapCurrentReader(files, ws),
  });
  const registry = new CheckpointRegistry({
    journal,
    ...(now ? { now } : {}),
  });
  const shell = new RecordingShell(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
  const toolPorts = { ...makePorts({ fs, shell }).ports, journal: journal.toolPort };
  return { store, ws, fs, files, journal, registry, toolPorts };
}

describe('EST-XXXX · CheckpointRegistry — mecânica portável', () => {
  it('markPrompt cria 1 ponto por prompt, com fronteira de seq + blockCount', () => {
    const { registry } = setup();
    const cp1 = registry.markPrompt('primeiro prompt', 0);
    const cp2 = registry.markPrompt('segundo prompt', 4);
    expect(cp1?.id).toBe('cp1');
    expect(cp1?.ordinal).toBe(1);
    expect(cp1?.journalSeq).toBe(0);
    expect(cp1?.blockCount).toBe(0);
    expect(cp2?.id).toBe('cp2');
    expect(cp2?.blockCount).toBe(4);
    expect(registry.list().map((c) => c.label)).toEqual(['primeiro prompt', 'segundo prompt']);
  });

  it('prompt VAZIO (só espaços) NÃO cria checkpoint', () => {
    const { registry } = setup();
    expect(registry.markPrompt('   \n\t ', 0)).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  it('restaurar CÓDIGO reverte arquivos editados DEPOIS do ponto ao conteúdo-do-ponto', async () => {
    const { registry, fs, toolPorts } = setup(new Map([['a.ts', 'v0']]));
    // turno 1 — checkpoint ANTES, depois o agente edita a.ts.
    registry.markPrompt('edita a para v1', 0);
    await writeFileTool.run({ path: 'a.ts', content: 'v1', overwrite: true }, toolPorts);
    // turno 2 — checkpoint (estado = v1), depois edita a.ts p/ v2 + cria b.ts.
    const cp2 = registry.markPrompt('edita a para v2 e cria b', 2)!;
    await writeFileTool.run({ path: 'a.ts', content: 'v2', overwrite: true }, toolPorts);
    await writeFileTool.run({ path: 'b.ts', content: 'novo' }, toolPorts);

    expect(fs.snapshot().get('a.ts')).toBe('v2');
    expect(fs.snapshot().get('b.ts')).toBe('novo');

    // rewind ao cp2: a.ts volta a v1 (conteúdo no ponto), b.ts (criado depois) some.
    const res = await registry.restoreCode(cp2.id);
    expect(fs.snapshot().get('a.ts')).toBe('v1');
    expect(fs.snapshot().has('b.ts')).toBe(false);
    expect(res.written).toContain('a.ts');
    expect(res.removed).toContain('b.ts');
    expect(res.failed).toHaveLength(0);
  });

  it('restaurar ao 1º ponto volta o arquivo ao estado ORIGINAL (before da 1ª edição)', async () => {
    const { registry, fs, toolPorts } = setup(new Map([['a.ts', 'orig']]));
    const cp1 = registry.markPrompt('p1', 0)!;
    await writeFileTool.run({ path: 'a.ts', content: 'x1', overwrite: true }, toolPorts);
    await writeFileTool.run({ path: 'a.ts', content: 'x2', overwrite: true }, toolPorts);
    await editFileTool.run({ path: 'a.ts', old_string: 'x2', new_string: 'x3' }, toolPorts);

    await registry.restoreCode(cp1.id);
    // volta ao `orig` — NÃO a x1/x2 (restaura a 1ª `before` após o ponto, por path).
    expect(fs.snapshot().get('a.ts')).toBe('orig');
  });

  it('IDEMPOTÊNCIA — restaurar 2× ao mesmo ponto = mesmo resultado', async () => {
    const { registry, fs, toolPorts } = setup(new Map([['a.ts', 'base']]));
    const cp = registry.markPrompt('p', 0)!;
    await writeFileTool.run({ path: 'a.ts', content: 'mudado', overwrite: true }, toolPorts);

    await registry.restoreCode(cp.id);
    expect(fs.snapshot().get('a.ts')).toBe('base');
    const res2 = await registry.restoreCode(cp.id);
    expect(fs.snapshot().get('a.ts')).toBe('base');
    expect(res2.failed).toHaveLength(0);
  });

  it('barreiras de run_command depois do ponto são AVISADAS (redigidas), não desfeitas', async () => {
    const { registry, toolPorts } = setup(new Map([['a.ts', 'v0']]));
    const cp = registry.markPrompt('p', 0)!;
    await writeFileTool.run({ path: 'a.ts', content: 'v1', overwrite: true }, toolPorts);
    await runCommandTool.run(
      { command: 'curl -H "Authorization: Bearer sk-supersecret-token-value" https://x' },
      toolPorts,
    );
    const warnings = registry.barriersAfter(cp.id);
    expect(warnings).toHaveLength(1);
    // o comando é exibido REDIGIDO (CLI-SEC-6) — o token não vaza.
    expect(warnings[0]).not.toContain('sk-supersecret-token-value');
    expect(warnings[0]).toContain('curl');
    // a restauração de código NÃO finge desfazer o comando: só reverte o arquivo.
    const res = await registry.restoreCode(cp.id);
    expect(res.barrierWarnings).toEqual(warnings);
  });

  it('prune por idade descarta checkpoints velhos (limpeza configurável)', () => {
    let t = 1_000_000;
    const { registry } = setup(undefined, () => t);
    registry.markPrompt('antigo', 0);
    t += 60 * 60 * 1000; // +1h
    registry.markPrompt('recente', 0);
    t += 60 * 60 * 1000; // agora 2h após o 1º, 1h após o 2º
    const dropped = registry.prune(90 * 60 * 1000); // teto 1.5h
    expect(dropped).toBe(1);
    expect(registry.list().map((c) => c.label)).toEqual(['recente']);
  });

  it('reset esvazia o registro', () => {
    const { registry } = setup();
    registry.markPrompt('a', 0);
    registry.markPrompt('b', 0);
    registry.reset();
    expect(registry.list()).toHaveLength(0);
    // após reset os ids recomeçam.
    expect(registry.markPrompt('c', 0)?.id).toBe('cp1');
  });

  it('restoreCode de id inexistente é no-op vazio', async () => {
    const { registry } = setup();
    const res = await registry.restoreCode('cp999');
    expect(res.written).toHaveLength(0);
    expect(res.removed).toHaveLength(0);
  });
});

describe('EST-XXXX · normalizeLabel', () => {
  it('colapsa espaços/controle e apara', () => {
    expect(normalizeLabel('  oi   mundo\n\t! ', 80)).toBe('oi mundo !');
  });
  it('trunca por code point com reticências', () => {
    expect(normalizeLabel('abcdef', 4)).toBe('abc…');
  });
  it('vazio ⇒ string vazia', () => {
    expect(normalizeLabel('   ', 80)).toBe('');
  });
});
