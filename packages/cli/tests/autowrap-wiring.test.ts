// Auditoria — a COSTURA do auto-wrap em `run.tsx`. `autowrap.test.tsx` cobre a função pura
// (`?7l` ao ligar, `?7h` uma vez), mas o que garante que o terminal do usuário NÃO fica com o
// auto-wrap desligado é a ligação do `restore()` em TODO caminho de término (fim normal via
// `finally`, sinais SIGINT/SIGTERM e `process.once('exit')`). `runSession` na TUI real não é
// montável em teste unitário (Ink + TTY), então este guarda ESTÁTICO falha se alguém remover a
// ligação — limitação conhecida: ele checa a fiação no código-fonte, não o runtime.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../src/session/run.tsx', import.meta.url)), 'utf8');

/** Corpo (aproximado) da função/arrow `disableBracketedPaste` — o ponto único de restauração. */
function corpoDoRestaurador(): string {
  const i = src.indexOf('const disableBracketedPaste = (): void => {');
  expect(i).toBeGreaterThan(0);
  return src.slice(i, src.indexOf('};', i));
}

describe('auto-wrap · fiação do restore em run.tsx', () => {
  it('o auto-wrap é desligado no boot da TUI e respeita ALUY_AUTOWRAP', () => {
    expect(src).toContain('disableAutowrap(baseStdout, noAutowrapEnabled(env))');
  });

  it('o ponto único de restauração religa o auto-wrap junto do bracketed paste', () => {
    const corpo = corpoDoRestaurador();
    expect(corpo).toContain('pasteMode.disable()');
    expect(corpo).toContain('autowrap.restore()');
  });

  it('o restaurador roda no exit do processo E no handler de sinais', () => {
    expect(src).toContain("process.once('exit', disableBracketedPaste)");
    const sinal = src.slice(src.indexOf('const onSignal = (): void => {'));
    expect(sinal.slice(0, sinal.indexOf('};'))).toContain('disableBracketedPaste()');
  });

  it('o restaurador também roda no finally do término normal da sessão', () => {
    // pelo menos 3 usos: definição + exit + sinal + finally(s) — o finally é o do waitUntilExit.
    const usos = src.split('disableBracketedPaste()').length - 1;
    expect(usos).toBeGreaterThanOrEqual(2);
  });
});
