// CA-3 — smoke do binário: `aluy --version` e `aluy --help` EXECUTAM e imprimem.
// Spawna o binário compilado (dist). Roda só após `npm run build` ter gerado o
// dist; se o dist não existir, o teste FALHA explicitamente (não mascara).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../dist/bin/aluy.js', import.meta.url));

function runAluy(
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    ...(input !== undefined ? { input } : {}),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('binário aluy (smoke, sobre dist/)', () => {
  it('o binário foi compilado (dist existe) — pré-condição honesta', () => {
    expect(existsSync(BIN), 'dist/bin/aluy.js ausente — rode `npm run build` antes do smoke').toBe(
      true,
    );
  });

  it('aluy --version imprime a versão e sai 0', () => {
    const { status, stdout } = runAluy(['--version']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^aluy \d+\.\d+\.\d+/);
  });

  it('aluy --help imprime a ajuda e sai 0', () => {
    const { status, stdout } = runAluy(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Uso:');
    expect(stdout).toContain('--help');
  });

  // EST-1007 — o help do binário lista os dois recursos novos (-p e --model).
  it('aluy --help documenta -p/--print/--exec e --model', () => {
    const { stdout } = runAluy(['--help']);
    expect(stdout).toMatch(/-p, --print, --exec/);
    expect(stdout).toMatch(/--model <slug>/);
    expect(stdout).toMatch(/HEADLESS/i);
  });

  // EST-1007 — `-p` SEM prompt (arg/posicional) e com STDIN VAZIO ⇒ erro de uso no
  // STDERR, stdout LIMPO, exit≠0. Prova ponta-a-ponta (binário real) o exit code + a
  // separação stdout/stderr — sem chamar o modelo (não há prompt p/ rodar).
  it('aluy -p sem prompt e stdin vazio ⇒ exit≠0, stderr avisa, stdout limpo', () => {
    const { status, stdout, stderr } = runAluy(['-p'], '');
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe(''); // nada no stdout scriptável.
    expect(stderr).toMatch(/-p sem prompt|sem prompt/i);
  });

  // EST-1112 — flags --budget/--no-budget são reconhecidas pelo binário e NÃO causam
  // erro de uso. Prova ponta-a-ponta (binário real) que o repasse bin→runSession não
  // está quebrado: --help mostra as flags (parseArgs as reconhece), e --version com
  // --budget/--no-budget sai 0 sem erro (não são flags desconhecidas).
  it('aluy --help documenta --budget, --no-budget e ALUY_BUDGET', () => {
    const { stdout } = runAluy(['--help']);
    expect(stdout).toContain('--budget');
    expect(stdout).toContain('--no-budget');
    expect(stdout).toContain('ALUY_BUDGET');
  });

  it('aluy --version --budget ⇒ exit 0 (flag reconhecida, não é erro de uso)', () => {
    const { status, stderr } = runAluy(['--version', '--budget']);
    expect(status).toBe(0);
    expect(stderr).not.toMatch(/flag desconhecida|erro de uso/i);
  });

  it('aluy --version --no-budget ⇒ exit 0 (flag reconhecida, não é erro de uso)', () => {
    const { status, stderr } = runAluy(['--version', '--no-budget']);
    expect(status).toBe(0);
    expect(stderr).not.toMatch(/flag desconhecida|erro de uso/i);
  });
});
