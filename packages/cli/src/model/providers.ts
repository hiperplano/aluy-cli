// EST-0962 · /provider — CATÁLOGO de providers do modo Custom (dado listável p/ o picker).
//
// O `/provider` seta o NOME do provider/vendor que o broker usa p/ RESOLVER o slug da
// via Custom (par `provider + model`). É só o NOME curado (DADO, não credencial — HG-2/
// CLI-SEC-7): o broker resolve `(provider, model)` → credencial server-side, no vault.
// NUNCA `api_key`/`base_url`/segredo entra aqui (binário público limpo, CLI-SEC-7).
//
// FONTE DA LISTA (EST-0962 / ADR-0076): o picker carrega os NOMES dos providers REALMENTE
// cadastrados no broker (`GET /v1/providers` → `ProvidersClient`), em vez de chumbar a
// lista no binário. A lista abaixo (`PROVIDERS`) é o FALLBACK estático conhecido (broker
// fora / lista vazia) E a fonte do display amigável (label/summary) p/ os providers do
// seed — o broker só devolve `name`+`adapter` (DADO público), não rótulo de UI. A fusão
// (broker + metadados estáticos) é a função PURA `buildProviderEntries`.

/** Nome canônico de um provider (o que o usuário digita em `/provider <name>`). */
export type ProviderName = 'openrouter' | 'deepseek';

/** Uma entrada do catálogo de providers (DADO p/ o picker — nunca hardcode por tela). */
export interface ProviderEntry {
  /**
   * Chave canônica (o NOME enviado ao broker; case-insensitive na resolução). `string`
   * (não a union `ProviderName`) porque a lista VIVA do broker (`GET /v1/providers`) pode
   * trazer providers além do seed conhecido (ex.: `tokenrouter`) — o NOME é DADO público.
   */
  readonly name: string;
  /** Rótulo amigável exibido no picker. */
  readonly label: string;
  /** Uma linha de descrição (a11y / discoverability no picker). */
  readonly summary: string;
  /** É o provider DEFAULT do seed (marca a dica "padrão" no picker)? */
  readonly isDefault?: boolean;
}

/**
 * EST-0962 — os providers do SEED. `openrouter` é o DEFAULT (o que o broker escolhe
 * sem `/provider`); `deepseek` é a alternativa pareável com o modelo Custom. DADO
 * listável (não hardcode espalhado por tela). FU: catálogo vivo do broker (ADR-0073).
 */
export const PROVIDERS: readonly ProviderEntry[] = [
  {
    name: 'openrouter',
    label: 'OpenRouter',
    summary: 'gateway multi-provider (padrão do broker)',
    isDefault: true,
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    summary: 'API direta da DeepSeek',
  },
];

/**
 * Resolve um nome digitado (`/provider <name>`) numa lista de entradas, case-insensitive
 * + trim. `undefined` quando não casa nenhum provider da lista (o caller emite o erro
 * honesto listando os válidos). NÃO faz I/O. A `list` default é o seed estático
 * (`PROVIDERS`) — passe a lista VIVA (de `buildProviderEntries`) p/ resolver providers
 * cadastrados além do seed (ex.: `tokenrouter`).
 */
export function resolveProviderName(
  input: string,
  list: readonly ProviderEntry[] = PROVIDERS,
): ProviderEntry | undefined {
  const q = input.trim().toLowerCase();
  if (q === '') return undefined;
  return list.find((p) => p.name.toLowerCase() === q);
}

/** Um provider cru vindo do broker (`GET /v1/providers`) — SÓ nome + adaptador. */
export interface BrokerProvider {
  readonly name: string;
  /** Adaptador (display); não usado no rótulo mas aceito p/ casar o contrato do client. */
  readonly adapter?: string;
}

/**
 * EST-0962 / ADR-0076 — FUNDE a lista VIVA de providers do broker (`GET /v1/providers`,
 * só `name`+`adapter`) com os metadados de display ESTÁTICOS do seed (`label`/`summary`/
 * `isDefault`), produzindo as entradas do picker. PURA e testável (sem I/O):
 *
 *  · cada provider do broker vira uma `ProviderEntry`: usa o label/summary do seed quando
 *    o NOME é conhecido (`openrouter`/`deepseek`), senão um display HUMANIZADO do próprio
 *    nome (Capitaliza + "(cadastrado no broker)") — nunca inventa metadado do seed;
 *  · DEDUP por nome (case-insensitive; o broker pode repetir) e ORDENA por nome, com o
 *    `isDefault` do seed empurrado p/ o TOPO (o default é o 1º item, como o seed estático);
 *  · `broker` VAZIO (lista vazia / não carregou) ⇒ devolve o FALLBACK estático (`PROVIDERS`)
 *    — NUNCA lista vazia (degradação honesta; o caller mostra a nota "(não foi possível
 *    listar os cadastrados)").
 *
 * HG-2/CLI-SEC-7 (por construção): só lê `name` do broker (+ `adapter`, descartado no
 * rótulo) e os campos de display do seed. NUNCA toca `api_key_ref`/`base_url`/markup —
 * o client (`parseProviders`) já os descartou; aqui nem existem no tipo de entrada.
 */
export function buildProviderEntries(
  broker: readonly BrokerProvider[],
  fallback: readonly ProviderEntry[] = PROVIDERS,
): readonly ProviderEntry[] {
  if (broker.length === 0) return fallback;
  const seedByName = new Map(fallback.map((e) => [e.name.toLowerCase(), e]));
  const seen = new Set<string>();
  const entries: ProviderEntry[] = [];
  for (const p of broker) {
    const name = p.name.trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const seed = seedByName.get(key);
    entries.push(
      seed
        ? { ...seed, name } // metadados do seed (label/summary/isDefault), nome do broker
        : { name, label: humanizeProvider(name), summary: 'cadastrado no broker' },
    );
  }
  // Ordena por nome; o default do seed sobe ao topo (paridade com a lista estática).
  entries.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (b.isDefault && !a.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/** Display humanizado p/ um provider FORA do seed (ex.: `tokenrouter` → `Tokenrouter`). */
function humanizeProvider(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
