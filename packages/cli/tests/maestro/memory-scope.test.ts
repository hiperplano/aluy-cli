import { describe, it, expect } from 'vitest';
import { deriveMemoryScope, legacyMemoryScope } from '../../src/maestro/memory-scope.js';

describe('deriveMemoryScope — isolamento INJETIVO por projeto (mem0 user_id)', () => {
  // Pares de caminhos DISTINTOS que a sanitização LEGADA colapsava no MESMO
  // escopo (bleed de memória entre projetos). Agora têm de ser DISTINTOS.
  const COLLIDING_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['/home/user/projects/acme/app', '/home/user/projects/acme-app'],
    ['/work/foo-bar', '/work/foo_bar'],
    ['/work/foo.bar', '/work/foo/bar'],
    ['/home/user/projects/aluy/aluy-vau', '/home/user/projects/aluy/aluy_vau'],
  ];

  it('a sanitização LEGADA colidia (prova do bug)', () => {
    for (const [a, b] of COLLIDING_PAIRS) {
      expect(legacyMemoryScope(a)).toBe(legacyMemoryScope(b)); // colidiam — era o bug.
    }
  });

  it('o escopo NOVO é distinto p/ cada caminho distinto (fim do bleed)', () => {
    for (const [a, b] of COLLIDING_PAIRS) {
      expect(deriveMemoryScope(a).scope).not.toBe(deriveMemoryScope(b).scope);
    }
  });

  it('o escopo NOVO carrega o basename legível + um hash (debugável)', () => {
    const { scope } = deriveMemoryScope('/home/user/projects/aluy/aluy-vau');
    expect(scope).toMatch(/^proj_aluy_vau_[0-9a-f]{12}$/);
  });

  it('é ESTÁVEL: o mesmo caminho ⇒ o mesmo escopo (persistência entre sessões)', () => {
    const p = '/home/user/projects/aluy/aluy-vau';
    expect(deriveMemoryScope(p).scope).toBe(deriveMemoryScope(p).scope);
  });

  it('normaliza `.`/`..`/barra final (mesmo projeto ⇒ mesmo escopo)', () => {
    const a = deriveMemoryScope('/home/user/projects/app').scope;
    const b = deriveMemoryScope('/home/user/projects/app/').scope;
    const c = deriveMemoryScope('/home/user/projects/sub/../app').scope;
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('recallScopes inclui o LEGADO (migração sem reset) e o NOVO em 1º', () => {
    const { scope, legacy, recallScopes } = deriveMemoryScope('/home/user/projects/x');
    expect(recallScopes[0]).toBe(scope); // novo primeiro (preferência).
    expect(recallScopes).toContain(legacy); // legado preservado p/ recall.
    expect(legacy).toBe('proj_home_user_projects_x'); // bate com a derivação antiga.
  });

  it('o STORE-target (scope) nunca é o legado quando há separadores no caminho', () => {
    const { scope, legacy } = deriveMemoryScope('/home/user/projects/aluy/aluy-vau');
    expect(scope).not.toBe(legacy);
  });
});
