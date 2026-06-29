# Modo TURBO — complementos, instalação e solução de problemas

O **modo turbo** liga três *complementos* (sidecars) opcionais que rodam **localmente** na sua
máquina, em loopback (`127.0.0.1`), sem nuvem:

| Complemento | O que faz | Porta | Onde mora |
|---|---|---|---|
| **ollama** | modelos locais — um *judge* (`qwen2.5:0.5b`) e um *embedder* (`nomic-embed-text`) | `11434` | `~/.aluy/ollama` (ou instalação de sistema) |
| **mem0** | memória persistente (fatos entre sessões) | `11435` | venv `~/.aluy/mem-venv` + store `~/.aluy/memory` |
| **headroom** | proxy de compressão de contexto | `8787` | venv `~/.aluy/hr-venv` |

O Aluy CLI **funciona sem eles** — são enriquecimentos. O perfil oposto, **leve**, não instala
nem sobe nenhum. Você escolhe o perfil no `aluy onboard` ou em `~/.aluy/config.json`
(`"profile": "turbo" | "leve"`).

> Os complementos **sobem sozinhos no boot** se já estiverem instalados. Instalar é um passo
> **explícito** (`aluy bootstrap`) — nunca acontece automático.

---

## Instalação

```bash
npm i -g @hiperplano/aluy-cli     # o CLI
aluy onboard                       # idioma, provider, modelo e perfil
aluy bootstrap                     # instala os 3 complementos (perfil turbo)
```

### Dois caminhos de instalação

O `aluy bootstrap` tem dois modos:

- **`aluy bootstrap`** (padrão, *via agente*): o próprio aluy detecta o SO/distro, instala os
  pré-requisitos que faltam (Python, pip, venv, `zstd`/`tar`, com `sudo` quando preciso) e os
  complementos, **acompanhando e tratando problemas**. ⚠ Roda em `--yolo` (acesso total à
  máquina) — optar pelo turbo é o consentimento.
- **`aluy bootstrap --no-agent`** (*direto*): provisiona pelo caminho determinístico (artefato
  pinado do Ollama + criação dos venvs), **sem usar modelo**. Requer Python já pronto.

**Quando usar `--no-agent`:** numa **máquina do zero sem modelo configurado/acessível**. O modo
*via agente* precisa de um modelo funcionando para "pensar" — e se o modelo é o próprio Ollama
que você ainda vai instalar, há um problema circular. A partir da **rc.35** o `aluy bootstrap`
**detecta** que o modelo não responde e **cai sozinho** no caminho direto; em versões anteriores,
use `--no-agent` explicitamente.

---

## Verificar e auto-reparar

```bash
aluy doctor          # diagnóstico read-only (no shell); exit≠0 se há ✗
```

Dentro da TUI, `/doctor` mostra os checks ao vivo. Se algum complemento do turbo estiver fora,
ele **pergunta** se você quer consertar:

```
/doctor fix
```

O `/doctor fix` entrega o conserto **ao próprio agente**: ele lê os logs
(`~/.aluy/logs/<nome>.log`), roda `aluy bootstrap --no-agent`, instala o que faltar e re-tenta
até os três ficarem ✓ — adaptando-se ao que a sua máquina precisar.

---

## Problemas comuns e como resolver

| Sintoma (no `doctor`) | Causa | Conserto |
|---|---|---|
| `mem0 ✗ (fora)` + log `can't open file '…/aluy-mem0-server.py'` | o script do servidor não está no venv | `aluy bootstrap` (copia o script). Em rc ≥ 33 o boot também o copia sozinho ao abrir o aluy. |
| `mem0 ✗` + log `KeyError: '_type'` ou `no such column: prev_value` | store de versão anterior, incompatível | `mv ~/.aluy/memory{,.bak}; mv ~/.mem0/history.db{,.bak}` e reabra. Em rc ≥ 29 o servidor faz isso sozinho (self-heal). |
| `ollama ✓` mas `ollama list` → *command not found* | serviço sobe em `:11434`, mas o binário ficou fora do `PATH` | rc ≥ 30 cria um symlink em `~/.local/bin`. Ou abra um shell novo / `source ~/.bashrc`. |
| `bootstrap` trava em *"verificando ollama"* + `erro de broker: provider local` | instalação *via agente* sem um modelo acessível | use `aluy bootstrap --no-agent` (rc ≥ 35 cai nisso sozinho). |
| `headroom ✗` + log `No module named 'fastapi'` / `Proxy dependencies not installed` | o venv instalou `headroom-ai` sem o extra `[proxy]` | `~/.aluy/hr-venv/bin/pip install 'headroom-ai[proxy]==0.25.0'` e reabra. Corrigido na fonte em rc ≥ 36. |
| `headroom ✗ (fora)` (outros) | venv sem deps, ou core sem wheel pro SO/arch | `aluy bootstrap --no-agent`; veja `~/.aluy/logs/headroom.log`. No Windows, suba com `HEADROOM_REQUIRE_RUST_CORE=false`. |
| os três `✗` numa máquina nova | nada provisionado ainda | `aluy bootstrap --no-agent`. |

> **Não rode `aluy` com `sudo`.** Os sidecars **recusam** rodar como root (segurança), e o `sudo`
> ainda manda o aluy procurar a config em `/root/.aluy` — outro lugar. Instale como seu usuário;
> o instalador pede `sudo` só nos passos que exigem (ex.: pré-requisitos do sistema).

Os logs de cada sidecar (truncados por boot) ficam em `~/.aluy/logs/ollama.log`,
`~/.aluy/logs/mem0.log`, `~/.aluy/logs/headroom.log` — o primeiro lugar a olhar quando um fica
fora.

---

## Instalação manual

Se preferir provisionar à mão (ou entender o que o bootstrap faz). Tudo mora em `~/.aluy/`.

### Ollama

```bash
# Linux: instalador oficial (instala em /usr/local/bin + serviço systemd)
curl -fsSL https://ollama.com/install.sh | sh
# puxe os dois modelos do turbo:
ollama pull qwen2.5:0.5b        # judge
ollama pull nomic-embed-text    # embedder
# confirme o serviço:
curl -s http://127.0.0.1:11434/api/tags
```

### mem0 (Python ≥ 3.10)

```bash
python3 -m venv ~/.aluy/mem-venv
~/.aluy/mem-venv/bin/pip install mem0ai==0.1.76 chromadb==0.5.23 ollama==0.4.7
# copie o script do servidor (vem no pacote npm, em assets/mem0/):
cp "$(npm root -g)/@hiperplano/aluy-cli/assets/mem0/aluy-mem0-server.py" ~/.aluy/mem-venv/
# teste à mão:
~/.aluy/mem-venv/bin/python3 ~/.aluy/mem-venv/aluy-mem0-server.py --host 127.0.0.1 --port 11435
curl -s http://127.0.0.1:11435/health     # → {"ok": true}
```

O mem0 usa o Ollama (`:11434`) como embedder/LLM — instale o Ollama **antes**. O store fica em
`~/.aluy/memory` (chromadb + history). Se um store antigo travar o boot, mova-o para backup
(veja a tabela acima).

### headroom (Python ≥ 3.10)

```bash
python3 -m venv ~/.aluy/hr-venv
~/.aluy/hr-venv/bin/pip install 'headroom-ai[proxy]==0.25.0'   # o extra [proxy] traz o fastapi
# o entrypoint fica em ~/.aluy/hr-venv/bin/headroom (Scripts\headroom.exe no Windows)
~/.aluy/hr-venv/bin/headroom proxy --port 8787
curl -s http://127.0.0.1:8787/health
```

Depois de provisionar à mão, `aluy doctor` deve mostrar os três ✓ (o boot os sobe ao abrir o
aluy, se o perfil for turbo).

---

## Layout dos arquivos (`~/.aluy/`)

```
~/.aluy/
  config.json        configuração durável (perfil, toggles, provider/modelo BYO…)  — veja `aluy config`
  ollama/            binário + modelos do Ollama (quando instalado em user-space)
  mem-venv/          venv do mem0 + aluy-mem0-server.py
  hr-venv/           venv do headroom
  memory/            store do mem0 (chromadb + history)
  logs/              ollama.log · mem0.log · headroom.log (truncados por boot)
```

Quais complementos sobem é controlado por `profile` + `sidecarToggles` no `config.json`. Veja
tudo o que está em vigor (e de onde vem cada chave) com **`aluy config`**.
