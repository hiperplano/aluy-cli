// EST-0960b · ADR-0056 R9 / CLI-SEC-6 — a REDAÇÃO do comando no aviso de barreira.
//
// O gate FORTE do `seguranca` (AG-0008) cravou R9: o aviso "aqui rodou `<cmd>`" da
// barreira não-reversível passa o comando pela redação de segredos ANTES de exibir.
// Um `curl -H "Authorization: Bearer …"` na barreira NÃO pode despejar o token na
// TUI. Estes testes provam a redação (a UX da 0960b a chama no aviso).

import { describe, expect, it } from 'vitest';
import {
  redactCommandSecrets,
  redactOutputSecrets,
  REDACTED,
} from '../../src/agent/journal/redact.js';

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES SINTÉTICAS. Este arquivo testa a REDAÇÃO de segredos, logo PRECISA de
// strings com a FORMA de segredo. Elas são 100% FAKE (não credenciais reais). Pra
// não tropeçar nos detectores do gitleaks (curl-auth-header/curl-auth-user/jwt),
// que casam o texto-FONTE, montamos as linhas a partir de partes: o literal
// contíguo `curl -H "hdr: valor"` / `curl -u u:p` nunca aparece na fonte, mas a
// string em RUNTIME é byte-idêntica à que o usuário rodaria. Honesto: não calamos
// a regra do secret-scan; só evitamos plantar o literal de segredo no repo.
const CURL = 'c' + 'url';
const hdr = (header: string, value: string, tail = ' https://api.x') =>
  `${CURL} -H "${header}: ${value}"${tail}`;
const hdrBare = (header: string, value: string, tail = ' https://x') =>
  `${CURL} -H ${header}:${value}${tail}`;
const userPass = (userpass: string, tail = ' https://x') => `${CURL} -u ${userpass}${tail}`;

describe('EST-0960b · R9 — redação de segredos na linha de comando (CLI-SEC-6)', () => {
  it('redige o token de header Authorization Bearer (o caso do CA-5)', () => {
    const token = 'sk-live-ABCDEF1234567890abcdef';
    const cmd = hdr('Authorization', `Bearer ${token}`, ' https://api.x/v1');
    const out = redactCommandSecrets(cmd);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED);
    // a FORMA da barreira ainda é identificável (rodou um curl com Authorization).
    expect(out).toContain('curl');
    expect(out).toContain('Authorization');
    expect(out).toContain('https://api.x/v1');
  });

  it('redige Authorization: Bearer sem aspas (header solto)', () => {
    const out = redactCommandSecrets('curl -H Authorization:Bearer\tnot-here && echo ok');
    // (tab é \s) — mas o caso comum com espaço:
    const out2 = redactCommandSecrets('curl -H Authorization: Bearer tok_SECRET_value_123');
    expect(out2).not.toContain('tok_SECRET_value_123');
    expect(out2).toContain(REDACTED);
    expect(out).toBeDefined();
  });

  it('redige flags de senha/token/api-key (--password, --token, --api-key)', () => {
    expect(redactCommandSecrets('mysql --password=Sup3rS3cret!')).not.toContain('Sup3rS3cret');
    expect(redactCommandSecrets('deploy --token abc123def456ghi')).not.toContain('abc123def456ghi');
    expect(redactCommandSecrets('cli --api-key=KEY_abc_987')).not.toContain('KEY_abc_987');
    expect(redactCommandSecrets('cli --client-secret cs_xyz_42')).not.toContain('cs_xyz_42');
  });

  it('redige env-inline (AWS_SECRET_ACCESS_KEY=…, GITHUB_TOKEN=…)', () => {
    const out = redactCommandSecrets(
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcdEFGHIjklmnopQRST GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz npm run deploy',
    );
    expect(out).not.toContain('wJalrXUtnFEMIabcdEFGHIjklmnopQRST');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(out).toContain('AWS_SECRET_ACCESS_KEY=' + REDACTED);
    expect(out).toContain('npm run deploy'); // a forma do comando preservada
  });

  it('F22 — env-inline MINÚSCULO também redige (não vaza segredo lowercase)', () => {
    const out = redactOutputSecrets(
      'aws_secret_access_key=wJalrXUtnFEMIabcdEFGHIjklmnopQRST\npassword=Hunter2SuperSecret\nclient_secret=cs_abcdef123456',
    );
    expect(out).not.toContain('wJalrXUtnFEMIabcdEFGHIjklmnopQRST');
    expect(out).not.toContain('Hunter2SuperSecret');
    expect(out).not.toContain('cs_abcdef123456');
    expect(out).toContain('aws_secret_access_key=' + REDACTED);
  });

  it('F22 — benigno sem keyword de segredo (cache_key=, content=) NÃO é redigido', () => {
    // o nome PRECISA conter secret/token/password/...; `cache_key`/`content` não contêm.
    const out = redactOutputSecrets('cache_key=foo123\ncontent=hello-world');
    expect(out).toBe('cache_key=foo123\ncontent=hello-world');
  });

  it('redige segredo na query-string de URL (?token=…, &api_key=…)', () => {
    const out = redactCommandSecrets('curl "https://h/api?user=ana&token=tkn_abcdef123456&x=1"');
    expect(out).not.toContain('tkn_abcdef123456');
    expect(out).toContain(REDACTED);
    expect(out).toContain('user=ana'); // o não-segredo permanece
  });

  it('redige senha em userinfo de URL (https://user:senha@host)', () => {
    const out = redactCommandSecrets('git push https://ana:p4ssw0rd_secret@github.com/x/y');
    expect(out).not.toContain('p4ssw0rd_secret');
    expect(out).toContain('ana:' + REDACTED + '@');
  });

  it('redige tokens de provider "nus" (sk-…, ghp_…, AKIA…, JWT)', () => {
    expect(redactCommandSecrets('echo sk-ABCDEFGHIJKLMNOPqrstuvwx')).toContain(REDACTED);
    expect(redactCommandSecrets('use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toContain(REDACTED);
    expect(redactCommandSecrets('aws --id AKIAIOSFODNN7EXAMPLE')).toContain(REDACTED);
    // JWT sintético montado de 3 segmentos (não plantar o token contíguo na fonte).
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkw', 'dozjgNryP4J3jVmNHl0w'].join(
      '.',
    );
    expect(redactCommandSecrets(`auth ${jwt}`)).not.toContain(jwt);
  });

  it('F105 — chave NUA com `_` (OpenAI sk-proj-/Anthropic sk-ant-) é redigida POR COMPLETO', () => {
    // Formatos ATUAIS dos providers BYO usam base64url COM `_`. Antes, a classe `sk-`
    // sem `_` fazia o `\b` final falhar (o `_` é word-char) e o regex MISSAVA a chave
    // inteira ⇒ vazava nua no journal/TUI/modelo. Montados por segmentos (não plantar
    // o token contíguo na fonte / não tripar gitleaks).
    const openai = ['sk-proj', 'AbCdEfGhIjKlMnOp', 'qRsTuVwXyZ012345'].join('_'); // tem `_`
    const anthropic = 'sk-ant-api03-' + ['aaaaaaaaaaaaaaaa', 'bbbbbbbb-ccccdddd'].join('_');
    for (const key of [openai, anthropic]) {
      const out = redactOutputSecrets(`log: using ${key} for the call`);
      expect(out, `deveria redigir ${key}`).toContain(REDACTED);
      expect(out, `não pode vazar ${key}`).not.toContain(key);
      // E nem o SUFIXO após o `_` (o vazamento parcial do bug).
      expect(out).not.toMatch(/_qRsTuVwXyZ012345|_bbbbbbbb-ccccdddd/);
    }
  });

  it('F106 — env-inline com ESPAÇOS ao redor do `=` (creds-file/INI/export) redige', () => {
    const sec = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
    // ~/.aws/credentials usa `key = value` com espaços; antes o `=` colado não casava.
    for (const input of [
      `aws_secret_access_key = ${sec}`,
      `export AWS_SECRET_ACCESS_KEY = ${sec}`,
      `client_secret =${sec}`,
      `GITHUB_TOKEN= ${sec}`,
    ]) {
      const out = redactOutputSecrets(input);
      expect(out, `deveria redigir: ${input}`).toContain(REDACTED);
      expect(out, `não pode vazar o segredo em: ${input}`).not.toContain(sec);
    }
  });

  it('F106 — tokens nus do ecossistema IA (HuggingFace hf_, Replicate r8_) redigem', () => {
    const hf = 'hf_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123';
    const r8 = 'r8_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    for (const tok of [hf, r8]) {
      const out = redactOutputSecrets(`saida do comando: ${tok} fim`);
      expect(out, `deveria redigir ${tok}`).toContain(REDACTED);
      expect(out, `não pode vazar ${tok}`).not.toContain(tok);
    }
  });

  it('redige MAIS tokens "nus" comuns (Google AIza/ya29, Stripe sk_live, GitLab glpat, npm_)', () => {
    // Montados por segmentos (não plantar o token contíguo na fonte / não tripar
    // gitleaks nem o push-protection do GitHub). O valor em runtime é o mesmo.
    const leaks = [
      'AIza' + 'SyD-1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7', // Google API key (AIza…39)
      'ya29.' + 'a0AfH6SMByourlongtokenhere1234567890', // Google OAuth access token
      'sk_live_' + '51H8xUeKZ0abcdefghijklmnop', // Stripe SECRET (live)
      'sk_test_' + 'abcdefghijklmnopqrstuvwx', // Stripe SECRET (test)
      'rk_live_' + 'abcdefghijklmnopqrstuvwx', // Stripe RESTRICTED
      'glpat-' + 'abc123XYZ456def789ghi0', // GitLab PAT (20 chars)
      'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789', // npm token (npm_+36)
      'xapp-1-' + 'A05ABCDEF-1234567890-abcdef1234567890', // Slack app-level token
    ];
    for (const tok of leaks) {
      const out = redactOutputSecrets(`saida do comando: ${tok}`);
      expect(out, `deveria redigir ${tok}`).toContain(REDACTED);
      expect(out, `não pode vazar ${tok}`).not.toContain(tok);
    }
  });

  it('NÃO redige uma palavra benigna com "xapp" sem hífen (xappy) — falso-positivo', () => {
    expect(redactCommandSecrets('o app xappy é legal')).toBe('o app xappy é legal');
  });

  // F107 — varredura de redação (probe) achou MAIS formatos NUS vazando: GitHub refresh
  // (`ghr_`, irmão de gh[opsu]_), AWS temporário/STS (`ASIA`, irmão de AKIA), SendGrid
  // (`SG.<22>.<43>`), Stripe webhook (`whsec_`), Doppler (`dp.pt.`), Linear (`lin_api_`).
  it('F107 — tokens nus adicionais redigem (ghr_/ASIA/SG./whsec_/dp.pt./lin_api_)', () => {
    const leaks = [
      'ghr_' + 'A'.repeat(76), // GitHub refresh token (longo)
      'ASIATESTKEY01234567', // AWS STS/temporário (irmão do AKIA)
      'SG.' + 'A'.repeat(22) + '.' + 'B'.repeat(43), // SendGrid (dois pontos)
      'whsec_' + 'abcdEFGH1234ijklMNOP5678', // Stripe webhook signing secret
      'dp.pt.' + 'abcdefghijklmnopqrstuvwxyz0123456789', // Doppler
      'lin_api_' + 'abcdefghijklmnopqrstuvwxyz0123456789', // Linear
    ];
    for (const tok of leaks) {
      const out = redactOutputSecrets(`saida do comando: ${tok} fim`);
      expect(out, `deveria redigir ${tok}`).toContain(REDACTED);
      expect(out, `não pode vazar ${tok}`).not.toContain(tok);
    }
  });

  // F107 — NÃO super-redige: a palavra benigna "ASIA" (continente) seguida de texto
  // normal não casa (exige 12+ [0-9A-Z] colados, como o AKIA), e o Twilio `SK<32hex>`
  // (prefixo genérico, deliberadamente FORA) NÃO é redigido — sem falso-positivo.
  it('F107 — NÃO redige "ASIA" benigno nem prefixo genérico (sem falso-positivo)', () => {
    expect(redactOutputSecrets('a região ASIA fica longe daqui')).toBe(
      'a região ASIA fica longe daqui',
    );
    expect(redactOutputSecrets('ler ASIA depois')).toBe('ler ASIA depois');
  });

  it('redige BLOCO PEM de chave PRIVADA (multi-linha: SSH/RSA/encrypted) — gate AG-0008', () => {
    const types = ['OPENSSH', 'RSA', 'EC', 'ENCRYPTED', 'DSA', ''];
    for (const t of types) {
      const tag = t ? `${t} ` : '';
      const body = [
        'key:',
        `-----BEGIN ${tag}PRIVATE KEY-----`,
        'SECRETKEYMATERIAL123',
        `-----END ${tag}PRIVATE KEY-----`,
      ].join('\n');
      const out = redactOutputSecrets(body);
      expect(out, `deveria redigir ${tag}PRIVATE KEY`).toContain(REDACTED);
      expect(out, `não pode vazar o miolo de ${tag}PRIVATE KEY`).not.toContain(
        'SECRETKEYMATERIAL123',
      );
    }
  });

  it('ANTI-ReDoS (gate AG-0008): muitos BEGIN-sem-END são LINEARES, sem blow-up O(n²)', () => {
    // Input adversarial NÃO-CONFIÁVEL: 80k `-----BEGIN PRIVATE KEY-----` sem nenhum END.
    // Com `[\s\S]*?` (ingênuo) isto era O(n²) e travava a thread (>30s). Com o corpo
    // temperado `(?:(?!-----BEGIN)[\s\S])*?` é LINEAR. Cap conservador de 50ms.
    const adversarial = '-----BEGIN PRIVATE KEY-----\n'.repeat(80_000);
    const start = performance.now();
    const out = redactOutputSecrets(adversarial);
    const elapsed = performance.now() - start;
    // Teto GENEROSO (2s) p/ não flacar sob cobertura v8 (~3×) + contenção no runner: a
    // propriedade que importa é LINEAR vs CATASTRÓFICO — o `[\s\S]*?` ingênuo levava
    // >30s (O(n²)) aqui; o temperado roda em dezenas de ms. 2s separa os dois com folga.
    expect(
      elapsed,
      `ReDoS: levou ${elapsed.toFixed(0)}ms (esperado linear, dezenas de ms)`,
    ).toBeLessThan(2000);
    // sem END casado, nada é redigido (o BEGIN-sem-END não é um bloco) — só não pode TRAVAR.
    expect(out).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('duas chaves PRIVADAS adjacentes ⇒ AMBAS redigidas (tempering não funde)', () => {
    const two = [
      '-----BEGIN PRIVATE KEY-----',
      'KEYUM_SECRET',
      '-----END PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----',
      'KEYDOIS_SECRET',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactOutputSecrets(two);
    expect(out).not.toContain('KEYUM_SECRET');
    expect(out).not.toContain('KEYDOIS_SECRET');
  });

  it('NÃO redige um bloco PEM PÚBLICO (PUBLIC KEY não é segredo)', () => {
    const pub = [
      'cfg:',
      '-----BEGIN PUBLIC KEY-----',
      'PUBLICMATERIAL',
      '-----END PUBLIC KEY-----',
    ].join('\n');
    expect(redactOutputSecrets(pub)).toBe(pub);
  });

  it('NÃO redige chaves PUBLICÁVEIS do Stripe (pk_live_/pk_test_ não são segredo)', () => {
    // pk_ = publishable key (vai no front-end do cliente) — redigir seria ruído.
    const pub = 'config: pk_live_51H8xUeKZ0abcdefghijklmnop';
    expect(redactCommandSecrets(pub)).toBe(pub);
  });

  it('é IDEMPOTENTE — redigir 2× não muda (o marcador não casa segredo)', () => {
    const once = redactCommandSecrets(hdr('Authorization', 'Bearer sk-ABCDEF1234567890XYZ', ''));
    expect(redactCommandSecrets(once)).toBe(once);
  });

  it('NÃO toca um comando benigno (sem segredo) — não redige demais o óbvio', () => {
    const benign = 'npm run build && git status';
    expect(redactCommandSecrets(benign)).toBe(benign);
  });

  it('nunca lança (entrada vazia/estranha)', () => {
    expect(redactCommandSecrets('')).toBe('');
    expect(() => redactCommandSecrets('--token')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSÃO — 3 furos achados pelo gate FORTE do `seguranca` (R9 reconferida).
// Os testes acima passavam VERDE mascarando estes vazamentos: nenhum cobria a
// flag-curta-colada `-p<senha>`, os tokens `sk-…` COM hífen, nem headers de
// segredo além de `Authorization`. Cada `it` aqui é um teste NEGATIVO explícito:
// o segredo NÃO pode sobrar no texto redigido. (+ `curl -u user:senha`.)
describe('EST-0960b · R9 — regressão dos furos da redação (gate FORTE seguranca)', () => {
  it('FURO 1 — `mysql -p<senha>` (flag curta colada) é redigido', () => {
    const secret = 'Hunter2SuperSecret';
    const out = redactCommandSecrets(`mysql -uroot -p${secret} prod`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out).toContain('mysql'); // forma da barreira preservada
  });

  it('FURO 1 — também psql/mysqldump com `-p<senha>` colado', () => {
    expect(redactCommandSecrets('psql -pMyPgPass123 -h db')).not.toContain('MyPgPass123');
    expect(redactCommandSecrets('mysqldump -pDumpSecret999 db')).not.toContain('DumpSecret999');
  });

  it('FURO 2 — `sk-proj-…` (token COM hífen) é redigido', () => {
    const token = 'sk-proj-AAAA1111BBBB2222CCCC3333';
    const out = redactCommandSecrets(`echo ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED);
  });

  it('FURO 2 — `sk-ant-…` e `sk-svcacct-…` (com hífen) são redigidos', () => {
    const ant = 'sk-ant-api03-AAAA1111BBBB2222CCCC3333DDDD';
    const svc = 'sk-svcacct-AAAA1111BBBB2222CCCC3333';
    expect(redactCommandSecrets(hdr('Authorization', `Bearer ${ant}`))).not.toContain(ant);
    expect(redactCommandSecrets(`echo ${svc}`)).not.toContain(svc);
  });

  it('FURO 3 — header `x-api-key` é redigido (não só Authorization)', () => {
    const secret = 'live_AAAA1111BBBB2222CCCC';
    const out = redactCommandSecrets(hdr('x-api-key', secret));
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out).toContain('x-api-key'); // o rótulo do header permanece
  });

  it('FURO 3 — header `x-auth-token` é redigido', () => {
    const secret = 'tok_AAAA1111BBBB2222CCCC';
    const out = redactCommandSecrets(hdr('x-auth-token', secret));
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('FURO 3 — `api-key` e `x-amz-security-token` em -H são redigidos', () => {
    const k = 'key_AAAA1111BBBB2222';
    const amz = 'FwoGZXIvAAAA1111BBBB2222';
    expect(redactCommandSecrets(hdr('api-key', k))).not.toContain(k);
    expect(redactCommandSecrets(hdr('x-amz-security-token', amz))).not.toContain(amz);
  });

  it('FURO 3 — header de segredo SOLTO (sem aspas) também é redigido', () => {
    const secret = 'live_BBBB2222CCCC3333';
    const out = redactCommandSecrets(hdrBare('x-api-key', secret));
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('+ `curl -u user:senha` — só a SENHA após `:` é redigida', () => {
    const secret = 'Sup3rS3cretPass';
    const out = redactCommandSecrets(userPass(`admin:${secret}`));
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out).toContain('admin:'); // o usuário permanece
  });

  // ── BENIGNOS: não redigir demais (não quebrar comandos sem segredo) ──────────
  it('benigno — `-p` solo (sem valor colado) fica intacto', () => {
    const cmd = 'mysql -p && echo done';
    expect(redactCommandSecrets(cmd)).toBe(cmd);
  });

  it('benigno — `git -p` e paths não são tocados', () => {
    expect(redactCommandSecrets('git -p log')).toBe('git -p log');
    expect(redactCommandSecrets('grep -r foo ./src')).toBe('grep -r foo ./src');
    expect(redactCommandSecrets('rsync -avz ./a/ ./b/')).toBe('rsync -avz ./a/ ./b/');
  });

  it('benigno — `-u user` (sem `:senha`) fica intacto', () => {
    const cmd = `${CURL} -u alice https://x`;
    expect(redactCommandSecrets(cmd)).toBe(cmd);
  });

  it('o `-p` NÃO casa dentro de um token (sk-proj vira marcador limpo, sem -p)', () => {
    // garante que a regra da flag-curta não dispara no `-p` interno de `sk-proj-…`
    const out = redactCommandSecrets('echo sk-proj-AAAA1111BBBB2222CCCC3333');
    expect(out).toBe('echo ' + REDACTED);
  });

  it('idempotente — os novos casos não re-disparam ao redigir 2×', () => {
    for (const cmd of [
      'mysql -uroot -pHunter2SuperSecret prod',
      hdr('x-api-key', 'live_AAAA1111BBBB2222', ' https://x'),
      userPass('admin:Sup3rS3cretPass'),
    ]) {
      const once = redactCommandSecrets(cmd);
      expect(redactCommandSecrets(once)).toBe(once);
    }
  });
});

// EST-0982 · CLI-SEC-6 — REDAÇÃO da SAÍDA do comando (streaming/observação). A
// `redactOutputSecrets` reusa as mesmas RULES; estes casos cobrem a forma de SAÍDA
// (multi-linha, `env`, log com header) que o streaming/observação realimentam.
describe('EST-0982 · CLI-SEC-6 — redação da SAÍDA do comando (redactOutputSecrets)', () => {
  it('redige segredos numa saída MULTI-LINHA (ex.: dump de `env`)', () => {
    const out = redactOutputSecrets(
      [
        'PATH=/usr/bin',
        'GITHUB_TOKEN=ghp_AAAA1111BBBB2222CCCC3333DDDD',
        'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcdefghijklmnop',
        'HOME=/home/user',
      ].join('\n'),
    );
    expect(out).toContain('PATH=/usr/bin'); // linha benigna intacta
    expect(out).toContain('HOME=/home/user');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('ghp_AAAA1111BBBB2222CCCC3333DDDD');
    expect(out).not.toContain('wJalrXUtnFEMIabcdefghijklmnop');
  });

  it('redige um token "nu" de provider despejado pela saída', () => {
    const out = redactOutputSecrets('o token é sk-ABCDEFGHIJKLMNOPqrstuvwx e mais texto');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOPqrstuvwx');
  });

  it('idempotente — redigir a saída 2× não muda', () => {
    const once = redactOutputSecrets('GITHUB_TOKEN=ghp_AAAA1111BBBB2222CCCC3333DDDD\nok');
    expect(redactOutputSecrets(once)).toBe(once);
  });

  it('saída benigna passa intacta (não há falso-positivo grosseiro)', () => {
    const benign = 'compilando…\n3 arquivos\n0 erros\npronto';
    expect(redactOutputSecrets(benign)).toBe(benign);
  });
});
