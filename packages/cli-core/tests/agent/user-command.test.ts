// EST-0974 · ADR-0053 §2.2 — COMANDOS CUSTOMIZADOS (`~/.aluy/commands/*.md`).
//
// Provas do PARSER/EXPANSÃO puros (o DoD da Parte 1): um `.md` vira `/<nome>` que
// EXPANDE o template (com args) e o resultado é submetido como OBJETIVO. Args, nome
// derivado do arquivo, frontmatter, e os casos-borda (vazio ⇒ não vira comando).

import { describe, expect, it } from 'vitest';
import {
  parseUserCommand,
  expandUserCommand,
  normalizeCommandName,
  splitFrontmatter,
} from '../../src/index.js';

describe('EST-0974 · nome derivado do ARQUIVO (não auto-declarado no corpo)', () => {
  it('normaliza basename ⇒ slug minúsculo `[a-z0-9_-]`', () => {
    expect(normalizeCommandName('Deploy.md')).toBe('deploy');
    expect(normalizeCommandName('revisar PR.md')).toBe('revisar-pr');
    expect(normalizeCommandName('FIX_bug.md')).toBe('fix_bug');
    expect(normalizeCommandName('a b c.md')).toBe('a-b-c'); // espaços viram `-`, sem `-` de borda
  });
  it("basename que vira vazio ⇒ `''` (o loader descarta)", () => {
    expect(normalizeCommandName('.md')).toBe('');
    expect(normalizeCommandName('---.md')).toBe('');
  });
});

describe('EST-0974 · frontmatter opcional (summary)', () => {
  it('extrai `summary:` do bloco `---` e devolve o corpo sem ele', () => {
    const { meta, body } = splitFrontmatter(
      '---\nsummary: faz o deploy\n---\nrode o deploy de prod',
    );
    expect(meta.summary).toBe('faz o deploy');
    expect(body).toBe('rode o deploy de prod');
  });
  it('sem frontmatter ⇒ meta vazio + corpo inteiro', () => {
    const { meta, body } = splitFrontmatter('só o corpo, sem meta');
    expect(meta.summary).toBeUndefined();
    expect(body).toBe('só o corpo, sem meta');
  });
});

describe('EST-0974 · parseUserCommand — `.md` ⇒ UserCommand', () => {
  it('monta name/summary/template; summary cai p/ default legível', () => {
    const cmd = parseUserCommand('deploy.md', 'rode o deploy de produção');
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe('deploy');
    expect(cmd!.summary).toContain('/deploy');
    expect(cmd!.template).toBe('rode o deploy de produção');
  });
  it('respeita o summary do frontmatter', () => {
    const cmd = parseUserCommand('deploy.md', '---\nsummary: CI/CD\n---\nrode');
    expect(cmd!.summary).toBe('CI/CD');
  });
  it('corpo VAZIO ⇒ null (comando inútil, descartado)', () => {
    expect(parseUserCommand('vazio.md', '')).toBeNull();
    expect(parseUserCommand('só-fm.md', '---\nsummary: x\n---\n')).toBeNull();
  });
});

describe('EST-0974 · expandUserCommand — template + args (o objetivo submetido)', () => {
  it('`$ARGUMENTS` recebe a string inteira de args', () => {
    expect(expandUserCommand('revise o arquivo $ARGUMENTS', 'src/a.ts src/b.ts')).toBe(
      'revise o arquivo src/a.ts src/b.ts',
    );
  });
  it('`$1`/`$2` posicionais; ausente ⇒ vazio', () => {
    expect(expandUserCommand('de $1 para $2', 'A B')).toBe('de A para B');
    expect(expandUserCommand('só $1', '')).toBe('só');
  });
  it('SEM placeholder mas COM args ⇒ anexa os args (não some o que o usuário digitou)', () => {
    expect(expandUserCommand('revise o código', 'foo.ts')).toBe('revise o código\n\nfoo.ts');
  });
  it('SEM placeholder e SEM args ⇒ o template puro', () => {
    expect(expandUserCommand('faça o build', '')).toBe('faça o build');
  });
  it('o resultado é texto-do-usuário (objetivo) — não há canal de instrução aqui', () => {
    // A expansão é só string→string; quem submete (run.tsx) chama controller.submit,
    // o MESMO caminho de uma fala digitada. Nenhuma elevação a `system`.
    const goal = expandUserCommand('analise $ARGUMENTS e proponha um plano', 'o módulo X');
    expect(goal).toBe('analise o módulo X e proponha um plano');
  });
});
