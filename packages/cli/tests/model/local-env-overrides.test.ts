// F-ENV — o AVISO de que o ambiente venceu o `~/.aluy/config.json`.
//
// O caso que originou isto: o dono rodou `/provider`, gravou `tokenrouter` no config,
// abriu o arquivo e viu lá — mas o rodapé seguia dizendo `openai`, porque uma
// `ALUY_LOCAL_PROVIDER=openai` esquecida no ambiente vinha antes na precedência
// (flag > env > config > default). A escrita nunca falhou; a LEITURA preferia outra
// fonte e não dizia. Diagnosticamos "provider não persiste" por várias rodadas.
//
// O que este arquivo trava é o SILÊNCIO, não a precedência — que segue igual e é
// deliberada (CI e container sobrescrevem sem editar arquivo).

import { describe, expect, it } from 'vitest';
import { detectLocalEnvOverrides } from '../../src/model/local/config.js';
import type { UserConfig } from '../../src/io/user-config.js';

const cfg = (over: Partial<UserConfig> = {}): UserConfig => ({ ...over }) as UserConfig;

describe('detectLocalEnvOverrides — o ambiente venceu o arquivo', () => {
  it('env DIVERGE do config declarado ⇒ reporta, com os dois valores', () => {
    const r = detectLocalEnvOverrides({
      env: { ALUY_LOCAL_PROVIDER: 'openai' },
      config: cfg({ localProvider: 'tokenrouter' }),
    });
    expect(r).toEqual([
      {
        key: 'provider',
        envVar: 'ALUY_LOCAL_PROVIDER',
        envValue: 'openai',
        configValue: 'tokenrouter',
      },
    ]);
  });

  // O cenário EXATO da máquina do dono: quatro variáveis, e o par incoerente
  // (provider de um serviço, baseUrl de outro) que produzia 401 sem explicação.
  it('reporta TODAS as chaves divergentes, não só a primeira', () => {
    const r = detectLocalEnvOverrides({
      env: {
        ALUY_LOCAL_PROVIDER: 'openai',
        ALUY_LOCAL_BASE_URL: 'https://api.tokenrouter.com/v1',
        ALUY_LOCAL_MODEL: 'deepseek/deepseek-v4-pro',
      },
      config: cfg({
        localProvider: 'tokenrouter',
        localBaseUrl: 'https://api.tokenrouter.com/v1',
        localModel: 'qwen/qwen3-27b',
      }),
    });
    // baseUrl é IGUAL nas duas fontes ⇒ não é conflito, não entra.
    expect(r.map((o) => o.key).sort()).toEqual(['model', 'provider']);
  });

  it('config SILENCIOSO ⇒ nada a reportar (env é só a fonte, não sobreposição)', () => {
    expect(detectLocalEnvOverrides({ env: { ALUY_LOCAL_PROVIDER: 'openai' }, config: cfg() })).toEqual([]);
  });

  it('env ausente ⇒ nada (o arquivo já é quem vale)', () => {
    expect(detectLocalEnvOverrides({ env: {}, config: cfg({ localProvider: 'tokenrouter' }) })).toEqual([]);
  });

  it('valores IGUAIS ⇒ silêncio, mesmo com caixa diferente', () => {
    const r = detectLocalEnvOverrides({
      env: { ALUY_LOCAL_PROVIDER: 'OpenAI' },
      config: cfg({ localProvider: 'openai' }),
    });
    expect(r).toEqual([]);
  });

  it('env VAZIO não conta como declaração (`ALUY_LOCAL_PROVIDER=` no shell)', () => {
    const r = detectLocalEnvOverrides({
      env: { ALUY_LOCAL_PROVIDER: '   ' },
      config: cfg({ localProvider: 'tokenrouter' }),
    });
    expect(r).toEqual([]);
  });

  // Sob flag explícita nem env nem config vencem — culpar o ambiente mandaria o dono
  // caçar a variável errada.
  it('FLAG explícita na mesma chave ⇒ omitida (a flag é que manda)', () => {
    const r = detectLocalEnvOverrides({
      flags: { localProvider: 'anthropic' },
      env: { ALUY_LOCAL_PROVIDER: 'openai' },
      config: cfg({ localProvider: 'tokenrouter' }),
    });
    expect(r).toEqual([]);
  });

  it('flag numa chave NÃO cala as outras', () => {
    const r = detectLocalEnvOverrides({
      flags: { localProvider: 'anthropic' },
      env: { ALUY_LOCAL_PROVIDER: 'openai', ALUY_LOCAL_MODEL: 'x/y' },
      config: cfg({ localProvider: 'tokenrouter', localModel: 'a/b' }),
    });
    expect(r.map((o) => o.key)).toEqual(['model']);
  });
});
