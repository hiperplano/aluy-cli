// EST-0949 · CLI-SEC-7 — scan "binário público limpo": o artefato PUBLICADO não pode
// conter segredo/credencial. Patterns ESPECÍFICOS (formato real de chave), não palavras
// soltas — evita falso-positivo no bundle minificado. Usado no smoke de release.
export const SECRET_PATTERNS = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'aluy-token-value', re: /ALUY_TOKEN\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/ },
  { id: 'bearer-literal', re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { id: 'pem-cert-key', re: /-----BEGIN PRIVATE KEY-----/ },
];

export function scanForSecrets(text) {
  const hits = [];
  for (const p of SECRET_PATTERNS) {
    const m = text.match(p.re);
    if (m) hits.push({ id: p.id, sample: m[0].slice(0, 24) + '…' });
  }
  return hits;
}
