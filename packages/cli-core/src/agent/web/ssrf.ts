// EST-0971 · CLI-SEC-13 — ANTI-SSRF: denylist DURA de IP + parsing de IP-literal.
//
// O coração de segurança das tools `web_fetch`/`web_search`. A ameaça é SSRF
// (Server-Side Request Forgery, aqui CLIENT-side mas idêntica): o modelo —
// manipulado por conteúdo injetado (CLI-SEC-4) — pede ao agente p/ buscar uma URL
// que aponta p/ um alvo INTERNO (metadata da cloud `169.254.169.254`, localhost,
// rede privada RFC1918, link-local). Se a tool resolve o host e conecta cegamente,
// o atacante exfiltra credenciais de metadata ou alcança serviços internos.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ A DEFESA (CLI-SEC-13, gate FORTE do `seguranca` — IP-PIN):                  ║
// ║  1. RESOLVE o host → obtém TODOS os IPs (A/AAAA).                            ║
// ║  2. VALIDA cada IP resolvido contra a denylist DURA (esta lista).           ║
// ║  3. CONECTA ao IP VALIDADO (pin) — NÃO re-resolve. Fecha DNS-rebinding: o    ║
// ║     IP que validamos é o IP que conectamos; um 2º lookup (TTL0) não tem voz. ║
// ║  4. Cada REDIRECT re-aplica 1→3 sobre a nova URL (host novo, IPs novos).     ║
// ║ As faixas internas NÃO são liberáveis por allowlist (a allowlist controla    ║
// ║ "para qual domínio público" — nunca abre o loopback/metadata).             ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): só dado + aritmética de string/bits. SEM `node:dns`,
// SEM `node:net`, SEM I/O. O resolver concreto (DNS real) e o connect-pinado são
// PORTAS injetadas pelo locus (@aluy/cli). Aqui está a LÓGICA testável com um
// resolver mock (incl. o mock de TTL0 da bateria CA-C1).

/** O resultado de classificar um IP contra a denylist dura. */
export interface IpClassification {
  /** `true` se o IP é BLOQUEADO (interno/perigoso) — não-liberável por allowlist. */
  readonly blocked: boolean;
  /** Motivo legível do bloqueio (auditoria/UX), quando `blocked`. */
  readonly reason?: string;
  /** A forma canônica/normalizada do IP testado (p/ o pin e o log). */
  readonly canonical: string;
}

/**
 * Normaliza um IPv4 a partir de QUALQUER notação que o `URL`/resolver de SO
 * aceitaria: pontilhada decimal (`127.0.0.1`), DECIMAL pura (`2130706433`),
 * OCTAL (`0177.0.0.1` / `017700000001`), HEX (`0x7f.0.0.1` / `0x7f000001`), e as
 * formas mistas com menos de 4 partes (`127.1`, `10.0xff`). Devolve o IPv4
 * canônico pontilhado, ou `undefined` se não é um IPv4-literal plausível.
 *
 * POR QUÊ (CA-C1): `http://2130706433/` é `127.0.0.1` em decimal — um bypass
 * clássico. Se só testássemos a string "2130706433" contra `/^127\./`, passaria.
 * Canonicalizamos ANTES de classificar p/ que decimal/octal/hex caiam na MESMA
 * denylist que a forma pontilhada.
 */
export function canonicalizeIpv4(raw: string): string | undefined {
  const s = raw.trim();
  if (s === '') return undefined;
  // Cada "parte" separada por `.`. IPv4 legado aceita 1..4 partes; a ÚLTIMA
  // parte absorve os octetos restantes (ex.: `127.1` ⇒ 127.0.0.1).
  const parts = s.split('.');
  if (parts.length === 0 || parts.length > 4) return undefined;

  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIntFlexible(p);
    if (n === undefined) return undefined;
    nums.push(n);
  }

  // Monta o inteiro de 32 bits conforme a aritmética histórica de inet_aton:
  //  - 4 partes: a.b.c.d  (cada 0..255)
  //  - 3 partes: a.b.(16 bits)
  //  - 2 partes: a.(24 bits)
  //  - 1 parte : (32 bits)
  let value: number;
  const n = nums.length;
  if (n === 1) {
    value = nums[0]!;
    if (value > 0xffffffff) return undefined;
  } else {
    // as primeiras n-1 partes são octetos (0..255); a última absorve o resto.
    let acc = 0;
    for (let i = 0; i < n - 1; i++) {
      const part = nums[i]!;
      if (part > 0xff) return undefined;
      acc = acc * 256 + part;
    }
    const last = nums[n - 1]!;
    const remainingBytes = 4 - (n - 1);
    const maxLast = Math.pow(256, remainingBytes) - 1;
    if (last > maxLast) return undefined;
    value = acc * Math.pow(256, remainingBytes) + last;
  }
  if (value < 0 || value > 0xffffffff) return undefined;
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  const c = (value >>> 8) & 0xff;
  const d = value & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Parseia UM componente de IPv4 em decimal/octal/hex (regras de inet_aton):
 *  - `0x..`/`0X..` ⇒ hexadecimal
 *  - `0..`  (≥2 dígitos, todos 0-7) ⇒ octal
 *  - resto (dígitos decimais) ⇒ decimal
 * `undefined` se a forma não é um número inteiro válido nessa base.
 */
function parseIntFlexible(p: string): number | undefined {
  if (p === '') return undefined;
  let n: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(p)) {
    n = parseInt(p.slice(2), 16);
  } else if (/^0[0-7]+$/.test(p)) {
    n = parseInt(p, 8);
  } else if (/^[0-9]+$/.test(p)) {
    n = parseInt(p, 10);
  } else {
    return undefined;
  }
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Extrai o IPv4 "mapeado" de um endereço IPv6 quando ele for um wrapper de um
 * IPv4 (IPv4-mapped `::ffff:127.0.0.1` / `::ffff:7f00:1`, ou IPv4-compatible
 * `::127.0.0.1`). Devolve o IPv4 pontilhado, ou `undefined`. Fecha o bypass
 * `::ffff:127.0.0.1` (CA-C1): ele é, na prática, o loopback — tem de cair na
 * denylist do IPv4.
 */
export function ipv4MappedFromV6(raw: string): string | undefined {
  let s = raw.trim().toLowerCase();
  // tira zona de scope (`%eth0`) e colchetes (`[::1]`).
  s = s.replace(/%.*$/, '').replace(/^\[/, '').replace(/\]$/, '');
  // Forma com IPv4 embutido textual: `::ffff:127.0.0.1` ou `::127.0.0.1`.
  const dotted = s.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted && (s.startsWith('::ffff:') || s.startsWith('::'))) {
    return canonicalizeIpv4(dotted[1]!);
  }
  // Forma hex: `::ffff:7f00:1` (os dois últimos grupos = 32 bits do IPv4).
  const m = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1]!, 16);
    const lo = parseInt(m[2]!, 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      return `${a}.${b}.${c}.${d}`;
    }
  }
  return undefined;
}

/** `true` se o texto parece um IPv6 (tem `:` e nenhum char fora do alfabeto v6). */
export function looksLikeIpv6(raw: string): boolean {
  const s = raw.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
  return s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s);
}

/** Expande um IPv6 p/ os 8 grupos de 16 bits (resolve `::`). `undefined` se inválido. */
function expandIpv6(raw: string): number[] | undefined {
  let s = raw.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
  // IPv4-suffix embutido (`::ffff:1.2.3.4`) — converte o sufixo p/ 2 grupos hex.
  const v4 = s.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4) {
    const canon = canonicalizeIpv4(v4[1]!);
    if (!canon) return undefined;
    const o = canon.split('.').map(Number);
    const g1 = ((o[0]! << 8) | o[1]!).toString(16);
    const g2 = ((o[2]! << 8) | o[3]!).toString(16);
    s = s.slice(0, v4.index) + g1 + ':' + g2;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':').filter((x) => x !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((x) => x !== '') : [];
  const groups: number[] = [];
  for (const h of head) {
    const n = parseInt(h, 16);
    if (!/^[0-9a-f]{1,4}$/.test(h) || !Number.isFinite(n)) return undefined;
    groups.push(n);
  }
  const middle = 8 - head.length - tail.length;
  if (halves.length === 2) {
    if (middle < 0) return undefined;
    for (let i = 0; i < middle; i++) groups.push(0);
  } else if (head.length !== 8) {
    return undefined;
  }
  for (const t of tail) {
    const n = parseInt(t, 16);
    if (!/^[0-9a-f]{1,4}$/.test(t) || !Number.isFinite(n)) return undefined;
    groups.push(n);
  }
  return groups.length === 8 ? groups : undefined;
}

/**
 * CLASSIFICA um endereço (IPv4 pontilhado, IPv4-literal exótico, ou IPv6) contra
 * a DENYLIST DURA do CLI-SEC-13. Devolve `blocked:true` p/ qualquer faixa interna/
 * perigosa — e essas faixas NÃO são liberáveis por allowlist (a allowlist abre
 * domínios PÚBLICOS, jamais o loopback/metadata). Fail-safe: o que não conseguimos
 * canonicalizar com confiança é BLOQUEADO (um IP que o resolver devolveu mas que
 * não entendemos é suspeito).
 */
export function classifyIp(raw: string): IpClassification {
  const input = raw.trim();
  if (input === '') return { blocked: true, reason: 'IP vazio', canonical: input };

  // 1) IPv4-mapped/compatible IPv6 ⇒ classifica o IPv4 embutido (`::ffff:127.0.0.1`).
  const mapped = ipv4MappedFromV6(input);
  if (mapped) {
    const v4 = classifyIpv4(mapped);
    if (v4.blocked) {
      return { ...v4, reason: `IPv4-mapped-IPv6 → ${v4.reason}` };
    }
    return v4;
  }

  // 2) IPv6 puro.
  if (looksLikeIpv6(input)) {
    return classifyIpv6(input);
  }

  // 3) IPv4 (pontilhado, decimal, octal, hex).
  const canon = canonicalizeIpv4(input);
  if (canon) return classifyIpv4(canon);

  // Não-canonicalizável ⇒ fail-safe BLOCK (não sabemos o que é; o resolver não
  // deveria devolver isto — mas se devolver, não conectamos às cegas).
  return { blocked: true, reason: `IP não-reconhecido: "${input}"`, canonical: input };
}

/**
 * EST-1075 · HR-SEC-2 (ADR-0102) — `true` SÓ se `raw` é, comprovadamente, um IP de
 * LOOPBACK (IPv4 `127.0.0.0/8` ou IPv6 `::1`), canonicalizando pela MESMA máquina do
 * `classifyIp` (decimal/octal/hex/IPv4-mapped). Então `2130706433`, `0177.0.0.1` e
 * `::ffff:127.0.0.1` contam como loopback, e um host público NUNCA (mata o bypass
 * de string-match `=== '127.0.0.1'`).
 *
 * É a INVERSÃO deliberada da denylist: o `classifyIp` BLOQUEIA loopback (correto p/
 * `web_fetch`, egress externo); aqui o loopback é o ÚNICO destino ACEITO — o caminho
 * só-loopback do headroom (compress roda automático SEM `ask`, então o destino tem
 * de ser provado interno-à-máquina, não confiado pelo nome). NÃO reabre RFC1918/
 * metadata (≠ `allowInternalHosts` do `safeFetch`, que suspende a denylist inteira).
 * Fail-safe: o que não canonicaliza ⇒ `false` (tratado como NÃO-loopback).
 */
export function isLoopbackIp(raw: string): boolean {
  const input = raw.trim();
  if (input === '') return false;
  // 1) IPv4-mapped/compatible IPv6 (`::ffff:127.0.0.1`) ⇒ olha o IPv4 embutido.
  const mapped = ipv4MappedFromV6(input);
  if (mapped) return mapped.split('.')[0] === '127';
  // 2) IPv6 puro ⇒ só `::1` (sete grupos zero + último 1).
  if (looksLikeIpv6(input)) {
    const groups = expandIpv6(input);
    if (!groups) return false;
    return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  }
  // 3) IPv4 (pontilhado/decimal/octal/hex) ⇒ 127.0.0.0/8.
  const canon = canonicalizeIpv4(input);
  if (canon) return canon.split('.')[0] === '127';
  return false; // não-canonicalizável ⇒ não-loopback (fail-safe).
}

/** Denylist dura de IPv4: loopback, RFC1918, link-local, CGNAT, metadata, etc. */
function classifyIpv4(dotted: string): IpClassification {
  const o = dotted.split('.').map(Number);
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) {
    return { blocked: true, reason: `IPv4 inválido: "${dotted}"`, canonical: dotted };
  }
  const [a, b] = o as [number, number, number, number];

  const block = (reason: string): IpClassification => ({
    blocked: true,
    reason,
    canonical: dotted,
  });

  // metadata da cloud (AWS/GCP/Azure/OpenStack) — o alvo mais valioso de SSRF.
  if (dotted === '169.254.169.254') return block('endpoint de metadata da cloud (169.254.169.254)');
  // este-host / “qualquer” (0.0.0.0/8) — em muitos SOs roteia p/ localhost.
  if (a === 0) return block('0.0.0.0/8 (este host / não-roteável)');
  // loopback 127.0.0.0/8
  if (a === 127) return block('loopback (127.0.0.0/8)');
  // RFC1918 privadas
  if (a === 10) return block('rede privada RFC1918 (10.0.0.0/8)');
  if (a === 172 && b >= 16 && b <= 31) return block('rede privada RFC1918 (172.16.0.0/12)');
  if (a === 192 && b === 168) return block('rede privada RFC1918 (192.168.0.0/16)');
  // link-local 169.254.0.0/16 (inclui metadata, já tratada acima)
  if (a === 169 && b === 254) return block('link-local (169.254.0.0/16)');
  // CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return block('CGNAT (100.64.0.0/10)');
  // benchmark 198.18.0.0/15
  if (a === 198 && (b === 18 || b === 19)) return block('rede de benchmark (198.18.0.0/15)');
  // multicast 224.0.0.0/4 + reservado 240.0.0.0/4 + broadcast
  if (a >= 224) return block('multicast/reservado (≥224.0.0.0/4)');
  if (dotted === '255.255.255.255') return block('broadcast (255.255.255.255)');

  return { blocked: false, canonical: dotted };
}

/** Denylist dura de IPv6: loopback `::1`, unspecified `::`, ULA `fc00::/7`, link-local `fe80::/10`, multicast `ff00::/8`. */
function classifyIpv6(raw: string): IpClassification {
  const groups = expandIpv6(raw);
  if (!groups) {
    return { blocked: true, reason: `IPv6 inválido: "${raw}"`, canonical: raw };
  }
  const canonical = groups.map((g) => g.toString(16)).join(':');
  const block = (reason: string): IpClassification => ({ blocked: true, reason, canonical });

  const allZeroExceptLast = groups.slice(0, 7).every((g) => g === 0);
  if (allZeroExceptLast && groups[7] === 1) return block('loopback IPv6 (::1)');
  if (groups.every((g) => g === 0)) return block('IPv6 unspecified (::)');
  const first = groups[0]!;
  // ULA fc00::/7  (primeiro byte 0xfc ou 0xfd)
  const firstByte = (first >> 8) & 0xff;
  if (firstByte === 0xfc || firstByte === 0xfd) return block('IPv6 ULA privada (fc00::/7)');
  // link-local fe80::/10
  if ((first & 0xffc0) === 0xfe80) return block('IPv6 link-local (fe80::/10)');
  // multicast ff00::/8 (special-use, NÃO unicast público — RFC 4291 §2.7). PARIDADE com
  // o lado IPv4, que já bloqueia `224.0.0.0/4`: o IPv6 deixava `ff02::1`/`ff05::c`/`ff02::fb`
  // (all-nodes/site-local/mDNS) PASSAREM como "IPv6 público". TCP não roteia multicast, então
  // não é exfiltração-prática via HTTP, mas a denylist NÃO deve classificar special-use como
  // destino válido — fecha a assimetria IPv4/IPv6 (fail-safe, defesa-em-profundidade).
  if (firstByte === 0xff) return block('IPv6 multicast (ff00::/8)');

  // EST-1014 (hunt SSRF) — IPv6 de TRANSIÇÃO que EMBUTE um IPv4: NAT64 e 6to4. Em
  // qualquer rede com gateway NAT64/6to4 (comum em ambientes IPv6-only/cloud/DNS64),
  // o kernel ROTEIA esses literais ao IPv4 embutido — `64:ff9b::a9fe:a9fe` alcança a
  // metadata `169.254.169.254`, `64:ff9b::a00:1` alcança 10.0.0.1, `2002:7f00:1::`
  // (6to4) alcança 127.0.0.1. O `ipv4MappedFromV6` (no chamador) só cobria `::ffff:`/
  // `::`; estes PASSAVAM como "IPv6 público". Extraímos o IPv4 embutido e o jogamos na
  // MESMA denylist do IPv4 — fechando o bypass (vale também no redirect, mesmo caminho).
  const embedded = ipv4FromTransitionV6(groups);
  if (embedded) {
    const v4 = classifyIpv4(embedded.ipv4);
    if (v4.blocked) {
      return { blocked: true, reason: `IPv6 ${embedded.kind} → ${v4.reason}`, canonical };
    }
  }

  return { blocked: false, canonical };
}

/**
 * EST-1014 (hunt SSRF) — extrai o IPv4 EMBUTIDO de um IPv6 de transição, p/ que ele
 * caia na denylist do IPv4:
 *  - NAT64 well-known-prefix `64:ff9b::/96` (RFC 6052): os 32 bits FINAIS são o IPv4.
 *  - NAT64 local-use prefix `64:ff9b:1::/48` (RFC 8215): idem (32 bits finais).
 *  - 6to4 `2002::/16` (RFC 3056): os bits 16..48 carregam o IPv4 (grupos[1] e [2]).
 * Devolve `{ ipv4, kind }` ou `undefined` se não é um prefixo de transição conhecido.
 */
function ipv4FromTransitionV6(
  groups: readonly number[],
): { ipv4: string; kind: string } | undefined {
  const g = groups;
  const dottedFromTwo = (hi: number, lo: number): string =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

  // NAT64 well-known `64:ff9b::/96` ⇒ g[0]=0x0064, g[1]=0xff9b, g[2..5]=0, IPv4 em g[6],g[7].
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return { ipv4: dottedFromTwo(g[6]!, g[7]!), kind: 'NAT64 (64:ff9b::/96)' };
  }
  // NAT64 local-use `64:ff9b:1::/48` ⇒ g[0]=0x0064, g[1]=0xff9b, g[2]=1; IPv4 nos 32 bits finais.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 1) {
    return { ipv4: dottedFromTwo(g[6]!, g[7]!), kind: 'NAT64 (64:ff9b:1::/48)' };
  }
  // 6to4 `2002::/16` ⇒ g[0]=0x2002, IPv4 nos 32 bits seguintes (g[1],g[2]).
  if (g[0] === 0x2002) {
    return { ipv4: dottedFromTwo(g[1]!, g[2]!), kind: '6to4 (2002::/16)' };
  }
  return undefined;
}

/**
 * VALIDA um conjunto de IPs resolvidos: se QUALQUER um cair na denylist, a
 * resolução inteira é BLOQUEADA (um host com 2 IPs, um público e um interno, não
 * pode ser conectado — o atacante escolheria o interno). Devolve o IP PINADO (o
 * 1º IP, já validado como público) p/ a conexão, ou o bloqueio.
 *
 * @returns `{ ok:true, pinnedIp }` p/ conectar AO `pinnedIp` (sem re-resolver),
 *          ou `{ ok:false, reason, offendingIp }` se algum IP é interno.
 */
export function validateResolvedIps(
  ips: readonly string[],
): { ok: true; pinnedIp: string } | { ok: false; reason: string; offendingIp: string } {
  if (ips.length === 0) {
    return { ok: false, reason: 'host não resolveu para nenhum IP', offendingIp: '' };
  }
  for (const ip of ips) {
    const c = classifyIp(ip);
    if (c.blocked) {
      return {
        ok: false,
        reason: c.reason ?? 'IP bloqueado pela denylist anti-SSRF',
        offendingIp: c.canonical,
      };
    }
  }
  // todos públicos — pina o 1º (canônico).
  return { ok: true, pinnedIp: classifyIp(ips[0]!).canonical };
}
