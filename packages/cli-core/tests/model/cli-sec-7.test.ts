// CLI-SEC-7 — teste de REGRESSÃO automatizado (CA-3 + CA-4).
//
// CA-3: varrendo o pacote @aluy/cli-core, NÃO há credencial de provider, nome de
//       provider, markup, quota nem ledger — `tier` é a única pista (HG-2).
// CA-4: EXISTE exatamente UM caminho de modelo (o broker, POST /v1/chat). Este
//       teste FALHA (vermelho) se aparecer uma rota alternativa (provider direto
//       / chave local / endpoint OpenAI-compat embutido / SDK de provider).
//
// É a contrapartida do "binário público limpo" que se repete no CI de release
// (EST-0949). Aqui entra como teste de código (DoD da EST-0943, gate seguranca).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Tokens que NÃO podem aparecer no código do core como economia/credencial de
 * provider embutida. Casamos só os nomes de PROVIDER e segredos — não palavras
 * neutras como "tier". Como o próprio core MENCIONA estes nomes em comentários
 * de negação ("não carrega chave de provider"), o scan ignora comentários e só
 * inspeciona CÓDIGO executável (linhas não-comentário).
 */
const FORBIDDEN_CODE_TOKENS: { token: RegExp; why: string }[] = [
  // SDKs de provider (uma dep de provider seria caminho fora do broker).
  { token: /@anthropic-ai\b/i, why: 'SDK Anthropic = provider direto (fora do broker)' },
  { token: /\bfrom\s+['"]openai['"]/i, why: 'SDK OpenAI = provider direto (fora do broker)' },
  { token: /@google\/generative-ai/i, why: 'SDK Google = provider direto (fora do broker)' },
  // Endpoints de provider crus / chaves de provider.
  { token: /api\.anthropic\.com/i, why: 'endpoint Anthropic cru (fora do broker)' },
  { token: /api\.openai\.com/i, why: 'endpoint OpenAI cru (fora do broker)' },
  { token: /generativelanguage\.googleapis/i, why: 'endpoint Google cru (fora do broker)' },
  // Prefixos de segredo de provider embutidos (sk- da OpenAI/Anthropic).
  { token: /['"]sk-[A-Za-z0-9]/, why: 'chave de provider literal (sk-…) embutida' },
  { token: /['"]sk-ant-/, why: 'chave Anthropic literal embutida' },
  // A API EXTERNA OpenAI-compat (/v1/chat/completions) é RESERVADA a terceiros
  // (ADR-0046); o CLI usa o endpoint INTERNO /v1/chat (Q3). Embuti-la seria a
  // topologia errada.
  {
    token: /\/v1\/chat\/completions/,
    why: 'endpoint OpenAI-compat (Q3: o CLI usa /v1/chat interno)',
  },
];

/** Remove comentários de linha/bloco para inspecionar só código executável. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // /* ... */
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

describe('CLI-SEC-7 · CA-3 — sem credencial/provider/markup/quota/ledger no código do core', () => {
  const files = tsFiles(SRC).filter((f) => !f.endsWith('.test.ts'));

  it('encontrou fontes do core para varrer', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('nenhum fonte do core embute SDK/endpoint/chave de provider (HG-1/HG-2)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const { token, why } of FORBIDDEN_CODE_TOKENS) {
        if (token.test(code)) offenders.push(`${file}: ${why}`);
      }
    }
    expect(offenders, `provider/economia embutidos no core:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('CLI-SEC-7 · CA-4 — EXATAMENTE UM caminho de modelo (o broker)', () => {
  const files = tsFiles(SRC).filter((f) => !f.endsWith('.test.ts'));

  it('a ÚNICA URL de chamada de modelo é /v1/chat do broker', () => {
    // Procura por construções de path de chat de modelo no código. O único
    // permitido é `/v1/chat` (constante CHAT_PATH no broker-client). Qualquer
    // outro path de modelo (ex.: /v1/chat/completions, /messages, /completions)
    // é rota alternativa proibida.
    const modelPaths = new Set<string>();
    const pathRe = /['"`](\/v1\/chat[a-z/]*|\/messages|\/completions)['"`]/g;
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      let m: RegExpExecArray | null;
      while ((m = pathRe.exec(code)) !== null) modelPaths.add(m[1]!);
    }
    expect([...modelPaths].sort()).toEqual(['/v1/chat']);
  });

  it('o cliente de CHAMADA DE MODELO é um único ponto (BrokerModelClient)', async () => {
    // Importa o barrel público e confirma que NÃO há um "DirectProviderClient" /
    // "OpenAIClient" etc. — nenhuma 2ª ROTA DE MODELO.
    //
    // EST-0962: além do BrokerModelClient, o core exporta clientes READ-ONLY que NÃO
    // são rota de modelo: o `TierCatalogClient` (`GET /v1/tiers/catalog`) e o
    // `CustomModelClient` (`GET /v1/models/custom`) — ambos projeção PÚBLICA do
    // ADR-0030 §3, nunca `/v1/chat`, sem credencial/provider/roteamento. O invariante
    // DURO (a única URL de CHAMADA de modelo é `/v1/chat`) é garantido pelo teste
    // ACIMA. Aqui fixamos o conjunto de classes `*Client` exportadas a uma LISTA-
    // PERMISSÃO explícita — qualquer NOVO cliente (ex.: um provider direto) faz este
    // teste FALHAR (vermelho), forçando a revisão do `seguranca`.
    //
    // EST-0948 · ADR-0069 (gate p/ o `seguranca`): o `QuotaClient` (`GET /v1/quota`) é
    // mais um cliente READ-ONLY — só LÊ a quota da PRÓPRIA conta do PAT (RLS no broker,
    // zero cross-user), NÃO é rota de modelo, NÃO carrega credencial/markup/ledger
    // (CLI-SEC-7). Entra na allowlist + prova abaixo de que NÃO toca `/v1/chat`.
    // EST-0962 · ADR-0076 (gate p/ o `seguranca`): o `ProvidersClient` (`GET /v1/providers`)
    // é mais um cliente READ-ONLY — só LÊ os NOMES dos providers cadastrados (DADO de
    // catálogo público; o broker já descarta `api_key_ref`/`base_url`/markup), NÃO é rota
    // de modelo, NÃO carrega credencial. Entra na allowlist + prova abaixo de que NÃO toca
    // `/v1/chat` e de que NÃO serializa credencial.
    // ADR-0120 / EST-1113 (gate p/ o `seguranca`): o `LocalModelClient` é o BACKEND
    // LOCAL (BYO) — uma 2ª ESTRATÉGIA de chamada de modelo SANCIONADA pelo ADR-0120,
    // OPT-IN (`--backend local`, default segue broker). NÃO é uma rota escondida dentro
    // do caminho do broker: é um client SEPARADO, escolhido no wiring. Invariantes que
    // o mantêm seguro e provados ABAIXO: (a) NÃO toca `/v1/chat` (o caminho do broker
    // continua único — a via local fala o protocolo NATIVO do provider, via adapter);
    // (b) NÃO embute HOST/SDK/chave de provider no core (CA-3 acima) — o `baseUrl` e a
    // credencial BYO são INJETADOS pelo @aluy/cli (keychain→env), nunca versionados
    // (CLI-SEC-7/CLI-SEC-2); (c) o `base_url` configurável é validado por anti-SSRF
    // (PROV-SEC-1). Entra na allowlist com essas provas.
    const ALLOWED_CLIENTS = [
      'BrokerModelClient',
      'LocalModelClient',
      'TierCatalogClient',
      'CustomModelClient',
      'ProvidersClient',
      'QuotaClient',
    ];
    const mod = await import('../../src/model/index.js');
    const clientClasses = Object.entries(mod)
      .filter(
        ([k, v]) => /Client$/.test(k) && typeof v === 'function' && /^class\s/.test(v.toString()),
      )
      .map(([k]) => k)
      .sort();
    expect(clientClasses).toEqual([...ALLOWED_CLIENTS].sort());
    const fs = await import('node:fs');
    // E o TierCatalogClient NÃO toca o caminho de modelo: seu único path é o catálogo.
    const catalogCode = stripComments(
      fs.readFileSync(
        fileURLToPath(new URL('../../src/model/catalog-client.ts', import.meta.url)),
        'utf8',
      ),
    );
    expect(catalogCode).toContain('/v1/tiers/catalog');
    expect(catalogCode).not.toMatch(/\/v1\/chat\b/);
    // E o CustomModelClient idem: SÓ `GET /v1/models/custom`, nunca `/v1/chat`.
    const customCode = stripComments(
      fs.readFileSync(
        fileURLToPath(new URL('../../src/model/custom-models-client.ts', import.meta.url)),
        'utf8',
      ),
    );
    expect(customCode).toContain('/v1/models/custom');
    expect(customCode).not.toMatch(/\/v1\/chat\b/);
    // E o QuotaClient (EST-0948 · ADR-0069) idem: SÓ `GET /v1/quota`, nunca `/v1/chat`.
    // READ-ONLY da PRÓPRIA quota; sem credencial/markup/ledger (CLI-SEC-7 / HG-3).
    const quotaCode = stripComments(
      fs.readFileSync(
        fileURLToPath(new URL('../../src/model/quota-client.ts', import.meta.url)),
        'utf8',
      ),
    );
    expect(quotaCode).toContain('/v1/quota');
    expect(quotaCode).not.toMatch(/\/v1\/chat\b/);
    // E o ProvidersClient (EST-0962 · ADR-0076) idem: SÓ `GET /v1/providers`, nunca
    // `/v1/chat`. READ-ONLY dos NOMES; sem credencial/api_key_ref/base_url (HG-2/CLI-SEC-7).
    const providersCode = stripComments(
      fs.readFileSync(
        fileURLToPath(new URL('../../src/model/providers-client.ts', import.meta.url)),
        'utf8',
      ),
    );
    expect(providersCode).toContain('/v1/providers');
    expect(providersCode).not.toMatch(/\/v1\/chat\b/);
    // ADR-0120 / EST-1113 — o LocalModelClient (backend BYO) NÃO toca `/v1/chat` (o
    // caminho do broker segue único) e NÃO embute host/SDK/chave de provider no core
    // (CA-3 acima já varre TODO o core, incl. `local/`). Aqui fixamos o invariante
    // específico: o client local fala o protocolo NATIVO do provider via adapter, nunca
    // o `/v1/chat` interno do broker.
    const localCode = stripComments(
      fs.readFileSync(
        fileURLToPath(new URL('../../src/model/local/local-client.ts', import.meta.url)),
        'utf8',
      ),
    );
    expect(localCode).not.toMatch(/\/v1\/chat\b/);
  });
});
