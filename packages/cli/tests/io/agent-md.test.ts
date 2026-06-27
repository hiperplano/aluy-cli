// EST-0964 — loadAgentMd: leitura CONFINADA do AGENT.md (config de projeto).
//
// Prova que o AGENT.md só é lido de DENTRO da raiz confinada, respeita path-deny e
// o teto de tamanho, e é fail-safe (ausência/escape ⇒ undefined). É config
// confiável — mas lida com as MESMAS travas do canal de leitura (defesa-em-prof.).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PROJECT_INSTRUCTIONS_CHARS } from '@hiperplano/aluy-cli-core';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { NodeFileSystemPort } from '../../src/io/fs-port.js';
import {
  loadAgentMd,
  loadProjectInstructions,
  PROJECT_INSTRUCTION_FILENAMES,
} from '../../src/io/agent-md.js';

function makeLoaderCtx(root: string) {
  const workspace = new NodeWorkspace({ root });
  const fs = new NodeFileSystemPort({ workspace });
  return { workspace, fs };
}

describe('EST-0964 · loadAgentMd — confinado ao workspace', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-agentmd-'));
    root = join(base, 'project');
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('ALUY.md presente ⇒ devolve o conteúdo (config confiável)', async () => {
    writeFileSync(join(root, 'ALUY.md'), '# proj\n\nrode npm test.\n');
    const instr = await loadAgentMd(makeLoaderCtx(root));
    expect(instr).toContain('rode npm test');
  });

  it('ALUY.md AUSENTE ⇒ undefined (sem config; prompt baseline)', async () => {
    expect(await loadAgentMd(makeLoaderCtx(root))).toBeUndefined();
  });

  it('ALUY.md VAZIO/whitespace ⇒ undefined (não injeta um bloco vazio)', async () => {
    writeFileSync(join(root, 'ALUY.md'), '   \n\n  ');
    expect(await loadAgentMd(makeLoaderCtx(root))).toBeUndefined();
  });

  it('ALUY.md gigante ⇒ TRUNCADO ao teto (não estoura a janela)', async () => {
    writeFileSync(join(root, 'ALUY.md'), 'y'.repeat(MAX_PROJECT_INSTRUCTIONS_CHARS + 9_000));
    const instr = await loadAgentMd(makeLoaderCtx(root));
    expect(instr).toBeDefined();
    expect(instr!.length).toBeLessThanOrEqual(MAX_PROJECT_INSTRUCTIONS_CHARS + 200);
    expect(instr!).toContain('truncado');
  });

  it('FAIL-SAFE — exists=true mas readFile lança (race/ilegível) ⇒ undefined', async () => {
    const workspace = new NodeWorkspace({ root });
    // fs fake: o arquivo "existe" mas sumiu/ficou ilegível na hora de ler.
    const flakyFs = {
      exists: () => Promise.resolve(true),
      readFile: () => Promise.reject(new Error('ENOENT (race)')),
      writeFile: () => Promise.resolve(),
    };
    const instr = await loadAgentMd({ workspace, fs: flakyFs });
    expect(instr).toBeUndefined();
  });

  it('CONFINAMENTO — ALUY.md é um symlink p/ FORA da raiz ⇒ undefined (nada lido)', async () => {
    const secret = join(base, 'secret-outside.md');
    writeFileSync(secret, 'SEGREDO FORA DO WORKSPACE');
    // ALUY.md dentro da raiz aponta (symlink) p/ um arquivo FORA da raiz.
    symlinkSync(secret, join(root, 'ALUY.md'));
    const instr = await loadAgentMd(makeLoaderCtx(root));
    // o confinamento rejeita o escape — o conteúdo de fora NUNCA é injetado.
    expect(instr).toBeUndefined();
  });
});

// EST-0979 — loadProjectInstructions: amplia as FONTES de instrução de projeto p/ o
// padrão Claude Code (CLAUDE.md) e Codex (AGENTS.md), além do nativo AGENT.md. Mesma
// injeção confiável no `system`; precedência cravada; confinamento intacto.
describe('EST-0979 · loadProjectInstructions — AGENT.md + AGENTS.md + CLAUDE.md', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-projinstr-'));
    root = join(base, 'project');
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('precedência cravada: ALUY.md > AGENT.md > AGENTS.md > CLAUDE.md', () => {
    expect([...PROJECT_INSTRUCTION_FILENAMES]).toEqual([
      'ALUY.md',
      'AGENT.md',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
  });

  it('só CLAUDE.md presente ⇒ injetado como instrução (igual ao AGENT.md)', async () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# claude\n\nrode pnpm test.\n');
    const r = await loadProjectInstructions(makeLoaderCtx(root));
    expect(r.instructions).toContain('rode pnpm test');
    expect(r.sources).toEqual(['CLAUDE.md']);
  });

  it('só AGENTS.md presente ⇒ injetado como instrução (Codex)', async () => {
    writeFileSync(join(root, 'AGENTS.md'), '# codex\n\nconvenções do repo.\n');
    const r = await loadProjectInstructions(makeLoaderCtx(root));
    expect(r.instructions).toContain('convenções do repo');
    expect(r.sources).toEqual(['AGENTS.md']);
  });

  it('UM arquivo só ⇒ injeta SEM cabeçalho de fonte (preserva EST-0964)', async () => {
    writeFileSync(join(root, 'CLAUDE.md'), 'instrução única.');
    const r = await loadProjectInstructions(makeLoaderCtx(root));
    expect(r.instructions).toBe('instrução única.');
    expect(r.instructions).not.toContain('fonte:');
  });

  it('os TRÊS presentes ⇒ COMPÕEM na ordem de precedência (AGENT.md primeiro)', async () => {
    writeFileSync(join(root, 'AGENT.md'), 'NATIVO-ALUY');
    writeFileSync(join(root, 'AGENTS.md'), 'CODEX-OPENAI');
    writeFileSync(join(root, 'CLAUDE.md'), 'CLAUDE-CODE');
    const r = await loadProjectInstructions(makeLoaderCtx(root));
    expect(r.sources).toEqual(['AGENT.md', 'AGENTS.md', 'CLAUDE.md']);
    const text = r.instructions!;
    // ordem: o nativo lidera, depois Codex, depois Claude Code.
    expect(text.indexOf('NATIVO-ALUY')).toBeLessThan(text.indexOf('CODEX-OPENAI'));
    expect(text.indexOf('CODEX-OPENAI')).toBeLessThan(text.indexOf('CLAUDE-CODE'));
    // cabeçalho discreto por fonte (compõe, não escolhe um).
    expect(text).toContain('fonte: AGENT.md');
    expect(text).toContain('fonte: CLAUDE.md');
  });

  it('nenhuma fonte ⇒ { sources: [] } e sem instruções (prompt baseline)', async () => {
    const r = await loadProjectInstructions(makeLoaderCtx(root));
    expect(r.sources).toEqual([]);
    expect(r.instructions).toBeUndefined();
  });

  it('CONFINAMENTO — CLAUDE.md symlink p/ FORA da raiz ⇒ pulado (nada de fora injetado)', async () => {
    const secret = join(base, 'secret.md');
    writeFileSync(secret, 'SEGREDO FORA');
    symlinkSync(secret, join(root, 'CLAUDE.md'));
    // AGENT.md legítimo coexiste — só ele deve contribuir.
    writeFileSync(join(root, 'AGENT.md'), 'LEGIT');
    const r = await loadProjectInstructions(makeLoaderCtx(root));
    expect(r.sources).toEqual(['AGENT.md']);
    expect(r.instructions).not.toContain('SEGREDO FORA');
  });

  it('cada fonte é CLAMPADA por arquivo (anti-estouro de janela)', async () => {
    writeFileSync(join(root, 'CLAUDE.md'), 'z'.repeat(MAX_PROJECT_INSTRUCTIONS_CHARS + 5_000));
    const r = await loadProjectInstructions(makeLoaderCtx(root));
    expect(r.instructions).toBeDefined();
    expect(r.instructions!.length).toBeLessThanOrEqual(MAX_PROJECT_INSTRUCTIONS_CHARS + 200);
    expect(r.instructions!).toContain('truncado');
  });
});
