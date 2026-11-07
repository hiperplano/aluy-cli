// ADR-0120 (retomada) — `/login` da sessão, backend LOCAL (BYO). Decisão do dono
// (relato "o /login não funciona"): SÓ o backend local grava chave aqui; broker
// (login de conta) fica de fora — ainda não existe dentro da sessão ("ainda não
// temos os modelos do aluy"). Prova a DECISÃO pura (existe chave? reusar ou pedir?
// provider ativo qual?) e o runner assíncrono (I/O fake — nunca toca keychain real).
import { describe, expect, it, vi } from 'vitest';
import {
  decideLocalLogin,
  parseReuseAnswer,
  runLoginSlash,
  type LoginSlashDeps,
} from '../../src/slash/handlers.js';
import { PromptInterruptedError, type TerminalIO } from '../../src/auth/io.js';
import type { StoreApiKeyResult } from '../../src/model/local/credential-resolver.js';

// ── decideLocalLogin — a DECISÃO pura, sem I/O ──────────────────────────────────

describe('decideLocalLogin', () => {
  it('backend broker ⇒ broker-unsupported, mesmo com provider/chave presentes', () => {
    expect(
      decideLocalLogin({ backend: 'broker', localProvider: 'anthropic', hasExistingKey: true }),
    ).toEqual({ kind: 'broker-unsupported' });
  });

  it('backend local sem provider ativo ⇒ no-active-provider (defensivo, nunca inventa)', () => {
    expect(decideLocalLogin({ backend: 'local', localProvider: undefined, hasExistingKey: true })).toEqual(
      { kind: 'no-active-provider' },
    );
    expect(decideLocalLogin({ backend: 'local', localProvider: '', hasExistingKey: false })).toEqual({
      kind: 'no-active-provider',
    });
  });

  it('backend local + provider + SEM chave existente ⇒ prompt-new', () => {
    expect(
      decideLocalLogin({ backend: 'local', localProvider: 'openrouter', hasExistingKey: false }),
    ).toEqual({ kind: 'prompt-new', provider: 'openrouter' });
  });

  it('backend local + provider + JÁ existe chave ⇒ ask-reuse (o ponto central da estória)', () => {
    expect(
      decideLocalLogin({ backend: 'local', localProvider: 'openrouter', hasExistingKey: true }),
    ).toEqual({ kind: 'ask-reuse', provider: 'openrouter' });
  });
});

// ── parseReuseAnswer — Enter = reusar (menor esforço, sem digitar de novo) ──────

describe('parseReuseAnswer', () => {
  it('vazio (Enter) ⇒ reusa — é literalmente "sem digitar de novo"', () => {
    expect(parseReuseAnswer('')).toBe(true);
    expect(parseReuseAnswer('   ')).toBe(true);
  });

  it('s/sim/y/yes (qualquer caixa, com espaço) ⇒ reusa', () => {
    for (const v of ['s', 'S', 'sim', 'SIM', ' y ', 'Yes']) expect(parseReuseAnswer(v)).toBe(true);
  });

  it('n/não/lixo/começo de colagem ⇒ NÃO reusa (cai no prompt de chave nova, reversível)', () => {
    for (const v of ['n', 'N', 'não', 'nao', 'no', 'sk-ant-alguma-coisa', 'talvez'])
      expect(parseReuseAnswer(v)).toBe(false);
  });
});

// ── runLoginSlash — o runner assíncrono (I/O fake) ──────────────────────────────

/** IO fake determinístico: respostas em fila; grava tudo que foi impresso p/ o
 * CLI-SEC (a chave nunca deve aparecer numa linha de saída). */
function fakeIO(answers: readonly string[]): { io: TerminalIO; printed: string[] } {
  const printed: string[] = [];
  let i = 0;
  return {
    printed,
    io: {
      out: (l) => printed.push(l),
      err: (l) => printed.push(l),
      prompt: async () => {
        const a = answers[i++];
        if (a === undefined) throw new Error('fakeIO: prompt sem resposta enfileirada');
        return a;
      },
    },
  };
}

const OK_KEYCHAIN: StoreApiKeyResult = { backend: 'keychain' };
const OK_FILE_VAULT: StoreApiKeyResult = { backend: 'file-vault' };

describe('runLoginSlash', () => {
  it('sem chave existente ⇒ pede direto (sem pergunta de reuso) e grava via storeKey', async () => {
    const { io, printed } = fakeIO(['sk-nova-chave-123']);
    const storeKey = vi.fn<LoginSlashDeps['storeKey']>().mockReturnValue(OK_KEYCHAIN);
    const note = await runLoginSlash({
      provider: 'anthropic',
      io,
      hasExistingKey: () => false,
      storeKey,
    });
    expect(storeKey).toHaveBeenCalledWith('anthropic', 'sk-nova-chave-123');
    expect(note.lines.join('\n')).toMatch(/keychain do SO/);
    // CLI-SEC — a chave nunca aparece no que foi impresso.
    expect(printed.join('\n')).not.toContain('sk-nova-chave-123');
  });

  it('já existe chave + Enter (reusa) ⇒ NÃO chama storeKey nem pede a chave de novo', async () => {
    const { io } = fakeIO(['']); // só a pergunta de reuso é respondida
    const storeKey = vi.fn<LoginSlashDeps['storeKey']>();
    const note = await runLoginSlash({
      provider: 'openrouter',
      io,
      hasExistingKey: () => true,
      storeKey,
    });
    expect(storeKey).not.toHaveBeenCalled();
    expect(note.lines.join('\n')).toMatch(/mantida a chave já guardada/);
  });

  it('já existe chave + "n" ⇒ cai no prompt de chave nova e grava (sobrescreve)', async () => {
    const { io } = fakeIO(['n', 'sk-substituta']);
    const storeKey = vi.fn<LoginSlashDeps['storeKey']>().mockReturnValue(OK_FILE_VAULT);
    const note = await runLoginSlash({
      provider: 'openai',
      io,
      hasExistingKey: () => true,
      storeKey,
    });
    expect(storeKey).toHaveBeenCalledWith('openai', 'sk-substituta');
    expect(note.lines.join('\n')).toMatch(/cofre local cifrado/);
  });

  it('chave vazia (só Enter no prompt secreto) ⇒ nota honesta, nada gravado', async () => {
    const { io } = fakeIO(['   ']);
    const storeKey = vi.fn<LoginSlashDeps['storeKey']>();
    const note = await runLoginSlash({
      provider: 'anthropic',
      io,
      hasExistingKey: () => false,
      storeKey,
    });
    expect(storeKey).not.toHaveBeenCalled();
    expect(note.lines.join('\n')).toMatch(/nenhuma chave informada/);
  });

  it('storeKey falha (keychain indisponível) ⇒ nota de erro, NUNCA interpola a chave', async () => {
    const { io, printed } = fakeIO(['sk-segredo-que-nao-pode-vazar']);
    const storeKey = vi.fn<LoginSlashDeps['storeKey']>().mockImplementation(() => {
      throw new Error('Secret Service indisponível (DBus)');
    });
    const note = await runLoginSlash({
      provider: 'anthropic',
      io,
      hasExistingKey: () => false,
      storeKey,
    });
    const text = note.lines.join('\n');
    expect(text).toMatch(/Secret Service indisponível/);
    expect(text).not.toContain('sk-segredo-que-nao-pode-vazar');
    expect(printed.join('\n')).not.toContain('sk-segredo-que-nao-pode-vazar');
  });

  it('Ctrl-C durante o prompt ⇒ nota de cancelado, NUNCA rejeita a Promise (sessão viva)', async () => {
    const io: TerminalIO = {
      out: () => {},
      err: () => {},
      prompt: async () => {
        throw new PromptInterruptedError();
      },
    };
    const storeKey = vi.fn<LoginSlashDeps['storeKey']>();
    await expect(
      runLoginSlash({ provider: 'anthropic', io, hasExistingKey: () => false, storeKey }),
    ).resolves.toMatchObject({ lines: [expect.stringMatching(/cancelado/)] });
    expect(storeKey).not.toHaveBeenCalled();
  });
});
