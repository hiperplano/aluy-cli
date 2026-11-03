// F8/F16 — TEXTO DE EXIBIÇÃO do eco "você" no transcript. Só apresentação: o modelo recebe o
// texto cheio; aqui o paste grande segue como o MESMO chip do composer (`[texto colado #1,
// +130 linhas]`) e cada arquivo anexado vira um chip `[anexo: caminho]` numa linha própria.

/** Monta o eco: o texto como digitado (com chips de paste) + uma linha de chips de anexo. */
export function buildSentDisplay(raw: string, attachedPaths: readonly string[]): string {
  const uniq = [...new Set(attachedPaths)];
  if (uniq.length === 0) return raw;
  const chips = uniq.map((p) => `[anexo: ${p}]`).join(' ');
  return raw.trim() === '' ? chips : `${raw}\n${chips}`;
}
