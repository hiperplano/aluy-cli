// `aluy onboard` — o INSTALADOR de verdade (Node + Ink), pra onde o bootstrap mínimo
// (shell/ps1/cmd) entrega o controle. Substitui o setup porco em script: splash + idioma
// + backend + provider (incl. custom OpenAI-compat) + chave + modelo + CHECK DE
// CONECTIVIDADE + sidecars (turbo/leve). Encoding-safe (Node controla o UTF-8), i18n.
//
// O check de conectividade (decisão do dono: "lisa do início ao fim") roda DEPOIS da
// chave/modelo e ANTES dos sidecars: faz uma chamada REAL ao provider; só prossegue se
// o modelo responder. Se falhar, mostra o motivo EXATO (chave/baseURL/modelo) e deixa
// corrigir — nunca entrega uma sessão quebrada nem provisiona o "restante" no escuro.

import React, { useEffect, useMemo, useState } from 'react';
import { render, Box, useApp, useInput } from 'ink';
import { MIN_WORDMARK_COLS, Wordmark } from '../ui/components/Wordmark.js';
import { ShadowedWordmark } from '../ui/components/ShadowedWordmark.js';
import { Role, ThemeProvider, resolveTheme } from '../ui/theme/index.js';
import { CLI_VERSION } from '../version.js';
import { LANGS, type Lang } from '../i18n/lang.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UserConfigStore } from '../io/user-config.js';
import { loadLocalProviderCatalog, addLocalProviderOverride } from '../io/providers-config.js';
import { storeApiKey } from '../model/local/credential-resolver.js';
import { checkModelConnectivity } from '../model/local/connectivity-check.js';
import { McpConfigWriter } from '../mcp/mcp-config-writer.js';
import { EMBEDDER_CATALOG, DEFAULT_EMBEDDER_MODEL } from '@hiperplano/aluy-cli-core';

type Step =
  | 'lang'
  | 'backend'
  | 'provider'
  | 'custom-id'
  | 'custom-url'
  | 'custom-model'
  | 'key'
  | 'model'
  | 'validating'
  | 'validate-failed'
  | 'mcp'
  | 'sidecars'
  | 'embedder'
  | 'done';

/**
 * Catálogo CURADO de MCPs oferecidos no onboarding (OPCIONAL, antes dos sidecars). Todos
 * rodam via `npx` sob demanda — não há instalação pesada (o `npx` baixa na 1ª vez), então
 * "instalar" aqui é só REGISTRAR no `~/.aluy/mcp.json`. (O RPA — server Python privado —
 * fica de fora até a decisão de distribuição; entra depois.)
 */
export interface McpEntry {
  readonly id: string;
  readonly label: string;
  readonly hintPt: string;
  readonly hintEn: string;
  readonly command: string;
  readonly args: readonly string[];
}
/**
 * BUG (relato do dono: "instalei setando outro modelo e ele forçou o mesmo") — decide o
 * que o onboarding grava em `config.localModel`. PURO, e exportado porque é a decisão
 * que precisa de teste: a UI/Ink em si é verificada no TTY (mesma disciplina do
 * `mcpCatalog`).
 *
 * A REGRA: o onboarding DECLARA a configuração. Ele nunca deixa o campo por conta do
 * valor anterior — ou grava o modelo escolhido, ou LIMPA (`undefined`).
 *
 * Por que limpar em vez de não escrever: `store.save` é MERGE. Não escrever fazia o
 * `localModel` de uma instalação ANTERIOR sobreviver intacto — e a resolução
 * (`model/local/config.ts`) dá precedência a `config.localModel` sobre o `defaultModel`
 * do provider, então o modelo VELHO vencia o provider NOVO que o dono acabara de
 * escolher. Em máquina limpa não havia valor velho e o sintoma não aparecia: só em
 * reinstalação, que é exatamente como ele o descreveu. Com `undefined` o campo some e a
 * resolução cai no default do provider ESCOLHIDO — a resposta certa para "não pedi
 * modelo nenhum".
 */
export function resolveOnboardLocalModel(args: {
  readonly providerId: string;
  /** O que o dono digitou/confirmou no passo `model` (built-ins vêm pré-preenchidos). */
  readonly model: string;
  /** O que ele digitou no passo `custom-model` (caminho `__custom__`, aceita vazio). */
  readonly customModel: string;
}): string | undefined {
  const escolhido = args.providerId === '__custom__' ? args.customModel : args.model;
  const limpo = escolhido.trim();
  return limpo !== '' ? limpo : undefined;
}

export function mcpCatalog(): McpEntry[] {
  return [
    {
      id: 'playwright',
      label: 'Playwright',
      hintPt: 'automação de navegador (oficial)',
      hintEn: 'browser automation (official)',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    },
    {
      id: 'sequential-thinking',
      label: 'Sequential Thinking',
      hintPt: 'raciocínio passo-a-passo',
      hintEn: 'step-by-step reasoning',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    {
      id: 'memory',
      label: 'Memory',
      hintPt: 'grafo de conhecimento persistente',
      hintEn: 'persistent knowledge graph',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    {
      id: 'filesystem',
      label: 'Filesystem',
      hintPt: 'arquivos (escopo: sua home)',
      hintEn: 'files (scope: your home)',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', homedir()],
    },
    {
      id: 'rpa',
      label: 'RPA (Aluy)',
      hintPt: 'automação visual de desktop — OCR/clica/digita · via uvx',
      hintEn: 'visual desktop automation — OCR/click/type · via uvx',
      command: 'uvx',
      args: ['aluy-mcp-rpa'],
    },
  ];
}

type Backend = 'broker' | 'local';
type Profile = 'turbo' | 'leve';

interface Opt {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * F-ONB (fix) — o que o onboard PEDE ao encerrar. A tela final promete `enter p/ entrar
 * no aluy`, mas o handler só fechava o Ink e o processo morria: o `aluy` nunca abria.
 * Agora o Enter EXPRESSA a intenção e o `bin/aluy.ts` a cumpre (mesmo caminho do
 * `case 'launch'`), fechando a cadeia `aluy onboard → aluy bootstrap → aluy` que o
 * comentário do `case 'bootstrap'` já descrevia.
 *
 * `bootstrap` é `true` quando o usuário escolheu o perfil **turbo** no passo `sidecars`:
 * optar pelo turbo É o consentimento da instalação (`docs/turbo.md`), então a cadeia
 * completa roda sem pedir o comando de novo. O `runInit` decide sozinho o que falta
 * (perfil leve e "nada a instalar" já são no-op lá) — não duplicamos essa lógica aqui.
 */
export interface OnboardOutcome {
  readonly code: number;
  /** Enter na tela final ⇒ abre a sessão. Esc ⇒ só sai. */
  readonly launch: boolean;
  /** Perfil turbo ⇒ roda o bootstrap ANTES de abrir. */
  readonly bootstrap: boolean;
}

function OnboardApp(props: {
  readonly store: UserConfigStore;
  /** Chamado UMA vez, no encerramento, com a intenção do usuário. */
  readonly onOutcome?: (o: { launch: boolean; bootstrap: boolean }) => void;
}): React.ReactElement {
  const app = useApp();
  const cfg = props.store.load();
  const providers = useMemo(() => loadLocalProviderCatalog().entries, []);

  const [step, setStep] = useState<Step>('lang');
  const [lang, setLang] = useState<Lang>(cfg.lang ?? 'pt-BR');
  const [backend, setBackend] = useState<Backend>('local');
  const [providerId, setProviderId] = useState<string>('anthropic');
  const [custom, setCustom] = useState<{ id: string; url: string; model: string }>({
    id: '',
    url: '',
    model: '',
  });
  const [apiKey, setApiKey] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [profile, setProfile] = useState<Profile>('leve'); // default LEVE (decisão do dono)
  const [embedder, setEmbedder] = useState<string>(DEFAULT_EMBEDDER_MODEL); // embedder do mem0 (turbo)
  const [vError, setVError] = useState<string>(''); // detalhe do check de conectividade falho

  const MCPS = useMemo(() => mcpCatalog(), []);
  const [mcpSel, setMcpSel] = useState<ReadonlySet<number>>(new Set()); // MCPs marcados (multi-select, opcional)
  const [mcpCursor, setMcpCursor] = useState<number>(0);

  const [cursor, setCursor] = useState<number>(
    Math.max(
      0,
      LANGS.findIndex((l) => l.code === lang),
    ),
  );
  const [buf, setBuf] = useState<string>('');
  const [savedMsg, setSavedMsg] = useState<string[]>([]);

  const pt = lang === 'pt-BR';
  const T = (p: string, e: string): string => (pt ? p : e);

  const backendOpts: Opt[] = [
    {
      value: 'local',
      label: T('Local (sua chave / BYO)', 'Local (your key / BYO)'),
      hint: T('direto no provider', 'direct to provider'),
    },
    {
      value: 'broker',
      label: T('Broker (conta Aluy)', 'Broker (Aluy account)'),
      hint: T('autentica depois com aluy login', 'authenticate later with aluy login'),
    },
  ];
  // Espelha o `wants3d` do <SplashScreen>: terminal estreito ⇒ marca plana.
  const temMarcaLarga = (process.stdout.columns ?? 80) >= MIN_WORDMARK_COLS;
  const providerOpts: Opt[] = [
    ...providers.map((e) => ({ value: e.id, label: e.label, hint: e.defaultModel })),
    {
      value: '__custom__',
      label: T('+ custom (OpenAI-compatível)', '+ custom (OpenAI-compatible)'),
      // Defeito 2 (relato do dono) — "TokenRouter" aqui era EXEMPLO, mas junto de itens
      // REAIS da lista (deepseek/openai/…) lia como se fosse mais um provider suportado
      // (reforçado pelo card do site apontando pra tokenrouter.com). `vLLM` some porque
      // era o MESMO tipo de exemplo, com o mesmo risco — trocados por termos que não são
      // nome de produto nenhum.
      hint: T('ex.: seu endpoint OpenAI-compat', 'e.g. your OpenAI-compat endpoint'),
    },
  ];
  const sidecarOpts: Opt[] = [
    {
      value: 'turbo',
      label: T('Turbo — instala tudo', 'Turbo — install all'),
      hint: T(
        'ollama + mem0 + headroom · pede máquina razoável',
        'ollama + mem0 + headroom · needs a decent machine',
      ),
    },
    {
      value: 'leve',
      label: T('Leve — nada agora', 'Lite — nothing now'),
      hint: T('liga depois com aluy bootstrap', 'enable later with aluy bootstrap'),
    },
  ];

  // Embedder do mem0 (turbo): catálogo do core, hints i18n. O 1º é o default (bge-m3, forte).
  const embedderOpts: Opt[] = EMBEDDER_CATALOG.map((e) => ({
    value: e.model,
    label: e.model,
    hint: T(e.hintPt, e.hintEn),
  }));

  const pickerLen = (s: Step): number =>
    s === 'lang'
      ? LANGS.length
      : s === 'backend'
        ? backendOpts.length
        : s === 'provider'
          ? providerOpts.length
          : s === 'sidecars'
            ? sidecarOpts.length
            : s === 'embedder'
              ? embedderOpts.length
              : 0;

  function gotoText(next: Step, prefill = ''): void {
    setBuf(prefill);
    setStep(next);
  }

  // Abre o passo de sidecars com LEVE pré-selecionado (decisão do dono): o cursor
  // ancora no índice de 'leve', não no topo. Usado em TODAS as entradas em 'sidecars'.
  function enterSidecars(): void {
    setCursor(
      Math.max(
        0,
        sidecarOpts.findIndex((o) => o.value === 'leve'),
      ),
    );
    setStep('sidecars');
  }

  // Passo de MCPs (OPCIONAL, multi-select) — vem ANTES da escolha light/turbo dos sidecars
  // (pedido do dono). Nenhum marcado por default; o usuário escolhe e ENTER segue.
  function enterMcp(): void {
    setMcpCursor(0);
    setStep('mcp');
  }

  // Alvo do check de conectividade (resolvido do estado atual). --------------
  function resolveTarget(): { wireFormat: string; baseUrl: string; model: string; key: string } {
    const isCustom = providerId === '__custom__';
    const entry = providers.find((p) => p.id === providerId);
    return {
      wireFormat: isCustom ? 'openai-compat' : (entry?.wireFormat ?? 'openai-compat'),
      baseUrl: isCustom ? custom.url.trim() : (entry?.baseUrl ?? ''),
      model: (isCustom ? custom.model : model.trim() || entry?.defaultModel || '').trim(),
      key: apiKey.trim(),
    };
  }

  // Roda o check quando entra em 'validating' (estado já assentado neste ponto).
  useEffect(() => {
    if (step !== 'validating') return;
    const tgt = resolveTarget();
    if (backend !== 'local' || tgt.key === '' || tgt.baseUrl === '' || tgt.model === '') {
      // Sem como validar (broker, ou faltou chave/url/modelo) ⇒ segue sem gate.
      enterMcp();
      return;
    }
    let cancelled = false;
    void checkModelConnectivity(tgt).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setVError('');
        enterMcp();
      } else {
        setVError(r.detail);
        setStep('validate-failed');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Recebe o profile ESCOLHIDO direto (não lê o estado `profile`): o setProfile do
  // handler é assíncrono, então ler `profile` aqui pegaria o valor VELHO (leve) — era o
  // bug "escolhi turbo e foi pra leve". `prof` é a fonte da verdade.
  function finish(prof: Profile, embedderChoice?: string): void {
    const msg: string[] = [];
    const patch: Record<string, unknown> = { lang, backend };
    if (backend === 'local') {
      patch.localProvider = providerId === '__custom__' ? custom.id.trim() : providerId;
      // BUG (relato do dono: "instalei setando outro modelo e ele forçou o mesmo") — o
      // `localModel` SEMPRE é resolvido, nunca deixado por conta do valor anterior.
      //
      // Antes, campo vazio significava "não escreve", e `store.save` é MERGE: numa
      // máquina que JÁ tinha instalação, o `localModel` velho sobrevivia intacto — e a
      // resolução (`model/local/config.ts`) dá precedência a `config.localModel` sobre o
      // `defaultModel` do provider, então o modelo ANTIGO vencia o provider NOVO que o
      // dono acabara de escolher. Em máquina limpa não havia valor velho, então o
      // sintoma só aparecia em reinstalação — que é exatamente como ele o descreveu.
      //
      // Vazio agora cai no default do PROVIDER ESCOLHIDO (a mesma fonte que a resolução
      // usaria se o campo não existisse) — o passo `model` já vem pré-preenchido com ele
      // nos built-ins, então isto só muda o caminho em que o passo não foi percorrido
      // (custom sem modelo digitado). O onboarding DECLARA a configuração: sair dele com
      // provider novo e modelo velho não é um estado que alguém pediu.
      // `undefined` no patch SOBRESCREVE o valor do disco (mecanismo documentado em
      // `user-config.ts:1095`) — ver `resolveOnboardLocalModel` para o porquê.
      patch.localModel = resolveOnboardLocalModel({
        providerId,
        model,
        customModel: custom.model,
      });
    }
    patch.profile = prof;
    // Embedder do mem0 escolhido no turbo (slug do catálogo) → config.embedder. O provisioner/
    // boot puxam/usam este (default bge-m3 se ausente). `embedderChoice` vem direto (estado async).
    if (prof === 'turbo' && embedderChoice !== undefined && embedderChoice !== '') {
      patch.embedder = embedderChoice;
    }
    props.store.save(patch as never);
    msg.push(`✓ ${T('config', 'config')}: backend ${backend}`);

    if (
      backend === 'local' &&
      providerId === '__custom__' &&
      custom.id.trim() !== '' &&
      custom.url.trim() !== ''
    ) {
      try {
        addLocalProviderOverride({
          id: custom.id.trim(),
          wireFormat: 'openai-compat',
          baseUrl: custom.url.trim(),
          defaultModel: custom.model.trim() || custom.id.trim(),
        });
        msg.push(
          T(
            `✓ provider custom "${custom.id.trim()}" registrado`,
            `✓ custom provider "${custom.id.trim()}" registered`,
          ),
        );
      } catch (e) {
        msg.push(`⚠ providers.json: ${String(e)}`);
      }
    }
    if (backend === 'local' && apiKey.trim() !== '') {
      const pid = providerId === '__custom__' ? custom.id.trim() : providerId;
      try {
        storeApiKey(pid, apiKey.trim());
        msg.push(T(`✓ chave de "${pid}" no keychain`, `✓ "${pid}" key in keychain`));
      } catch {
        msg.push(
          T(
            `⚠ keychain indisponível — rode: aluy login --provider ${pid}`,
            `⚠ keychain unavailable — run: aluy login --provider ${pid}`,
          ),
        );
      }
    }
    // MCPs escolhidos (opcional) → registra no ~/.aluy/mcp.json. "Instalar" é registrar:
    // todos rodam via `npx` sob demanda (baixa na 1ª vez). Best-effort: falha não derruba
    // o onboard (a sessão funciona sem MCP); reporta o que entrou.
    const chosenMcps = MCPS.filter((_, i) => mcpSel.has(i));
    if (chosenMcps.length > 0) {
      try {
        const writer = new McpConfigWriter({ file: join(homedir(), '.aluy', 'mcp.json') });
        for (const m of chosenMcps) {
          writer.add(
            { name: m.id, command: m.command, args: [...m.args], env: {} },
            { force: true },
          );
        }
        msg.push(
          T(
            `✓ ${chosenMcps.length} MCP(s) registrado(s): ${chosenMcps.map((m) => m.id).join(', ')}`,
            `✓ ${chosenMcps.length} MCP(s) registered: ${chosenMcps.map((m) => m.id).join(', ')}`,
          ),
        );
      } catch (e) {
        msg.push(`⚠ mcp.json: ${String(e)}`);
      }
    }
    msg.push(`✓ sidecars: ${prof}`);
    if (prof === 'turbo' && embedderChoice !== undefined && embedderChoice !== '') {
      msg.push(`  → embedder: ${embedderChoice}`);
    }
    if (prof === 'turbo')
      msg.push(T('  → instale agora: aluy bootstrap', '  → install now: aluy bootstrap'));
    if (vError !== '')
      msg.push(
        T('⚠ modelo NÃO validado — pode não funcionar', '⚠ model NOT validated — may not work'),
      );
    if (backend === 'broker')
      msg.push(
        T('→ broker: autentique com `aluy login`', '→ broker: authenticate with `aluy login`'),
      );
    setSavedMsg(msg);
    setStep('done');
  }

  useInput((input, key) => {
    if (step === 'done') {
      // F-ONB (fix) — ANTES: `key.return || key.escape || input` ⇒ Enter, Esc e QUALQUER
      // tecla faziam a MESMA coisa (só `app.exit()`), então (a) o `enter p/ entrar no aluy`
      // que a tela promete nunca acontecia e (b) não havia como RECUSAR (nem toque
      // acidental era inofensivo). Agora as três intenções são distintas:
      //   Enter ⇒ abre a sessão (e, no perfil turbo, roda o bootstrap antes);
      //   Esc   ⇒ sai pro shell sem abrir nada;
      //   outra ⇒ IGNORA (não encerra por tecla solta).
      if (key.return) {
        props.onOutcome?.({ launch: true, bootstrap: profile === 'turbo' });
        app.exit();
      } else if (key.escape) {
        props.onOutcome?.({ launch: false, bootstrap: false });
        app.exit();
      }
      return;
    }
    if (step === 'validating') return; // sem input durante o check (async)

    if (step === 'validate-failed') {
      if (key.escape) {
        app.exit();
        return;
      }
      const ch = (input || '').toLowerCase();
      if (key.return || ch === 'r')
        setStep('validating'); // tenta de novo
      else if (ch === 'k')
        gotoText('key', ''); // troca a chave
      else if (ch === 'u' && providerId === '__custom__')
        gotoText('custom-url', custom.url); // troca a baseURL
      else if (ch === 'c') enterMcp(); // segue mesmo assim
      return;
    }

    if (key.escape) {
      app.exit();
      return;
    }

    // MCPs — MULTI-select (opcional): ↑↓ navega · ESPAÇO marca/desmarca · ENTER segue.
    if (step === 'mcp') {
      if (key.upArrow) setMcpCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setMcpCursor((c) => Math.min(MCPS.length - 1, c + 1));
      else if (input === ' ')
        setMcpSel((s) => {
          const n = new Set(s);
          if (n.has(mcpCursor)) n.delete(mcpCursor);
          else n.add(mcpCursor);
          return n;
        });
      else if (key.return) enterSidecars(); // confirma a seleção (mesmo vazia) e segue
      return;
    }

    const isPicker =
      step === 'lang' ||
      step === 'backend' ||
      step === 'provider' ||
      step === 'sidecars' ||
      step === 'embedder';
    if (isPicker) {
      const len = pickerLen(step);
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(len - 1, c + 1));
      else if (key.return) advancePicker();
      return;
    }

    // passos de TEXTO
    if (key.return) {
      advanceText();
      return;
    }
    if (key.backspace || key.delete) {
      setBuf((b) => b.slice(0, -1));
      return;
    }
    if (
      input &&
      !key.ctrl &&
      !key.meta &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow
    ) {
      setBuf((b) => b + input);
    }
  });

  function advancePicker(): void {
    if (step === 'lang') {
      const chosen = LANGS[cursor]!.code;
      props.store.saveLang(chosen);
      setLang(chosen);
      setCursor(0);
      setStep('backend');
    } else if (step === 'backend') {
      const b = backendOpts[cursor]!.value as Backend;
      setBackend(b);
      if (b === 'broker') {
        enterMcp();
      } else {
        setCursor(0);
        setStep('provider');
      }
    } else if (step === 'provider') {
      const v = providerOpts[cursor]!.value;
      setProviderId(v);
      if (v === '__custom__') {
        gotoText('custom-id', '');
      } else {
        // Provider SEM credencial (`auth:['none']`, ex.: Ollama local): PULA o passo da chave
        // — não faz sentido pedir uma chave que não existe — e vai direto p/ o modelo.
        const entry = providers.find((p) => p.id === v);
        const keyless = entry?.auth?.length === 1 && entry.auth[0] === 'none';
        if (keyless) {
          setApiKey('');
          gotoText('model', entry?.defaultModel ?? '');
        } else {
          gotoText('key', '');
        }
      }
    } else if (step === 'sidecars') {
      const chosen = sidecarOpts[cursor]!.value as Profile;
      setProfile(chosen);
      // TURBO ⇒ pergunta o embedder do mem0 antes de fechar; LEVE ⇒ fecha direto.
      if (chosen === 'turbo') {
        setCursor(0); // 1º do catálogo = default (bge-m3)
        setStep('embedder');
      } else {
        finish(chosen);
      }
    } else if (step === 'embedder') {
      const m = embedderOpts[cursor]!.value;
      setEmbedder(m);
      finish('turbo', m); // passa o embedder direto (estado é assíncrono)
    }
  }

  function advanceText(): void {
    const val = buf.trim();
    if (step === 'custom-id') {
      setCustom((c) => ({ ...c, id: val }));
      gotoText('custom-url', '');
    } else if (step === 'custom-url') {
      setCustom((c) => ({ ...c, url: val }));
      gotoText('custom-model', '');
    } else if (step === 'custom-model') {
      setCustom((c) => ({ ...c, model: val }));
      gotoText('key', '');
    } else if (step === 'key') {
      setApiKey(buf);
      // builtin → pergunta modelo (prefill default); custom já tem modelo. Ambos → check.
      if (providerId === '__custom__') setStep('validating');
      else {
        const def = providers.find((p) => p.id === providerId)?.defaultModel ?? '';
        gotoText('model', def);
      }
    } else if (step === 'model') {
      setModel(val);
      setStep('validating');
    }
  }

  const stepNo = (): string => {
    const map: Record<string, string> = {
      lang: '1/8',
      backend: '2/8',
      provider: '3/8',
      'custom-id': '3/8',
      'custom-url': '3/8',
      'custom-model': '3/8',
      key: '4/8',
      model: '5/8',
      validating: '6/8',
      'validate-failed': '6/8',
      mcp: '7/8',
      sidecars: '8/8',
    };
    return map[step] ?? '';
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      {/* MESMA MARCA DO CLI — o onboarding desenhava a <Wordmark> PLANA enquanto o terminal
          abre com a SOMBREADA. Instalar e abrir acontecem no mesmo minuto, e a marca mudava
          de cara entre os dois. Espelha a decisão do <SplashScreen>: 3D só quando o terminal
          comporta (Unicode + largura); senão a plana, que é o fallback fiel.
          `animate={false}` de propósito — aqui a marca é IDENTIDADE, não animação: o brilho
          varrendo competiria com a lista de escolha logo abaixo. */}
      {temMarcaLarga ? <ShadowedWordmark frame={0} animate={false} /> : <Wordmark columns={80} />}
      <Box paddingTop={1}>
        {/* Mostra a VERSÃO que está sendo instalada/configurada na tela do logo (pedido do
            dono): tira a dúvida de "qual versão estou rodando" logo no 1º passo. */}
        <Role name="fgDim">
          aluy v{CLI_VERSION} · {T('configuração inicial', 'first-run setup')}
          {step !== 'done' ? `  ·  ${stepNo()}` : ''}
        </Role>
      </Box>
      <Box paddingTop={1} flexDirection="column">
        {step === 'lang' && (
          <Picker
            title={T('Idioma', 'Language')}
            opts={LANGS.map((l) => ({ value: l.code, label: l.label }))}
            cursor={cursor}
            active={lang}
          />
        )}
        {step === 'backend' && (
          <Picker
            title={T('Backend do modelo', 'Model backend')}
            opts={backendOpts}
            cursor={cursor}
          />
        )}
        {step === 'provider' && (
          <Picker
            title={T('Provider', 'Provider')}
            opts={providerOpts}
            cursor={cursor}
            active={providerId}
          />
        )}
        {step === 'mcp' && (
          <McpPicker
            title={T('MCPs (opcional) — quais instalar?', 'MCPs (optional) — which to install?')}
            entries={MCPS}
            cursor={mcpCursor}
            selected={mcpSel}
            pt={pt}
          />
        )}
        {step === 'sidecars' && (
          <Box flexDirection="column">
            <Picker
              title={T('Complementos (modo turbo)', 'Complements (turbo mode)')}
              opts={sidecarOpts}
              cursor={cursor}
              active={profile}
            />
            <Box paddingTop={1} flexDirection="column">
              <Role name="fgDim">
                {T(
                  'Turbo roda modelos locais (Ollama) + memória — pede uma máquina razoável:',
                  'Turbo runs local models (Ollama) + memory — needs a decent machine:',
                )}
              </Role>
              <Role name="fgDim">
                {T(
                  '  ~8GB+ de RAM, alguns GB de disco e uma boa conexão (baixa o Ollama + modelos).',
                  '  ~8GB+ RAM, a few GB of disk and a good connection (downloads Ollama + models).',
                )}
              </Role>
              <Role name="fgDim">
                {T(
                  '  Em máquina fraca, escolha Leve — o aluy funciona normal e você liga o turbo depois.',
                  '  On a weak machine, pick Lite — aluy works fine and you can enable turbo later.',
                )}
              </Role>
            </Box>
          </Box>
        )}
        {step === 'embedder' && (
          <Box flexDirection="column">
            <Picker
              title={T('Modelo de embedding (memória)', 'Embedding model (memory)')}
              opts={embedderOpts}
              cursor={cursor}
              active={embedder}
            />
            <Box paddingTop={1} flexDirection="column">
              <Role name="fgDim">
                {T(
                  'O embedder transforma suas memórias em vetores p/ o recall semântico do mem0.',
                  'The embedder turns your memories into vectors for mem0’s semantic recall.',
                )}
              </Role>
              <Role name="fgDim">
                {T(
                  '  bge-m3 é o mais forte (multilíngue, melhor em PT) — porém o maior download.',
                  '  bge-m3 is the strongest (multilingual) — but the biggest download.',
                )}
              </Role>
            </Box>
          </Box>
        )}

        {step === 'custom-id' && (
          // Defeito 2 (relato do dono) — "tokenrouter" aqui era só EXEMPLO deste campo
          // livre, mas por ser nome de produto REAL (e ecoado por um card do site
          // apontando pra tokenrouter.com) lia como se fosse opção suportada no /provider.
          // Trocado por um placeholder obviamente genérico — sem mudar a lista real
          // (que já vem, sem dessincronia, de `loadLocalProviderCatalog().entries`).
          <TextRow
            label={T('id do provider (ex.: meu-provider)', 'provider id (e.g. my-provider)')}
            value={buf}
          />
        )}
        {step === 'custom-url' && (
          <TextRow label={T('base URL (https, .../v1)', 'base URL (https, .../v1)')} value={buf} />
        )}
        {step === 'custom-model' && (
          <TextRow label={T('modelo default', 'default model')} value={buf} />
        )}
        {step === 'key' && (
          <TextRow
            label={T(
              `API key de ${providerId === '__custom__' ? custom.id : providerId} (oculta)`,
              `${providerId === '__custom__' ? custom.id : providerId} API key (hidden)`,
            )}
            value={buf}
            mask
          />
        )}
        {step === 'model' && (
          <Box flexDirection="column">
            <TextRow label={T('modelo (enter = default)', 'model (enter = default)')} value={buf} />
            {(() => {
              const sugg = providers.find((p) => p.id === providerId)?.models ?? [];
              return sugg.length > 0 ? (
                <Box paddingTop={1}>
                  <Role name="fgDim">{T('sugestões: ', 'suggestions: ') + sugg.join(' · ')}</Role>
                </Box>
              ) : null;
            })()}
          </Box>
        )}

        {step === 'validating' && (
          <Box flexDirection="column">
            <Role name="fg">{T('Testando o modelo…', 'Testing the model…')}</Role>
            <Box paddingTop={1}>
              <Role name="fgDim">
                {T(
                  'chamada real ao provider (não prossigo se falhar)',
                  "real call to the provider (won't proceed if it fails)",
                )}
              </Role>
            </Box>
          </Box>
        )}

        {step === 'validate-failed' && (
          <Box flexDirection="column">
            <Role name="fg">{T('✗ o modelo NÃO respondeu', '✗ the model did NOT respond')}</Role>
            <Box paddingTop={1}>
              <Role name="fgDim">{vError}</Role>
            </Box>
            <Box paddingTop={1}>
              <Role name="fgDim">
                {T('enter/r tentar de novo · k trocar chave', 'enter/r retry · k change key')}
                {providerId === '__custom__' ? T(' · u trocar baseURL', ' · u change baseURL') : ''}
                {T(' · c seguir mesmo assim · esc sair', ' · c continue anyway · esc quit')}
              </Role>
            </Box>
          </Box>
        )}

        {step === 'done' && (
          <Box flexDirection="column">
            {savedMsg.map((m, i) => (
              <Role key={i} name={m.startsWith('⚠') ? 'fg' : 'accent'}>
                {m}
              </Role>
            ))}
            <Box paddingTop={1}>
              <Role name="fgDim">{T('enter p/ entrar no aluy', 'enter to launch aluy')}</Role>
            </Box>
          </Box>
        )}
      </Box>
      {step !== 'done' && step !== 'validating' && step !== 'validate-failed' && (
        <Box paddingTop={1}>
          <Role name="fgDim">
            {step === 'lang' ||
            step === 'backend' ||
            step === 'provider' ||
            step === 'sidecars' ||
            step === 'embedder'
              ? `↑↓ ${T('navegar', 'move')} · enter ${T('escolher', 'select')} · esc ${T('sair', 'quit')}`
              : `${T('digite', 'type')} · enter ${T('confirmar', 'confirm')} · esc ${T('sair', 'quit')}`}
          </Role>
        </Box>
      )}
    </Box>
  );
}

function Picker(props: {
  readonly title: string;
  readonly opts: readonly Opt[];
  readonly cursor: number;
  readonly active?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Role name="fg">{props.title}</Role>
      <Box flexDirection="column" paddingTop={1}>
        {props.opts.map((o, i) => (
          <Box key={o.value}>
            <Role name={i === props.cursor ? 'accent' : 'fgDim'}>
              {i === props.cursor ? '❯ ' : '  '}
            </Role>
            <Role name={i === props.cursor ? 'accent' : 'fg'}>{o.label}</Role>
            {o.hint ? <Role name="fgDim"> · {o.hint}</Role> : null}
            {props.active !== undefined && o.value === props.active ? (
              <Role name="fgDim"> ●</Role>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** MULTI-select dos MCPs (opcional): checkbox por item + dica de controles. */
function McpPicker(props: {
  readonly title: string;
  readonly entries: readonly McpEntry[];
  readonly cursor: number;
  readonly selected: ReadonlySet<number>;
  readonly pt: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Role name="fg">{props.title}</Role>
      <Box flexDirection="column" paddingTop={1}>
        {props.entries.map((m, i) => {
          const on = props.selected.has(i);
          const cur = i === props.cursor;
          return (
            <Box key={m.id}>
              <Role name={cur ? 'accent' : 'fgDim'}>{cur ? '❯ ' : '  '}</Role>
              <Role name={on ? 'accent' : 'fgDim'}>{on ? '[x] ' : '[ ] '}</Role>
              <Role name={cur ? 'accent' : 'fg'}>{m.label}</Role>
              <Role name="fgDim"> · {props.pt ? m.hintPt : m.hintEn}</Role>
            </Box>
          );
        })}
      </Box>
      <Box paddingTop={1}>
        <Role name="fgDim">
          {props.pt
            ? 'ESPAÇO marca/desmarca · ENTER segue (pode seguir sem nenhum) · baixam na 1ª vez (npx/uvx)'
            : 'SPACE toggles · ENTER continues (none is fine) · fetched on first use (npx/uvx)'}
        </Role>
      </Box>
    </Box>
  );
}

function TextRow(props: {
  readonly label: string;
  readonly value: string;
  readonly mask?: boolean;
}): React.ReactElement {
  const shown = props.mask ? '•'.repeat(props.value.length) : props.value;
  return (
    <Box>
      <Role name="fg">{props.label}: </Role>
      <Role name="accent">{shown}</Role>
      <Role name="accent">▏</Role>
    </Box>
  );
}

/** Lança o onboard (Ink) e resolve quando o usuário sai. Retorna o exit code. */
export async function runOnboard(): Promise<OnboardOutcome> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(
      'aluy onboard precisa de um terminal interativo.\n' +
        'Abra um terminal e rode:  aluy onboard\n',
    );
    return { code: 0, launch: false, bootstrap: false };
  }
  const store = new UserConfigStore();
  const theme = resolveTheme({});
  // Default RECUSA: se o Ink sair por qualquer via que não seja o Enter da tela final
  // (ctrl-c, erro de render, `unmount` externo), NÃO abrimos nada — abrir sessão é ato
  // pedido, nunca consequência de um encerramento qualquer.
  let outcome = { launch: false, bootstrap: false };
  const instance = render(
    <ThemeProvider theme={theme}>
      <OnboardApp
        store={store}
        onOutcome={(o) => {
          outcome = o;
        }}
      />
    </ThemeProvider>,
  );
  await instance.waitUntilExit();
  return { code: 0, ...outcome };
}
