// EST-0960b · ADR-0056 R9 / CLI-SEC-6 — REDAÇÃO de segredos numa LINHA DE COMANDO.
//
// A barreira não-reversível (`run_command`) guarda o COMANDO EXATO na pilha (a
// 0960a precisa dele p/ a 0960b dizer "aqui rodou `<cmd>` — não desfeito"). Mas
// esse comando pode conter um SEGREDO na linha — `curl -H "Authorization: Bearer
// sk-…"`, `--password …`, `?token=…`, `AWS_SECRET_ACCESS_KEY=…`. R9 (gate FORTE
// do `seguranca`, AG-0008): o aviso de barreira NÃO pode despejar esse token em
// claro na TUI/feedback. Esta função é a redação de CLI-SEC-6 aplicada à linha de
// comando ANTES de exibir.
//
// PORTÁVEL (ADR-0053 §8): pura, sem `node:*`, sem I/O. Mora no cli-core (mecânica
// de segurança reutilizável); a UX de `/undo` (@hiperplano/aluy-cli) a consome no aviso.
//
// FILOSOFIA (fail-safe, conservadora): preferimos redigir DEMAIS a vazar. O
// objetivo é IDENTIFICAR a barreira ("rodou um curl"), não reproduzir o comando
// fielmente. Quando em dúvida, o segredo vira `‹redigido›`.

/** O marcador que substitui um segredo redigido (visível, não-segredo). */
export const REDACTED = '‹redigido›';

/**
 * Padrões de segredo numa linha de comando. Cada um casa a PARTE sensível e a
 * troca por `REDACTED`, preservando a forma do flag/chave em volta (p/ o aviso
 * ainda dizer "tinha um -H Authorization", sem o valor). Ordem importa: os mais
 * específicos (Bearer, headers) antes dos genéricos (token=, KEY=).
 */
interface SecretRule {
  readonly re: RegExp;
  /** Reescreve a captura mantendo o rótulo e redigindo o valor. */
  readonly replace: (m: RegExpMatchArray) => string;
}

const RULES: readonly SecretRule[] = [
  // Authorization: Bearer <token>  /  Authorization: Basic <b64>  (com ou sem aspas)
  {
    re: /\b(Authorization\s*:\s*)(Bearer|Basic|Token)\s+([^\s"'`]+)/gi,
    replace: (m) => `${m[1]}${m[2]} ${REDACTED}`,
  },
  // -H "Authorization: Bearer <token>"  — o header inteiro como UM arg entre aspas.
  {
    re: /(-H\s+["'])(Authorization\s*:\s*)(Bearer|Basic|Token)\s+([^"']+)(["'])/gi,
    replace: (m) => `${m[1]}${m[2]}${m[3]} ${REDACTED}${m[5]}`,
  },
  // -H "<header-de-segredo>: <valor>"  — headers sensíveis além de Authorization
  // (x-api-key, x-auth-token, api-key, x-amz-security-token, proxy-authorization).
  // O rótulo do header fica; o VALOR vira REDACTED. Cobre aspas e header solto.
  {
    re: /(-H\s+["'])((?:x-api-key|x-auth-token|api-key|x-amz-security-token|x-access-token|proxy-authorization)\s*:\s*)([^"']+)(["'])/gi,
    replace: (m) => `${m[1]}${m[2]}${REDACTED}${m[4]}`,
  },
  {
    re: /\b((?:x-api-key|x-auth-token|api-key|x-amz-security-token|x-access-token|proxy-authorization)\s*:\s*)([^\s"'`]+)/gi,
    replace: (m) => `${m[1]}${REDACTED}`,
  },
  // --header Authorization=...  (forma `=` de header)
  {
    re: /(--header[=\s]+["']?Authorization\s*[:=]\s*)(Bearer|Basic|Token)?\s*([^\s"'`]+)/gi,
    replace: (m) => `${m[1]}${m[2] ? m[2] + ' ' : ''}${REDACTED}`,
  },
  // FLAG CURTA DE SENHA COLADA: `-p<senha>` (mysql/psql/mysqldump -pHunter2).
  // O valor gruda no flag, sem `=` nem espaço — a regra genérica abaixo (que exige
  // separador) não pega. Tem de vir ANTES dela.
  //   • `(?<![\w-])` — o `-p` tem de COMEÇAR um token (precedido de branco/início,
  //     não de letra/hífen): evita casar o `-p` dentro de `sk-proj-…`/`my-prop`.
  //   • `(?=\S)(?!=)` — exige ≥1 char não-branco colado (não casa `-p` solo, que o
  //     teste "nunca lança" cobre) e não casa a forma `-p=…` (cai na genérica).
  {
    re: /(?<![\w-])(-p)(?=\S)(?!=)([^\s"'`]+)/g,
    replace: (m) => `${m[1]}${REDACTED}`,
  },
  // `-u user:senha` (curl HTTP basic): redige só a SENHA após o `:`, mantendo o
  // usuário. `-u user` (sem `:senha`) não casa — fica intacto.
  {
    re: /(-u\s+["']?[^\s:"'`]+:)([^\s"'`]+)/g,
    replace: (m) => `${m[1]}${REDACTED}`,
  },
  // flags de senha/token/segredo/chave-de-api: --password=… / --token … / -p … (longos)
  {
    re: /(--?(?:password|passwd|pass|token|secret|api[-_]?key|apikey|auth[-_]?token|access[-_]?token|client[-_]?secret|key)(?:[=\s]+))(["']?)([^\s"'`]+)(\2)/gi,
    replace: (m) => `${m[1]}${m[2]}${REDACTED}${m[4]}`,
  },
  // env-inline:  AWS_SECRET_ACCESS_KEY=…  GITHUB_TOKEN=…  OPENAI_API_KEY=…  PASSWORD=…
  // F22 (dogfooding) — `i`: o nome do env ZERA o case. Sem ele, só MAIÚSCULO redigia e
  // `aws_secret_access_key=`/`password=`/`client_secret=` MINÚSCULOS VAZAVAM ao modelo+
  // transcript (CLI-SEC-6). Os IRMÃOS (flag `--password`, query `?token=`) já são `/gi`;
  // isto só fecha a inconsistência. Fail-safe: over-redigir (ex.: `max_tokens=`, que o
  // MAIÚSCULO já redige) é preferível a vazar segredo.
  // F106 — tolera ESPAÇOS ao redor do `=` (`[ \t]*=[ \t]*`): o formato `~/.aws/credentials`
  // (`aws_secret_access_key = …`), INI e `export VAR = …` usam ` = ` com espaço — antes o
  // `=` colado NÃO casava ⇒ o segredo do arquivo de credenciais VAZAVA. `[ \t]` (não `\s`)
  // p/ não cruzar quebras de linha. O separador é capturado (grupo 2) e preservado no replace.
  {
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*)([ \t]*=[ \t]*)([^\s"'`]+)/gi,
    replace: (m) => `${m[1]}${m[2]}${REDACTED}`,
  },
  // segredo embutido numa URL de query: ?token=…  &api_key=…  &access_token=…
  {
    re: /([?&](?:token|api[-_]?key|apikey|access[-_]?token|auth|key|secret|password)=)([^\s"'`&]+)/gi,
    replace: (m) => `${m[1]}${REDACTED}`,
  },
  // userinfo em URL:  https://user:senha@host  → redige a senha
  {
    re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi,
    replace: (m) => `${m[1]}${REDACTED}${m[3]}`,
  },
  // tokens de provider reconhecíveis "nus" (sem flag), como rede de segurança:
  //   sk-… (OpenAI/Anthropic), gh[oprsu]_…/github_pat_… (GitHub: personal/oauth/REFRESH/
  //   server/user — F107 adicionou `ghr_` ao conjunto), xox[baprs]-… (Slack), AKIA…/ASIA…
  //   (AWS access key id — F107 adicionou o `ASIA` das credenciais TEMPORÁRIAS/STS, mesma
  //   forma+risco do AKIA), eyJ… JWT longo.
  // F105 — a classe do `sk-` inclui `_` (`[A-Za-z0-9_-]`): os formatos ATUAIS dos dois
  // providers BYO usam base64url COM `_` — OpenAI `sk-proj-…_…`, Anthropic `sk-ant-api03-…_…`.
  // Com a classe antiga `[A-Za-z0-9-]` (sem `_`), o run parava no `_` E o `\b` final NÃO
  // casava (o `_` é word-char) ⇒ o regex FALHAVA INTEIRO e a chave NUA vazava POR COMPLETO
  // (CLI-SEC-6). `_` na classe ⇒ casa a chave inteira até o `\b` real (espaço/aspas).
  {
    re: /\b(sk-[A-Za-z0-9_-]{16,}|gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    replace: () => REDACTED,
  },
  // MAIS tokens "nus" de provider (MESMA rede de segurança; formatos comuns de alto
  // valor que a regra acima NÃO cobria — achados por probe de redação). Vazavam à
  // TUI E ao modelo quando caíam na SAÍDA de um comando (`echo`/`env`/log). Prefixos
  // DISTINTIVOS + comprimento fixo ⇒ falso-positivo baixíssimo; filosofia fail-safe
  // (redigir demais > vazar). NOTA: `sk_live_`/`sk_test_` usam `_` (a regra `sk-` do
  // OpenAI exige `-`, então NÃO os pegava). `pk_`/`pk_live_` são PUBLICÁVEIS (não-
  // segredo) e por isso NÃO entram aqui — só `sk_`/`rk_` (secret/restricted).
  //   Google API key (AIza…39), Google OAuth (ya29.…), Stripe (sk_/rk_ live|test),
  //   GitLab PAT (glpat-…), npm (npm_…36), Slack app-level (xapp-…). O `xapp-` é
  //   distinto do `xox[baprs]-` da regra de cima (que é bot/user/etc.) — o gate de
  //   segurança (AG-0008) apontou a falta. Mesma rede aditiva fail-safe.
  {
    re: /\b(AIza[0-9A-Za-z_-]{35,}|ya29\.[0-9A-Za-z_-]{20,}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}|glpat-[0-9A-Za-z_-]{20,}|npm_[0-9A-Za-z]{36,}|xapp-[0-9A-Za-z-]{10,})\b/g,
    replace: () => REDACTED,
  },
  // F106 — MAIS prefixos distintivos de alto valor do ecossistema de modelos/IA, que a
  // varredura de redação achou vazando nus: HuggingFace (`hf_…`) e Replicate (`r8_…`).
  // Mesma rede aditiva fail-safe (prefixo + comprimento ⇒ falso-positivo baixíssimo).
  {
    re: /\b(hf_[0-9A-Za-z]{20,}|r8_[0-9A-Za-z]{30,})\b/g,
    replace: () => REDACTED,
  },
  // F107 — MAIS prefixos distintivos de alto valor que a varredura de redação achou
  // vazando nus na SAÍDA de comando (env/log/dump de config): SendGrid (`SG.<22>.<43>` —
  // estrutura de DOIS pontos, inconfundível), Stripe webhook signing (`whsec_…`), Doppler
  // (`dp.pt.…`), Linear (`lin_api_…`). Mesma rede aditiva fail-safe (prefixo DISTINTIVO +
  // comprimento ⇒ falso-positivo baixíssimo; redigir demais > vazar). NÃO incluímos o
  // Twilio `SK<32hex>`: o prefixo `SK` de 2 letras é genérico demais (alto FP).
  {
    re: /\b(SG\.[\w-]{20,}\.[\w-]{40,}|whsec_[0-9A-Za-z]{20,}|dp\.pt\.[0-9A-Za-z]{20,}|lin_api_[0-9A-Za-z]{20,})\b/g,
    replace: () => REDACTED,
  },
  // BLOCO PEM de CHAVE PRIVADA (multi-linha) — segredo top-tier (SSH `id_rsa`,
  // service-account, chave TLS). Um `cat ~/.ssh/id_rsa`/dump de config na SAÍDA de
  // comando vazaria a chave INTEIRA; as regras acima são single-line por prefixo e
  // NÃO pegam o bloco. O gate AG-0008 apontou a falta. Casa do `-----BEGIN … PRIVATE
  // KEY-----` ao `-----END … PRIVATE KEY-----` (RSA/EC/OPENSSH/DSA/genérica/encrypted),
  // non-greedy. NOTA STREAMING: como `redactOutputSecrets` roda por-chunk E no agregado
  // final, um bloco partido entre chunks só é pego no AGREGADO (a porta junta por linha;
  // o corpo final é re-redigido) — mesma limitação já documentada dos segredos intra-linha.
  // Marcador público (`PUBLIC KEY`) NÃO casa (exige `PRIVATE`). Idempotente.
  {
    // ⚠ ANTI-ReDoS (gate AG-0008): o corpo é `(?:(?!-----BEGIN)[\s\S])*?` — NÃO o
    // `[\s\S]*?` ingênuo. `redactOutputSecrets` roda SÍNCRONO na thread principal sobre
    // saída NÃO-CONFIÁVEL (run_command/web-fetch/MCP); com `[\s\S]*?` um input com muitos
    // `-----BEGIN … PRIVATE KEY-----` SEM `END` causa backtracking O(n²) (medido: 1MB→~15s
    // travando a TUI) = DoS. O `(?!-----BEGIN)` faz um BEGIN-sem-END falhar LOCALMENTE em
    // vez de varrer até o EOF ⇒ LINEAR (80k BEGINs sem END < 50ms). Duas chaves adjacentes
    // seguem ambas redigidas (o tempering não funde uma na outra).
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:(?!-----BEGIN)[\s\S])*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
    replace: () => REDACTED,
  },
];

/**
 * Redige segredos de uma LINHA DE COMANDO (CLI-SEC-6 / R9). Aplica cada regra em
 * sequência. Determinística e idempotente (rodar 2× não muda o resultado — o
 * marcador `REDACTED` já não casa nenhum padrão de segredo). Nunca lança.
 *
 * @returns o comando com os segredos trocados por `REDACTED` — seguro p/ exibir
 *          na TUI/feedback do aviso de barreira.
 */
export function redactCommandSecrets(command: string): string {
  let out = command;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => {
      // String.replace passa (match, ...groups, offset, fullString); montamos um
      // RegExpMatchArray-like p/ o `replace` da regra (índices 0..n = grupos).
      const groups = args.slice(0, -2) as string[];
      return rule.replace(groups as unknown as RegExpMatchArray);
    });
  }
  return out;
}

/**
 * EST-0982 · CLI-SEC-6 — REDIGE segredos da SAÍDA (stdout/stderr) de um comando
 * ANTES de virar observação/render. A saída de um comando pode despejar token/senha
 * (`echo $GITHUB_TOKEN`, um `env`, um log com `Authorization: Bearer …`); como o
 * streaming mostra a saída AO VIVO e a observação a realimenta ao modelo, ela passa
 * pela MESMA redação de CLI-SEC-6 que o comando — a mesma fonte de verdade (`RULES`),
 * sem regra divergente. Aplicada por CHUNK (no streaming) e ao corpo final (na
 * coleta): idempotente, então redigir o chunk e de novo o agregado não muda nada.
 *
 * Por ser por-chunk, um segredo que caia ASTRADO entre dois chunks pode escapar à
 * regra (o split de buffer parte o token). Fail-safe da porta concreta: ela junta a
 * saída por LINHA antes de emitir o chunk (segredos são intra-linha), reduzindo o
 * risco; e o corpo final agregado é redigido de novo. É a MESMA filosofia
 * conservadora de `redactCommandSecrets` (preferir redigir demais a vazar).
 *
 * @returns a saída com os segredos trocados por `REDACTED` — segura p/ exibir/realimentar.
 */
export function redactOutputSecrets(output: string): string {
  return redactCommandSecrets(output);
}
