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
import { Wordmark } from '../ui/components/Wordmark.js';
import { Role, ThemeProvider, resolveTheme } from '../ui/theme/index.js';
import { LANGS, type Lang } from '../i18n/lang.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UserConfigStore } from '../io/user-config.js';
import { loadLocalProviderCatalog, addLocalProviderOverride } from '../io/providers-config.js';
import { storeApiKey } from '../model/local/credential-resolver.js';
import { checkModelConnectivity } from '../model/local/connectivity-check.js';
import { McpConfigWriter } from '../mcp/mcp-config-writer.js';

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
export function mcpCatalog(): McpEntry[] {
  return [
    { id: 'playwright', label: 'Playwright', hintPt: 'automação de navegador (oficial)', hintEn: 'browser automation (official)', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    { id: 'sequential-thinking', label: 'Sequential Thinking', hintPt: 'raciocínio passo-a-passo', hintEn: 'step-by-step reasoning', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    { id: 'memory', label: 'Memory', hintPt: 'grafo de conhecimento persistente', hintEn: 'persistent knowledge graph', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    { id: 'filesystem', label: 'Filesystem', hintPt: 'arquivos (escopo: sua home)', hintEn: 'files (scope: your home)', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', homedir()] },
  ];
}

type Backend = 'broker' | 'local';
type Profile = 'turbo' | 'leve';

interface Opt {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

function OnboardApp(props: { readonly store: UserConfigStore }): React.ReactElement {
  const app = useApp();
  const cfg = props.store.load();
  const providers = useMemo(() => loadLocalProviderCatalog().entries, []);

  const [step, setStep] = useState<Step>('lang');
  const [lang, setLang] = useState<Lang>(cfg.lang ?? 'pt-BR');
  const [backend, setBackend] = useState<Backend>('local');
  const [providerId, setProviderId] = useState<string>('anthropic');
  const [custom, setCustom] = useState<{ id: string; url: string; model: string }>({ id: '', url: '', model: '' });
  const [apiKey, setApiKey] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [profile, setProfile] = useState<Profile>('leve'); // default LEVE (decisão do dono)
  const [vError, setVError] = useState<string>(''); // detalhe do check de conectividade falho

  const MCPS = useMemo(() => mcpCatalog(), []);
  const [mcpSel, setMcpSel] = useState<ReadonlySet<number>>(new Set()); // MCPs marcados (multi-select, opcional)
  const [mcpCursor, setMcpCursor] = useState<number>(0);

  const [cursor, setCursor] = useState<number>(Math.max(0, LANGS.findIndex((l) => l.code === lang)));
  const [buf, setBuf] = useState<string>('');
  const [savedMsg, setSavedMsg] = useState<string[]>([]);

  const pt = lang === 'pt-BR';
  const T = (p: string, e: string): string => (pt ? p : e);

  const backendOpts: Opt[] = [
    { value: 'local', label: T('Local (sua chave / BYO)', 'Local (your key / BYO)'), hint: T('direto no provider', 'direct to provider') },
    { value: 'broker', label: T('Broker (conta Aluy)', 'Broker (Aluy account)'), hint: T('autentica depois com aluy login', 'authenticate later with aluy login') },
  ];
  const providerOpts: Opt[] = [
    ...providers.map((e) => ({ value: e.id, label: e.label, hint: e.defaultModel })),
    { value: '__custom__', label: T('+ custom (OpenAI-compatível)', '+ custom (OpenAI-compatible)'), hint: T('ex.: TokenRouter, vLLM…', 'e.g. TokenRouter, vLLM…') },
  ];
  const sidecarOpts: Opt[] = [
    { value: 'turbo', label: T('Turbo — instala tudo', 'Turbo — install all'), hint: 'ollama + mem0 + headroom' },
    { value: 'leve', label: T('Leve — nada agora', 'Lite — nothing now'), hint: T('liga depois com aluy bootstrap', 'enable later with aluy bootstrap') },
  ];

  const pickerLen = (s: Step): number =>
    s === 'lang' ? LANGS.length : s === 'backend' ? backendOpts.length : s === 'provider' ? providerOpts.length : s === 'sidecars' ? sidecarOpts.length : 0;

  function gotoText(next: Step, prefill = ''): void {
    setBuf(prefill);
    setStep(next);
  }

  // Abre o passo de sidecars com LEVE pré-selecionado (decisão do dono): o cursor
  // ancora no índice de 'leve', não no topo. Usado em TODAS as entradas em 'sidecars'.
  function enterSidecars(): void {
    setCursor(Math.max(0, sidecarOpts.findIndex((o) => o.value === 'leve')));
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
  function finish(prof: Profile): void {
    const msg: string[] = [];
    const patch: Record<string, unknown> = { lang, backend };
    if (backend === 'local') {
      patch.localProvider = providerId === '__custom__' ? custom.id.trim() : providerId;
      const chosenModel = providerId === '__custom__' ? custom.model : model;
      if (chosenModel.trim() !== '') patch.localModel = chosenModel.trim();
    }
    patch.profile = prof;
    props.store.save(patch as never);
    msg.push(`✓ ${T('config', 'config')}: backend ${backend}`);

    if (backend === 'local' && providerId === '__custom__' && custom.id.trim() !== '' && custom.url.trim() !== '') {
      try {
        addLocalProviderOverride({
          id: custom.id.trim(),
          wireFormat: 'openai-compat',
          baseUrl: custom.url.trim(),
          defaultModel: custom.model.trim() || custom.id.trim(),
        });
        msg.push(T(`✓ provider custom "${custom.id.trim()}" registrado`, `✓ custom provider "${custom.id.trim()}" registered`));
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
        msg.push(T(`⚠ keychain indisponível — rode: aluy login --provider ${pid}`, `⚠ keychain unavailable — run: aluy login --provider ${pid}`));
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
          writer.add({ name: m.id, command: m.command, args: [...m.args], env: {} }, { force: true });
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
    if (prof === 'turbo') msg.push(T('  → instale agora: aluy bootstrap', '  → install now: aluy bootstrap'));
    if (vError !== '') msg.push(T('⚠ modelo NÃO validado — pode não funcionar', '⚠ model NOT validated — may not work'));
    if (backend === 'broker') msg.push(T('→ broker: autentique com `aluy login`', '→ broker: authenticate with `aluy login`'));
    setSavedMsg(msg);
    setStep('done');
  }

  useInput((input, key) => {
    if (step === 'done') {
      if (key.return || key.escape || input) app.exit();
      return;
    }
    if (step === 'validating') return; // sem input durante o check (async)

    if (step === 'validate-failed') {
      if (key.escape) {
        app.exit();
        return;
      }
      const ch = (input || '').toLowerCase();
      if (key.return || ch === 'r') setStep('validating'); // tenta de novo
      else if (ch === 'k') gotoText('key', ''); // troca a chave
      else if (ch === 'u' && providerId === '__custom__') gotoText('custom-url', custom.url); // troca a baseURL
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

    const isPicker = step === 'lang' || step === 'backend' || step === 'provider' || step === 'sidecars';
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
    if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
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
      if (v === '__custom__') gotoText('custom-id', '');
      else gotoText('key', '');
    } else if (step === 'sidecars') {
      const chosen = sidecarOpts[cursor]!.value as Profile;
      setProfile(chosen);
      finish(chosen);
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
      lang: '1/8', backend: '2/8', provider: '3/8', 'custom-id': '3/8', 'custom-url': '3/8', 'custom-model': '3/8',
      key: '4/8', model: '5/8', validating: '6/8', 'validate-failed': '6/8', mcp: '7/8', sidecars: '8/8',
    };
    return map[step] ?? '';
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      <Wordmark columns={80} />
      <Box paddingTop={1}>
        <Role name="fgDim">{T('configuração inicial', 'first-run setup')}{step !== 'done' ? `  ·  ${stepNo()}` : ''}</Role>
      </Box>
      <Box paddingTop={1} flexDirection="column">
        {step === 'lang' && <Picker title={T('Idioma', 'Language')} opts={LANGS.map((l) => ({ value: l.code, label: l.label }))} cursor={cursor} active={lang} />}
        {step === 'backend' && <Picker title={T('Backend do modelo', 'Model backend')} opts={backendOpts} cursor={cursor} />}
        {step === 'provider' && <Picker title={T('Provider', 'Provider')} opts={providerOpts} cursor={cursor} active={providerId} />}
        {step === 'mcp' && (
          <McpPicker
            title={T('MCPs (opcional) — quais instalar?', 'MCPs (optional) — which to install?')}
            entries={MCPS}
            cursor={mcpCursor}
            selected={mcpSel}
            pt={pt}
          />
        )}
        {step === 'sidecars' && <Picker title={T('Sidecars', 'Sidecars')} opts={sidecarOpts} cursor={cursor} active={profile} />}

        {step === 'custom-id' && <TextRow label={T('id do provider (ex.: tokenrouter)', 'provider id (e.g. tokenrouter)')} value={buf} />}
        {step === 'custom-url' && <TextRow label={T('base URL (https, .../v1)', 'base URL (https, .../v1)')} value={buf} />}
        {step === 'custom-model' && <TextRow label={T('modelo default', 'default model')} value={buf} />}
        {step === 'key' && <TextRow label={T(`API key de ${providerId === '__custom__' ? custom.id : providerId} (oculta)`, `${providerId === '__custom__' ? custom.id : providerId} API key (hidden)`)} value={buf} mask />}
        {step === 'model' && <TextRow label={T('modelo (enter = default)', 'model (enter = default)')} value={buf} />}

        {step === 'validating' && (
          <Box flexDirection="column">
            <Role name="fg">{T('Testando o modelo…', 'Testing the model…')}</Role>
            <Box paddingTop={1}>
              <Role name="fgDim">{T('chamada real ao provider (não prossigo se falhar)', 'real call to the provider (won\'t proceed if it fails)')}</Role>
            </Box>
          </Box>
        )}

        {step === 'validate-failed' && (
          <Box flexDirection="column">
            <Role name="fg">{T('✗ o modelo NÃO respondeu', '✗ the model did NOT respond')}</Role>
            <Box paddingTop={1}><Role name="fgDim">{vError}</Role></Box>
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
              <Role key={i} name={m.startsWith('⚠') ? 'fg' : 'accent'}>{m}</Role>
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
            {step === 'lang' || step === 'backend' || step === 'provider' || step === 'sidecars'
              ? `↑↓ ${T('navegar', 'move')} · enter ${T('escolher', 'select')} · esc ${T('sair', 'quit')}`
              : `${T('digite', 'type')} · enter ${T('confirmar', 'confirm')} · esc ${T('sair', 'quit')}`}
          </Role>
        </Box>
      )}
    </Box>
  );
}

function Picker(props: { readonly title: string; readonly opts: readonly Opt[]; readonly cursor: number; readonly active?: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Role name="fg">{props.title}</Role>
      <Box flexDirection="column" paddingTop={1}>
        {props.opts.map((o, i) => (
          <Box key={o.value}>
            <Role name={i === props.cursor ? 'accent' : 'fgDim'}>{i === props.cursor ? '❯ ' : '  '}</Role>
            <Role name={i === props.cursor ? 'accent' : 'fg'}>{o.label}</Role>
            {o.hint ? <Role name="fgDim"> · {o.hint}</Role> : null}
            {props.active !== undefined && o.value === props.active ? <Role name="fgDim"> ●</Role> : null}
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
            ? 'ESPAÇO marca/desmarca · ENTER segue (pode seguir sem nenhum) · todos via npx'
            : 'SPACE toggles · ENTER continues (none is fine) · all via npx'}
        </Role>
      </Box>
    </Box>
  );
}

function TextRow(props: { readonly label: string; readonly value: string; readonly mask?: boolean }): React.ReactElement {
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
export async function runOnboard(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(
      'aluy onboard precisa de um terminal interativo.\n' + 'Abra um terminal e rode:  aluy onboard\n',
    );
    return 0;
  }
  const store = new UserConfigStore();
  const theme = resolveTheme({});
  const instance = render(
    <ThemeProvider theme={theme}>
      <OnboardApp store={store} />
    </ThemeProvider>,
  );
  await instance.waitUntilExit();
  return 0;
}
