// Higiene de mensagens: o texto que o USUÁRIO lê não carrega jargão interno (conceitos de
// segurança do modelo, ids de ADR, "fan-out"). Os textos voltados ao modelo ficam como estão.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveText } from '../../src/i18n/translate.js';

const PROIBIDO = /fan-out|entram? como dado|user_inject|reanchor|envelopad|CLI-SEC|ADR-\d/i;

describe('mensagens ao usuário sem jargão interno', () => {
  it('catálogo pt-BR', () => {
    const src = readFileSync(new URL('../../src/i18n/pt-BR.ts', import.meta.url), 'utf8');
    const linhas = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(linhas.filter((l) => PROIBIDO.test(l) || /NESTE turno/.test(l))).toEqual([]);
    expect(resolveText('pt-BR', 'hints.idle')).not.toMatch(PROIBIDO);
  });

  it('/memory e /help: nada de "DADO"/"instrução"/read-deny', () => {
    for (const f of ['../../src/slash/memory.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      const linhas = src
        .split('\n')
        .filter((l) => /^\s*'/.test(l) || /lines:/.test(l))
        .join('\n');
      expect(linhas).not.toMatch(/\bDADO\b|nunca instrução|NÃO vira instrução/);
    }
    const h = readFileSync(new URL('../../src/slash/handlers.ts', import.meta.url), 'utf8');
    expect(h).not.toMatch(/read-deny\)'/);
  });
});
