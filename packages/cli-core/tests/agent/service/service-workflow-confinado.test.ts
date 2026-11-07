// CONFINAMENTO do `workflow:` — achado numa conversa de arquitetura com o dono, ao
// avaliar se workflows podiam morar em SUBPASTAS.
//
// O valor de `workflow:` vira caminho (`<serviceDir>/workflows/<valor>.md`) no locus
// concreto. Sem validar a FORMA, um `service.md` apontava para FORA da árvore do
// serviço (`../../../../etc/passwd`). Pior que o acesso: o "manifesto visível" exibido
// ANTES do `install` mostra só o valor DECLARADO — então dava para esconder da revisão
// do dono qual arquivo de fato roda.
//
// SUBPASTA É LEGÍTIMA e continua aceita (foi o pedido que revelou o furo). O que se
// recusa é ESCAPAR.

import { describe, expect, it } from 'vitest';
import { parseServiceManifest, isServiceManifestError, isSafeWorkflowRef } from '../../../src/index.js';

function manifestoCom(workflow: string): ReturnType<typeof parseServiceManifest> {
  return parseServiceManifest(
    'service.md',
    ['---', 'name: t', `workflow: ${workflow}`, '---', 'Rege, não opera.'].join('\n'),
  );
}

describe('isSafeWorkflowRef — forma PURA', () => {
  it('nome simples e SUBPASTA são aceitos (organizar workflows em pastas é legítimo)', () => {
    expect(isSafeWorkflowRef('turno')).toBe(true);
    expect(isSafeWorkflowRef('intraday/turno')).toBe(true);
    expect(isSafeWorkflowRef('a/b/c/turno')).toBe(true);
  });

  it('segmento ".." é recusado EM QUALQUER POSIÇÃO (não só no começo)', () => {
    // Sem cobrir o caso do MEIO, um mutante que só checasse `startsWith('..')`
    // passaria — e `x/../../y` sobe dois níveis igual.
    expect(isSafeWorkflowRef('../fora')).toBe(false);
    expect(isSafeWorkflowRef('x/../../y')).toBe(false);
    expect(isSafeWorkflowRef('a/b/../../../c')).toBe(false);
  });

  it('caminho ABSOLUTO é recusado (posix e windows)', () => {
    expect(isSafeWorkflowRef('/etc/passwd')).toBe(false);
    expect(isSafeWorkflowRef('C:/Windows/system32')).toBe(false);
  });

  it('barra invertida é recusada (traversal no Windows)', () => {
    expect(isSafeWorkflowRef('..\\win')).toBe(false);
    expect(isSafeWorkflowRef('sub\\turno')).toBe(false);
  });

  it('byte nulo é recusado (truncamento de caminho)', () => {
    expect(isSafeWorkflowRef('turno\0.md')).toBe(false);
  });

  it('vazio/só-espaço é recusado', () => {
    expect(isSafeWorkflowRef('')).toBe(false);
    expect(isSafeWorkflowRef('   ')).toBe(false);
  });

  it('nome contendo ".." SEM ser segmento próprio é ACEITO (não é traversal)', () => {
    // `re..tro` não sobe nível nenhum — recusar seria falso positivo. Mata o mutante
    // que trocasse a checagem de SEGMENTO por um `includes('..')` cru.
    expect(isSafeWorkflowRef('re..tro')).toBe(true);
    expect(isSafeWorkflowRef('turno..v2')).toBe(true);
  });
});

describe('parseServiceManifest — recusa o manifesto inteiro (fail-closed)', () => {
  it('workflow que escapa ⇒ manifesto REJEITADO, não apenas o campo ignorado', () => {
    const r = manifestoCom('../../../../etc/passwd');
    expect(isServiceManifestError(r)).toBe(true);
    if (isServiceManifestError(r)) expect(r.reason).toMatch(/DENTRO de workflows\//);
  });

  it('subpasta ⇒ manifesto ACEITO, valor preservado como declarado', () => {
    const r = manifestoCom('intraday/turno');
    expect(isServiceManifestError(r)).toBe(false);
    if (!isServiceManifestError(r)) expect(r.workflow).toBe('intraday/turno');
  });
});
