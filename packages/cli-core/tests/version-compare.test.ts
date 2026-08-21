import { describe, it, expect } from 'vitest';
import {
  parseVersion,
  compareVersions,
  isNewer,
  distTagFor,
  shouldAutoUpdate,
} from '../src/version-compare.js';

describe('version-compare (SemVer mínimo p/ o update-notifier)', () => {
  it('parseVersion: M.m.p[-pre], tolera prefixo v, números no prerelease', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseVersion('v1.0.0')).toEqual({ major: 1, minor: 0, patch: 0, pre: [] });
    expect(parseVersion('1.0.0-rc.3')).toEqual({ major: 1, minor: 0, patch: 0, pre: ['rc', 3] });
    expect(parseVersion('lixo')).toBeNull();
  });

  it('compara major/minor/patch numericamente', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
    expect(isNewer('1.1.0', '1.0.9')).toBe(true);
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
  });

  it('estável > prerelease da mesma versão', () => {
    expect(isNewer('1.0.0', '1.0.0-rc.3')).toBe(true);
    expect(isNewer('1.0.0-rc.3', '1.0.0')).toBe(false);
  });

  it('entre prereleases: numérico por VALOR (rc.10 > rc.2, não lexical)', () => {
    expect(isNewer('1.0.0-rc.4', '1.0.0-rc.3')).toBe(true);
    expect(isNewer('1.0.0-rc.3', '1.0.0-rc.4')).toBe(false);
    expect(isNewer('1.0.0-rc.10', '1.0.0-rc.2')).toBe(true);
    expect(isNewer('1.0.0-rc.3', '1.0.0-rc.3')).toBe(false);
  });

  it('conjunto de prerelease mais curto é MENOR (rc < rc.1)', () => {
    expect(isNewer('1.0.0-rc.1', '1.0.0-rc')).toBe(true);
    expect(isNewer('1.0.0-rc', '1.0.0-rc.1')).toBe(false);
  });

  it('alfanumérico > numérico no mesmo campo do prerelease', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1);
  });

  it('versão ilegível ⇒ null (e isNewer falso, não crasha o boot)', () => {
    expect(compareVersions('lixo', '1.0.0')).toBeNull();
    expect(isNewer('lixo', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', 'lixo')).toBe(false);
  });

  it('cenário real: rc.3 instalado, rc.4/stable no npm ⇒ avisa; mesma ⇒ não', () => {
    expect(isNewer('1.0.0-rc.4', '1.0.0-rc.3')).toBe(true); // rc novo
    expect(isNewer('1.0.0', '1.0.0-rc.3')).toBe(true); // stable saiu
    expect(isNewer('1.0.0-rc.3', '1.0.0-rc.3')).toBe(false); // já é a mais nova
  });
});

describe('distTagFor (canal npm da versão)', () => {
  it('estável (sem prerelease) ⇒ "latest"', () => {
    expect(distTagFor('1.0.0')).toBe('latest');
    expect(distTagFor('v2.3.4')).toBe('latest');
  });

  it('prerelease ⇒ primeiro identificador (\'1.0.0-rc.138\' → \'rc\')', () => {
    expect(distTagFor('1.0.0-rc.138')).toBe('rc');
    expect(distTagFor('1.0.0-beta.1')).toBe('beta');
    expect(distTagFor('1.0.0-rc')).toBe('rc'); // sem sequência numérica também
  });

  it('versão ilegível ⇒ "latest" (default conservador, nunca lança)', () => {
    expect(distTagFor('lixo')).toBe('latest');
  });
});

describe('shouldAutoUpdate (decisão "devo instalar?" — mesmo canal + estritamente mais nova)', () => {
  it('rc.137 instalado, rc.138 publicado no MESMO canal ⇒ true', () => {
    expect(shouldAutoUpdate('1.0.0-rc.137', '1.0.0-rc.138')).toBe(true);
  });

  it('rc.9 instalado, rc.10 publicado ⇒ true (ordenação NUMÉRICA, não lexicográfica)', () => {
    expect(shouldAutoUpdate('1.0.0-rc.9', '1.0.0-rc.10')).toBe(true);
    // se fosse comparação de string, '10' < '9' lexicograficamente — provaria o oposto.
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1);
  });

  it('GUARDA DE CANAL: rc instalado com ESTÁVEL mais nova publicada ⇒ false (não pula p/ latest sozinho)', () => {
    // isNewer confirma que semver "acha" a estável mais nova — é exatamente o caso que
    // shouldAutoUpdate tem que blindar (canais diferentes: 'rc' vs 'latest').
    expect(isNewer('1.0.0', '1.0.0-rc.137')).toBe(true);
    expect(shouldAutoUpdate('1.0.0-rc.137', '1.0.0')).toBe(false);
  });

  it('GUARDA DE CANAL: estável instalada com rc publicado ⇒ false (não pula p/ prerelease sozinho)', () => {
    expect(shouldAutoUpdate('1.0.0', '1.1.0-rc.1')).toBe(false);
  });

  it('instalada MAIOR que a publicada (mesmo canal) ⇒ false — nunca faz downgrade', () => {
    expect(shouldAutoUpdate('1.0.0-rc.138', '1.0.0-rc.137')).toBe(false);
    expect(shouldAutoUpdate('2.0.0', '1.9.9')).toBe(false);
  });

  it('instalada IGUAL à publicada ⇒ false — nada a instalar', () => {
    expect(shouldAutoUpdate('1.0.0-rc.138', '1.0.0-rc.138')).toBe(false);
    expect(shouldAutoUpdate('1.0.0', '1.0.0')).toBe(false);
  });

  it('versão ilegível em qualquer lado ⇒ false, nunca instala às cegas', () => {
    expect(shouldAutoUpdate('lixo', '1.0.0-rc.1')).toBe(false);
    expect(shouldAutoUpdate('1.0.0-rc.1', 'lixo')).toBe(false);
  });

  it('canais de prerelease DIFERENTES (rc vs beta) ⇒ false mesmo se semver acharia mais nova', () => {
    expect(shouldAutoUpdate('1.0.0-beta.5', '1.0.0-rc.1')).toBe(false);
  });
});
