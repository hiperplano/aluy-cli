// ADR-0120 / EST-1113/1114 — parsing de `--backend` e `login --provider/--oauth`.
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs — --backend', () => {
  it('captura --backend local (forma separada) sem confundir com o goal', () => {
    const a = parseArgs(['--backend', 'local', 'meu objetivo']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.backend).toBe('local');
      expect(a.goal).toBe('meu objetivo');
    }
  });

  it('captura --backend=local (forma igual)', () => {
    const a = parseArgs(['--backend=local']);
    if (a.kind === 'launch') expect(a.backend).toBe('local');
  });

  it('sem --backend ⇒ undefined (cai em env/config/default no wiring)', () => {
    const a = parseArgs(['oi']);
    if (a.kind === 'launch') expect(a.backend).toBeUndefined();
  });
});

describe('parseArgs — login --provider / --oauth (backend local)', () => {
  it('login --provider anthropic ⇒ provider sem oauth', () => {
    const a = parseArgs(['login', '--provider', 'anthropic']);
    expect(a.kind).toBe('login');
    if (a.kind === 'login') {
      expect(a.provider).toBe('anthropic');
      expect(a.oauth).toBeUndefined();
    }
  });

  it('login --provider anthropic --oauth ⇒ oauth:true', () => {
    const a = parseArgs(['login', '--provider', 'anthropic', '--oauth']);
    if (a.kind === 'login') {
      expect(a.provider).toBe('anthropic');
      expect(a.oauth).toBe(true);
    }
  });

  it('login --provider openrouter --token sk ⇒ token + provider', () => {
    const a = parseArgs(['login', '--provider', 'openrouter', '--token', 'sk-x']);
    if (a.kind === 'login') {
      expect(a.provider).toBe('openrouter');
      expect(a.token).toBe('sk-x');
    }
  });

  it('login SEM --provider ⇒ login do broker (provider undefined)', () => {
    const a = parseArgs(['login', '--token', 'pat']);
    if (a.kind === 'login') expect(a.provider).toBeUndefined();
  });
});
