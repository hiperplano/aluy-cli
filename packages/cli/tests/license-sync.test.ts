// guard de licença — os QUATRO manifestos e o arquivo LICENSE têm de contar a MESMA
// história.
//
// ACHADO REAL (20/09/2026): o `LICENSE` dizia "Todos os direitos reservados", os
// `package.json` publicavam `SEE LICENSE IN LICENSE` e o `termos.html` do site — que o
// instalador OBRIGA a aceitar — afirmava MIT. Três fontes, três respostas, e a que o
// usuário lê antes de instalar era a que ninguém tinha conferido. Licença divergente não
// é detalhe de metadado: é o que decide se quem clona pode usar o que clonou.
//
// O teste não fixa "MIT": lê a licença declarada na RAIZ e exige que os outros três
// manifestos digam o mesmo e que o `LICENSE` seja daquela família. Trocar de licença
// segue sendo uma edição de um lugar só — o que fica proibido é trocar pela metade.
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PKG_CLI = join(ROOT, 'packages/cli');

const MANIFESTOS = [
  'package.json',
  'packages/cli/package.json',
  'packages/cli-core/package.json',
] as const;

// O `package.publish.json` é GERADO (e gitignorado): num clone limpo ele não existe, então
// lê-lo direto reprovaria na CI. Geramos como o `bundle.test.ts` faz — e é ele que importa,
// porque é o manifesto que vai DENTRO do tarball do npm: o único que o usuário recebe.
beforeAll(() => {
  execFileSync('node', ['scripts/make-publish-pkg.mjs'], { cwd: PKG_CLI, stdio: 'pipe' });
});

function licenseOf(rel: string): string {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf-8')).license;
}

describe('license sync (guard de publicação)', () => {
  const raiz = licenseOf('package.json');

  it('a raiz declara uma licença não-vazia', () => {
    expect(raiz).toBeTypeOf('string');
    expect(raiz.trim()).not.toBe('');
  });

  it.each(MANIFESTOS)('%s declara a MESMA licença da raiz', (rel) => {
    expect(licenseOf(rel)).toBe(raiz);
  });

  it('o manifesto PUBLICADO (package.publish.json) herda a mesma licença', () => {
    expect(licenseOf('packages/cli/package.publish.json')).toBe(raiz);
  });

  it('o arquivo LICENSE corresponde à licença declarada', () => {
    const texto = readFileSync(resolve(ROOT, 'LICENSE'), 'utf-8');
    if (raiz.startsWith('SEE LICENSE IN')) {
      // licença customizada: o arquivo só precisa existir com conteúdo.
      expect(texto.trim().length).toBeGreaterThan(0);
      return;
    }
    // SPDX conhecido (ex.: MIT) ⇒ o arquivo tem de nomeá-lo, e NÃO pode continuar
    // dizendo o contrário — foi exatamente o estado que gerou o achado.
    expect(texto).toContain(raiz);
    expect(texto.toLowerCase()).not.toContain('todos os direitos reservados');
    expect(texto.toLowerCase()).not.toContain('all rights reserved');
  });
});
