// ADR-0158 — `resolveServiceWorkspaceRoots` (locus concreto do campo `workspace:`).
//
// Bateria: ausente/vazio ⇒ sem raiz extra; absoluto entra como veio; relativo
// resolve contra a pasta do serviço; "~"/"~/x" expande contra o `home` INJETADO
// (nunca o real da máquina); diretório inexistente/arquivo (não-diretório) ⇒ erro;
// dedup; e o PISO QUE NÃO CAI — qualquer raiz que caia dentro de `aluyHome`
// (injetado, NUNCA o `~/.aluy/` real) é recusada, mesmo que o diretório exista de
// verdade e mesmo que seja declarada como `~/.aluy` literal.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveServiceWorkspaceRoots } from '../../src/service/workspace-roots.js';

describe('resolveServiceWorkspaceRoots', () => {
  let base: string;
  let serviceDir: string;
  let fakeHome: string;
  let aluyHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-wsroots-'));
    fakeHome = join(base, 'home');
    aluyHome = join(fakeHome, '.aluy');
    serviceDir = join(aluyHome, 'services', 'trader');
    mkdirSync(serviceDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('declared ausente/vazio ⇒ { ok:true, roots:[] } — comportamento de hoje', () => {
    expect(resolveServiceWorkspaceRoots(serviceDir, undefined, aluyHome, fakeHome)).toEqual({
      ok: true,
      roots: [],
    });
    expect(resolveServiceWorkspaceRoots(serviceDir, [], aluyHome, fakeHome)).toEqual({
      ok: true,
      roots: [],
    });
  });

  it('caminho ABSOLUTO existente entra como veio (canonicalizado)', () => {
    const target = join(base, 'projects', 'fluider');
    mkdirSync(target, { recursive: true });
    const r = resolveServiceWorkspaceRoots(serviceDir, [target], aluyHome, fakeHome);
    expect(r).toEqual({ ok: true, roots: [target] });
  });

  it('caminho RELATIVO resolve contra a pasta do serviço', () => {
    const sibling = join(aluyHome, 'services', 'outro-projeto');
    mkdirSync(sibling, { recursive: true });
    const r = resolveServiceWorkspaceRoots(serviceDir, ['../outro-projeto'], aluyHome, fakeHome);
    // "../outro-projeto" cai DENTRO de aluyHome (é filho de services/) — recusado
    // pelo piso. Testa a RESOLUÇÃO relativa isoladamente com um alvo FORA do piso.
    expect(r.ok).toBe(false);
  });

  it('caminho RELATIVO fora do piso resolve contra a pasta do serviço', () => {
    // serviceDir = <base>/home/.aluy/services/trader ; "../../../projects/fluider"
    // sobe 3 segmentos (trader, services, .aluy) — sobra <base>/home (= fakeHome) —
    // e desce em projects/fluider ⇒ <base>/home/projects/fluider.
    const target = join(fakeHome, 'projects', 'fluider');
    mkdirSync(target, { recursive: true });
    const r = resolveServiceWorkspaceRoots(
      serviceDir,
      ['../../../projects/fluider'],
      aluyHome,
      fakeHome,
    );
    expect(r).toEqual({ ok: true, roots: [target] });
  });

  it('"~" e "~/x" expandem contra o "home" INJETADO (nunca o real)', () => {
    const target = join(fakeHome, 'projects', 'fluider');
    mkdirSync(target, { recursive: true });
    const r = resolveServiceWorkspaceRoots(serviceDir, ['~/projects/fluider'], aluyHome, fakeHome);
    expect(r).toEqual({ ok: true, roots: [target] });
  });

  it('diretório INEXISTENTE ⇒ erro fail-closed', () => {
    const r = resolveServiceWorkspaceRoots(
      serviceDir,
      [join(base, 'nao-existe')],
      aluyHome,
      fakeHome,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/não existe/);
  });

  it('caminho que é um ARQUIVO (não diretório) ⇒ erro fail-closed', () => {
    const filePath = join(base, 'arquivo.txt');
    writeFileSync(filePath, 'conteudo');
    const r = resolveServiceWorkspaceRoots(serviceDir, [filePath], aluyHome, fakeHome);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/não é um diretório/);
  });

  it('PISO QUE NÃO CAI — "workspace: ~/.aluy" (a raiz de config/journal em si) ⇒ recusado', () => {
    const r = resolveServiceWorkspaceRoots(serviceDir, ['~/.aluy'], aluyHome, fakeHome);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/~\/\.aluy/);
  });

  it('PISO QUE NÃO CAI — subpasta de "~/.aluy" (ex.: outro serviço) ⇒ recusado mesmo existindo', () => {
    const outroServico = join(aluyHome, 'services', 'outro');
    mkdirSync(outroServico, { recursive: true });
    const r = resolveServiceWorkspaceRoots(serviceDir, [outroServico], aluyHome, fakeHome);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/~\/\.aluy/);
  });

  it('PISO QUE NÃO CAI — a PRÓPRIA pasta do serviço (também sob ~/.aluy/) é recusada como raiz EXTRA', () => {
    // Ela já É raiz por outro caminho (a primária, `cwd`); redeclará-la aqui não
    // perde nada e mantém a regra simples: NENHUMA raiz extra pode alcançar
    // `~/.aluy/`, sem caso especial pra "mas essa aqui já era raiz mesmo".
    const r = resolveServiceWorkspaceRoots(serviceDir, [serviceDir], aluyHome, fakeHome);
    expect(r.ok).toBe(false);
  });

  it('QUALQUER raiz hostil rejeita o CONJUNTO INTEIRO (mesma disciplina de workflow:)', () => {
    const good = join(base, 'projects', 'boa');
    mkdirSync(good, { recursive: true });
    const r = resolveServiceWorkspaceRoots(serviceDir, [good, '~/.aluy'], aluyHome, fakeHome);
    expect(r.ok).toBe(false);
  });

  it('dedup preservando ordem quando a mesma raiz (canonicalizada) aparece 2x', () => {
    const target = join(base, 'projects', 'fluider');
    mkdirSync(target, { recursive: true });
    const r = resolveServiceWorkspaceRoots(serviceDir, [target, target], aluyHome, fakeHome);
    expect(r).toEqual({ ok: true, roots: [target] });
  });

  it('várias raízes válidas ⇒ todas resolvidas, na ordem declarada', () => {
    const a = join(base, 'projects', 'a');
    const b = join(base, 'projects', 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const r = resolveServiceWorkspaceRoots(serviceDir, [a, b], aluyHome, fakeHome);
    expect(r).toEqual({ ok: true, roots: [a, b] });
  });
});
