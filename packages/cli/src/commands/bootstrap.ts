// EST-1133 / ADR-0130 — `aluy bootstrap`: provisionamento explícito de sidecars user-space.
//
// Dispara o provisionamento de runtimes (Ollama, Mem0) em ~/.aluy/
// quando o perfil é TURBO (default). LEVE não provisiona nada.
// Passo EXPLÍCITO — NUNCA roda no boot automático (CA-G2-11).
//
// EST-1133-wizard — wizard de 1ª execução: antes de provisionar, verifica se há
// provider+modelo+chave configurados (necessários p/ o `--agent` usar o LLM). Se
// faltar, entra num wizard interativo que pergunta provider, chave e modelo.

import { Entry } from '@napi-rs/keyring';
import { UserConfigStore } from '../io/user-config.js';
import { runProvisioner } from '../provisioner/sidecar-provisioner.js';
import {
  storeApiKey,
  apiKeyAccount,
  LOCAL_KEYCHAIN_SERVICE,
  type KeyringEntry,
} from '../model/local/credential-resolver.js';
import type { LocalProviderKind } from '@hiperplano/aluy-cli-core';

const VALID_PROVIDERS: readonly LocalProviderKind[] = ['anthropic', 'openrouter', 'openai'];

/** Interface de prompt injetável (testes). Espelha o `TerminalIO` de auth/io.ts. */
export interface WizardPrompt {
  (question: string, opts?: { secret?: boolean }): Promise<string>;
}

/**
 * Wizard de 1ª execução: garante provider + chave + modelo LOCAIS configurados.
 *
 * Verifica:
 *  - `config.localProvider` presente?
 *  - `config.localModel` presente?
 *  - chave de API no keychain p/ o provider?
 *
 * Se TUDO presente ⇒ no-op (idempotente).
 * Se NÃO-interativo (sem TTY, `--yes`, headless) ⇒ reporta o que falta e instrui,
 *   sem pendurar.
 * Se interativo ⇒ pergunta provider → chave → modelo, grava no keychain + config.
 *
 * @returns `true` se o wizard seguiu p/ provisionamento; `false` se o usuário
 *          desistiu / não-interativo sem config completa.
 */
export async function runFirstRunWizard(opts: {
  config: ReturnType<UserConfigStore['load']>;
  configStore: UserConfigStore;
  prompt: WizardPrompt;
  out: (line: string) => void;
  err: (line: string) => void;
  entryFactory?: (service: string, account: string) => KeyringEntry;
  isInteractive: boolean;
}): Promise<boolean> {
  const { config, configStore, prompt, out, err, entryFactory, isInteractive } = opts;

  const hasProvider = config.localProvider !== undefined;
  const hasModel = config.localModel !== undefined;

  // Verifica se há chave no keychain.
  let hasKey = false;
  let currentProvider: LocalProviderKind | undefined = config.localProvider;
  if (currentProvider) {
    try {
      const e = (entryFactory ?? defaultEntryFactory)(
        LOCAL_KEYCHAIN_SERVICE,
        apiKeyAccount(currentProvider),
      );
      const v = e.getPassword();
      hasKey = v !== '' && v !== undefined;
    } catch {
      // chave não encontrada ou keychain indisponível
    }
  }

  if (hasProvider && hasModel && hasKey) {
    return true; // tudo pronto, segue p/ provisionamento
  }

  if (!isInteractive) {
    // Não-interativo: reporta e instrui, sem pendurar.
    err('aluy bootstrap: configuração de 1ª execução necessária (provider + chave + modelo).');
    if (!hasProvider) err('  ✗ Falta provider local em ~/.aluy/config.json.');
    if (!hasModel) err('  ✗ Falta modelo local em ~/.aluy/config.json.');
    if (!hasKey) err('  ✗ Falta chave de API no keychain do SO.');
    err('');
    err('  Rode `aluy bootstrap` interativamente (num terminal com TTY) para o wizard,');
    err('  ou configure manualmente:');
    err(
      '    1. `aluy login --provider <anthropic|openrouter|openai>`  (grava a chave no keychain)',
    );
    err('    2. Edite ~/.aluy/config.json e adicione:');
    err('       "localProvider": "<provider>",');
    err('       "localModel": "<modelo-nativo>"');
    err('');
    return false;
  }

  // ── Wizard interativo ──────────────────────────────────────────────────────
  out('');
  out('╔══════════════════════════════════════════════════════════════╗');
  out('║  Configuração de 1ª execução — provider + chave + modelo   ║');
  out('╚══════════════════════════════════════════════════════════════╝');
  out('');
  out('O `aluy bootstrap --agent` usa um modelo de linguagem para instalar');
  out('dependências. Precisamos de provider, chave de API e modelo.');
  out('(As credenciais ficam no keychain do SO — nunca em texto.)');
  out('');

  // Passo 1 — Provider.
  if (!hasProvider) {
    const answer = (await prompt(`Provider (${VALID_PROVIDERS.join('/')}): `)).trim().toLowerCase();
    if (!(VALID_PROVIDERS as readonly string[]).includes(answer)) {
      err(`Provider inválido "${answer}". Use: ${VALID_PROVIDERS.join(', ')}.`);
      return false;
    }
    currentProvider = answer as LocalProviderKind;
    out('');
  } else {
    out(`Provider: ${currentProvider} (já configurado)`);
  }

  // Passo 2 — Chave de API.
  if (!hasKey) {
    // currentProvider é garantido não-undefined após passo 1 ou config.
    const provider = currentProvider!;
    const key = (await prompt(`API key de ${provider}: `, { secret: true })).trim();
    if (key === '') {
      err('Chave vazia — abortando.');
      return false;
    }
    try {
      storeApiKey(provider, key, entryFactory);
      out('✓ Chave guardada no keychain do SO.');
    } catch (e) {
      err(`Falha ao gravar no keychain: ${e instanceof Error ? e.message : String(e)}`);
      err('(Por segurança, a credencial nunca é gravada em texto. Instale o Secret Service no Linux.)');
      return false;
    }
    out('');
  } else {
    out('✓ Chave já está no keychain.');
  }

  // Passo 3 — Modelo.
  if (!hasModel) {
    const provider = currentProvider!;
    const model = (await prompt(`Modelo nativo (ex.: claude-sonnet-4-8): `)).trim();
    if (model === '') {
      err('Modelo vazio — abortando.');
      return false;
    }
    configStore.save({
      localProvider: provider as 'anthropic' | 'openrouter' | 'openai',
      localModel: model,
    });
    out(`✓ Provider "${provider}" + modelo "${model}" salvos em ~/.aluy/config.json.`);
    out('');
  }

  out('Configuração concluída. Seguindo para o provisionamento…');
  out('');
  return true;
}

/** Fábrica padrão de Entry do keychain (produção). */
function defaultEntryFactory(service: string, account: string): KeyringEntry {
  return new Entry(service, account) as unknown as KeyringEntry;
}

/**
 * Roda o `aluy bootstrap`.
 *
 * 1. Wizard de 1ª execução (provider+chave+modelo), SE necessário.
 * 2. Lê perfil/toggles de ~/.aluy/config.json.
 * 3. Se LEVE ⇒ informa e sai (sem provisionar).
 * 4. Se TURBO ⇒ provisiona sidecars conforme toggles.
 * 5. Reporta resultado ao usuário.
 *
 * @param out - Função de saída (stdout).
 * @param err - Função de erro (stderr).
 * @returns Exit code (0 = sucesso, 1 = falha total).
 */
export async function runInit(opts: {
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * EST-1133-bis — habilita a DELEGAÇÃO ao agente (`--agent`) quando o SO não tem
   * artefato pinado (não-Linux). Sem isso, em SO não-Linux o provisionador instrui
   * em vez de tentar baixar o artefato Linux errado.
   */
  agent?: boolean;
  /**
   * Prompt interativo p/ o wizard (testes injetam mock). Ausente ⇒ wizard
   * roda em modo NÃO-interativo (reporta e instrui).
   */
  prompt?: WizardPrompt;
  /**
   * Fábrica de Entry do keychain (testes). Default: `@napi-rs/keyring`.
   */
  entryFactory?: (service: string, account: string) => KeyringEntry;
  /**
   * Override do config store (testes). Default: `~/.aluy/config.json` real.
   */
  configStore?: UserConfigStore;
  /**
   * Força modo interativo/não-interativo (default: `process.stdin.isTTY`).
   */
  isInteractive?: boolean;
}): Promise<number> {
  const { out, err } = opts;

  // Lê config (fail-safe: ausente/corrompido ⇒ defaults).
  const configStore = opts.configStore ?? new UserConfigStore();
  let profile: 'turbo' | 'leve' | undefined;
  let sidecarToggles: { ollama?: boolean; mem0?: boolean } | undefined;
  let config: ReturnType<UserConfigStore['load']>;
  try {
    config = configStore.load();
    profile = config.profile;
    sidecarToggles = config.sidecarToggles;
  } catch {
    config = {};
    // fail-safe: defaults
  }

  // ── Wizard de 1ª execução ─────────────────────────────────────────────────
  const isInteractive =
    opts.isInteractive !== undefined
      ? opts.isInteractive
      : process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (opts.prompt !== undefined || !isInteractive) {
    // Só roda o wizard com prompt explícito OU em não-interativo (p/ reportar).
    const promptFn = opts.prompt ?? (async () => '');
    const ok = await runFirstRunWizard({
      config,
      configStore,
      prompt: promptFn,
      out,
      err,
      ...(opts.entryFactory !== undefined ? { entryFactory: opts.entryFactory } : {}),
      isInteractive,
    });
    if (!ok) {
      return 0; // wizard reportou o que falta (não-interativo) ou usuário desistiu
    }
  }

  out('O Aluy CLI já está instalado e pronto para uso.');
  out('');
  out('Esta etapa instala os COMPLEMENTOS opcionais (modo turbo): memória, modelos');
  out('locais e gestão de contexto. Eles enriquecem a experiência, mas não são');
  out('obrigatórios — se algum não instalar, você usa o Aluy CLI normalmente sem ele.');
  out('');
  out(`  Perfil escolhido: ${profile ?? 'turbo'}`);

  if (profile === 'leve') {
    out('  Perfil LEVE: nenhum complemento será instalado — o Aluy CLI já está pronto.');
    out('  Para instalá-los depois, rode `aluy bootstrap` ou troque para o perfil turbo.');
    return 0;
  }

  // EST-1133-bis — SO não-Linux: sem artefato pinado. Com `--agent`, o aluy instala
  // via o PRÓPRIO agente (⚠ --yolo). Sem a flag, instrui (sem tentar baixar errado).
  const isLinux = process.platform === 'linux';
  if (!isLinux) {
    if (opts.agent) {
      out(
        `  Sistema ${process.platform}: os componentes serão instalados pelo próprio aluy.`,
      );
      out(
        '  (No Linux há um pacote único já verificado; nos demais sistemas a instalação é assistida.)',
      );
    } else {
      out(
        `  Sistema ${process.platform}: a instalação automática dos componentes está, por ora,`,
      );
      out('  disponível só no Linux. Você tem duas opções:');
      out('   • `aluy bootstrap --agent` — o aluy instala sozinho (acesso total à máquina); ou');
      out('   • instalar manualmente. Instalar o Ollama para Windows já basta — ele sobe');
      out('     em :11434 e o aluy detecta sozinho.');
      return 0;
    }
  }

  out('  Instalando os complementos (você verá o progresso de cada um abaixo)...');
  out('');

  const result = await runProvisioner(profile, sidecarToggles, {
    useAgent: opts.agent === true,
  });

  for (const t of result.targets) {
    const icon = t.installed ? '✓' : '✗';
    out(`  ${icon} ${t.target}: ${t.message}`);
  }

  out('');

  if (result.anySuccess) {
    out('Complementos instalados. O Aluy CLI está pronto, agora com o modo turbo.');
    if (result.allFailed) {
      out('Observação: alguns complementos não instalaram — o Aluy CLI funciona sem eles.');
    }
    return 0;
  }

  if (result.targets.length === 0) {
    out('Nenhum complemento a instalar — o Aluy CLI já está pronto.');
    return 0;
  }

  err('Nenhum complemento foi instalado agora — sem problema, o Aluy CLI funciona');
  err('normalmente. Você pode tentar de novo depois com `aluy bootstrap`.');
  return 1;
}
