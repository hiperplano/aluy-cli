import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, isNewer } from '../src/version-compare.js';

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
