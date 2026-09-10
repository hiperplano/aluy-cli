// O STORE dos plugins instalados (`~/.aluy/plugins/<nome>/`).
//
// Pedido do dono (10/09/2026): "quero que você tenha a opção de plugins do aluy como no
// claude". O aluy já tem todas as peças que um plugin empacota — agents, commands, skills,
// workflows, hooks; o que falta é o BUNDLE. Este módulo é o lado de I/O: varrer o diretório,
// ler o manifesto de cada um (parser PURO do core) e dizer QUAIS diretórios de extensão cada
// plugin traz, para os loaders existentes somarem.
//
// ── PROVENIÊNCIA (o que este arquivo protege) ───────────────────────────────────────────
//
// Os loaders de hoje separam config do DONO (`~/.aluy/agents/` — confiável, entra na
// auto-seleção) de dado de PROJETO (não-confiável). Plugin é uma TERCEIRA categoria: código
// de terceiro que o dono escolheu instalar. Ver o cabeçalho de `plugin/manifest.ts`.
//
// Confinamento, espelhando o `UserAgentsLoader`:
//   • só subdiretórios DIRETOS de `~/.aluy/plugins/` (sem recursão de descoberta);
//   • o nome do dir tem de casar o `name` do manifesto — um dir `../evil` com manifesto
//     `name:"bom"` não passa, e um `name` que não bate com a pasta também não;
//   • dir sem `aluy-plugin.json` legível é IGNORADO com erro visível, nunca carregado
//     "no melhor esforço" (falha fechada — o conteúdo é de terceiro);
//   • teto de plugins (anti-runaway), como o teto de agentes.
//
// O que este módulo NÃO faz: baixar, instalar, executar. Só LÊ o que já está no disco.
// Instalação (git clone / cópia) é efeito e passa pela catraca, no comando.

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { parseManifesto, TIPOS_DE_EXTENSAO, type PluginManifest } from '@hiperplano/aluy-cli-core';

/** Nome do diretório sob `~/.aluy/`. */
export const PLUGINS_DIRNAME = 'plugins';

/** Nome do manifesto na raiz de cada bundle. */
export const MANIFESTO_NOME = 'aluy-plugin.json';

/** Teto defensivo — um dir com mil pastas não vira mil leituras de manifesto. */
export const MAX_PLUGINS = 64;

/** Teto do manifesto em bytes (arquivo de terceiro; não lemos um JSON de 10 MB). */
const MAX_MANIFESTO_BYTES = 64 * 1024;

/** Um plugin instalado e legível. */
export interface PluginInstalado {
  readonly manifest: PluginManifest;
  /** Raiz do bundle no disco (`~/.aluy/plugins/<nome>`). */
  readonly raiz: string;
  /** Os diretórios de extensão que ele de fato TEM (só os que existem). */
  readonly extensoes: Readonly<Partial<Record<(typeof TIPOS_DE_EXTENSAO)[number], string>>>;
  /** `false` ⇒ instalado mas DESLIGADO pelo dono (`/plugin disable`). */
  readonly ativo: boolean;
}

/** Um bundle que não pôde ser carregado — carga VISÍVEL, nunca silêncio. */
export interface PluginComErro {
  /** O nome do DIRETÓRIO (o do manifesto pode ser justamente o ilegível). */
  readonly dir: string;
  readonly motivo: string;
}

export interface LeituraDePlugins {
  readonly plugins: readonly PluginInstalado[];
  readonly erros: readonly PluginComErro[];
}

export interface PluginStoreOptions {
  /** Base (default `~/.aluy`). Injetável — nenhum teste pode tocar o estado real. */
  readonly baseDir?: string;
  /** Nomes DESLIGADOS pelo dono. Vem da config; o store só marca `ativo:false`. */
  readonly desligados?: readonly string[];
}

/** `true` se `alvo` está DENTRO de `base` (não é o próprio, não escapa por `..`). */
function dentroDe(base: string, alvo: string): boolean {
  const b = resolve(base);
  const a = resolve(alvo);
  return a.startsWith(b + sep) && a !== b;
}

export class PluginStore {
  private readonly dir: string;
  private readonly desligados: ReadonlySet<string>;

  constructor(opts: PluginStoreOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.aluy');
    this.dir = join(base, PLUGINS_DIRNAME);
    this.desligados = new Set(opts.desligados ?? []);
  }

  /** O caminho do dir de plugins (p/ mensagens/teste). */
  get pluginsDir(): string {
    return this.dir;
  }

  /**
   * Lê todos os plugins instalados. Determinístico (ordem alfabética). Dir ausente ⇒
   * `{plugins:[], erros:[]}` — nunca lança; QoL não derruba o boot.
   */
  load(): LeituraDePlugins {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return { plugins: [], erros: [] };
    }
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const plugins: PluginInstalado[] = [];
    const erros: PluginComErro[] = [];
    for (const nome of dirs) {
      if (plugins.length >= MAX_PLUGINS) break;
      const lido = this.lerUm(nome);
      if ('motivo' in lido) erros.push(lido);
      else plugins.push(lido);
    }
    return { plugins, erros };
  }

  /** Lê UM bundle. Devolve o plugin ou o erro — nunca um plugin pela metade. */
  private lerUm(nomeDir: string): PluginInstalado | PluginComErro {
    const raiz = join(this.dir, nomeDir);
    // Confinamento: `nomeDir` vem do `readdir`, mas a checagem é barata e fecha o caso de
    // um nome exótico que o `join` resolva para fora.
    if (!dentroDe(this.dir, raiz)) {
      return { dir: nomeDir, motivo: 'caminho resolve para fora de ~/.aluy/plugins' };
    }

    const caminhoManifesto = join(raiz, MANIFESTO_NOME);
    let bruto: string;
    try {
      const st = statSync(caminhoManifesto);
      if (!st.isFile()) return { dir: nomeDir, motivo: `${MANIFESTO_NOME} não é um arquivo` };
      if (st.size > MAX_MANIFESTO_BYTES) {
        return { dir: nomeDir, motivo: `${MANIFESTO_NOME} grande demais` };
      }
      bruto = readFileSync(caminhoManifesto, 'utf8');
    } catch {
      return { dir: nomeDir, motivo: `sem ${MANIFESTO_NOME} legível na raiz` };
    }

    const parsed = parseManifesto(bruto);
    if ('error' in parsed) return { dir: nomeDir, motivo: parsed.error };

    // O nome do MANIFESTO tem de bater com o da PASTA.
    //
    // Sem isto, um bundle na pasta `inofensivo/` poderia se declarar `name:"backend-eng"` e
    // rotular os itens dele como se fossem de outro plugin — e o rótulo é justamente o que
    // carrega a proveniência na tela. Divergir é erro, não preferência.
    if (parsed.manifest.name !== nomeDir) {
      return {
        dir: nomeDir,
        motivo:
          `o "name" do manifesto ("${parsed.manifest.name}") não bate com a pasta ` +
          `("${nomeDir}") — renomeie uma das duas.`,
      };
    }

    const extensoes: Partial<Record<(typeof TIPOS_DE_EXTENSAO)[number], string>> = {};
    for (const tipo of TIPOS_DE_EXTENSAO) {
      const p = join(raiz, tipo);
      try {
        if (statSync(p).isDirectory()) extensoes[tipo] = p;
      } catch {
        /* o plugin simplesmente não traz este tipo */
      }
    }

    return {
      manifest: parsed.manifest,
      raiz,
      extensoes,
      ativo: !this.desligados.has(parsed.manifest.name),
    };
  }
}
