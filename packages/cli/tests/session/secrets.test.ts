// ADR 0005 — `/secret`: parser da linha e serviço (memória + `--save` no cofre CIFRADO).
// Nada aqui toca o `~/.aluy` real: o cofre cifrado aponta para um diretório temporário.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretVault } from '@hiperplano/aluy-cli-core';
import { SecretsService, isSecretCommandLine, parseSecretArgs } from '../../src/session/secrets.js';

const CANARY = 'ZIMBRO-canario-7f3a91c2e8';

describe('parseSecretArgs', () => {
  it('uso, list, remove, prompt', () => {
    expect(parseSecretArgs('')).toEqual({ kind: 'usage' });
    expect(parseSecretArgs('list')).toEqual({ kind: 'list' });
    expect(parseSecretArgs('remove API_KEY')).toEqual({ kind: 'remove', name: 'API_KEY' });
    expect(parseSecretArgs('API_KEY')).toEqual({
      kind: 'prompt',
      name: 'API_KEY',
      save: false,
      force: false,
    });
    expect(parseSecretArgs('API_KEY --save --force')).toEqual({
      kind: 'prompt',
      name: 'API_KEY',
      save: true,
      force: true,
    });
  });

  it('VALOR digitado na linha ⇒ inline-value (nunca prompt, nunca guarda)', () => {
    expect(parseSecretArgs(`API_KEY ${CANARY}`).kind).toBe('inline-value');
    expect(parseSecretArgs(`API_KEY --save ${CANARY}`).kind).toBe('inline-value');
    expect(parseSecretArgs(`remove API_KEY ${CANARY}`).kind).toBe('inline-value');
    // o valor colado NO LUGAR do nome também é tratado como valor em aberto
    expect(parseSecretArgs(CANARY).kind).toBe('inline-value');
    expect(parseSecretArgs('sk-proj-abc123def456ghi789').kind).toBe('inline-value');
  });

  it('nome inválido ⇒ erro SEM ecoar o token', () => {
    const r = parseSecretArgs('api_key');
    expect(r.kind).toBe('error');
    expect(JSON.stringify(r)).not.toContain('api_key');
  });

  it('isSecretCommandLine reconhece `/secret …` (p/ nunca ir ao histórico/fila)', () => {
    expect(isSecretCommandLine('/secret API_KEY')).toBe(true);
    expect(isSecretCommandLine('  /SECRET list')).toBe(true);
    expect(isSecretCommandLine('/secrets')).toBe(false);
    expect(isSecretCommandLine('oi /secret')).toBe(false);
  });
});

describe('SecretsService', () => {
  let dir: string;
  let vaultPath: string;
  let vault: SecretVault;
  const mk = (project = '/proj-a'): SecretsService =>
    new SecretsService({
      projectDir: project,
      vault,
      fileVault: { vaultPath, machineId: { reader: () => 'maquina-de-teste' }, username: 'u' },
    });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aluy-secrets-'));
    vaultPath = join(dir, 'credentials.enc');
    vault = new SecretVault();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sem --save: só memória (nada em disco); remove zera', () => {
    const s = mk();
    expect(s.submit('API_KEY', CANARY)).toEqual({ ok: true, weak: false, saved: false });
    expect(() => readFileSync(vaultPath)).toThrow(); // nenhum arquivo criado
    expect(s.list()).toEqual([{ name: 'API_KEY', saved: false }]);
    expect(s.remove('API_KEY')).toEqual({ removed: true, wasSaved: false });
    expect(vault.has('API_KEY')).toBe(false);
  });

  it('--save: grava CIFRADO (o valor não aparece em claro no arquivo) e volta no boot, SÓ no projeto', () => {
    const s = mk('/proj-a');
    expect(s.submit('API_KEY', CANARY, { save: true })).toMatchObject({ ok: true, saved: true });
    const bruto = readFileSync(vaultPath).toString('latin1');
    expect(bruto).not.toContain(CANARY);
    expect(bruto).not.toContain('API_KEY');

    // novo "processo": cofre vazio, mesmo projeto ⇒ carrega
    vault = new SecretVault();
    const volta = mk('/proj-a');
    expect(volta.loadSaved()).toBe(1);
    expect(vault.valueOf('API_KEY')).toBe(CANARY);
    expect(volta.list()).toEqual([{ name: 'API_KEY', saved: true }]);

    // outro projeto NÃO enxerga
    vault = new SecretVault();
    expect(mk('/proj-b').loadSaved()).toBe(0);
    expect(vault.has('API_KEY')).toBe(false);
  });

  it('remove de um salvo apaga também do cofre cifrado', () => {
    const s = mk();
    s.submit('API_KEY', CANARY, { save: true });
    expect(s.remove('API_KEY')).toEqual({ removed: true, wasSaved: true });
    vault = new SecretVault();
    expect(mk().loadSaved()).toBe(0);
  });

  it('regravar SEM --save um nome salvo remove o valor antigo do disco (sem divergência)', () => {
    const s = mk();
    s.submit('API_KEY', CANARY, { save: true });
    s.submit('API_KEY', 'outro-valor-novo-12');
    vault = new SecretVault();
    expect(mk().loadSaved()).toBe(0);
  });

  it('curto (<8) recusado; com force aceito e marcado weak; mensagem não contém o valor', () => {
    const s = mk();
    const r = s.submit('PIN', 'abc');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('abc');
    expect(s.submit('PIN', 'abc', { force: true })).toMatchObject({ ok: true, weak: true });
  });

  it('falha ao salvar (sem machine-id) ⇒ segue em memória e avisa, sem gravar em claro', () => {
    const s = new SecretsService({
      projectDir: '/proj-a',
      vault,
      fileVault: { vaultPath, machineId: { reader: () => undefined } },
    });
    const r = s.submit('API_KEY', CANARY, { save: true });
    expect(r).toMatchObject({ ok: true, saved: false });
    expect(r.ok && r.note).toBeTruthy();
    expect(() => readFileSync(vaultPath)).toThrow();
    expect(vault.has('API_KEY')).toBe(true);
  });
});
