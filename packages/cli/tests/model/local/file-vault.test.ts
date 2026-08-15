// Cofre em arquivo CIFRADO — emenda à CLI-SEC-2 (ver credential-resolver.ts). Testa
// a propriedade central (a chave de cifra NUNCA viaja com o arquivo — deriva da
// identidade da MÁQUINA) e os TRÊS caminhos de erro exigidos: máquina diferente,
// machine-id ilegível, permissão aberta. Usa tmpdir REAL (nunca `~/.aluy` real —
// mesma disciplina do F167 nos testes de local-login).
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readFileVaultAccount,
  writeFileVaultAccount,
  readMachineId,
  MachineIdUnavailableError,
  type FileVaultOptions,
} from '../../../src/model/local/file-vault.js';

const dirs: string[] = [];
function tmpVaultPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aluy-file-vault-'));
  dirs.push(dir);
  return join(dir, 'nested', 'credentials.enc');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MAQUINA_A: FileVaultOptions = {
  machineId: { reader: () => 'machine-aaaa-1111' },
  username: 'tiago',
};
const MAQUINA_B: FileVaultOptions = {
  machineId: { reader: () => 'machine-bbbb-2222' },
  username: 'tiago',
};

describe('file-vault — round-trip básico', () => {
  it('grava e lê de volta o mesmo segredo', () => {
    const vaultPath = tmpVaultPath();
    const opts = { ...MAQUINA_A, vaultPath };
    writeFileVaultAccount('openrouter:apikey', 'sk-or-real-segredo', opts);
    const lido = readFileVaultAccount('openrouter:apikey', opts);
    expect(lido.valor).toBe('sk-or-real-segredo');
    expect(lido.erro).toBeUndefined();
  });

  it('múltiplas contas no MESMO arquivo — merge, sem perder as outras', () => {
    const vaultPath = tmpVaultPath();
    const opts = { ...MAQUINA_A, vaultPath };
    writeFileVaultAccount('anthropic:apikey', 'sk-ant-1', opts);
    writeFileVaultAccount('openrouter:apikey', 'sk-or-2', opts);
    writeFileVaultAccount('openai:apikey', 'sk-oa-3', opts);
    expect(readFileVaultAccount('anthropic:apikey', opts).valor).toBe('sk-ant-1');
    expect(readFileVaultAccount('openrouter:apikey', opts).valor).toBe('sk-or-2');
    expect(readFileVaultAccount('openai:apikey', opts).valor).toBe('sk-oa-3');
  });

  it('conta nunca gravada ⇒ ausente, sem erro (não é falha, é "nunca configurada")', () => {
    const vaultPath = tmpVaultPath();
    const opts = { ...MAQUINA_A, vaultPath };
    writeFileVaultAccount('anthropic:apikey', 'sk-ant', opts);
    const lido = readFileVaultAccount('openai:apikey', opts);
    expect(lido.valor).toBeUndefined();
    expect(lido.erro).toBeUndefined();
  });

  it('arquivo nunca existiu ⇒ ausente, sem erro', () => {
    const opts = { ...MAQUINA_A, vaultPath: tmpVaultPath() }; // caminho nunca escrito
    const lido = readFileVaultAccount('anthropic:apikey', opts);
    expect(lido.valor).toBeUndefined();
    expect(lido.erro).toBeUndefined();
  });
});

describe('file-vault — a chave nunca viaja com o arquivo (propriedade central)', () => {
  it('o segredo NUNCA aparece em claro nos bytes do arquivo', () => {
    const vaultPath = tmpVaultPath();
    const opts = { ...MAQUINA_A, vaultPath };
    const segredo = 'sk-real-0123456789abcdefghijklmnopqrstuvwxyz';
    writeFileVaultAccount('anthropic:apikey', segredo, opts);
    const raw = readFileSync(vaultPath, 'utf8');
    expect(raw).not.toContain(segredo);
    expect(raw).not.toContain('anthropic:apikey'); // nem a CONTA (nome da chave do mapa) vaza
  });

  it('cada escrita usa um IV novo — dois writes do MESMO segredo produzem bytes DIFERENTES', () => {
    const vaultPath = tmpVaultPath();
    const opts = { ...MAQUINA_A, vaultPath };
    writeFileVaultAccount('anthropic:apikey', 'sk-mesmo-segredo', opts);
    const primeira = readFileSync(vaultPath, 'utf8');
    writeFileVaultAccount('anthropic:apikey', 'sk-mesmo-segredo', opts);
    const segunda = readFileSync(vaultPath, 'utf8');
    expect(segunda).not.toBe(primeira); // IV aleatório ⇒ ciphertext muda mesmo com o mesmo plaintext
    // mas o round-trip continua correto:
    expect(readFileVaultAccount('anthropic:apikey', opts).valor).toBe('sk-mesmo-segredo');
  });

  it('nasce 0600', () => {
    const vaultPath = tmpVaultPath();
    writeFileVaultAccount('anthropic:apikey', 'sk-x', { ...MAQUINA_A, vaultPath });
    const mode = statSync(vaultPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('cria o diretório pai (0700) se não existir', () => {
    const vaultPath = tmpVaultPath(); // já inclui um subdiretório "nested/" inexistente
    writeFileVaultAccount('anthropic:apikey', 'sk-x', { ...MAQUINA_A, vaultPath });
    const dirMode = statSync(join(vaultPath, '..')).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });
});

describe('file-vault — os TRÊS caminhos de erro (honestos, nunca crasham, nunca vazam)', () => {
  it('arquivo de OUTRA MÁQUINA ⇒ mensagem clara, sem crash, sem valor', () => {
    const vaultPath = tmpVaultPath();
    // grava sob a identidade da máquina A…
    writeFileVaultAccount('anthropic:apikey', 'sk-da-maquina-a', { ...MAQUINA_A, vaultPath });
    // …lê sob a identidade da máquina B (ex.: o mesmo arquivo copiado via scp/tar/snapshot).
    const lido = readFileVaultAccount('anthropic:apikey', { ...MAQUINA_B, vaultPath });
    expect(lido.valor).toBeUndefined();
    expect(lido.erro).toBeDefined();
    expect(lido.motivo).toBe('maquina-diferente');
    expect(lido.erro).toMatch(/outra máquina|adulterado/i);
    expect(lido.erro).not.toContain('sk-da-maquina-a'); // o erro NUNCA cita o segredo
  });

  it('machine-id ILEGÍVEL na LEITURA ⇒ mensagem clara, cai (o resolvedor cai pra env — testado à parte)', () => {
    const vaultPath = tmpVaultPath();
    writeFileVaultAccount('anthropic:apikey', 'sk-x', { ...MAQUINA_A, vaultPath });
    const semMachineId: FileVaultOptions = {
      vaultPath,
      machineId: { reader: () => undefined },
    };
    const lido = readFileVaultAccount('anthropic:apikey', semMachineId);
    expect(lido.valor).toBeUndefined();
    expect(lido.erro).toBeDefined();
    expect(lido.motivo).toBe('machine-id-indisponivel');
  });

  it('machine-id ILEGÍVEL na ESCRITA ⇒ lança MachineIdUnavailableError, NUNCA grava em claro (nem cria arquivo)', () => {
    const vaultPath = tmpVaultPath();
    const semMachineId: FileVaultOptions = {
      vaultPath,
      machineId: { reader: () => undefined },
    };
    expect(() => writeFileVaultAccount('anthropic:apikey', 'sk-x', semMachineId)).toThrow(
      MachineIdUnavailableError,
    );
    // nenhum arquivo foi criado — não há "consolo em claro".
    expect(() => statSync(vaultPath)).toThrow();
  });

  it('PERMISSÃO mais aberta que 0600 ⇒ RECUSA usar (mesmo que a decifra funcionasse)', () => {
    const vaultPath = tmpVaultPath();
    writeFileVaultAccount('anthropic:apikey', 'sk-x', { ...MAQUINA_A, vaultPath });
    chmodSync(vaultPath, 0o644); // afrouxa a permissão depois de gravado corretamente
    const lido = readFileVaultAccount('anthropic:apikey', { ...MAQUINA_A, vaultPath });
    expect(lido.valor).toBeUndefined();
    expect(lido.erro).toBeDefined();
    expect(lido.motivo).toBe('permissao-aberta');
    expect(lido.erro).toMatch(/permiss/i);
  });

  it('arquivo CORROMPIDO (bytes aleatórios, não é o formato esperado) ⇒ mensagem clara, sem crash', () => {
    const vaultPath = tmpVaultPath();
    writeFileVaultAccount('anthropic:apikey', 'sk-x', { ...MAQUINA_A, vaultPath }); // garante o diretório
    writeFileSync(vaultPath, 'isto não é um blob cifrado válido', { mode: 0o600 });
    chmodSync(vaultPath, 0o600);
    const lido = readFileVaultAccount('anthropic:apikey', { ...MAQUINA_A, vaultPath });
    expect(lido.valor).toBeUndefined();
    expect(lido.erro).toBeDefined();
    expect(lido.motivo).toBe('corrompido');
  });

  it('escrever com permissão aberta preexistente ⇒ recusa SOBRESCREVER às cegas (lança)', () => {
    const vaultPath = tmpVaultPath();
    writeFileVaultAccount('anthropic:apikey', 'sk-x', { ...MAQUINA_A, vaultPath });
    chmodSync(vaultPath, 0o644);
    expect(() => writeFileVaultAccount('openai:apikey', 'sk-y', { ...MAQUINA_A, vaultPath })).toThrow(
      /permiss/i,
    );
  });
});

describe('readMachineId — leitor real (smoke, best-effort)', () => {
  it('reader injetado tem prioridade total (nunca toca fs/child_process reais)', () => {
    expect(readMachineId({ reader: () => 'abc-123' })).toBe('abc-123');
    expect(readMachineId({ reader: () => undefined })).toBeUndefined();
    expect(readMachineId({ reader: () => '' })).toBeUndefined(); // vazio == indisponível
  });

  it('nesta máquina Linux de teste, consegue ler algo de /etc/machine-id (smoke real)', () => {
    // Best-effort: se a máquina de CI não tiver /etc/machine-id, isto simplesmente
    // devolve undefined — não é uma invariante que o teste force.
    const v = readMachineId({ platform: 'linux' });
    expect(v === undefined || typeof v === 'string').toBe(true);
  });
});
