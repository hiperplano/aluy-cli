// LOOPBACK-DECLARADO — a regra que decide se o baseURL do provider aponta para a própria
// máquina, e a GUARDA de que todo chamador do fetch pinado a consulta.
//
// História curta e cara: o dono pediu "desbloqueie o ollama, nao quero ficar contornando".
// A rc.147 destravou o caminho de STREAMING e declarou o assunto resolvido. Duas coisas
// sobreviveram:
//
//   1. O REGEX estava errado. `^https?://(127\.|...)([:/]|$)` exige `:` ou `/` logo depois
//      de `127.` — e o que vem é `0`, de `127.0.0.1`. O endereço mais comum do Ollama nunca
//      casou; a exceção só valia para quem escrevia `localhost`. Lendo, o regex parece
//      certo. Só apareceu quando imprimi a tabela de casos.
//
//   2. Havia NOVE pontos de chamada do fetch pinado e o conserto tocou UM. O dono trocou de
//      provider e recebeu "egress recusado — aponta p/ IP interno (loopback (127.0.0.0/8))"
//      num provider que o próprio Aluy oferece.
//
// Por isso este arquivo tem duas partes: a TABELA (a regra) e a GUARDA ESTRUTURAL (todos os
// chamadores). Testar só a regra deixaria o defeito nº 2 vivo — e ele é o caro.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrlEhLocal } from '../../../src/model/local/pinned-stream-fetch.js';

describe('baseUrlEhLocal — o que conta como "a própria máquina"', () => {
  const local = [
    'http://localhost:11434',
    'http://localhost:11434/v1',
    'http://LOCALHOST/v1',
    'http://127.0.0.1',
    'http://127.0.0.1:11434/v1', // O CASO DO DEFEITO — o regex antigo devolvia false aqui.
    'http://127.1.2.3:8080', // o bloqueio anuncia o /8 inteiro; a exceção acompanha
    'http://[::1]:11434/v1',
    'http://user:pw@localhost:11434',
  ];
  for (const u of local) {
    it(`LOCAL: ${u}`, () => {
      expect(baseUrlEhLocal(u)).toBe(true);
    });
  }

  const remoto = [
    'https://openrouter.ai/api/v1',
    'http://10.0.0.5:11434', // RFC1918 NÃO é loopback — segue bloqueado
    'http://192.168.1.10:11434',
    'http://169.254.169.254/latest/meta-data', // metadata da cloud é LINK-LOCAL
    // Hostnames que COMEÇAM com a forma local mas não são: o buraco clássico.
    'http://localhost.evil.com/',
    'http://127.0.0.1.evil.com/',
    'https://notlocalhost/v1',
    '',
  ];
  for (const u of remoto) {
    it(`NÃO-local: ${u === '' ? '(vazio)' : u}`, () => {
      expect(baseUrlEhLocal(u)).toBe(false);
    });
  }

  it('ausente ⇒ false (sem baseURL declarado não há exceção a conceder)', () => {
    expect(baseUrlEhLocal(undefined)).toBe(false);
  });
});

// GUARDA ESTRUTURAL — precedente: `packages/cli-core/tests/boundary.test.ts`.
describe('todo chamador do fetch pinado decide sobre loopback', () => {
  const raiz = fileURLToPath(new URL('../../../src', import.meta.url));

  function arquivos(dir: string): string[] {
    const out: string[] = [];
    for (const nome of readdirSync(dir)) {
      const p = join(dir, nome);
      if (statSync(p).isDirectory()) out.push(...arquivos(p));
      else if (/\.tsx?$/.test(nome)) out.push(p);
    }
    return out;
  }

  it('nenhuma chamada com opções VAZIAS — ou passa `baseUrl`, ou decide com `allowLoopback`', () => {
    const faltando: string[] = [];
    for (const arq of arquivos(raiz)) {
      const texto = readFileSync(arq, 'utf8');
      // A DEFINIÇÃO da função não conta como chamada.
      if (arq.endsWith('pinned-stream-fetch.ts')) continue;
      for (const linha of texto.split('\n')) {
        const m = /createPinnedStreamFetch\(([^)]*)\)/.exec(linha);
        if (m === null) continue;
        const args = m[1] ?? '';
        if (!args.includes('baseUrl') && !args.includes('allowLoopback')) {
          faltando.push(`${arq.slice(raiz.length + 1)}: ${linha.trim()}`);
        }
      }
    }
    expect(
      faltando,
      `chamadas sem decisão de loopback (foi assim que o Ollama seguiu bloqueado):\n${faltando.join('\n')}`,
    ).toEqual([]);
  });

  it('a guarda ENXERGA os chamadores (senão ela passaria vazia, sem provar nada)', () => {
    const encontrados = arquivos(raiz).filter(
      (a) => !a.endsWith('pinned-stream-fetch.ts') && readFileSync(a, 'utf8').includes('createPinnedStreamFetch('),
    );
    // Um teste que varre e não acha nada é verde por vacuidade — o pior tipo.
    expect(encontrados.length).toBeGreaterThanOrEqual(4);
  });
});
