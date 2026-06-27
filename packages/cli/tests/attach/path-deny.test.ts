// EST-0957 · CA-4 · CLI-SEC-6 (baseline) — path-deny do canal `@arquivo`.

import { describe, expect, it } from 'vitest';
import { classifyAttachPath, isPickable } from '../../src/attach/path-deny.js';

describe('classifyAttachPath — caminhos sensíveis', () => {
  it('DENY material de chave/credencial (nunca anexa)', () => {
    for (const p of [
      '.ssh/id_rsa',
      'home/.ssh/known_hosts',
      '.aws/credentials',
      '.gnupg/pubring.kbx',
      'secrets/server.pem',
      'cert.key',
      // ── .aluy HOME — INTOCADO ──
      '~/.aluy/credential.json',
      '~/.aluy/agents/revisor.md',
      '~/.aluy/workflows/sdlc.md',
      '~/.aluy/commands/deploy.md',
    ]) {
      expect(classifyAttachPath(p).kind).toBe('deny');
    }
  });

  // ── ADR-0113: carve-out de path-deny p/ config de projeto ───────────────

  it('ADR-0113 — ALLOW .aluy/agents/x.md (workspace, carve-out)', () => {
    expect(classifyAttachPath('.aluy/agents/revisor.md').kind).toBe('allow');
    expect(classifyAttachPath('.aluy/agents/sub/x.md').kind).toBe('allow');
    expect(classifyAttachPath('proj/.aluy/agents/foo.md').kind).toBe('allow');
  });

  it('ADR-0113 — ALLOW .aluy/workflows/x.md (workspace, carve-out)', () => {
    expect(classifyAttachPath('.aluy/workflows/sdlc.md').kind).toBe('allow');
    expect(classifyAttachPath('proj/.aluy/workflows/deploy.md').kind).toBe('allow');
  });

  it('ADR-0113 — ALLOW .aluy/commands/x.md (workspace, carve-out)', () => {
    expect(classifyAttachPath('.aluy/commands/deploy.md').kind).toBe('allow');
    expect(classifyAttachPath('proj/.aluy/commands/review.md').kind).toBe('allow');
  });

  it('ADR-0113 — DENY .aluy/memory/x (fail-closed, NÃO está na allow-list)', () => {
    expect(classifyAttachPath('.aluy/memory/foo.json').kind).toBe('deny');
    expect(classifyAttachPath('.aluy/memory/project.db').kind).toBe('deny');
  });

  it('ADR-0113 — DENY .aluy/secrets/ e qualquer outro subdir não-listado (fail-closed)', () => {
    expect(classifyAttachPath('.aluy/secrets/token.txt').kind).toBe('deny');
    expect(classifyAttachPath('.aluy/journal/2024.json').kind).toBe('deny');
    expect(classifyAttachPath('.aluy/qualquer-outro/x.md').kind).toBe('deny');
  });

  it('ADR-0113 — DENY .aluy/ sem subdir (bare .aluy)', () => {
    expect(classifyAttachPath('.aluy').kind).toBe('deny');
    expect(classifyAttachPath('.aluy/').kind).toBe('deny');
  });

  it('ADR-0113 — DENY ~/.aluy/agents/ (HOME, NUNCA carve-out)', () => {
    // O ~/.aluy/ do HOME é INTOCADO — credencial/journal/estado.
    expect(classifyAttachPath('~/.aluy/agents/revisor.md').kind).toBe('deny');
    expect(classifyAttachPath('~/.aluy/workflows/sdlc.md').kind).toBe('deny');
    expect(classifyAttachPath('~/.aluy/commands/deploy.md').kind).toBe('deny');
  });

  it('ADR-0113 — DENY .aluy/agents mas com path-deny de outro tipo (ex.: .aluy/agents/.env)', () => {
    // O carve-out tira o deny do .aluy/agents/, mas um .env DENTRO dele ainda cai
    // na regra de .env (ask). Verifica que o path-deny não foi relaxado.
    expect(classifyAttachPath('.aluy/agents/.env').kind).toBe('ask');
  });

  it('ADR-0113 GS-I3 — `.aluy/agents/../memory/x` ⇒ DENY (canonicaliza ANTES de classificar)', () => {
    // ANTI-TRAVERSAL: o `..` escapa do dir permitido (`agents/`) pro DENY `.aluy/memory/`.
    // O resolveInside só confina à RAIZ (e `.aluy/memory/` ESTÁ dentro da raiz — não basta);
    // o path-deny CANONICALIZA o caminho (colapsa o `..`) e NEGA o alvo real. Sem isso, em
    // --yolo o ASK/allow seria auto-aprovado e a memória vazaria por traversal.
    expect(classifyAttachPath('.aluy/agents/../memory/x.json').kind).toBe('deny');
    expect(classifyAttachPath('.aluy/workflows/../../.aluy/memory/x').kind).toBe('deny');
  });

  it('ASK arquivos `.env` e nomes sensíveis (fora do picker por padrão)', () => {
    for (const p of ['.env', 'config/.env.production', 'app-token.txt', 'my_secret.json']) {
      expect(classifyAttachPath(p).kind).toBe('ask');
    }
  });

  it('ASK `.env` colado num nome (`backup.env`/`prod.env`) — R2 do seguranca', () => {
    // O âncora antigo `(?:^|\/)\.env` deixava o sufixo `.env` colado passar; o novo
    // casa `.env` como sufixo de QUALQUER segmento.
    expect(classifyAttachPath('backup.env').kind).toBe('ask');
    expect(classifyAttachPath('prod.env').kind).toBe('ask');
    expect(classifyAttachPath('config/staging.env').kind).toBe('ask');
  });

  it('ALLOW `.env.example`/`.env.sample` (placeholders, não segredo)', () => {
    expect(classifyAttachPath('.env.example').kind).toBe('allow');
    expect(classifyAttachPath('.env.sample').kind).toBe('allow');
    expect(classifyAttachPath('.env.template').kind).toBe('allow');
    // …inclusive com nome colado antes (`prod.env.example` é placeholder).
    expect(classifyAttachPath('prod.env.example').kind).toBe('allow');
  });

  it('ALLOW `.env.dist` (build output, não segredo) — protege negative lookahead', () => {
    expect(classifyAttachPath('.env.dist').kind).toBe('allow');
    expect(classifyAttachPath('prod.env.dist').kind).toBe('allow');
  });

  it('ALLOW nomes que CONTÊM "env" sem o sufixo `.env` (sem falso-positivo)', () => {
    expect(classifyAttachPath('src/environment.ts').kind).toBe('allow');
    expect(classifyAttachPath('myenv.txt').kind).toBe('allow');
  });

  it('ALLOW arquivos comuns de código', () => {
    for (const p of ['packages/cli/src/auth/session.ts', 'README.md', 'src/index.tsx']) {
      expect(classifyAttachPath(p).kind).toBe('allow');
    }
  });
});

describe('isPickable — só `allow` aparece no picker', () => {
  it('esconde .env e chaves do picker', () => {
    expect(isPickable('.env')).toBe(false);
    expect(isPickable('.ssh/id_ed25519')).toBe(false);
    expect(isPickable('src/app.ts')).toBe(true);
  });

  it('esconde arquivos `ask` do picker (só `allow` passa)', () => {
    expect(isPickable('.env')).toBe(false);
    expect(isPickable('config/secrets.token')).toBe(false);
    expect(isPickable('.ssh/config')).toBe(false);
  });
});
