// EST-0977 · ADR-0061 — `aluy agents` (shell): lista os perfis .md mapeados das DUAS
// camadas (global + projeto/cwd), via os MESMOS loaders do boot/`/doctor` (fs-temp, sem
// tocar a home real, sem modelo, sem rede). Bateria:
//  - 1 válido + 2 rejeitados (cenário do Tiago) ⇒ os 3 saem (válido c/ nome/escopo/tools/
//    persona; rejeitados c/ motivo RES-MD-3).
//  - pasta ausente ⇒ "nenhum" (loader fail-safe).
//  - projeto + global ⇒ AMBOS os escopos na saída.
//  - exit 0 SEMPRE (listagem, não gate) — mesmo só com rejeitados.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgents } from '../../src/commands/agents.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { UserAgentsLoader, AGENTS_DIRNAME } from '../../src/io/user-agents.js';
import { ProjectAgentsLoader } from '../../src/io/project-agents.js';

/** Captura a saída + roda o runner ligado a loaders REAIS apontados aos tmpdirs. */
function run(opts: {
  globalBase?: string; // raiz do `~/.aluy` (loader real lê `<base>/agents/`)
  projectRoot?: string; // raiz do workspace (loader real lê `.claude/agents/`)
}): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runAgents({
    out: (l) => out.push(l),
    ...(opts.globalBase !== undefined
      ? { loadGlobal: () => new UserAgentsLoader({ baseDir: opts.globalBase! }).load() }
      : { loadGlobal: () => ({ profiles: [], errors: [] }) }),
    ...(opts.projectRoot !== undefined
      ? {
          loadProject: () =>
            new ProjectAgentsLoader({
              workspace: new NodeWorkspace({ root: opts.projectRoot! }),
            }).load(),
        }
      : { loadProject: () => ({ profiles: [], errors: [] }) }),
  });
  return { code, out };
}

describe('EST-0977 · aluy agents (shell)', () => {
  let globalBase: string;
  let globalAgentsDir: string;
  let projectRoot: string;

  beforeEach(() => {
    globalBase = mkdtempSync(join(tmpdir(), 'aluy-agents-g-'));
    globalAgentsDir = join(globalBase, AGENTS_DIRNAME);
    mkdirSync(globalAgentsDir, { recursive: true });
    projectRoot = mkdtempSync(join(tmpdir(), 'aluy-agents-p-'));
  });
  afterEach(() => {
    rmSync(globalBase, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeGlobal(name: string, body: string): void {
    writeFileSync(join(globalAgentsDir, name), body);
  }
  function writeProject(name: string, body: string): void {
    const dir = join(projectRoot, '.claude', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
  }

  it('cenário do Tiago: 1 válido + 2 rejeitados ⇒ lista os 3 com detalhe e motivo', () => {
    writeGlobal(
      'revisor.md',
      '---\nname: revisor\ndescription: Revisa código.\ntools: read_file, grep\n---\nVocê é o revisor rigoroso.',
    );
    writeGlobal('saudador.md', '---\nname: saudador\ntools:\n---\ncorpo'); // tools vazio ⇒ RES-MD-3
    writeGlobal('somador.md', '---\nname: somador\ntools: []\n---\ncorpo'); // tools vazio ⇒ RES-MD-3

    const { code, out } = run({ globalBase });
    const t = out.join('\n');

    expect(code).toBe(0);
    // Válido com nome/escopo/tools/persona — agora numa LINHA de tabela com bordas.
    const rowRevisor = out.find((l) => l.includes('revisor'))!;
    expect(rowRevisor).toContain('revisor');
    expect(rowRevisor).toContain('global');
    expect(rowRevisor).toContain('read_file, grep');
    expect(t).toContain('Revisa código.');
    // Rejeitados: a seção declara que não foram carregados por estarem inválidos,
    // cada arquivo é uma linha da tabela e a célula `motivo` traz o começo do
    // motivo (truncado pelo teto).
    expect(t).toContain('não foram carregados por estarem inválidos');
    const rowSaudador = out.find((l) => l.includes('saudador.md'))!;
    expect(rowSaudador).toContain('"tools" presente');
    expect(t).toContain('somador.md');
    expect(t).toContain('conserto:');
  });

  it('pasta ausente (nada global, nada projeto) ⇒ "nenhum", exit 0', () => {
    rmSync(globalAgentsDir, { recursive: true, force: true });
    const { code, out } = run({ globalBase }); // projeto não injetado ⇒ vazio
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('nenhum agente .md');
  });

  it('projeto + global ⇒ AMBOS os escopos aparecem', () => {
    writeGlobal('g.md', '---\nname: gagent\ndescription: global agent\n---\ncorpo do global');
    writeProject('p.md', '---\nname: pagent\ndescription: project agent\n---\ncorpo do projeto');

    const { code, out } = run({ globalBase, projectRoot });
    expect(code).toBe(0);
    const rowG = out.find((l) => l.includes('gagent'))!;
    const rowP = out.find((l) => l.includes('pagent'))!;
    expect(rowG).toContain('global');
    expect(rowP).toContain('projeto');
  });

  it('SÓ rejeitados ⇒ ainda exit 0 (é listagem, não gate)', () => {
    writeGlobal('quebrado.md', '---\nname: quebrado\ntools:\n---\ncorpo');
    const { code, out } = run({ globalBase });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('rejeitados (1)');
  });

  // ── EST-1013: bateria adicional ──────────────────────────────────────────

  it('(A) AGREGAÇÃO: loadGlobal e loadProject injetados com contadores, saída tem cabeçalho', () => {
    let globalCalls = 0;
    let projectCalls = 0;
    const sink: string[] = [];

    const code = runAgents({
      loadGlobal: () => {
        globalCalls++;
        return { profiles: [], errors: [] };
      },
      loadProject: () => {
        projectCalls++;
        return { profiles: [], errors: [] };
      },
      out: (l) => sink.push(l),
      globalDir: '~/.aluy/agents',
    });

    expect(code).toBe(0);
    expect(globalCalls).toBe(1);
    expect(projectCalls).toBe(1);
    // buildAgentsNote com listas vazias produz "nenhum agente .md" + dica
    expect(sink.join('\n')).toContain('nenhum agente .md');
  });

  it('(B) ESTADO VAZIO: saída menciona o globalDir injetado', () => {
    const sink: string[] = [];
    const code = runAgents({
      loadGlobal: () => ({ profiles: [], errors: [] }),
      loadProject: () => ({ profiles: [], errors: [] }),
      out: (l) => sink.push(l),
      globalDir: '/tmp/.aluy/agents',
    });

    expect(code).toBe(0);
    const t = sink.join('\n');
    expect(t).toContain('/tmp/.aluy/agents');
    expect(t).toContain('nenhum');
  });

  it('(C) FALLBACK dos loaders reais: sem loadGlobal/loadProject, retorna 0 sem lançar', () => {
    const sink: string[] = [];
    // Sem loadGlobal/loadProject — exercita o ramo default que constrói os
    // loaders reais (UserAgentsLoader / ProjectAgentsLoader). Eles são fail-safe
    // (dir ausente/ilegível ⇒ vazio), então deve retornar 0 sem lançar.
    expect(() => {
      const code = runAgents({ out: (l) => sink.push(l) });
      expect(code).toBe(0);
    }).not.toThrow();
    // O sink deve ter recebido alguma linha (não asserimos conteúdo específico
    // da home real, pois depende do ambiente).
    expect(sink.length).toBeGreaterThan(0);
  });
});
