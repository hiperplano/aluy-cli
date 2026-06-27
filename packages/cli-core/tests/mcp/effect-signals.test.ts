// EST-0970 · ADR-0058 (E-B2) · CLI-SEC-12 — classificação por SINAIS do input,
// NUNCA por rótulo `readonly` auto-declarado pelo server.

import { describe, expect, it } from 'vitest';
import {
  MCP_TOOL_PREFIX,
  collectStrings,
  extractPathCandidates,
  inputHasNetworkSignal,
  isMcpToolName,
} from '../../src/index.js';

describe('isMcpToolName / prefixo', () => {
  it('prefixo canônico mcp__', () => {
    expect(MCP_TOOL_PREFIX).toBe('mcp__');
    expect(isMcpToolName('mcp__fs__read')).toBe(true);
    expect(isMcpToolName('read_file')).toBe(false);
  });
});

describe('inputHasNetworkSignal — detecta egress no input (E-B2)', () => {
  it('URL http(s) em qualquer campo', () => {
    expect(inputHasNetworkSignal({ q: 'https://evil.example/x' })).toBe(true);
    expect(inputHasNetworkSignal({ anything: 'visit http://10.0.0.1' })).toBe(true);
  });
  it('esquema remoto não-file', () => {
    expect(inputHasNetworkSignal({ u: 's3://bucket/key' })).toBe(true);
    expect(inputHasNetworkSignal({ u: 'ftp://h/x' })).toBe(true);
  });
  it('file:// é LOCAL ⇒ não é sinal de rede', () => {
    expect(inputHasNetworkSignal({ u: 'file:///etc/hosts' })).toBe(false);
  });
  it('user@host FQDN e host:porta', () => {
    expect(inputHasNetworkSignal({ x: 'deploy git@github.com:o/r' })).toBe(true);
    expect(inputHasNetworkSignal({ x: 'connect to db.example.com:5432' })).toBe(true);
  });
  it('texto local simples ⇒ sem sinal', () => {
    expect(inputHasNetworkSignal({ msg: 'hello world' })).toBe(false);
    expect(inputHasNetworkSignal({ path: './src/x.ts' })).toBe(false);
  });
  it('varre valores ANINHADOS (server pode esconder o destino)', () => {
    expect(inputHasNetworkSignal({ opts: { to: ['https://evil/'] } })).toBe(true);
  });
});

describe('extractPathCandidates — pega caminhos do input (E-B2)', () => {
  it('valores de chaves com nome de path conhecido', () => {
    const c = extractPathCandidates({ file: '~/.ssh/id_rsa', other: 'x' });
    expect(c).toContain('~/.ssh/id_rsa');
  });
  it('qualquer string que PAREÇA path (com `/`, `~`, `./`)', () => {
    const c = extractPathCandidates({ whatever: '/etc/passwd' });
    expect(c).toContain('/etc/passwd');
  });
  it('strings sem cara de path ⇒ não viram candidato', () => {
    const c = extractPathCandidates({ name: 'hello' });
    expect(c).toEqual([]);
  });
  it('pega path aninhado também', () => {
    const c = extractPathCandidates({ opts: { dest: '~/.aluy/hooks.json' } });
    expect(c).toContain('~/.aluy/hooks.json');
  });
});

describe('collectStrings — varredura rasa limitada (sem recursão infinita)', () => {
  it('coleta 1 nível + arrays + objetos rasos', () => {
    const s = collectStrings({ a: 'x', b: ['y'], c: { d: 'z' } });
    expect(s).toEqual(expect.arrayContaining(['x', 'y', 'z']));
  });

  // EST-1015 — endurecimento: limite de profundidade (depth > 3 => return)
  it('limite de profundidade depth > 3: strings aninhadas além do 3º nível não aparecem', () => {
    const input = {
      raso: 'superficial',
      nivel2: {
        medio: 'nivel-2',
        nivel3: {
          fundo: 'nivel-3',
          nivel4: {
            profundissimo: 'valor-fundo',
          },
        },
      },
    };
    const s = collectStrings(input);
    // 'superficial' está em depth 1 => incluída
    expect(s).toContain('superficial');
    // 'nivel-2' está em depth 2 => incluída
    expect(s).toContain('nivel-2');
    // 'nivel-3' está em depth 3 => incluída
    expect(s).toContain('nivel-3');
    // 'valor-fundo' está em depth 5 (nivel4 => depth 4, profundissimo => depth 5) => NÃO incluída
    expect(s).not.toContain('valor-fundo');
  });

  it('limite de profundidade com arrays aninhados também respeita o corte', () => {
    const input = {
      a: ['x', ['y', ['z', ['w']]]],
    };
    const s = collectStrings(input);
    // 'x' depth 2 => incluída
    expect(s).toContain('x');
    // 'y' depth 3 => incluída
    expect(s).toContain('y');
    // 'z' depth 4 => NÃO incluída (depth > 3)
    expect(s).not.toContain('z');
    // 'w' depth 5 => NÃO incluída
    expect(s).not.toContain('w');
  });
});

describe('extractPathCandidates / looksLikePath — sinais de caminho (EST-1015)', () => {
  it('inclui valor que começa com ~/ (tilde home)', () => {
    const c = extractPathCandidates({ whatever: '~/arquivo' });
    expect(c).toContain('~/arquivo');
  });

  it('inclui valor que começa com ./ (relativo)', () => {
    const c = extractPathCandidates({ x: './rel' });
    expect(c).toContain('./rel');
  });

  it('inclui valor que começa com ../ (relativo-pai)', () => {
    const c = extractPathCandidates({ x: '../rel' });
    expect(c).toContain('../rel');
  });

  it('inclui valor com C:\\ (Windows absoluto)', () => {
    // Em JS, 'C:\\Users\\x' vira a string 'C:\Users\x'
    const c = extractPathCandidates({ win: 'C:\\Users\\x' });
    expect(c).toContain('C:\\Users\\x');
  });

  it('inclui valor com / (separador unix)', () => {
    const c = extractPathCandidates({ p: 'a/b/c' });
    expect(c).toContain('a/b/c');
  });

  it('strings sem separador nem prefixo de caminho NÃO são incluídas', () => {
    const c = extractPathCandidates({ nome: 'textoqualquer' });
    expect(c).not.toContain('textoqualquer');
    expect(c).toEqual([]);
  });

  it('string vazia não é candidata a caminho', () => {
    const c = extractPathCandidates({ vazio: '' });
    expect(c).not.toContain('');
    expect(c).toEqual([]);
  });
});
