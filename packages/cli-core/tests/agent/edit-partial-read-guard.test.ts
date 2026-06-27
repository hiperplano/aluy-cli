// EST-0944 (anti-data-loss · regressão) — o editor NÃO pode reescrever sobre uma
// leitura PARCIAL. Cenário REAL: o NodeFileSystemPort de produção, ao ler um arquivo
// acima do teto de bytes (5 MiB), devolve só um PREFIXO + um marcador textual
// (`[arquivo truncado: …]`), e p/ um binário devolve uma NOTA. Antes deste fix, o
// `edit_file`/`write_file` usavam ESSE conteúdo como `before`, achavam o `old_string`
// no prefixo, e reescreviam — TRUNCANDO o arquivo no disco (de M bytes p/ ~5 MiB) e
// ainda injetando o marcador no fonte. Mesma classe de perda de dados que o str_replace
// cirúrgico nasceu p/ matar.
//
// O contrato: portas com `readFileMeta` reportam `complete=false` p/ leitura parcial/
// binária; o editor RECUSA (nada escrito). Portas sem `readFileMeta` (legado) degradam
// p/ `readFile` (assumem completo) — não regridem.

import { describe, expect, it } from 'vitest';
import { editFileTool, writeFileTool } from '../../src/agent/tools/native.js';
import { MemoryFs, makePorts } from './helpers.js';
import type { FileReadMeta } from '../../src/agent/tools/types.js';

/**
 * MemoryFs que SIMULA o port de produção: `readFile` devolve o que o modelo VÊ
 * (prefixo + marcador de truncamento), e `readFileMeta` reporta `complete=false`.
 * O conteúdo REAL em disco (`fullOnDisk`) é o arquivo inteiro — o que NÃO pode ser
 * destruído. Capturamos o que foi escrito p/ provar que NADA foi reescrito.
 */
class TruncatingFs extends MemoryFs {
  written: string | undefined;
  constructor(
    private readonly path: string,
    private readonly visiblePrefix: string,
  ) {
    super(new Map([[path, visiblePrefix]]));
  }
  override async readFileMeta(p: string): Promise<FileReadMeta> {
    if (p === this.path) return { content: this.visiblePrefix, complete: false };
    return { content: await super.readFile(p), complete: true };
  }
  override async writeFile(p: string, content: string): Promise<void> {
    this.written = content;
    await super.writeFile(p, content);
  }
}

describe('EST-0944 — editor recusa write-back sobre leitura PARCIAL (anti-data-loss)', () => {
  const PREFIX = 'linha A\nlinha B\n[arquivo truncado: lidos 5242880 de 12000000 bytes]';

  it('edit_file: arquivo lido parcialmente ⇒ RECUSA, nada escrito', async () => {
    const fs = new TruncatingFs('big.ts', PREFIX);
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run(
      { path: 'big.ts', old_string: 'linha A', new_string: 'linha X' },
      ports,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/grande demais|parcialmente|binário/i);
    // PROVA do bug: writeFile NUNCA foi chamado ⇒ o arquivo no disco fica intacto.
    expect(fs.written).toBeUndefined();
  });

  it('write_file (sem overwrite): arquivo existente ilegível por inteiro ⇒ RECUSA', async () => {
    const fs = new TruncatingFs('big.ts', PREFIX);
    const { ports } = makePorts({ fs });
    const r = await writeFileTool.run({ path: 'big.ts', content: 'novo conteúdo curto' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/grande demais|parcialmente|binário/i);
    expect(fs.written).toBeUndefined();
  });

  it('NÃO regride: porta SEM readFileMeta (legado) edita normalmente', async () => {
    // MemoryFs base não tem readFileMeta ⇒ degrada p/ readFile (assume completo).
    const fs = new MemoryFs(new Map([['a.ts', 'um dois tres']]));
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run(
      { path: 'a.ts', old_string: 'dois', new_string: 'DOIS' },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('a.ts')).toBe('um DOIS tres');
  });

  it('NÃO regride: readFileMeta com complete=true edita normalmente', async () => {
    const fs = new (class extends MemoryFs {
      override async readFileMeta(p: string): Promise<FileReadMeta> {
        return { content: await this.readFile(p), complete: true };
      }
    })(new Map([['a.ts', 'um dois tres']]));
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run(
      { path: 'a.ts', old_string: 'tres', new_string: 'TRES' },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('a.ts')).toBe('um dois TRES');
  });
});
