// Orquestração de login/logout/whoami — PORTÁVEL (store e prompt injetados).
//
// Junta: IdentityClient (rede) + CredentialStore (keychain, injetado) +
// device-flow (polling) + PAT. NÃO faz I/O de terminal: o @hiperplano/aluy-cli é quem
// renderiza o prompt e lê o PAT. Nenhum segredo é logado/retornado aqui — só
// a forma redigida (CLI-SEC-2/10).

import {
  redactCredential,
  type CredentialStore,
  type RedactedCredential,
} from './credential-store.js';
import { runDeviceFlow, type DevicePrompt } from './device-flow.js';
import {
  IdentityHttpError,
  InvalidPatError,
  RefreshUnavailableError,
  SessionExpiredError,
} from './errors.js';
import { IdentityClient, type IdentityClientOptions } from './identity-client.js';
import { isPat } from './pat.js';
import {
  DEFAULT_HEADLESS_SCOPES,
  type HeadlessScope,
  type HeadlessTokenResponse,
  type StoredCredential,
} from './types.js';

export interface LoginServiceOptions extends IdentityClientOptions {
  readonly store: CredentialStore;
}

/**
 * O erro do `client.refresh` é uma REJEIÇÃO DEFINITIVA do refresh_token (e portanto
 * a credencial deve ser apagada + re-login)? Só quando o identity RESPONDEU recusando
 * a troca: 400 (`invalid_grant` — rotacionado/reuse/expirado), 401 ou 403. Qualquer
 * outra coisa — 5xx/429 (identity instável) ou erro de rede/timeout (o `doFetch`
 * lança cru, NÃO um `IdentityHttpError`) — é TRANSITÓRIA: o refresh_token pode estar
 * perfeitamente válido; um blip não pode destruir a sessão. PURO/testável.
 */
function isDefinitiveRefreshRejection(err: unknown): boolean {
  return (
    err instanceof IdentityHttpError &&
    (err.status === 400 || err.status === 401 || err.status === 403)
  );
}

/** Converte o par de tokens do device-flow numa credencial persistível. */
function credentialFromTokens(tokens: HeadlessTokenResponse, now: () => number): StoredCredential {
  return {
    kind: 'device',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    organization_id: tokens.organization_id,
    scopes: tokens.scope.split(' ').filter(Boolean),
    expires_at: now() + tokens.expires_in * 1000,
    v: 1,
  };
}

export interface DeviceLoginArgs {
  readonly organizationId: string;
  readonly scopes?: readonly HeadlessScope[];
  readonly onPrompt: (prompt: DevicePrompt) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

export class LoginService {
  private readonly client: IdentityClient;
  private readonly store: CredentialStore;
  private readonly now: () => number;
  /**
   * HUNT-IO-NET — `sleep` injetável repassado ao device-flow. Sem isto, o
   * `loginWithDeviceFlow` usava SEMPRE o sleep real ⇒ um teste com `interval` no
   * piso de 1s esperava 1s de relógio REAL (e antes, com a fragilidade `interval:0`
   * = sleep(0), mascarava o hot-loop). Injetável = teste determinístico sem timer.
   */
  private readonly sleep: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /**
   * FALLBACK do PAT do AMBIENTE (`ALUY_TOKEN`) — injetado pelo @hiperplano/aluy-cli (portável:
   * o core NÃO lê `process.env`). Consumido por `getAccessToken` SÓ quando o
   * keychain está VAZIO: o caminho headless/CI documentado é `export ALUY_TOKEN=…`
   * SEM rodar `aluy login`, e o boot já trata `ALUY_TOKEN` presente como "logado"
   * (`isLoggedOut`). Sem este fallback, esse usuário passava o check de boot mas a
   * 1ª chamada ao broker estourava `SessionExpiredError` ("sessão expirou — rode
   * aluy login") — enganoso: não há sessão expirada e o token FOI fornecido. Aqui o
   * env-PAT vira a credencial efetiva da chamada. NUNCA logamos o valor (CLI-SEC-2).
   */
  private readonly envToken: (() => string | undefined) | undefined;
  /**
   * SINGLE-FLIGHT do refresh rotativo (CLI-SEC-1). O refresh é ROTATIVO: cada
   * sucesso INVALIDA o refresh_token anterior e a próxima reutilização dele é
   * tratada pelo identity como REUSE-DETECTION ⇒ revoga a família inteira. Sem
   * coalescência, N chamadas concorrentes de `getAccessToken` (sub-agentes
   * paralelos, stream+tool, boot carregando catálogo/quota/modelos em paralelo)
   * leem a MESMA credencial expirada e disparam N refresh com o MESMO
   * refresh_token: o 1º rotaciona, os demais batem reuse ⇒ `store.clear()` APAGA
   * a credencial recém-rotacionada e a sessão MORRE (re-login espúrio). Aqui
   * guardamos a promessa do refresh em voo; os concorrentes AGUARDAM o mesmo
   * resultado em vez de refazer a rede. NÃO guarda token — só a promessa efêmera.
   */
  private inFlightRefresh: Promise<string> | undefined;

  constructor(
    opts: LoginServiceOptions,
    deps: {
      now?: () => number;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
      /** Provedor do `ALUY_TOKEN` do ambiente — ver campo `envToken`. */
      envToken?: () => string | undefined;
    } = {},
  ) {
    this.client = new IdentityClient(opts);
    this.store = opts.store;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep;
    this.envToken = deps.envToken;
  }

  /** Caminho INTERATIVO: device-flow → guarda no keychain. */
  async loginWithDeviceFlow(args: DeviceLoginArgs): Promise<RedactedCredential> {
    const tokens = await runDeviceFlow(
      this.client,
      {
        organizationId: args.organizationId,
        scopes: args.scopes ?? DEFAULT_HEADLESS_SCOPES,
        onPrompt: args.onPrompt,
        ...(args.signal ? { signal: args.signal } : {}),
      },
      { now: this.now, ...(this.sleep ? { sleep: this.sleep } : {}) },
    );
    const cred = credentialFromTokens(tokens, this.now);
    await this.store.set(cred);
    return redactCredential(cred);
  }

  /**
   * Caminho HEADLESS/CI: PAT. Valida o FORMATO localmente (introspect real é
   * server-side, no broker — EST-0943). Guarda no keychain. `organizationId`
   * vem da introspecção quando o CLI fizer a 1ª chamada; aqui guardamos o PAT.
   */
  async loginWithPat(token: string, organizationId: string): Promise<RedactedCredential> {
    if (!isPat(token)) {
      throw new InvalidPatError();
    }
    const cred: StoredCredential = {
      kind: 'pat',
      pat: token,
      organization_id: organizationId,
      // O escopo efetivo é o do PAT (server-side); guardamos o default declarado.
      scopes: [...DEFAULT_HEADLESS_SCOPES],
      v: 1,
    };
    await this.store.set(cred);
    return redactCredential(cred);
  }

  /** `aluy whoami` — credencial corrente REDIGIDA (sem segredo). */
  async whoami(): Promise<RedactedCredential | null> {
    const cred = await this.store.get();
    // Passa o `now` injetável p/ a avaliação HONESTA de validade (M-2) ser testável.
    return cred ? redactCredential(cred, this.now) : null;
  }

  /**
   * Devolve um access token VÁLIDO (refresca se expirado, no caminho device).
   * Para PAT, o próprio PAT é a credencial. Usado pela integração broker
   * (EST-0943). Refresh rotativo: cada refresh invalida o anterior — guardamos
   * o novo par. Reuse-detection/expiração ⇒ SessionExpiredError (re-login).
   */
  async getAccessToken(skewMs = 30_000): Promise<string> {
    const cred = await this.store.get();
    if (!cred) {
      // Keychain VAZIO ⇒ tenta o PAT do ambiente (`ALUY_TOKEN`) antes de desistir.
      // É o caminho headless/CI documentado (`export ALUY_TOKEN=…` sem `aluy login`).
      // Só aceitamos um PAT de FORMATO válido (mesma checagem do `loginWithPat`) — um
      // env-token lixo NÃO vira um Bearer malformado num 401 genérico depois; vira o
      // mesmo erro de re-login claro. NUNCA logamos o valor (CLI-SEC-2).
      const envPat = this.envToken?.()?.trim();
      if (envPat && isPat(envPat)) {
        return envPat;
      }
      throw new SessionExpiredError();
    }
    if (cred.kind === 'pat') {
      // PAT não-vazio garantido pelo loginWithPat.
      return cred.pat as string;
    }
    const stillValid =
      cred.access_token !== undefined &&
      cred.expires_at !== undefined &&
      this.now() + skewMs < cred.expires_at;
    if (stillValid) {
      return cred.access_token as string;
    }
    // Expirou (ou perto) ⇒ refresh rotativo (SINGLE-FLIGHT — ver `inFlightRefresh`).
    if (!cred.refresh_token) {
      throw new SessionExpiredError();
    }
    return await this.refreshSingleFlight(cred.refresh_token);
  }

  /**
   * Coalesce o refresh rotativo: a PRIMEIRA chamada concorrente faz a rede e
   * rotaciona; as demais AGUARDAM a mesma promessa (não reusam o refresh_token
   * antigo ⇒ não disparam reuse-detection). A promessa é limpa ao terminar para
   * que o PRÓXIMO ciclo de expiração inicie um novo refresh. Note que ela usa o
   * refresh_token DESTE caller: como concorrentes leem a mesma credencial
   * expirada (mesmo token), coalescer pelo primeiro é correto; tokens diferentes
   * só surgem após uma rotação já concluída (e aí `inFlightRefresh` é undefined).
   */
  private refreshSingleFlight(refreshToken: string): Promise<string> {
    const existing = this.inFlightRefresh;
    if (existing) {
      return existing;
    }
    const flight = (async () => {
      let tokens: HeadlessTokenResponse;
      try {
        tokens = await this.client.refresh(refreshToken);
      } catch (err) {
        // HUNT-AUTH-HONESTY — distinguir REJEIÇÃO DEFINITIVA de FALHA TRANSITÓRIA. O
        // `catch {}` cego antigo APAGAVA a credencial em QUALQUER erro — inclusive um blip
        // de rede / identity 5xx-por-1s / timeout — forçando re-login espúrio. Era o
        // "não estou logado" do dogfood: abrir `/model` dispara chamadas EXTRAS ao broker
        // (catálogo/custom) ⇒ `getAccessToken` ⇒ refresh; um blip durante isso destruía a
        // sessão. Agora: SÓ uma rejeição definitiva do identity (invalid_grant/reuse/
        // revogado — 400/401/403) apaga o keychain + re-login; um transitório PRESERVA a
        // credencial e devolve um erro re-tentável (o token pode estar perfeitamente válido).
        if (isDefinitiveRefreshRejection(err)) {
          await this.store.clear();
          throw new SessionExpiredError();
        }
        throw new RefreshUnavailableError();
      }
      const next = credentialFromTokens(tokens, this.now);
      await this.store.set(next);
      return next.access_token as string;
    })();
    this.inFlightRefresh = flight;
    // Limpa o slot quando a corrida termina (sucesso OU falha), sem mascarar o
    // resultado que os concorrentes aguardam.
    const clear = (): void => {
      if (this.inFlightRefresh === flight) {
        this.inFlightRefresh = undefined;
      }
    };
    flight.then(clear, clear);
    return flight;
  }

  /**
   * `aluy logout` — REVOGA no identity (device) e APAGA do keychain. Idempotente:
   * sem credencial ⇒ no-op. A revogação server-side é best-effort (logout local
   * sempre limpa, mesmo se a rede falhar — mas tentamos revogar primeiro).
   */
  async logout(): Promise<{ revoked: boolean }> {
    const cred = await this.store.get();
    if (!cred) {
      return { revoked: false };
    }
    let revoked = false;
    if (cred.kind === 'device' && cred.refresh_token) {
      try {
        await this.client.revoke(cred.refresh_token);
        revoked = true;
      } catch {
        // Revogação falhou (offline?) — ainda assim limpamos o keychain local.
        revoked = false;
      }
    }
    // PAT: revogação server-side é pela web (EST-0940); aqui só apagamos local.
    await this.store.clear();
    return { revoked };
  }
}
