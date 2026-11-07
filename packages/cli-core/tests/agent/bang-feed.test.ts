// ADR 0003 (emenda) · 0005 — `!comando`: a saída ENTRA na conversa (observação, canal
// CLI-SEC-4), bloco em texto simples, `cd` persistente e aviso de comando interativo.

import { afterEach, describe, expect, it } from 'vitest';
import {
  BANG_FEED_MAX_CHARS,
  BangExecutor,
  NON_INTERACTIVE_HINT,
  PolicyPermissionEngine,
  SECRET_REDACTED,
  bangFeedObservation,
  buildMessages,
  detectNonInteractive,
  formatBangOutput,
  parseSimpleCd,
  secretVault,
  NATIVE_TOOLS,
  UNTRUSTED_OPEN,
} from '../../src/index.js';
import { MemoryCwd, RecordingShell, makePorts } from './helpers.js';

afterEach(() => secretVault.clear());

const allow = new PolicyPermissionEngine({
  policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
});

describe('saída do bloco em texto simples', () => {
  it('exit 0 sem stderr ⇒ só o stdout (sem exit=/stdout:/stderr:)', () => {
    const o = formatBangOutput({ exitCode: 0, stdout: 'a\nb\n', stderr: '' });
    expect(o).toBe('a\nb');
    expect(o).not.toMatch(/exit|stdout:|stderr/);
  });
  it('exit 0 sem saída ⇒ vazio', () => {
    expect(formatBangOutput({ exitCode: 0, stdout: '', stderr: '' })).toBe('');
  });
  it('exit ≠ 0 mostra `exit N`; stderr só quando há (rotulado se há stdout também)', () => {
    expect(formatBangOutput({ exitCode: 2, stdout: '', stderr: 'boom\n' })).toBe('boom\nexit 2');
    expect(formatBangOutput({ exitCode: 1, stdout: 'ok', stderr: 'w' })).toBe(
      'ok\nstderr:\nw\nexit 1',
    );
  });
  it('abortado não vira "exit 130"', () => {
    expect(formatBangOutput({ exitCode: 130, stdout: '', stderr: '', aborted: true })).toBe(
      '[interrompido pelo usuário]',
    );
  });
});

describe('a saída do `!` vira observação para o modelo', () => {
  it('BangExecutor.run devolve observação com o comando e a saída (canal observation)', async () => {
    const shell = new RecordingShell(() => ({
      stdout: 'PALAVRA-ZIMBRO-42\n',
      stderr: '',
      exitCode: 0,
    }));
    const out = await new BangExecutor({
      permission: allow,
      ports: makePorts({ shell }).ports,
    }).run('echo PALAVRA-ZIMBRO-42');
    expect(out.kind).toBe('ran');
    if (out.kind !== 'ran') return;
    expect(out.observation.role).toBe('observation');
    const txt = (out.observation as { text: string }).text;
    expect(txt).toContain('echo PALAVRA-ZIMBRO-42');
    expect(txt).toContain('PALAVRA-ZIMBRO-42');
    // chega ao prompt ENVELOPADO como dado não-confiável (CLI-SEC-4), nunca como system.
    const msgs = buildMessages(NATIVE_TOOLS, [{ role: 'goal', text: 'oi' }, out.observation]);
    const obs = msgs.find(
      (m) => typeof m.content === 'string' && m.content.includes('ZIMBRO-42') && m.role === 'user',
    );
    expect(obs && (obs.content as string)).toContain(UNTRUSTED_OPEN);
    expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('saída enorme é LIMITADA e a observação DIZ que truncou', () => {
    const grande = 'x'.repeat(BANG_FEED_MAX_CHARS * 3);
    const t = (bangFeedObservation('cat enorme', grande) as { text: string }).text;
    expect(t.length).toBeLessThan(BANG_FEED_MAX_CHARS + 600);
    expect(t).toMatch(/caracteres omitidos no meio/);
    const curto = (bangFeedObservation('ls', 'a') as { text: string }).text;
    expect(curto).not.toMatch(/omitidos/);
  });

  it('o comando digitado com token vai REDIGIDO na observação', () => {
    const t = (
      bangFeedObservation('curl -H "Authorization: Bearer sk-abcdefghijklmnop1234"', 'ok') as {
        text: string;
      }
    ).text;
    expect(t).not.toContain('sk-abcdefghijklmnop1234');
  });

  it('segredo do /secret: `!echo $API_KEY` roda (env de TODOS) e a saída chega redigida', async () => {
    secretVault.set('API_KEY', 'CANARIO-valor-secreto-9');
    let envVisto: Readonly<Record<string, string>> | undefined;
    const shell = new RecordingShell();
    const exec = shell.exec.bind(shell);
    shell.exec = async (c, o) => {
      envVisto = o?.env;
      void exec;
      return { stdout: 'CANARIO-valor-secreto-9\n', stderr: '', exitCode: 0 };
    };
    const out = await new BangExecutor({
      permission: allow,
      ports: makePorts({ shell }).ports,
    }).run('echo $API_KEY');
    expect(envVisto).toEqual({ API_KEY: 'CANARIO-valor-secreto-9' });
    if (out.kind !== 'ran') throw new Error('esperava ran');
    expect(out.output).toBe(SECRET_REDACTED);
    expect(JSON.stringify(out.observation)).not.toContain('CANARIO-valor-secreto-9');
  });
});

describe('`!cd` persiste (porta de cwd, mesmas cercas)', () => {
  it('parseSimpleCd só aceita cd simples', () => {
    expect(parseSimpleCd('cd /tmp')).toBe('/tmp');
    expect(parseSimpleCd('cd')).toBe('');
    expect(parseSimpleCd('cd -')).toBe('-');
    expect(parseSimpleCd('cd "a b"')).toBe('a b');
    expect(parseSimpleCd('cd a && ls')).toBeUndefined();
    expect(parseSimpleCd('cd $HOME')).toBeUndefined();
    expect(parseSimpleCd('cdrom')).toBeUndefined();
  });

  it('`!cd sub` move o cwd da sessão e NÃO chama o shell', async () => {
    const cwd = new MemoryCwd('/proj', new Set(['/proj', '/proj/sub']));
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell, cwd });
    const bang = new BangExecutor({ permission: allow, ports });
    const out = await bang.run('cd sub');
    expect(shell.executed).toEqual([]);
    expect(cwd.cwd).toBe('/proj/sub');
    expect(out.kind === 'ran' && out.output).toContain('diretório da sessão agora: sub');
    // o modelo é avisado (caminhos relativos mudaram)
    expect(out.kind === 'ran' && (out.observation as { text: string }).text).toContain(
      'diretório de trabalho',
    );
    // `cd -` volta
    await bang.run('cd -');
    expect(cwd.cwd).toBe('/proj');
  });

  it('destino inexistente ⇒ erro explicado, cwd intacto', async () => {
    const cwd = new MemoryCwd('/proj', new Set(['/proj', '/proj/sub']));
    const { ports } = makePorts({ cwd });
    const out = await new BangExecutor({ permission: allow, ports }).run('cd nao-existe');
    expect(out.kind === 'ran' && out.ok).toBe(false);
    expect(out.kind === 'ran' && out.output).toMatch(/não consegui entrar/);
    expect(cwd.cwd).toBe('/proj');
  });

  it('destino ABSOLUTO fora das raízes: a porta clampa e a mensagem EXPLICA', async () => {
    const cwd = new MemoryCwd('/proj', new Set(['/proj', '/proj/sub']));
    const { ports } = makePorts({ cwd });
    const out = await new BangExecutor({ permission: allow, ports }).run('cd /etc');
    expect(out.kind === 'ran' && out.output).toMatch(/fora das raízes autorizadas/);
    expect(cwd.cwd).toBe('/proj');
  });

  it('Plan (deny) bloqueia o `!cd` como bloquearia o change_dir do modelo', async () => {
    const cwd = new MemoryCwd('/proj', new Set(['/proj', '/proj/sub']));
    const { ports } = makePorts({ cwd });
    const out = await new BangExecutor({
      permission: new PolicyPermissionEngine({ mode: 'plan' }),
      ports,
    }).run('cd sub');
    expect(out.kind).toBe('blocked');
    expect(cwd.cwd).toBe('/proj');
  });

  it('`cd x && ls` NÃO é cd simples: vai ao shell (não persiste)', async () => {
    const cwd = new MemoryCwd('/proj', new Set(['/proj', '/proj/x']));
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell, cwd });
    await new BangExecutor({ permission: allow, ports }).run('cd x && ls');
    expect(shell.executed).toEqual(['cd x && ls']);
    expect(cwd.cwd).toBe('/proj');
  });
});

describe('comando interativo (stdin fechado) — o que DÁ para detectar', () => {
  it('`read` no texto', () => {
    expect(detectNonInteractive('read -p x; echo got=$x', 1, '', '')).toBe(NON_INTERACTIVE_HINT);
    expect(detectNonInteractive('echo a; read v', 1, '', '')).toBe(NON_INTERACTIVE_HINT);
  });
  it('mensagens de "preciso de TTY" no stderr', () => {
    expect(
      detectNonInteractive('sudo ls', 1, '', 'sudo: a terminal is required to read the password'),
    ).toBe(NON_INTERACTIVE_HINT);
    expect(detectNonInteractive('docker run -it x', 1, '', 'the input device is not a TTY')).toBe(
      NON_INTERACTIVE_HINT,
    );
  });
  it('programas de tela cheia (vim, less, top…)', () => {
    expect(detectNonInteractive('vim a.txt', 0, '', '')).toBe(NON_INTERACTIVE_HINT);
    expect(detectNonInteractive('less README.md', 0, '', '')).toBe(NON_INTERACTIVE_HINT);
  });
  it('NÃO acusa comando comum (nem o `thread`/`already` que contêm "read")', () => {
    expect(detectNonInteractive('ls -la', 0, 'x', '')).toBeUndefined();
    expect(detectNonInteractive('echo already thread', 0, '', '')).toBeUndefined();
    expect(detectNonInteractive('npm test', 1, '', 'falhou')).toBeUndefined();
  });
  it('o aviso entra no bloco (output) mas NÃO na observação ao modelo', async () => {
    const shell = new RecordingShell(() => ({ stdout: 'got=\n', stderr: '', exitCode: 0 }));
    const out = await new BangExecutor({
      permission: allow,
      ports: makePorts({ shell }).ports,
    }).run('read -p x; echo got=$x');
    if (out.kind !== 'ran') throw new Error('ran');
    expect(out.output).toContain(NON_INTERACTIVE_HINT);
    expect(out.hint).toBe(NON_INTERACTIVE_HINT);
  });
});
