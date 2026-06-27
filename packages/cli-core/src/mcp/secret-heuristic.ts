// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — HEURÍSTICA: este `--env K=V` carrega um
// SEGREDO LITERAL?
//
// A regra "o mcp.json NÃO carrega segredo literal" (config.ts §SEGREDO / CLI-SEC-7) é
// PRESERVADA: `aluy mcp add --env K=V` é a porta de escrita da config, e aqui
// detectamos (heuristicamente) quando o VALOR parece um segredo embutido — p/ AVISAR
// o usuário a usar uma REFERÊNCIA (`--env K=$MINHA_VAR` resolvida pelo ambiente do
// usuário no spawn) em vez do segredo cru. NÃO bloqueamos (a config é DADO do usuário,
// o ato é dele): avisamos, alto recall, fail-safe — um falso-positivo custa um aviso a
// mais; um segredo cru gravado no `mcp.json` (arquivo versionável/legível) é o que
// queremos flagrar.
//
// PORTÁVEL: regex/string puro, sem I/O nem `node:*`.

/** Por que um valor de env foi marcado como "parece segredo" (p/ a mensagem). */
export type SecretSignal =
  | 'secret-key-name' // a CHAVE tem nome de segredo (API_KEY, TOKEN, SECRET, PASSWORD…)
  | 'high-entropy'; // o VALOR parece uma credencial (longo, alto-entropia/base64-ish)

/** Resultado da inspeção de UM par `K=V` do `--env`. */
export interface SecretInspection {
  /** `true` ⇒ o valor parece um segredo literal — a UX avisa (não bloqueia). */
  readonly looksLikeSecret: boolean;
  /** Sinais que dispararam (vazio quando não parece segredo). */
  readonly signals: readonly SecretSignal[];
}

// Nomes de CHAVE que tipicamente carregam credencial. Casa como SUBSTRING (case-insensitive)
// p/ pegar prefixos/sufixos (GITHUB_TOKEN, MY_API_KEY, DB_PASSWORD, …). Alto recall.
const SECRET_KEY_PARTS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'access_key',
  'accesskey',
  'private_key',
  'privatekey',
  'credential',
  'auth',
];

// Uma REFERÊNCIA (não é segredo literal): `$VAR`, `${VAR}`, `%VAR%`. Estas formas são
// o caminho RECOMENDADO — o valor real é resolvido do ambiente do usuário no spawn, e o
// `mcp.json` guarda só o NOME da variável. Nunca avisamos sobre elas.
const ENV_REFERENCE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$|^%[A-Za-z_][A-Za-z0-9_]*%$/;

/**
 * Heurística de alto-entropia: valor LONGO sem espaços, dominado por caracteres de
 * credencial (alfanumérico + `-_+/=.`), com mistura de classes (maiúscula+minúscula+
 * dígito) OU bem longo. Pega chaves tipo `sk-...`, base64, hex longo, JWT. Conservadora
 * o suficiente p/ não marcar palavras comuns ("production", "/usr/local/bin").
 */
function looksHighEntropy(value: string): boolean {
  if (value.length < 20) return false; // segredos curtos são raros; evita falso-positivo.
  if (/\s/.test(value)) return false; // frase com espaço ⇒ não é credencial.
  // Caminho de filesystem comum (começa com / ou ./ ou ~/): não é segredo.
  if (/^[~./]/.test(value)) return false;
  // Só caracteres de "credencial"? (sem isso, é texto livre).
  if (!/^[A-Za-z0-9_\-+/=.]+$/.test(value)) return false;
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  const classes = (hasUpper ? 1 : 0) + (hasLower ? 1 : 0) + (hasDigit ? 1 : 0);
  // Mistura de classes (típico de chave gerada) OU muito longo (hex/base64 puro).
  return classes >= 2 || value.length >= 32;
}

/** A CHAVE tem nome de segredo? (substring, case-insensitive). */
function keyLooksSecret(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PARTS.some((part) => k.includes(part));
}

/**
 * Inspeciona UM par `K=V` do `--env`: o valor parece um segredo LITERAL? Avisa (não
 * bloqueia). Uma REFERÊNCIA (`$VAR`/`${VAR}`/`%VAR%`) NUNCA é segredo (é o caminho
 * recomendado). Caso contrário, marca se a CHAVE tem nome de segredo OU se o VALOR é
 * alto-entropia (parece credencial). Puro/determinístico, sem I/O.
 */
export function inspectEnvSecret(key: string, value: string): SecretInspection {
  // Referência explícita (forma recomendada) ⇒ nunca é segredo literal.
  if (ENV_REFERENCE.test(value.trim())) {
    return { looksLikeSecret: false, signals: [] };
  }
  const signals: SecretSignal[] = [];
  // Chave com nome de segredo só conta como sinal se o valor NÃO está vazio (uma chave
  // `API_KEY=""` é um placeholder, não um segredo gravado).
  if (value.length > 0 && keyLooksSecret(key)) signals.push('secret-key-name');
  if (looksHighEntropy(value)) signals.push('high-entropy');
  return { looksLikeSecret: signals.length > 0, signals };
}
