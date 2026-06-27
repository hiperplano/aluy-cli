// EST-1009 · ADR-0065 · CLI-SEC-H1 — FUNDAÇÃO do sandbox de SO (a PRIMITIVA).
//
// O processo-MÃE (não-confinado, é a TCB / kernel-de-cliente — ADR-0053 §2.2)
// cria, para cada SUB-PROCESSO de efeito (bash em EST-1010, processo-server MCP
// em EST-1011), um sandbox de SO que é um PISO DURO sob a catraca: por invariante
// do SO, o sub-processo só enxerga o WORKSPACE (cwd) + mounts explícitos, e NUNCA
// `~/.aluy/` (journal/memória/config), `~/.ssh`/`~/.aws`/`.env*`, nem nada fora do
// workspace — independente de qualquer ofuscação de path (FU-VAU-11/11-bis/RES-M-4).
//
// O sandbox NÃO substitui a catraca (`decide()`, CLI-SEC-3) — ele a REFORÇA: a
// catraca é a POLÍTICA (allow/ask/deny, consentimento informado), o sandbox é o
// PISO (mesmo que a catraca seja furada por ofuscação — FU-VAU-5 —, o SO barra).
//
// ESTE MÓDULO É PORTÁVEL (ADR-0053 §8): só TIPOS + LÓGICA PURA (detecção de
// fail-mode, política de seccomp). NÃO toca `node:child_process`/`node:os` — o
// LANÇADOR concreto (`bwrap`/userns + spawn + fd) mora em `@aluy/cli`
// (`src/sandbox/`), o "locus concreto" que injeta a primitiva. Assim a fronteira
// atravessa-loci (§8-bis): quando a engine for re-hospedada server-side, o modelo
// de confinamento viaja junto da catraca — o piso de SO não é do front.

/**
 * AMBIENTE de execução do CLI, para a postura de fail-mode (D-SB-4). Resolvido
 * pelo locus concreto a partir de `ALUY_ENV` (dado, não decisão de código). NÃO é
 * o broker-URL: é a postura de segurança do canal.
 *
 * - `dev`/`staging`: máquina de desenvolvimento — sem piso de SO ⇒ DEGRADA com
 *   aviso inequívoco + marca a máquina não-promovível a `prod` (nunca silencioso).
 * - `prod`: canal público (`npm i -g` publicado) — sem piso de SO ⇒ RECUSA por
 *   default; o usuário consciente força com `--unsafe-no-sandbox` por sessão.
 */
export type SandboxEnv = 'dev' | 'staging' | 'prod';

/**
 * SUPORTE de SO detectado para o sandbox (capability probe — D-SB-1/feita pelo
 * locus concreto no boot; o `/doctor` pode reportar — FU). PURO/serializável: a
 * detecção concreta (executar `bwrap --version`, ler `/proc/.../userns`, abrir
 * Landlock) é do `@aluy/cli`; aqui é só a FORMA do resultado, que a lógica de
 * fail-mode consome sem tocar o SO.
 */
export interface SandboxCapability {
  /** SO da máquina (`linux`/`darwin`/`win32`/outro). Fase 1 = `linux` (D-SB-1). */
  readonly platform: NodeJS.Platform | string;
  /** `bwrap` (bubblewrap) presente e executável no PATH. */
  readonly bwrap: boolean;
  /** user namespaces rootless disponíveis (caminho default em kernels modernos). */
  readonly userns: boolean;
  /** seccomp-bpf disponível (filtro de syscalls — nega o conjunto perigoso). */
  readonly seccomp: boolean;
  /**
   * Landlock (LSM, kernel ≥5.13) disponível — REFORÇO ADITIVO de FS, NUNCA único
   * (Landlock não cobre rede/PID — ADR-0065 §1, alt. C rejeitada como único).
   */
  readonly landlock: boolean;
  /**
   * CONFINAMENTO DE RECURSO (cgroup v2) disponível? — REFORÇO ADITIVO §13.2: o
   * `systemd-run --user --scope` (delegação rootless de cgroup v2) está presente
   * p/ envolver o `bwrap` com TasksMax/MemoryMax/CPUQuota e fechar o fork-bomb/DoS
   * (`:(){ :|:& };:`, `cat /dev/zero`) que o bwrap NÃO cobre (bwrap confina FUGA —
   * FS/rede/syscall —, não RECURSO). ADITIVO, NUNCA condiciona o piso de FUGA: sem
   * cgroups o lançamento DEGRADA-COM-AVISO (roda sem teto de recurso), nunca recusa
   * por falta dele (não é gate duro — é o PISO de DoS, hardening em camada distinta).
   *
   * OPCIONAL no tipo (capabilities pré-§13.2 não o setam ⇒ tratado como `false`);
   * o detector concreto SEMPRE o seta explícito (honesto).
   */
  readonly cgroupLimits?: boolean;
  /**
   * Versão do kernel detectada (ex.: "6.17.0") — só informativo p/ o `/doctor`;
   * a decisão de Landlock usa `landlock`, não o parse de versão. OPCIONAL.
   */
  readonly kernel?: string;
  /**
   * Motivo legível quando o piso NÃO está disponível (p/ o aviso inequívoco do
   * fail-mode e p/ o `/doctor`). OPCIONAL: presente só quando `floorAvailable`
   * (abaixo) é falso.
   */
  readonly unavailableReason?: string;
}

/**
 * O PISO DE SO está disponível nesta máquina? É a condição mínima para confinar
 * por invariante: precisa de `bwrap` (ou userns direto) E seccomp. Landlock é
 * ADITIVO (não condiciona o piso). PURA — só lê a capability.
 *
 * Fase 1 = Linux (D-SB-1): em plataforma != linux o piso NÃO está disponível
 * (macOS=Fase 2/Seatbelt, Windows=FU-SB-WIN) ⇒ fail-mode de D-SB-4.
 */
export function floorAvailable(cap: SandboxCapability): boolean {
  if (cap.platform !== 'linux') return false;
  // userns é a base do confinamento (mount/PID/net namespaces); seccomp nega o
  // conjunto perigoso DENTRO do namespace. `bwrap` é o lançador preferido, mas o
  // que o piso EXIGE é userns + seccomp; sem `bwrap`, o fallback de namespaces
  // diretos (FU) ainda precisa de userns. Sem userns OU sem seccomp ⇒ sem piso.
  return cap.bwrap && cap.userns && cap.seccomp;
}

/**
 * AÇÃO resolvida pelo fail-mode (D-SB-4) quando se vai lançar um sub-processo de
 * efeito. É a saída PURA de `resolveFailMode`. O locus concreto (lançador) age
 * conforme:
 *  - `confine`: o piso existe ⇒ lança DENTRO do sandbox (caminho normal).
 *  - `degrade`: dev/staging sem piso ⇒ lança SEM sandbox MAS emite o aviso
 *     inequívoco e marca a máquina não-promovível (NUNCA finge confinamento).
 *  - `refuse`: prod sem piso e sem `--unsafe-no-sandbox` ⇒ NÃO lança o efeito
 *     (recusa explícita; o usuário vê por quê e como forçar conscientemente).
 *  - `unsafe`: prod sem piso COM `--unsafe-no-sandbox` ⇒ lança SEM sandbox, com
 *     aviso de risco assumido. NÃO relaxa sempre-ask nem o write-deny de
 *     `~/.aluy/` da catraca (esses valem ACIMA do flag — ADR-0064/EST-0974).
 */
export type SandboxAction = 'confine' | 'degrade' | 'refuse' | 'unsafe';

/**
 * DECISÃO de fail-mode (D-SB-4): a ação + se confina + se a máquina é promovível
 * + um aviso INEQUÍVOCO (quando há). O aviso é NÃO-SUPRIMÍVEL por config (é a
 * postura cravada do `seguranca`): quem degrada/roda-unsafe SEMPRE vê.
 */
export interface SandboxDecision {
  readonly action: SandboxAction;
  /** O efeito vai rodar DENTRO do sandbox? (`true` só em `confine`). */
  readonly confined: boolean;
  /** O efeito vai EXECUTAR? (`false` só em `refuse` — recusa por default). */
  readonly allowed: boolean;
  /**
   * Esta máquina é PROMOVÍVEL a `prod`? `false` sempre que rodou sem piso de SO
   * (degrade/unsafe) — marca cravada de D-SB-4. `confine`=promovível; `refuse`
   * não roda (irrelevante, mantido `false` por conservadorismo).
   */
  readonly promotable: boolean;
  /**
   * Aviso inequívoco a EMITIR (não-suprimível). Vazio só em `confine` (caminho
   * normal, sem aviso). É TEXTO (i18n-neutro: chave/estrutura é do locus); aqui
   * a lógica PURA devolve o motivo cravado.
   */
  readonly warning?: string;
}

/**
 * CONFINAMENTO de um lançamento: o universo de FS/rede que o sub-processo enxerga.
 * É o CONTRATO que EST-1010/1011 preenchem (bash passa o workspace; MCP idem). A
 * primitiva (lançador) o traduz em mounts/namespaces do SO.
 *
 * INVARIANTE (ADR-0065 §2): o lançador NUNCA monta `~/.aluy/`, `~/.ssh`, `~/.aws`
 * nem `$HOME` no namespace — mesmo que um `roBinds`/`rwBinds` aponte p/ lá, o
 * lançador REJEITA paths sob `~/.aluy/` (defesa em profundidade no próprio
 * lançador, além do invariante de "não montar por default").
 */
export interface SandboxConfinement {
  /**
   * O WORKSPACE (uma ou mais raízes autorizadas — EST-0982 multi-raiz). RW dentro
   * do sandbox. É o ÚNICO FS de efeito que o sub-processo vê por default. Caminhos
   * absolutos, canonicalizados pelo locus concreto ANTES de chegar aqui.
   */
  readonly workspaceRoots: readonly string[];
  /** cwd do sub-processo DENTRO do sandbox (⊆ uma das `workspaceRoots`). */
  readonly cwd: string;
  /**
   * Mounts read-only EXPLICITAMENTE liberados (allow-list de paths do usuário —
   * DADO; default vazia além do mínimo de sistema que o lançador injeta). NUNCA
   * sob `~/.aluy/` (o lançador rejeita). OPCIONAL.
   */
  readonly roBinds?: readonly string[];
  /**
   * Mounts read-write explicitamente liberados (além do workspace). MESMA regra:
   * nunca sob `~/.aluy/`. OPCIONAL (raro; default vazia).
   */
  readonly rwBinds?: readonly string[];
  /**
   * REDE liberada para ESTE sub-processo? Default `false` (net-deny — D-SB-3): um
   * sub-processo que NÃO declarou precisar de rede roda SEM rede (corta o socket
   * de exfiltração direto). A catraca (categoria `network` sempre-ask) é quem,
   * APÓS mostrar o destino (CLI-SEC-9), pede `network:true` p/ aquele lançamento.
   */
  readonly network?: boolean;
  /**
   * §13.2 — TETO de RECURSO (cgroup v2) deste lançamento. São o PISO DE DoS: capam
   * fork-bomb (TasksMax), RAM (MemoryMax) e CPU (CPUQuota) por invariante do kernel,
   * INDEPENDENTE do bwrap (que confina FUGA, não RECURSO). Aplicados via
   * `systemd-run --user --scope -p ...` envolvendo o `bwrap`. OPCIONAIS com default
   * conservador (o lançador preenche o ausente). Sem `cgroupLimits` na capability,
   * o lançador NÃO os aplica e AVISA (degrade-com-aviso) — nunca finge confinamento.
   */
  readonly resourceLimits?: SandboxResourceLimits;
}

/**
 * §13.2 — limites de RECURSO de um lançamento (cgroup v2 via systemd-run scope).
 * Cada campo mapeia 1:1 num property do scope do systemd. Todos opcionais; o
 * lançador aplica o DEFAULT conservador (`DEFAULT_RESOURCE_LIMITS`) p/ o ausente.
 */
export interface SandboxResourceLimits {
  /**
   * TasksMax do scope — nº MÁXIMO de tarefas (processos + threads) na árvore.
   * É o teto que ARROMBA o fork-bomb: `:(){ :|:& };:` bate no limite e o kernel
   * recusa o `clone()` (EAGAIN) em vez de derrubar a máquina. Default 512.
   */
  readonly tasksMax?: number;
  /**
   * MemoryMax do scope — RAM MÁXIMA da árvore (sufixo systemd: '2G', '512M', …).
   * Estourar ⇒ OOM-kill DENTRO do cgroup (não da máquina). Cap p/ `cat /dev/zero`
   * e amigos. Default '2G'.
   */
  readonly memoryMax?: string;
  /**
   * CPUQuota do scope — fração de CPU (formato systemd: '200%' = 2 núcleos cheios,
   * '50%' = meio núcleo). NÃO mata; só THROTTLA (a máquina respira sob busy-loop).
   * Default '200%'.
   */
  readonly cpuQuota?: string;
}

/**
 * §13.2 — DEFAULT conservador dos limites de recurso. Valores escolhidos p/ um
 * sub-processo de efeito típico (build/teste/git): generoso o bastante p/ não
 * atrapalhar trabalho legítimo, apertado o bastante p/ que um fork-bomb/`cat
 * /dev/zero`/busy-loop NÃO derrube a máquina. O lançador funde o pedido sobre estes.
 */
export const DEFAULT_RESOURCE_LIMITS: Required<SandboxResourceLimits> = Object.freeze({
  tasksMax: 512,
  memoryMax: '2G',
  cpuQuota: '200%',
});

/**
 * Resultado de um lançamento confinado. Estende o que o locus precisa p/ esperar
 * o processo + abortá-lo (EST-1010/1011 ligam isto ao `ShellPort`/transporte MCP).
 * O TIPO do handle de processo é abstrato aqui (portável) — o concreto é o
 * `ChildProcess` do Node, no `@aluy/cli`.
 */
export interface SandboxSpawnResult<Proc = unknown> {
  /** A decisão de fail-mode aplicada (p/ o locus auditar/avisar). */
  readonly decision: SandboxDecision;
  /**
   * O processo lançado, OU `undefined` quando a decisão foi `refuse` (não rodou).
   * Em `confine` está DENTRO do sandbox; em `degrade`/`unsafe`, fora (com aviso).
   */
  readonly process?: Proc;
  /**
   * §13.2 — AVISO ADITIVO não-suprimível do CONFINAMENTO DE RECURSO, ORTOGONAL ao
   * `decision.warning` (que é sobre o piso de FUGA). Presente SÓ quando o lançamento
   * confinou a FUGA (bwrap OK) mas NÃO conseguiu o teto de RECURSO (cgroup
   * indisponível) — degrade-com-aviso, nunca silencioso: o efeito rodou SEM teto de
   * fork-bomb/RAM/CPU. Vazio quando o cgroup foi aplicado (ou quando nem se confina).
   */
  readonly warning?: string;
}

/**
 * A PRIMITIVA exposta aos próximos (EST-1010 bash / EST-1011 MCP). O lançador é o
 * MÃE: detecta a capability uma vez, resolve o fail-mode por lançamento e cria o
 * sandbox. Genérico no tipo de processo p/ o core não acoplar ao `child_process`.
 *
 * Esta interface é o CONTRATO estável que 1010/1011 consomem; a implementação
 * `bwrap` vive em `@aluy/cli`. O core a EXPÕE (tipo) mas não a IMPLEMENTA.
 */
export interface SandboxLauncher<Proc = unknown, SpawnOpts = unknown> {
  /** A capability detectada (imutável após o boot). */
  readonly capability: SandboxCapability;
  /** O ambiente resolvido (postura de fail-mode). */
  readonly env: SandboxEnv;
  /**
   * RESOLVE a decisão de fail-mode SEM lançar (p/ o locus decidir/avisar/auditar
   * antes — ex.: o `/doctor` ou um pré-flight do `ShellPort`). PURA sobre a
   * capability+env+flag desta primitiva.
   */
  decide(): SandboxDecision;
  /**
   * LANÇA um comando/argv DENTRO do confinamento (ou degrada/recusa/unsafe
   * conforme `decide()`). O `command` é o programa + args (o locus monta o shell);
   * `opts` carrega os ganchos do locus (sinais, stdio) sem o core conhecê-los.
   */
  spawnConfined(
    command: readonly string[],
    confinement: SandboxConfinement,
    opts?: SpawnOpts,
  ): SandboxSpawnResult<Proc>;
}
