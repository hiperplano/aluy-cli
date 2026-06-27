import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseArgs } from '../src/cli.js';

describe('parseArgs — subcomandos de auth (EST-0942)', () => {
  it('login sem flags ⇒ kind=login, forceDeviceFlow=false', () => {
    const a = parseArgs(['login']);
    expect(a).toEqual({ kind: 'login', forceDeviceFlow: false });
  });

  it('login --token <PAT> --org <id>', () => {
    const a = parseArgs(['login', '--token', 'pat_x', '--org', 'org-1']);
    expect(a).toEqual({
      kind: 'login',
      forceDeviceFlow: false,
      token: 'pat_x',
      org: 'org-1',
    });
  });

  it('login --token=<PAT> (forma com =)', () => {
    const a = parseArgs(['login', '--token=pat_y']);
    expect(a.kind).toBe('login');
    if (a.kind === 'login') expect(a.token).toBe('pat_y');
  });

  it('login --device ⇒ forceDeviceFlow=true', () => {
    const a = parseArgs(['login', '--device', '--org', 'o']);
    expect(a.kind).toBe('login');
    if (a.kind === 'login') expect(a.forceDeviceFlow).toBe(true);
  });

  it('logout / whoami', () => {
    expect(parseArgs(['logout']).kind).toBe('logout');
    expect(parseArgs(['whoami']).kind).toBe('whoami');
  });

  it('login --help ⇒ ajuda geral (não executa login)', () => {
    expect(parseArgs(['login', '--help']).kind).toBe('help');
    expect(parseArgs(['login', '-h']).kind).toBe('help');
  });

  it('--version/--help globais seguem funcionando', () => {
    expect(parseArgs(['--version']).kind).toBe('version');
    expect(parseArgs(['--help']).kind).toBe('help');
    expect(parseArgs([]).kind).toBe('launch');
  });

  it('HELP_TEXT documenta login/logout/whoami', () => {
    expect(HELP_TEXT).toContain('login');
    expect(HELP_TEXT).toContain('logout');
    expect(HELP_TEXT).toContain('whoami');
    expect(HELP_TEXT).toContain('keychain do SO');
  });
});
