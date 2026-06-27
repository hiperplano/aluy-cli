// EST-0948 — SearchPort (grep) confinado: varre dentro da raiz, ignora .git/
// node_modules, não segue symlink p/ fora.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSearchPort } from '../../src/io/search-port.js';
import { NodeWorkspace, WorkspaceEscapeError } from '../../src/io/workspace.js';

describe('NodeSearchPort — busca confinada', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-grep-'));
    root = join(base, 'project');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'const httpClient = 1;\nconst broker = 2;\n');
    writeFileSync(join(root, 'src', 'b.ts'), 'import { httpClient } from "x";\n');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'httpClient everywhere\n');
    writeFileSync(join(base, 'outside.ts'), 'httpClient leak\n');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('encontra o padrão em arquivos dentro da raiz', async () => {
    const search = new NodeSearchPort({ workspace: new NodeWorkspace({ root }) });
    const { matches } = await search.search('httpClient', '.');
    const paths = matches.map((m) => m.path);
    expect(paths.some((p) => p.endsWith('a.ts'))).toBe(true);
    expect(paths.some((p) => p.endsWith('b.ts'))).toBe(true);
  });

  it('IGNORA node_modules', async () => {
    const search = new NodeSearchPort({ workspace: new NodeWorkspace({ root }) });
    const { matches } = await search.search('httpClient', '.');
    expect(matches.every((m) => !m.path.includes('node_modules'))).toBe(true);
  });

  it('NÃO encontra fora da raiz (confinamento do base)', async () => {
    const search = new NodeSearchPort({ workspace: new NodeWorkspace({ root }) });
    // buscar a partir de `..` é rejeitado pelo confinamento.
    await expect(search.search('httpClient', '..')).rejects.toThrow(WorkspaceEscapeError);
  });

  it('NÃO segue symlink que aponta p/ fora da raiz', async () => {
    symlinkSync(join(base, 'outside.ts'), join(root, 'src', 'link.ts'));
    const search = new NodeSearchPort({ workspace: new NodeWorkspace({ root }) });
    const { matches } = await search.search('leak', '.');
    // o conteúdo "leak" só existe fora (via symlink) ⇒ não deve aparecer.
    expect(matches.length).toBe(0);
  });

  it('devolve o número de linha correto', async () => {
    const search = new NodeSearchPort({ workspace: new NodeWorkspace({ root }) });
    const { matches } = await search.search('broker', 'src/a.ts');
    expect(matches.length).toBe(1);
    expect(matches[0]!.line).toBe(2);
  });

  // EST-1010 — ANTI-OOM: arquivo GIGANTE é lido só até o teto (stream parcial),
  // nunca materializado inteiro. Casa o que está dentro do teto; não OOMa.
  it('TRUNCA arquivo > maxScanBytes sem materializar o todo (anti-OOM)', async () => {
    const big = join(root, 'src', 'dump.log');
    // Linha alvo no INÍCIO (dentro do teto) + ~1 MiB de lixo depois (> teto de 4 KiB).
    const head = 'needle aqui na linha 1\n';
    const filler = Buffer.alloc(1024 * 1024, 0x2e); // 1 MiB de '.'
    writeFileSync(big, Buffer.concat([Buffer.from(head), filler]));
    const search = new NodeSearchPort({
      workspace: new NodeWorkspace({ root }),
      maxScanBytes: 4 * 1024,
    });
    // Não OOMa e ainda acha o needle que está dentro do teto.
    const { matches } = await search.search('needle', 'src/dump.log');
    expect(matches.length).toBe(1);
    expect(matches[0]!.line).toBe(1);
  });

  it('arquivo pequeno é varrido INTEIRO (não regride: needle no fim continua achado)', async () => {
    const small = join(root, 'src', 'small.txt');
    writeFileSync(small, 'a\nb\nc\nneedle no fim\n');
    const search = new NodeSearchPort({
      workspace: new NodeWorkspace({ root }),
      maxScanBytes: 4 * 1024,
    });
    const { matches } = await search.search('needle', 'src/small.txt');
    expect(matches.length).toBe(1);
    expect(matches[0]!.line).toBe(4);
  });

  // ── EST-1013: endurecimento de cobertura ──────────────────────────────

  it('pula arquivo com byte NUL (heurística de binário)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-grep-nul-'));
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    // Arquivo com NUL no meio do conteúdo — a heurística de binário deve pular.
    writeFileSync(
      join(root, 'binario.txt'),
      'linha1\n' + 'achado' + String.fromCharCode(0) + ' mais\nlinha3\n',
    );
    // Arquivo normal, sem NUL, que também contém o pattern.
    writeFileSync(join(root, 'normal.txt'), 'linha1\nachado normal\nlinha3\n');

    const search = new NodeSearchPort({ workspace: new NodeWorkspace({ root }) });
    const { matches } = await search.search('achado', '.');

    // O match do arquivo normal deve aparecer.
    expect(matches.some((m) => m.path.endsWith('normal.txt'))).toBe(true);
    // O arquivo com NUL não deve gerar match algum.
    expect(matches.every((m) => !m.path.endsWith('binario.txt'))).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });

  it('pula symlink na varredura (arquivo real é encontrado, symlink não)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-grep-sym-'));
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    // Arquivo real com o pattern.
    writeFileSync(join(root, 'alvo.txt'), 'conteudo alvolink aqui\n');
    // Symlink dentro da raiz apontando para o arquivo real.
    symlinkSync(join(root, 'alvo.txt'), join(root, 'link.txt'));

    const search = new NodeSearchPort({ workspace: new NodeWorkspace({ root }) });
    const { matches } = await search.search('alvolink', '.');

    // O match deve vir do arquivo real.
    expect(matches.some((m) => m.path.endsWith('alvo.txt'))).toBe(true);
    // Nenhum match deve ter path igual ao symlink.
    expect(matches.every((m) => !m.path.endsWith('link.txt'))).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });

  it('respeita teto maxMatches (corta no limite)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-grep-maxm-'));
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    // Arquivo com duas linhas contendo o pattern.
    writeFileSync(join(root, 'multi.txt'), 'match linha1\nmatch linha2\n');

    const search = new NodeSearchPort({
      workspace: new NodeWorkspace({ root }),
      maxMatches: 1,
    });
    const { matches } = await search.search('match', '.');

    expect(matches.length).toBeLessThanOrEqual(1);
    // Como maxMatches=1, só deve vir 1 match (a primeira linha).
    expect(matches.length).toBe(1);
    expect(matches[0]!.line).toBe(1);

    rmSync(base, { recursive: true, force: true });
  });

  it('respeita teto maxFiles (varre no máximo N arquivos)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-grep-maxf-'));
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    // Dois arquivos, cada um com o pattern.
    writeFileSync(join(root, 'um.txt'), 'pattern um\n');
    writeFileSync(join(root, 'dois.txt'), 'pattern dois\n');

    const search = new NodeSearchPort({
      workspace: new NodeWorkspace({ root }),
      maxFiles: 1,
    });
    const { matches } = await search.search('pattern', '.');

    // maxFiles=1 ⇒ só varre 1 arquivo, então todos os matches vêm de um único arquivo.
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const arquivos = new Set(matches.map((m) => m.path));
    expect(arquivos.size).toBe(1);

    rmSync(base, { recursive: true, force: true });
  });
});

// EST-1016 — TRUNCAMENTO VISÍVEL: o port reporta `truncated` quando bate cada teto
// (anti-OOM/anti-flood). Os tetos (EST-1010) PERMANECEM; só passam a ser sinalizados.
describe('NodeSearchPort — truncamento honesto (EST-1016)', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-grep-trunc-'));
    root = join(base, 'project');
    mkdirSync(join(root, 'src'), { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  // CA-5 (não-regressão / não trunca): busca que NÃO atinge nenhum teto.
  it('CA-5 — varredura completa: truncated vazio (todos os ramos ausentes)', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'const httpClient = 1;\nconst broker = 2;\n');
    const search = new NodeSearchPort({ workspace: new NodeWorkspace({ root }) });
    const { matches, truncated } = await search.search('httpClient', '.');
    expect(matches.length).toBe(1);
    expect(truncated.byScanBytes).toBeUndefined();
    expect(truncated.byMaxMatches).toBeUndefined();
    expect(truncated.byMaxFiles).toBeUndefined();
  });

  // CA-2 (REPRO 1, scan-bytes): arquivo > teto com padrão antes E depois do teto.
  it('CA-2 — byScanBytes: arquivo > maxScanBytes lista o path; acha só o de dentro do teto', async () => {
    const big = join(root, 'src', 'dump.log');
    // "agulha" na linha 1 (dentro do teto) + ~1 MiB de lixo + "agulha" no FIM (além).
    const head = 'agulha no inicio\n';
    const filler = Buffer.alloc(1024 * 1024, 0x2e); // 1 MiB de '.'
    const tail = '\nagulha no fim\n';
    writeFileSync(big, Buffer.concat([Buffer.from(head), filler, Buffer.from(tail)]));
    const search = new NodeSearchPort({
      workspace: new NodeWorkspace({ root }),
      maxScanBytes: 4 * 1024,
    });
    const { matches, truncated } = await search.search('agulha', 'src/dump.log');
    // só a do início (a do fim está além do teto) ⇒ resultado PARCIAL...
    expect(matches.length).toBe(1);
    expect(matches[0]!.line).toBe(1);
    // ...mas o truncamento é VISÍVEL (path do arquivo cortado).
    expect(truncated.byScanBytes).toBeDefined();
    expect(truncated.byScanBytes!.some((p) => p.endsWith('dump.log'))).toBe(true);
  });

  // CA-3 (REPRO 2, maxMatches): mais acertos que o teto.
  it('CA-3 — byMaxMatches: corta em maxMatches e sinaliza (não conta errado em silêncio)', async () => {
    const many = Array.from({ length: 300 }, () => 'agulha').join('\n') + '\n';
    writeFileSync(join(root, 'src', 'many.txt'), many);
    const search = new NodeSearchPort({
      workspace: new NodeWorkspace({ root }),
      maxMatches: 200,
    });
    const { matches, truncated } = await search.search('agulha', '.');
    expect(matches.length).toBe(200);
    expect(truncated.byMaxMatches).toBe(true);
    // os outros ramos não dispararam.
    expect(truncated.byScanBytes).toBeUndefined();
  });

  // CA-4 (maxFiles): árvore com mais arquivos que o teto.
  it('CA-4 — byMaxFiles: varredura para no teto de arquivos e sinaliza', async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(root, 'src', `f${i}.txt`), 'agulha\n');
    }
    // teto BAIXO (3) p/ um teste barato — o default 5000 é preservado em CA-7.
    const search = new NodeSearchPort({
      workspace: new NodeWorkspace({ root }),
      maxFiles: 3,
    });
    const { truncated } = await search.search('agulha', '.');
    expect(truncated.byMaxFiles).toBe(true);
  });

  // CA-7 (anti-regressão EST-1010): os defaults NÃO mudam + read-bounded preservado.
  it('CA-7 — defaults preservados (5 MiB / 200 / 5000) e read-bounded ativo', async () => {
    // (i) com defaults, um arquivo pequeno NÃO é reportado como truncado por bytes.
    writeFileSync(join(root, 'src', 'small.txt'), 'agulha\n');
    const def = new NodeSearchPort({ workspace: new NodeWorkspace({ root }) });
    const r1 = await def.search('agulha', '.');
    expect(r1.truncated.byScanBytes).toBeUndefined();
    // (ii) o read-bounded continua valendo: arquivo > teto explícito ⇒ byScanBytes.
    const big = join(root, 'src', 'big.bin');
    writeFileSync(big, Buffer.concat([Buffer.from('agulha\n'), Buffer.alloc(1024 * 64, 0x2e)]));
    const bounded = new NodeSearchPort({
      workspace: new NodeWorkspace({ root }),
      maxScanBytes: 1024,
    });
    const r2 = await bounded.search('agulha', 'src/big.bin');
    expect(r2.truncated.byScanBytes).toBeDefined();
    expect(r2.matches.length).toBe(1); // achou o que está dentro do teto, não OOMou
    // (iii) o DEFAULT maxScanBytes é EXATAMENTE 5 MiB (anti-regressão EST-1010 +
    // mutação adversarial): um arquivo > 5 MiB SOB OS DEFAULTS é truncado (afrouxar o
    // default p/ um valor enorme faria esta asserção reprovar). ~4 MiB NÃO trunca.
    const justUnder = join(root, 'src', 'under5.bin');
    writeFileSync(justUnder, Buffer.alloc(4 * 1024 * 1024, 0x61)); // 4 MiB de 'a' (< 5 MiB)
    expect(
      (await def.search('zzz-nao-existe', 'src/under5.bin')).truncated.byScanBytes,
    ).toBeUndefined();
    const justOver = join(root, 'src', 'over5.bin');
    writeFileSync(justOver, Buffer.alloc(6 * 1024 * 1024, 0x61)); // 6 MiB de 'a' (> 5 MiB)
    const r3 = await def.search('zzz-nao-existe', 'src/over5.bin');
    expect(r3.truncated.byScanBytes).toBeDefined();
    expect(r3.truncated.byScanBytes!.some((p) => p.endsWith('over5.bin'))).toBe(true);
  });
});
