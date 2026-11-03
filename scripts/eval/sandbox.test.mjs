import { describe, expect, it } from 'vitest';
import { bwrapArgs, confinar } from './sandbox.mjs';

describe('sandbox bwrap', () => {
  const opts = { home: '/home/u', existe: (p) => !p.endsWith('mcp.json') };
  const a = bwrapArgs('/tmp/w', opts);
  it('monta o disco read-only e só o diretório do cenário gravável', () => {
    expect(a.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    const binds = a.flatMap((x, i) => (x === '--bind' ? [a[i + 1]] : []));
    expect(binds).toEqual(['/tmp/w']);
    expect(a).toContain('--die-with-parent');
    expect(a).toContain('--new-session');
    expect(a).not.toContain('--unshare-net');
  });
  it('cobre ~/.aluy com tmpfs e monta só os arquivos de auth existentes, ro', () => {
    expect(a.join(' ')).toContain('--tmpfs /home/u/.aluy');
    expect(a.join(' ')).toContain('--ro-bind /home/u/.aluy/credentials.enc');
    expect(a.join(' ')).not.toContain('mcp.json');
  });
  it('confinar prefixa o bwrap e termina com o comando', () => {
    const c = confinar('/tmp/w', ['node', 'x'], opts);
    expect(c[0]).toBe('/usr/bin/bwrap');
    expect(c.slice(-3)).toEqual(['--', 'node', 'x']);
  });
});
