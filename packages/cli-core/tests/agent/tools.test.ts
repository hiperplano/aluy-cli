import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  changeDirTool,
  editFileTool,
  grepTool,
  readFileTool,
  runCommandTool,
  unifiedDiff,
  writeFileTool,
} from '../../src/agent/tools/index.js';
import { MemoryCwd, MemoryFs, MemorySearch, RecordingShell, makePorts } from './helpers.js';

describe('EST-0944 · tools nativas', () => {
  it('read_file lê o conteúdo via porta injetável', async () => {
    const fs = new MemoryFs(new Map([['a.ts', 'olá']]));
    const { ports } = makePorts({ fs });
    const r = await readFileTool.run({ path: 'a.ts' }, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toBe('olá');
  });

  it('read_file sem path ⇒ erro (ok=false, não lança)', async () => {
    const { ports } = makePorts();
    const r = await readFileTool.run({}, ports);
    expect(r.ok).toBe(false);
  });

  it('edit_file (str_replace) troca SÓ o trecho e PRESERVA o resto', async () => {
    const fs = new MemoryFs(new Map([['x.ts', 'um\ndois\ntrês']]));
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run(
      { path: 'x.ts', old_string: 'dois', new_string: 'DOIS' },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('x.ts')).toBe('um\nDOIS\ntrês');
    expect(r.display).toContain('-dois');
    expect(r.display).toContain('+DOIS');
  });

  it('edit_file: new_string com "$" é LITERAL (não interpreta $&/$1 — não corrompe $VAR)', async () => {
    const fs = new MemoryFs(new Map([['s.sh', 'echo OLD']]));
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run(
      { path: 's.sh', old_string: 'OLD', new_string: '$HOME/$1 e $& literal' },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('s.sh')).toBe('echo $HOME/$1 e $& literal');
  });

  it('edit_file new_string vazio REMOVE o trecho (resto intacto)', async () => {
    const fs = new MemoryFs(new Map([['x.ts', 'a;b;c']]));
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run({ path: 'x.ts', old_string: ';b', new_string: '' }, ports);
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('x.ts')).toBe('a;c');
  });

  it('edit_file: old_string não encontrado ⇒ ERRA sem escrever', async () => {
    const fs = new MemoryFs(new Map([['x.ts', 'conteúdo original']]));
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run(
      { path: 'x.ts', old_string: 'inexistente', new_string: 'novo' },
      ports,
    );
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/não encontrado/i);
    // arquivo INTACTO — nenhum byte escrito.
    expect(fs.snapshot().get('x.ts')).toBe('conteúdo original');
  });

  it('edit_file: old_string ambíguo (>1×) sem replace_all ⇒ ERRA sem escrever', async () => {
    const fs = new MemoryFs(new Map([['x.ts', 'foo\nfoo\nfoo']]));
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run({ path: 'x.ts', old_string: 'foo', new_string: 'bar' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/ambíguo|3×/i);
    expect(fs.snapshot().get('x.ts')).toBe('foo\nfoo\nfoo'); // intacto
  });

  it('edit_file: replace_all troca TODAS as ocorrências', async () => {
    const fs = new MemoryFs(new Map([['x.ts', 'foo\nfoo\nfoo']]));
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run(
      { path: 'x.ts', old_string: 'foo', new_string: 'bar', replace_all: true },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('x.ts')).toBe('bar\nbar\nbar');
  });

  it('edit_file: old_string === new_string ⇒ ERRA (nada a fazer)', async () => {
    const fs = new MemoryFs(new Map([['x.ts', 'igual']]));
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run({ path: 'x.ts', old_string: 'ig', new_string: 'ig' }, ports);
    expect(r.ok).toBe(false);
  });

  it('edit_file em arquivo INEXISTENTE ⇒ ERRA orientando write_file', async () => {
    const fs = new MemoryFs();
    const { ports } = makePorts({ fs });
    const r = await editFileTool.run({ path: 'novo.ts', old_string: 'a', new_string: 'b' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/write_file/);
    expect(fs.snapshot().has('novo.ts')).toBe(false);
  });

  // ── O CENÁRIO DO BUG (data-loss do Granito): arquivo 95 linhas, troca 1 linha ──
  // O modelo barato re-emitia o arquivo INTEIRO como "content" e o truncava (95→2).
  // Com edit_file (str_replace) isso é IMPOSSÍVEL: troca-se só 1 linha ⇒ 95 linhas, 1
  // mudada (NÃO 2). E o tool não aceita mais "content" full — não há como truncar.
  it('CENÁRIO DO BUG — arquivo 95 linhas, troca 1 linha ⇒ 95 linhas (1 mudada, NÃO 2)', async () => {
    const linhas = Array.from({ length: 95 }, (_, i) => `linha ${i + 1}`);
    const original = linhas.join('\n');
    const fs = new MemoryFs(new Map([['types.ts', original]]));
    const { ports } = makePorts({ fs });

    const r = await editFileTool.run(
      { path: 'types.ts', old_string: 'linha 42', new_string: 'linha 42 EDITADA' },
      ports,
    );

    expect(r.ok).toBe(true);
    const after = fs.snapshot().get('types.ts')!;
    const afterLines = after.split('\n');
    expect(afterLines).toHaveLength(95); // NÃO truncou p/ 2
    expect(afterLines[41]).toBe('linha 42 EDITADA');
    // todas as OUTRAS linhas intactas:
    expect(afterLines[0]).toBe('linha 1');
    expect(afterLines[94]).toBe('linha 95');
  });

  it('edit_file: o input "content" full NÃO é aceito (sem old_string ⇒ ERRA, não trunca)', async () => {
    const fs = new MemoryFs(new Map([['types.ts', 'A\nB\nC\nD\nE']]));
    const { ports } = makePorts({ fs });
    // o caso real: o modelo manda só "content" (2 linhas) como antes ⇒ ERRA, arquivo intacto.
    const r = await editFileTool.run({ path: 'types.ts', content: 'A\nB' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/old_string/);
    expect(fs.snapshot().get('types.ts')).toBe('A\nB\nC\nD\nE'); // NÃO truncou
  });

  // ── write_file (full content) — criar novo + guard anti-truncamento ──
  it('write_file cria arquivo NOVO e expõe diff exato (CLI-SEC-9)', async () => {
    const fs = new MemoryFs();
    const { ports } = makePorts({ fs });
    const r = await writeFileTool.run({ path: 'novo.ts', content: 'linha' }, ports);
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('novo.ts')).toBe('linha');
    expect(r.display).toContain('+++ novo.ts');
    expect(r.display).toContain('+linha');
  });

  it('write_file sobre arquivo MENOR (>50%) ⇒ RECUSA (guard anti-truncamento)', async () => {
    const original = Array.from({ length: 95 }, (_, i) => `linha ${i + 1}`).join('\n');
    const fs = new MemoryFs(new Map([['types.ts', original]]));
    const { ports } = makePorts({ fs });
    // O bug real: modelo manda 2 linhas como "content" full sobre o arquivo de 95.
    const r = await writeFileTool.run({ path: 'types.ts', content: 'linha 1\nlinha 2' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/RECUSOU|edit_file|overwrite/);
    expect(fs.snapshot().get('types.ts')).toBe(original); // INTACTO — não destruiu
  });

  it('write_file com marcador de truncamento ("… resto igual …") ⇒ RECUSA', async () => {
    const original = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';
    const fs = new MemoryFs(new Map([['m.ts', original]]));
    const { ports } = makePorts({ fs });
    const r = await writeFileTool.run(
      { path: 'm.ts', content: 'a\nb\nc\nd\ne\nf\n// ... resto igual ...' },
      ports,
    );
    expect(r.ok).toBe(false);
    expect(fs.snapshot().get('m.ts')).toBe(original);
  });

  it('F17 — write_file com marcador PT "mantenha as outras" ⇒ RECUSA (marcador, NÃO <50%)', async () => {
    const original = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj'; // 10 linhas
    const fs = new MemoryFs(new Map([['cfg.py', original]]));
    const { ports } = makePorts({ fs });
    // 7 linhas (>50% de 10 ⇒ o guard de <50% NÃO dispara); só o MARCADOR pega.
    const r = await writeFileTool.run(
      { path: 'cfg.py', content: 'a\nb\nc\nd\ne\nf\n# ... (mantenha as outras linhas)' },
      ports,
    );
    expect(r.ok).toBe(false);
    expect(fs.snapshot().get('cfg.py')).toBe(original);
  });

  it('F19 — write_file com `[...]` INLINE legítimo (numpy arr[...]) NÃO casa marcador ⇒ recusa GENÉRICA "já existe" (não a de truncamento) + com overwrite:true ESCREVE', async () => {
    // 10 linhas → 10 linhas (sem shrink); o `[...]` inline NÃO é marcador de truncamento.
    // Política nova (anti-data-loss): sobre EXISTENTE sem overwrite ⇒ recusa, mas o motivo
    // é "já existe" (não "truncamento"), provando que a heurística inline NÃO deu FP. Com
    // overwrite:true o rewrite intencional passa (o `[...]` inline não barra).
    const original = Array.from({ length: 10 }, (_, i) => `linha ${i}`).join('\n');
    const novo = Array.from({ length: 10 }, (_, i) =>
      i === 4 ? 'valor = arr[...]  # numpy Ellipsis' : `linha ${i}`,
    ).join('\n');
    const fs = new MemoryFs(new Map([['calc.py', original]]));
    const { ports } = makePorts({ fs });
    const refused = await writeFileTool.run({ path: 'calc.py', content: novo }, ports);
    expect(refused.ok).toBe(false);
    expect(refused.observation).toMatch(/já existe/i); // recusa genérica, não a de truncamento
    expect(refused.observation).not.toMatch(/truncamento|resto igual/i);
    expect(fs.snapshot().get('calc.py')).toBe(original); // intacto
    const r = await writeFileTool.run({ path: 'calc.py', content: novo, overwrite: true }, ports);
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('calc.py')).toBe(novo);
  });

  it('F19 — write_file com `[...]` em LINHA-PRÓPRIA ⇒ ainda RECUSA (catch da truncação preservado)', async () => {
    const original = Array.from({ length: 10 }, (_, i) => `linha ${i}`).join('\n');
    // mesmo tamanho (sem shrink); a truncação `[...]` numa linha sozinha deve ser pega.
    const truncado = Array.from({ length: 10 }, (_, i) =>
      i === 4 ? '  [...]' : `linha ${i}`,
    ).join('\n');
    const fs = new MemoryFs(new Map([['calc.py', original]]));
    const { ports } = makePorts({ fs });
    const r = await writeFileTool.run({ path: 'calc.py', content: truncado }, ports);
    expect(r.ok).toBe(false);
    expect(fs.snapshot().get('calc.py')).toBe(original);
  });

  it('write_file overwrite:true ⇒ reescreve DE PROPÓSITO (guard liberado)', async () => {
    const original = Array.from({ length: 95 }, (_, i) => `linha ${i + 1}`).join('\n');
    const fs = new MemoryFs(new Map([['types.ts', original]]));
    const { ports } = makePorts({ fs });
    const r = await writeFileTool.run(
      { path: 'types.ts', content: 'novo conteúdo curto', overwrite: true },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('types.ts')).toBe('novo conteúdo curto');
  });

  // REGRESSÃO (EST-0944) — o BUG do dogfood: "criar CHANGELOG.md" sobre um existente
  // de 100 linhas CURADAS com 50 linhas NOVAS NÃO-truncadas (não <50% das linhas, bytes
  // comparáveis, SEM marcador) ⇒ shrink/byte-shrink/marcador NÃO disparavam e o write
  // PROSSEGUIA, apagando o header Keep-a-Changelog + groundwork de release. Agora: sobre
  // arquivo EXISTENTE sem overwrite ⇒ RECUSA SEMPRE, NADA escrito, conteúdo PRESERVADO.
  // SEM o fix esta asserção falha (r.ok===true, o curado some). Prove revertendo o source.
  it('REGRESSÃO — write_file "criar CHANGELOG.md" sobre existente curado, conteúdo NÃO-truncado, sem overwrite ⇒ RECUSA "já existe" e PRESERVA o curado', async () => {
    // 100 linhas curadas (header Keep-a-Changelog + groundwork de release).
    const curado = [
      '# Changelog',
      'Todas as mudanças notáveis deste projeto (Keep a Changelog).',
      ...Array.from({ length: 98 }, (_, i) => `- entrada curada ${i + 1}`),
    ].join('\n');
    expect(curado.split('\n').length).toBe(100);
    const fs = new MemoryFs(new Map([['CHANGELOG.md', curado]]));
    const { ports } = makePorts({ fs });

    // 50 linhas NOVAS, não-truncadas: 50 NÃO é <50% de 100 (=50, não < 50); bytes
    // comparáveis (≥50% do tamanho); sem marcador "resto igual" — os guards antigos
    // ficavam CEGOS a este caso. É o gesto "criar" do modelo sobre um arquivo existente.
    const novo = Array.from({ length: 50 }, (_, i) => `## release nova entrada ${i + 1}`).join(
      '\n',
    );
    const afterLines = novo.split('\n').length;
    const beforeLines = curado.split('\n').length;
    expect(afterLines).not.toBeLessThan(beforeLines * 0.5); // shrink por linhas NÃO dispara
    expect(novo.length).not.toBeLessThan(curado.length * 0.5); // shrink por bytes NÃO dispara

    const r = await writeFileTool.run({ path: 'CHANGELOG.md', content: novo }, ports);
    expect(r.ok).toBe(false); // SEM o fix: true (o write prosseguia) ⇒ teste falha
    expect(r.observation).toMatch(/já existe/i);
    expect(r.observation).toMatch(/edit_file/); // orienta a editar preservando o resto
    expect(r.observation).toMatch(/overwrite/); // ou rewrite intencional explícito
    expect(fs.snapshot().get('CHANGELOG.md')).toBe(curado); // o curado SOBREVIVE intacto
  });

  it('write_file sobre arquivo de tamanho SEMELHANTE (não-truncado) sem overwrite ⇒ RECUSA "já existe" (anti-data-loss) + intacto', async () => {
    // Era o caso do BUG (dogfood CHANGELOG.md): conteúdo NÃO-truncado, tamanho semelhante,
    // sem overwrite ⇒ o write ANTES prosseguia e apagava o curado. Agora RECUSA SEMPRE.
    const fs = new MemoryFs(new Map([['x.ts', 'a\nb\nc\nd\ne\nf\ng\nh']]));
    const { ports } = makePorts({ fs });
    const r = await writeFileTool.run({ path: 'x.ts', content: 'A\nB\nC\nD\nE\nF\nG\nH' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/já existe/i);
    expect(r.observation).toMatch(/edit_file|overwrite/);
    expect(fs.snapshot().get('x.ts')).toBe('a\nb\nc\nd\ne\nf\ng\nh'); // intacto
  });

  it('hunt — write_file sobre arquivo 1-LINHA grande (minificado, 50 KiB → "x") ⇒ RECUSA (shrink por BYTES)', async () => {
    // Minificado/bundle/JSON numa linha só: beforeLines=1 ⇒ o guard por LINHAS é CEGO.
    // Sem o shrink por BYTES, um 50 KiB → "x" passava SILENCIOSO (perda total de dados).
    const minified = 'a'.repeat(50_000); // 1 linha, 50 KiB
    const fs = new MemoryFs(new Map([['bundle.min.js', minified]]));
    const { ports } = makePorts({ fs });
    const r = await writeFileTool.run({ path: 'bundle.min.js', content: 'x' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/RECUSOU|bytes|overwrite|edit_file/);
    expect(fs.snapshot().get('bundle.min.js')).toBe(minified); // INTACTO — não destruiu
  });

  it('hunt — write_file shrink por BYTES é liberado por overwrite:true (rewrite intencional)', async () => {
    const minified = 'a'.repeat(50_000);
    const fs = new MemoryFs(new Map([['bundle.min.js', minified]]));
    const { ports } = makePorts({ fs });
    const r = await writeFileTool.run(
      { path: 'bundle.min.js', content: 'x', overwrite: true },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('bundle.min.js')).toBe('x');
  });

  it('hunt — write_file em arquivo PEQUENO existente (<1 KiB, sem shrink dramático) sem overwrite ⇒ RECUSA "já existe" + com overwrite reescreve', async () => {
    // Não dispara shrink por linhas (<8) nem por bytes (<1 KiB), mas é EXISTENTE ⇒ recusa
    // genérica (não a de truncamento). Para reescrever de propósito ⇒ overwrite:true.
    const fs = new MemoryFs(new Map([['note.txt', 'a\nb\nc\nd']])); // 4 linhas, poucos bytes
    const { ports } = makePorts({ fs });
    const refused = await writeFileTool.run({ path: 'note.txt', content: 'a' }, ports);
    expect(refused.ok).toBe(false);
    expect(refused.observation).toMatch(/já existe/i);
    expect(refused.observation).not.toMatch(/>50% menor/); // não foi a recusa de shrink
    expect(fs.snapshot().get('note.txt')).toBe('a\nb\nc\nd'); // intacto
    const r = await writeFileTool.run({ path: 'note.txt', content: 'a', overwrite: true }, ports);
    expect(r.ok).toBe(true);
    expect(fs.snapshot().get('note.txt')).toBe('a');
  });

  it('run_command executa via shell injetável e reporta exit', async () => {
    const shell = new RecordingShell((cmd) => ({ stdout: `ran:${cmd}`, stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ shell });
    const r = await runCommandTool.run({ command: 'ls' }, ports);
    expect(r.ok).toBe(true);
    expect(shell.executed).toEqual(['ls']);
    expect(r.display).toBe('$ ls');
  });

  it('run_command exit≠0 ⇒ ok=false (mas observação volta)', async () => {
    const shell = new RecordingShell(() => ({ stdout: '', stderr: 'boom', exitCode: 1 }));
    const { ports } = makePorts({ shell });
    const r = await runCommandTool.run({ command: 'false' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('boom');
  });

  it('grep formata acertos path:line:text', async () => {
    const search = new MemorySearch([{ path: 'a.ts', line: 3, text: 'match' }]);
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'm', path: 'a.ts' }, ports);
    expect(r.observation).toBe('a.ts:3: match');
  });

  it('F18 — grep 0 acertos com padrão que PARECE regex ⇒ avisa que é SUBSTRING literal', async () => {
    const search = new MemorySearch([]); // 0 acertos
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'TODO|FIXME', path: '.' }, ports);
    expect(r.observation).toMatch(/SUBSTRING LITERAL|não regex/i);
  });

  it('F18 — grep 0 acertos com padrão LITERAL ⇒ SEM aviso de regex (zero ruído/FP)', async () => {
    const search = new MemorySearch([]);
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'TODO', path: '.' }, ports);
    expect(r.observation).not.toMatch(/SUBSTRING LITERAL|não regex/i);
  });

  // EST-1016 — observation HONESTA de scan parcial. A nota SÓ aparece quando algum ramo
  // de `truncated` disparou; sem truncamento a observation é idêntica à de hoje.
  it('CA-6 — sem truncamento: observation IDÊNTICA à de hoje (zero nota)', async () => {
    const search = new MemorySearch([{ path: 'a.ts', line: 3, text: 'match' }], {});
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'm', path: 'a.ts' }, ports);
    expect(r.observation).toBe('a.ts:3: match');
    expect(r.observation).not.toContain('⚠');
  });

  it('CA-6 — truncated.byScanBytes: anexa nota de arquivo lido só até o teto de bytes', async () => {
    const search = new MemorySearch([{ path: 'big.log', line: 1, text: 'agulha' }], {
      byScanBytes: ['big.log'],
    });
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'agulha', path: '.' }, ports);
    expect(r.observation).toContain('big.log:1: agulha');
    expect(r.observation).toContain('⚠ scan parcial');
    expect(r.observation).toContain('1 arquivo(s) > 5 MiB lido(s) só até o teto');
    // só o ramo que disparou — não menciona os outros tetos.
    expect(r.observation).not.toContain('teto de 200 acertos');
    expect(r.observation).not.toContain('arquivos varridos');
  });

  it('CA-6 — truncated.byMaxMatches: anexa nota de teto de acertos atingido', async () => {
    const search = new MemorySearch([{ path: 'a.ts', line: 1, text: 'agulha' }], {
      byMaxMatches: true,
    });
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'agulha', path: '.' }, ports);
    expect(r.observation).toContain('⚠ scan parcial');
    expect(r.observation).toContain('teto de 200 acertos');
    expect(r.observation).not.toContain('só até o teto de bytes');
  });

  it('CA-6 — truncated.byMaxFiles: anexa nota de teto de arquivos atingido', async () => {
    const search = new MemorySearch([{ path: 'a.ts', line: 1, text: 'agulha' }], {
      byMaxFiles: true,
    });
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'agulha', path: '.' }, ports);
    expect(r.observation).toContain('⚠ scan parcial');
    expect(r.observation).toContain('5000 arquivos varridos');
  });

  it('CA-6 — múltiplos ramos: lista TODOS os que dispararam', async () => {
    const search = new MemorySearch([{ path: 'a.ts', line: 1, text: 'x' }], {
      byScanBytes: ['big1.log', 'big2.log'],
      byMaxMatches: true,
      byMaxFiles: true,
    });
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'x', path: '.' }, ports);
    expect(r.observation).toContain('2 arquivo(s) > 5 MiB');
    expect(r.observation).toContain('teto de 200 acertos');
    expect(r.observation).toContain('5000 arquivos varridos');
  });

  it('CA-6 — nenhum acerto MAS truncado: a nota ainda aparece (não engana com "0")', async () => {
    const search = new MemorySearch([], { byMaxFiles: true });
    const { ports } = makePorts({ search });
    const r = await grepTool.run({ pattern: 'agulha', path: '.' }, ports);
    expect(r.observation).toContain('nenhum acerto');
    expect(r.observation).toContain('⚠ scan parcial');
  });

  it('cada tool declara efeito correto', () => {
    expect(readFileTool.effect).toBe('read');
    expect(grepTool.effect).toBe('read');
    expect(editFileTool.effect).toBe('write');
    expect(writeFileTool.effect).toBe('write');
    expect(runCommandTool.effect).toBe('exec');
    // EST-0982 — change_dir é NAVEGAÇÃO sem efeito mutante ⇒ efeito `read`.
    expect(changeDirTool.effect).toBe('read');
  });

  it('unifiedDiff de arquivo novo usa /dev/null', () => {
    expect(unifiedDiff('n.ts', '', 'a\nb', false)).toContain('--- /dev/null');
  });

  // EST-0944 (hunt #277) — TETO do diff exibido. Constantes do produto:
  // MAX_DIFF_LINES=200, DIFF_CONTEXT_LINES=3.
  describe('unifiedDiff — TETO (recurso sem teto)', () => {
    it('edit pequeno ⇒ diff COMPLETO, inalterado (sem nota de truncamento)', () => {
      const before = 'a\nb\nc\nd\n';
      const after = 'a\nB\nc\nd\n';
      const diff = unifiedDiff('f.ts', before, after, true);
      expect(diff).toContain('-b');
      expect(diff).toContain('+B');
      expect(diff).not.toContain('truncado');
      expect(diff).not.toContain('inalterada');
      // diff curtinho fica longe do teto
      expect(diff.split('\n').length).toBeLessThan(20);
    });

    it('arquivo GRANDE com mudança no MEIO ⇒ diff capado + CENTRADO na mudança', () => {
      const n = 2000;
      const lines = Array.from({ length: n }, (_, i) => `linha-${i}`);
      const before = lines.join('\n');
      const changed = [...lines];
      changed[1000] = 'MUDOU-AQUI';
      const after = changed.join('\n');

      const diff = unifiedDiff('big.ts', before, after, true);
      const body = diff.split('\n');

      // Teto: corpo (sem contar o header de 2 linhas) ≤ MAX_DIFF_LINES + notas.
      expect(body.length).toBeLessThan(60);
      // Mostra a MUDANÇA, não o topo cru: a linha alterada aparece…
      expect(diff).toContain('-linha-1000');
      expect(diff).toContain('+MUDOU-AQUI');
      // …e a vizinhança (contexto), não o topo distante.
      expect(diff).toContain(' linha-999');
      expect(diff).toContain(' linha-1001');
      expect(diff).not.toContain('linha-0');
      // Nota honesta de elisão acima/abaixo (não cortou silencioso).
      expect(diff).toMatch(/linhas? inalterad/);
    });

    it('mudança no FIM de arquivo grande ⇒ NÃO mostra só o topo inalterado', () => {
      const n = 2000;
      const lines = Array.from({ length: n }, (_, i) => `L${i}`);
      const before = lines.join('\n');
      const changed = [...lines];
      changed[n - 1] = 'FIM-MUDOU';
      const after = changed.join('\n');

      const diff = unifiedDiff('big.ts', before, after, true);
      expect(diff).toContain('+FIM-MUDOU');
      expect(diff).toContain('-L1999');
      // o topo NÃO domina o diff
      expect(diff).not.toContain(' L0\n L1\n L2');
      expect(diff).toMatch(/inalterad/);
    });

    it('arquivo NOVO grande ⇒ topo + nota honesta (N de M linhas)', () => {
      const n = 1000;
      const content = Array.from({ length: n }, (_, i) => `x${i}`).join('\n');
      const diff = unifiedDiff('novo.ts', '', content, false);
      const body = diff.split('\n');
      expect(body.length).toBeLessThan(210);
      expect(diff).toContain('--- /dev/null');
      expect(diff).toMatch(/diff truncado: 200 de 1000 linhas/);
    });

    it('TETO de BYTES — linhas longas estouram bytes antes de linhas ⇒ nota de bytes', () => {
      // 30 linhas, cada uma ~2 KiB ⇒ < 200 linhas, mas > 16 KiB.
      const long = 'z'.repeat(2000);
      const before = Array.from({ length: 30 }, () => long).join('\n');
      const after = before + '\nNOVA';
      const diff = unifiedDiff('wide.ts', before, after, true);
      expect(diff.length).toBeLessThanOrEqual(16_000 + 80);
      expect(diff).toMatch(/diff truncado: excede 16000 bytes/);
    });
  });
});

describe('EST-0982 · change_dir (diretório de trabalho de sessão)', () => {
  it('cd subdir move o sessionCwd da porta', async () => {
    const cwd = new MemoryCwd();
    const { ports } = makePorts({ cwd });
    const r = await changeDirTool.run({ path: 'ecommerce-app' }, ports);
    expect(r.ok).toBe(true);
    expect(cwd.cwd).toBe('/ws/ecommerce-app');
    // o display mostra o cwd RELATIVO à raiz (auditável, legível).
    expect(r.display).toBe('cd ecommerce-app');
  });

  it('cd encadeado é relativo ao cwd corrente', async () => {
    const cwd = new MemoryCwd();
    const { ports } = makePorts({ cwd });
    await changeDirTool.run({ path: 'ecommerce-app' }, ports);
    await changeDirTool.run({ path: 'data' }, ports);
    expect(cwd.cwd).toBe('/ws/ecommerce-app/data');
  });

  it('CONFINAMENTO — cd .. no topo é clampado na raiz (não escapa)', async () => {
    const cwd = new MemoryCwd();
    const { ports } = makePorts({ cwd });
    const r = await changeDirTool.run({ path: '..' }, ports);
    expect(r.ok).toBe(true);
    expect(cwd.cwd).toBe('/ws');
    expect(r.display).toBe('cd .'); // raiz ⇒ "."
  });

  it('CONFINAMENTO — cd /etc (absoluto fora) é clampado na raiz', async () => {
    const cwd = new MemoryCwd();
    const { ports } = makePorts({ cwd });
    await changeDirTool.run({ path: '/etc' }, ports);
    expect(cwd.cwd).toBe('/ws');
  });

  it('cd p/ dir inexistente ⇒ ok=false (erro como dado, não lança)', async () => {
    const cwd = new MemoryCwd();
    const { ports } = makePorts({ cwd });
    const r = await changeDirTool.run({ path: 'nao-existe' }, ports);
    expect(r.ok).toBe(false);
    expect(cwd.cwd).toBe('/ws'); // não mudou
  });

  it('sem porta de cwd ⇒ inerte (erro claro, não-regressão)', async () => {
    const { ports } = makePorts(); // sem cwd
    const r = await changeDirTool.run({ path: 'x' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/indispon/i);
  });

  it('sem path ⇒ erro (ok=false)', async () => {
    const cwd = new MemoryCwd();
    const { ports } = makePorts({ cwd });
    const r = await changeDirTool.run({}, ports);
    expect(r.ok).toBe(false);
  });

  // EST-1015 (fix borda) — raiz EXTRA (/add-dir) cujo caminho STRING-prefixa a primária:
  // `/ws-lib` vs raiz `/ws`. O display NÃO pode virar o relativo ENGANOSO `-lib/src` — o
  // `startsWith(root)` cru casava o irmão. Tem de ser o ABSOLUTO (a função já promete isso
  // p/ cwd fora da raiz primária). O agente LÊ esse display ⇒ caminho errado o confundiria.
  it('cd p/ raiz extra que PREFIXA a primária ⇒ ABSOLUTO, não relativo enganoso', async () => {
    let session = '/ws';
    const cwd = {
      get cwd(): string {
        return session;
      },
      root: '/ws',
      setCwd(requested: string): string {
        session = requested; // a porta resolveu p/ a raiz extra autorizada (/add-dir)
        return session;
      },
    };
    const { ports } = makePorts({ cwd });
    const r = await changeDirTool.run({ path: '/ws-lib/src' }, ports);
    expect(r.ok).toBe(true);
    // ABSOLUTO (com o fix). Sem o fix mostrava o relativo enganoso `cd -lib/src`.
    expect(r.display).toBe('cd /ws-lib/src');
  });
});

describe('EST-0944 · ToolRegistry', () => {
  it('registra e resolve por nome', () => {
    const reg = new ToolRegistry([readFileTool]);
    expect(reg.has('read_file')).toBe(true);
    expect(reg.get('read_file')).toBe(readFileTool);
    expect(reg.get('nope')).toBeUndefined();
  });

  it('rejeita tool duplicada', () => {
    expect(() => new ToolRegistry([readFileTool, readFileTool])).toThrow(/duplicada/);
  });
});
