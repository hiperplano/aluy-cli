// EST-1012 · CLI-SEC-H1 — HARDENING de cobertura do classifier MCP-aware
// (`classifyMcpPathCandidate` E-B1/E-B2 + sinal de rede) e dos ramos vazios.
//
// Testes ADVERSARIAIS: cada `it` MATA uma mutação concreta da fronteira textual
// que protege `~/.aluy`/`.ssh` e a categoria de rede de tools MCP. A classificação
// MCP é exercitada pela FRONTEIRA PÚBLICA (`classifyAlwaysAsk` com nome MCP), que é
// o caminho REAL do `decide()` — `classifyMcpPathCandidate` é interno.

import { describe, expect, it } from 'vitest';
import { classifyAlwaysAsk, type CategoryMatch } from '../../src/index.js';

function matches(name: string, input: Record<string, unknown>): readonly CategoryMatch[] {
  return classifyAlwaysAsk(name, input);
}
function cats(name: string, input: Record<string, unknown>): string[] {
  return matches(name, input).map((m) => m.category);
}
/** O acerto de uma categoria específica (p/ checar o flag `deny`). */
function pick(name: string, input: Record<string, unknown>, category: string): CategoryMatch {
  const m = matches(name, input).find((x) => x.category === category);
  if (!m) throw new Error(`categoria ${category} não casou em ${name} ${JSON.stringify(input)}`);
  return m;
}

const MCP = 'mcp__evil-server__do_thing';

describe('EST-1012 — MCP path candidate: ~/.aluy e .ssh permanecem DENY (não relaxam p/ ask)', () => {
  // ── MUTAÇÃO: `deny: true` → (omitido/`false`) em classifyMcpPathCandidate p/
  //    `~/.aluy` (aluy-config-write-deny) e p/ os SENSITIVE_READ críticos (.ssh). ──
  // Um server MCP que MENTE "readonly" mas manda um path de `~/.aluy`/`.ssh` precisa
  // cair em DENY (acima até do `--unsafe`), não num ask relaxável. Se a mutação
  // rebaixar p/ ask, `deny` deixa de ser `true` — estes asserts pegam.

  it('tool MCP com path `~/.aluy/...` ⇒ aluy-config-write-deny com deny=true (sempre-deny)', () => {
    const m = pick(MCP, { path: '~/.aluy/hooks.json' }, 'always-ask:aluy-config-write-deny');
    expect(m.deny).toBe(true);
  });

  it('tool MCP com path `$HOME/.aluy/...` (campo de path arbitrário) ⇒ deny=true', () => {
    // chave `target` é PATH_LIKE; o server escolhe o nome do campo (não-confiável).
    const m = pick(MCP, { target: '$HOME/.aluy/config' }, 'always-ask:aluy-config-write-deny');
    expect(m.deny).toBe(true);
  });

  it('tool MCP que toca `~/.ssh/id_rsa` ⇒ sensitive-read com deny=true (crítico, não relaxa)', () => {
    const m = pick(MCP, { file: '~/.ssh/id_rsa' }, 'always-ask:sensitive-read');
    expect(m.deny).toBe(true);
  });

  it('tool MCP que toca `.aws/credentials` ⇒ sensitive-read DENY (crítico)', () => {
    const m = pick(MCP, { path: '/home/u/.aws/credentials' }, 'always-ask:sensitive-read');
    expect(m.deny).toBe(true);
  });

  it('tool MCP com `.env` (sensível NÃO-crítico) ⇒ sensitive-read deny=false (ask, não deny)', () => {
    // Espelho que PROVA o flag não está preso em `true`: o `.env` é ask, não deny.
    // Mata a mutação inversa (`deny:false` → `deny:true` indiscriminado).
    const m = pick(MCP, { path: 'config/.env' }, 'always-ask:sensitive-read');
    expect(m.deny).toBe(false);
  });
});

describe('EST-1012 — sinal de REDE de tool MCP é always-ask:network (não vira só mcp-effect)', () => {
  // ── MUTAÇÃO: remover/relaxar o ramo `if (inputHasNetworkSignal(input))` que
  //    ANEXA always-ask:network, deixando a tool MCP de rede só com mcp-effect. ──
  // O EFEITO de egress de uma tool MCP precisa do MESMO veredito de um `curl`:
  // always-ask:network. Se o sinal de rede for descartado, sobra só mcp-effect.

  it('tool MCP com URL http no input ⇒ network ANEXADO ao mcp-effect baseline', () => {
    const c = cats(MCP, { endpoint: 'https://exfil.example.com/steal' });
    expect(c).toContain('always-ask:mcp-effect');
    expect(c).toContain('always-ask:network'); // mata a remoção do sinal de rede
  });

  it('tool MCP com user@host (scp-like) no input ⇒ network sinalizado', () => {
    const c = cats(MCP, { dest: 'attacker@evil.example.com' });
    expect(c).toContain('always-ask:network');
  });

  it('tool MCP com esquema remoto NÃO-http (s3://) ⇒ network sinalizado', () => {
    const c = cats(MCP, { bucket: 's3://leak-bucket/path' });
    expect(c).toContain('always-ask:network');
  });

  it('tool MCP SEM sinal de rede ⇒ mcp-effect SÓ (sem network) — limite do sinal', () => {
    // Mata a mutação inversa: sempre-anexa-network. Sem destino remoto, NÃO há
    // network — só o baseline mcp-effect. `file://` é local (exceção explícita).
    const c = cats(MCP, { note: 'hello world', ref: 'file:///local/x' });
    expect(c).toContain('always-ask:mcp-effect');
    expect(c).not.toContain('always-ask:network');
  });

  it('tool MCP de path sensível NÃO contamina como rede (separação dos sinais)', () => {
    // `~/.ssh/...` é path, não rede: deve dar deny de sensitive-read SEM network.
    const c = cats(MCP, { path: '~/.ssh/config' });
    expect(c).not.toContain('always-ask:network');
    expect(c).toContain('always-ask:mcp-effect');
  });
});

describe('EST-1012 — ramos VAZIOS (candidate==="" / target ausente) não fabricam categoria', () => {
  // ── classifyMcpPathCandidate: `if (candidate === '') return out;` (early return).
  // Um candidato vazio NÃO pode casar nenhum matcher (a mutação que remove o guard
  // faria `''` testar contra os regex e possivelmente casar `looksOutsideWorkspace`
  // / config-startup espúrio). Forçamos um path vazio via campo PATH_LIKE.

  it('tool MCP com campo de path vazio NÃO adiciona categoria de path (só mcp-effect)', () => {
    const c = cats(MCP, { path: '', file: '' });
    expect(c).toEqual(['always-ask:mcp-effect']);
  });

  it('web_fetch SEM url ⇒ network, reason sem sufixo de alvo (ramo target-vazio do ternário)', () => {
    // web_fetch/web_search: o ternário do reason tem o ramo VAZIO (sem url/query).
    // Sob a mutação que sempre concatena, a reason teria ` ()` espúrio.
    const m = pick('web_fetch', {}, 'always-ask:network');
    expect(m.reason).toBe('rede: web_fetch');
    expect(m.reason).not.toContain('('); // ramo vazio do ternário
  });

  it('web_fetch COM url ⇒ network, reason inclui o alvo (ramo não-vazio do ternário)', () => {
    const m = pick('web_fetch', { url: 'http://x.test/y' }, 'always-ask:network');
    expect(m.reason).toBe('rede: web_fetch (http://x.test/y)');
  });

  it('web_search SEM query ⇒ network, reason sem sufixo', () => {
    const m = pick('web_search', {}, 'always-ask:network');
    expect(m.reason).toBe('rede: web_search');
  });
});
