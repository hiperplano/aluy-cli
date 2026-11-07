#!/usr/bin/env python3
"""
aluy-mem0-server — servidor HTTP stdlib para o Mem0 OSS local.

EST-1138 · ADR-0123 §8-emenda E2/E3 · C4.
Implementa EXATAMENTE os endpoints que `mem0-memory-engine.ts` chama.

Bind: 127.0.0.1 (loopback, CA-G2-6), porta via --port (default 11435).
Uma instância de Memory() — criada UMA vez no boot.

Endpoints:
  GET  /health              → 200 {"ok":true}
  POST /v1/memories/        → mem.add(...)          → {"id":"..."}
  GET  /v1/memories/?...    → mem.search(...)       → {"results":[...]}
  GET  /v1/users/           → lista scopes          → {"users":[...]}
  DELETE /v1/memories/?...  → mem.delete_all(...)   → 204

Dependências: mem0ai, chromadb (já no venv provisionado).
Embedder: nomic-embed-text via Ollama em 127.0.0.1:11434.
Store: chromadb em ~/.aluy/memory.
"""

import argparse
import json
import os
import re
import signal
import sys
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn
from typing import Any

# ── Constantes ────────────────────────────────────────────────────────────
DEFAULT_PORT = 11435
DEFAULT_HOST = "127.0.0.1"
ALUY_MEMORY_DIR = os.path.expanduser("~/.aluy/memory")
OLLAMA_BASE_URL = "http://127.0.0.1:11434"
# Embedder CONFIG-DRIVEN: o boot passa `ALUY_MEM0_EMBEDDER` (escolhido na instalação); default
# bge-m3 (multilíngue, forte). Trocar o embedder muda a DIMENSÃO do vetor (bge-m3/mxbai=1024,
# nomic=768) ⇒ o store chromadb antigo fica incompatível e o self-heal o reseta no 1º boot.
EMBEDDER_MODEL = os.environ.get("ALUY_MEM0_EMBEDDER", "bge-m3").strip() or "bge-m3"
# LLM local p/ extração de fatos (mem0 add infer=True). SEM isto o mem0 cai no
# default OpenAI → 401. Local-first: tudo via Ollama loopback, zero credencial.
LLM_MODEL = "qwen2.5:0.5b"
USERS_FILE = os.path.join(ALUY_MEMORY_DIR, "aluy_users.json")


# ── Mem0 config ───────────────────────────────────────────────────────────
def _build_mem0_config() -> dict[str, Any]:
    """Monta a config do mem0ai com paths locais absolutos."""
    return {
        # history em ~/.aluy/memory (não no default ~/.mem0): TODO o estado do mem0 fica num
        # único lugar ⇒ limpar ~/.aluy/memory no self-heal recria TUDO fresco. Antes o history
        # ia p/ ~/.mem0/history.db e, de uma versão antiga, dava `no such column: prev_value`.
        "history_db_path": os.path.join(ALUY_MEMORY_DIR, "history.db"),
        "vector_store": {
            "provider": "chroma",
            "config": {
                "collection_name": "mem0",
                "path": ALUY_MEMORY_DIR,
            },
        },
        "embedder": {
            "provider": "ollama",
            "config": {
                "model": EMBEDDER_MODEL,
                "ollama_base_url": OLLAMA_BASE_URL,
            },
        },
        "llm": {
            "provider": "ollama",
            "config": {
                "model": LLM_MODEL,
                "ollama_base_url": OLLAMA_BASE_URL,
            },
        },
    }


# ── Tracking de usuários ──────────────────────────────────────────────────
def _load_users() -> dict[str, dict[str, Any]]:
    """Carrega o tracking de usuários do disco (JSON simples)."""
    try:
        if os.path.exists(USERS_FILE):
            with open(USERS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _save_users(users: dict[str, dict[str, Any]]) -> None:
    """Persiste o tracking de usuários."""
    os.makedirs(ALUY_MEMORY_DIR, mode=0o700, exist_ok=True)
    tmp = USERS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(users, f)
    os.replace(tmp, USERS_FILE)
    os.chmod(USERS_FILE, 0o600)


def _track_user(users: dict[str, dict[str, Any]], user_id: str) -> None:
    """Registra um user_id se ainda não existe no tracking."""
    if user_id not in users:
        users[user_id] = {"created_at": None}
        _save_users(users)


def _untrack_user(users: dict[str, dict[str, Any]], user_id: str) -> None:
    """Remove um user_id do tracking."""
    if user_id in users:
        del users[user_id]
        _save_users(users)


# ── Handler HTTP ──────────────────────────────────────────────────────────

# ── COMPATIBILIDADE DE API DO mem0ai ──────────────────────────────────────────
#
# O mem0ai TROCOU a assinatura de leitura entre as linhas 0.1.x e 2.x, e este script
# tinha sido escrito só para a 2.x:
#
#     0.1.x  search(query, user_id=..., limit=...)      get_all(user_id=...)
#     2.x    search(query, filters={...}, top_k=...)    get_all(filters={...})
#
# Só que `MEM0_PIP_PACKAGES` (provisioner-contract.ts) pina `mem0ai==0.1.76` — ou seja,
# o que É INSTALADO tem a API ANTIGA e o script chamava a NOVA. Toda leitura levava
# `TypeError: Memory.search() got an unexpected keyword argument 'top_k'` ⇒ HTTP 500.
#
# O que isso produzia, e por que passou tanto tempo despercebido: `add` usa a API
# ANTIGA (linha do _handle_add) e SEMPRE funcionou. Então a memória GRAVAVA e nunca
# LIA — o agente anotava os fatos, o `recall` do boot morria no 500, o chamador
# engolia num `catch` e a sessão abria amnésica. O único sinal para o usuário era um
# `✗` de um caractere no rodapé. Diagnóstico do dono, em 31/08: "entrei e parece que
# ele nem sabe do que se trata".
#
# Tentamos a assinatura DO PIN primeiro (0.1.x) e caímos na 2.x só no `TypeError`,
# porque quem provisionou antes pode ter qualquer uma das duas no venv. `TypeError` é
# estreito de propósito: erro de backend (conexão, disco) tem de CONTINUAR subindo
# como 500 em vez de virar "lista vazia" silenciosa — conflar os dois é o defeito que
# este bloco existe para não repetir.


def _search_compat(memory, query, user_id, limit):
    """`search` tolerante às duas linhas de API do mem0ai. Ver bloco acima."""
    try:
        return memory.search(query, user_id=user_id, limit=limit)
    except TypeError:
        return memory.search(query, filters={"user_id": user_id}, top_k=limit)


def _get_all_compat(memory, user_id):
    """`get_all` tolerante às duas linhas de API do mem0ai. Ver bloco acima."""
    try:
        return memory.get_all(user_id=user_id)
    except TypeError:
        return memory.get_all(filters={"user_id": user_id})


class Mem0Handler(BaseHTTPRequestHandler):
    """
    Handler HTTP que traduz requests REST ↔ chamadas ao Memory() do mem0ai.
    """

    # Injectados pelo servidor (antes de start).
    memory: Any = None
    users: dict[str, dict[str, Any]] = {}

    # ── Helpers ────────────────────────────────────────────────────────

    def _send_json(self, status: int, body: Any) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(body, default=str).encode("utf-8"))

    def _send_no_content(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def _parse_qs(self) -> dict[str, str]:
        """Extrai query params da URL (simples, sem dependência)."""
        path = self.path
        qs: dict[str, str] = {}
        if "?" in path:
            query_string = path.split("?", 1)[1]
            for pair in query_string.split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    qs[k] = v
                elif pair:
                    qs[pair] = ""
        return qs

    # ── Routing ────────────────────────────────────────────────────────

    def _route_path(self) -> str:
        """Devolve o path sem query string."""
        return self.path.split("?", 1)[0].rstrip("/")

    def do_GET(self) -> None:
        path = self._route_path()
        try:
            if path == "/health":
                self._handle_health()
            elif path == "/v1/memories":
                self._handle_search()
            elif path == "/v1/users":
                self._handle_list_users()
            else:
                self._send_json(404, {"error": "not found"})
        except Exception:
            traceback.print_exc()
            self._send_json(500, {"error": traceback.format_exc()})

    def do_POST(self) -> None:
        path = self._route_path()
        try:
            if path == "/v1/memories":
                self._handle_add()
            else:
                self._send_json(404, {"error": "not found"})
        except Exception:
            traceback.print_exc()
            self._send_json(500, {"error": traceback.format_exc()})

    def do_DELETE(self) -> None:
        path = self._route_path()
        try:
            if path == "/v1/memories":
                self._handle_delete()
            else:
                self._send_json(404, {"error": "not found"})
        except Exception:
            traceback.print_exc()
            self._send_json(500, {"error": traceback.format_exc()})

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ── Handlers ───────────────────────────────────────────────────────

    def _handle_health(self) -> None:
        """GET /health → 200 {"ok":true} (handshake do boot)."""
        self._send_json(200, {"ok": True})

    def _handle_add(self) -> None:
        """POST /v1/memories/ → mem.add(...) → {"id":"..."}."""
        body = self._read_body()
        user_id = body.get("user_id", "default")
        messages = body.get("messages", [])
        metadata = body.get("metadata")

        if not messages:
            self._send_json(400, {"error": "messages é obrigatório"})
            return

        # infer=False: armazena o conteúdo DIRETO (embed+store), sem extração por LLM.
        # Semântica da porta MemoryEngine = "guarda o que recebe"; e o judge local
        # (qwen2.5:0.5b) é fraco demais p/ a extração de fatos do mem0 (retornaria vazio).
        result = self.memory.add(messages, user_id=user_id, metadata=metadata, infer=False)

        # mem0ai 2.0.7 retorna {"results":[{"id",...}]}; o TS espera {"id": "..."}.
        first_id = None
        if isinstance(result, dict):
            res_list = result.get("results")
            if isinstance(res_list, list) and res_list:
                first_id = res_list[0].get("id")
            else:
                first_id = result.get("id")
        elif isinstance(result, list) and result:
            first_id = result[0].get("id")

        # Track user
        _track_user(self.users, user_id)

        self._send_json(200, {"id": first_id})

    def _handle_search(self) -> None:
        """GET /v1/memories/?user_id&query&limit → mem.search(...) → {"results":[...]}."""
        qs = self._parse_qs()
        user_id = qs.get("user_id", "default")
        query = qs.get("query", "")
        limit = int(qs.get("limit", "10"))

        resp = _search_compat(self.memory, query, user_id, limit)

        # mem0ai.search retorna {"results": [...]}
        results = resp.get("results", []) if isinstance(resp, dict) else []

        self._send_json(200, {"results": results})

    def _handle_list_users(self) -> None:
        """GET /v1/users/ → lista scopes com memory_count."""
        # Reconcilia tracking file com o estado real (get_all de cada user).
        users_list = []
        for user_id in list(self.users.keys()):
            try:
                all_mems = _get_all_compat(self.memory, user_id)
            except Exception:
                # F100 — erro TRANSITÓRIO no get_all NÃO é "scope vazio". Conflar os dois
                # (count=0 ⇒ untrack) DESTRÓI o tracking de um scope COM memórias num hiccup
                # do backend — o scope some da lista (memórias intactas, mas invisíveis) até
                # o próximo add. CA-MA8: degrada, não destrói estado. Preserva o tracking e
                # OMITE só desta resposta (reaparece no próximo list bem-sucedido).
                continue

            if isinstance(all_mems, dict):
                count = len(all_mems.get("results", []))
            elif isinstance(all_mems, list):
                count = len(all_mems)
            else:
                count = 0

            created_at = self.users[user_id].get("created_at")
            entry: dict[str, Any] = {
                "user_id": user_id,
                "memory_count": count,
            }
            if created_at:
                entry["created_at"] = created_at

            # Vazio COMPROVADO (get_all OK retornando 0) ⇒ foi deletado: untrack.
            if count > 0:
                users_list.append(entry)
            else:
                _untrack_user(self.users, user_id)

        self._send_json(200, {"users": users_list})

    def _handle_delete(self) -> None:
        """DELETE /v1/memories/?user_id=X → mem.delete_all(user_id=X)."""
        qs = self._parse_qs()
        user_id = qs.get("user_id", "default")

        self.memory.delete_all(user_id=user_id)
        _untrack_user(self.users, user_id)

        self._send_no_content()

    # Suprime logs por request (stderr polui a TUI).
    def log_message(self, format: str, *args: Any) -> None:
        pass


# ── ThreadingHTTPServer ───────────────────────────────────────────────────
class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """HTTPServer com thread por request (stdlib apenas)."""
    daemon_threads = True


# ── Main ──────────────────────────────────────────────────────────────────
EMBEDDER_MARKER = os.path.join(ALUY_MEMORY_DIR, ".embedder")


def _migrate_embedder_if_changed() -> None:
    """Se o embedder mudou desde o último boot (marca em `.embedder` ≠ atual), a dimensão do
    vetor muda e o store chromadb fica incompatível ⇒ reseta proativamente. Best-effort."""
    try:
        prev = None
        if os.path.exists(EMBEDDER_MARKER):
            with open(EMBEDDER_MARKER, encoding="utf-8") as fh:
                prev = fh.read().strip()
        if prev is not None and prev != EMBEDDER_MODEL:
            sys.stderr.write(
                f"aluy-mem0: embedder mudou ({prev} → {EMBEDDER_MODEL}); "
                "dimensão do vetor difere — resetando store p/ recriar.\n"
            )
            _reset_incompatible_stores()
            os.makedirs(ALUY_MEMORY_DIR, mode=0o700, exist_ok=True)
    except Exception:  # noqa: BLE001 — migração best-effort, nunca derruba o boot
        pass


def _write_embedder_marker() -> None:
    """Grava qual embedder gerou os vetores atuais (p/ detectar troca no próximo boot)."""
    try:
        os.makedirs(ALUY_MEMORY_DIR, mode=0o700, exist_ok=True)
        with open(EMBEDDER_MARKER, "w", encoding="utf-8") as fh:
            fh.write(EMBEDDER_MODEL)
    except Exception:  # noqa: BLE001
        pass


# ── Classificação de erro ao abrir o store ─────────────────────────────────
# REGRA DE OURO: só uma incompatibilidade RECONHECIDA do store justifica movê-lo. Qualquer outro
# erro (Ollama fora do ar, timeout, disco, permissão, bug) deixa os dados EXATAMENTE onde estão.
# Achado ao vivo: com o Ollama parado, o `from_config` do mem0 estourou `ConnectionError` e o
# antigo `except Exception` tratou isso como "store incompatível" ⇒ o store inteiro (48 docs)
# foi renomeado para `memory.incompat-<ts>` e a memória semântica sumiu em silêncio.
_TRANSPORT_CLASS_NAMES = frozenset({
    "ConnectError", "ConnectTimeout", "ReadTimeout", "ReadError", "WriteError", "PoolTimeout",
    "TimeoutException", "NetworkError", "RemoteProtocolError", "ProtocolError",
    "NewConnectionError", "MaxRetryError", "ProxyError", "ChunkedEncodingError",
})
_TRANSPORT_MESSAGE_MARKERS = (
    "failed to connect to ollama", "connection refused", "connection reset",
    "connection aborted", "name or service not known", "temporary failure in name resolution",
    "timed out", "max retries exceeded",
)
_INCOMPAT_MESSAGE_MARKERS = (
    "no such column",                 # sqlite do history de versão antiga (prev_value…)
    "no such table",
    "file is not a database",         # sqlite ilegível
    "database disk image is malformed",
    "invaliddimensionexception",      # chromadb: dimensão do vetor ≠ da collection
    "embedding dimension",
    "dimension mismatch",
    "expecting embedding with dimension",
)


def _exc_chain(exc: BaseException) -> list[BaseException]:
    chain: list[BaseException] = []
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        chain.append(cur)
        cur = cur.__cause__ or cur.__context__
    return chain


def is_transport_error(exc: BaseException) -> bool:
    """Falha de rede/transporte até o embedder (Ollama fora, timeout, DNS…). NUNCA é store."""
    import socket
    for e in _exc_chain(exc):
        if isinstance(e, (ConnectionError, TimeoutError, socket.timeout, socket.gaierror)):
            return True
        if type(e).__name__ in _TRANSPORT_CLASS_NAMES:
            return True
        msg = str(e).lower()
        if any(m in msg for m in _TRANSPORT_MESSAGE_MARKERS):
            return True
    return False


def is_store_incompatible(exc: BaseException) -> bool:
    """True SÓ para as incompatibilidades documentadas do store (chromadb KeyError '_type',
    sqlite `no such column`, dimensão do vetor…). Erro de transporte ⇒ sempre False."""
    if is_transport_error(exc):
        return False
    for e in _exc_chain(exc):
        if isinstance(e, KeyError) and e.args and e.args[0] == "_type":
            return True
        msg = f"{type(e).__name__}: {e}".lower()
        if any(m in msg for m in _INCOMPAT_MESSAGE_MARKERS):
            return True
    return False


_UUID_DIR = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _is_store_artifact(name: str, is_dir: bool) -> bool:
    """Só o que é do STORE (chromadb/history). `global.md`, `*.md` e qualquer outro arquivo do
    usuário em `~/.aluy/memory` NÃO são store e jamais se movem."""
    if ".incompat-" in name:
        return False
    if is_dir:
        return bool(_UUID_DIR.match(name))
    return name == ".embedder" or name.startswith("chroma.sqlite3") or name.startswith("history.db")


def _legacy_history_path() -> str:
    return os.path.expanduser("~/.mem0/history.db")


def _reset_incompatible_stores() -> None:
    """Quarentena (NÃO apaga) dos artefatos do store incompatível, p/ recriar fresco.
    Move só os artefatos do store para `<memória>.incompat-<ts>/` (mesmo nome de arquivo ⇒
    restaurar é mover de volta) e só cria o diretório se HÁ o que mover. Não toca `global.md`
    nem outros arquivos. Também o `~/.mem0/history.db` legado. Best-effort — nunca lança e
    NUNCA apaga: se o move falhar, deixa como está."""
    import shutil
    import time
    try:
        ts = int(time.time())
    except Exception:  # noqa: BLE001
        ts = 0
    try:
        if os.path.isdir(ALUY_MEMORY_DIR):
            movable = [
                n for n in sorted(os.listdir(ALUY_MEMORY_DIR))
                if _is_store_artifact(n, os.path.isdir(os.path.join(ALUY_MEMORY_DIR, n)))
            ]
            if movable:
                backup = f"{ALUY_MEMORY_DIR}.incompat-{ts}"
                os.makedirs(backup, mode=0o700, exist_ok=True)
                for n in movable:
                    try:
                        shutil.move(os.path.join(ALUY_MEMORY_DIR, n), os.path.join(backup, n))
                    except Exception:  # noqa: BLE001
                        pass
    except Exception:  # noqa: BLE001
        pass
    legacy = _legacy_history_path()
    try:
        if os.path.exists(legacy):
            os.rename(legacy, f"{legacy}.incompat-{ts}")
    except OSError:
        pass


def _open_memory(memory_cls: Any, config: dict[str, Any], *, sleep: Any = None,
                 wait_s: float | None = None) -> Any:
    """Abre o Memory(). Erro de TRANSPORTE (Ollama ainda subindo) ⇒ espera/tenta de novo até
    `wait_s` e, esgotado, sai SEM tocar no store. Incompatibilidade reconhecida ⇒ propaga
    `StoreIncompatible`. Qualquer outro erro ⇒ propaga intacto (store preservado)."""
    import time
    sleep = sleep or time.sleep
    if wait_s is None:
        try:
            wait_s = float(os.environ.get("ALUY_MEM0_OLLAMA_WAIT_S", "12"))
        except ValueError:
            wait_s = 12.0
    waited = 0.0
    while True:
        try:
            return memory_cls.from_config(config)
        except Exception as exc:  # noqa: BLE001
            if is_transport_error(exc):
                if waited >= wait_s:
                    raise EmbedderUnavailable(str(exc)) from exc
                sleep(1.0)
                waited += 1.0
                continue
            raise


class EmbedderUnavailable(Exception):
    """Embedder (Ollama) inalcançável: o store NÃO foi tocado; tente de novo mais tarde."""


def main() -> None:
    parser = argparse.ArgumentParser(description="aluy-mem0-server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"Porta loopback (default: {DEFAULT_PORT})")
    parser.add_argument("--host", type=str, default=DEFAULT_HOST,
                        help=f"Host (default: {DEFAULT_HOST})")
    args = parser.parse_args()

    # Import lazy — só depois do venv estar configurado.
    try:
        from mem0 import Memory  # type: ignore[import-untyped]
    except ImportError:
        print("ERRO: mem0ai não instalado. Rode `aluy init` primeiro.", file=sys.stderr)
        sys.exit(1)

    # Garante o dir de store com perms corretas.
    os.makedirs(ALUY_MEMORY_DIR, mode=0o700, exist_ok=True)

    # MIGRAÇÃO DE EMBEDDER (proativa): trocar o embedder muda a DIMENSÃO do vetor (bge-m3/
    # mxbai=1024, nomic=768). O chromadb só estoura a incompatibilidade no ADD/SEARCH (runtime),
    # NÃO no boot — então o self-heal abaixo (que envolve só o `from_config`) não pegaria. Aqui,
    # ANTES de subir: se o embedder mudou desde o último boot, reseta o store (a marca guarda
    # qual embedder gerou os vetores atuais). Best-effort — nunca derruba o boot.
    _migrate_embedder_if_changed()

    # Instancia Memory() UMA vez. SELF-HEAL de upgrade: um store gravado por uma versão
    # ANTERIOR do chromadb/mem0 pode ser ilegível pela atual (ex.: chromadb `KeyError: '_type'`
    # na config da collection; sqlite `no such column: prev_value` no history). Em vez de
    # CRASHAR (deixando o sidecar "fora" sem causa visível), movemos os stores antigos p/
    # backup e RECRIAMOS frescos. Perde-se memória antiga (já ilegível de qualquer forma),
    # mas o serviço SOBE. Achado ao vivo na máquina do dono (dois stores de jun/antigo).
    config = _build_mem0_config()
    try:
        memory = _open_memory(Memory, config)
    except EmbedderUnavailable as exc:
        # Ollama fora do ar: NÃO é store ruim. Dados intactos; sai p/ o supervisor/próximo boot
        # tentar de novo (o serviço volta sozinho quando o Ollama estiver de pé).
        sys.stderr.write(
            f"aluy-mem0: embedder (Ollama) indisponível ({exc}); store INTACTO, nada movido.\n"
        )
        sys.exit(75)
    except Exception as exc:  # noqa: BLE001
        if not is_store_incompatible(exc):
            # Erro não reconhecido como incompatibilidade: não adivinha, não move nada.
            sys.stderr.write(
                f"aluy-mem0: falha ao abrir o store ({type(exc).__name__}: {exc}); "
                "não é incompatibilidade reconhecida — store INTACTO.\n"
            )
            raise
        if os.environ.get("ALUY_MEM0_RESET_DONE") == "1":
            # JÁ resetamos uma vez e AINDA falha ⇒ não é store velho; propaga (não loopa).
            raise
        sys.stderr.write(
            f"aluy-mem0: store incompatível ({type(exc).__name__}: {exc}); "
            "movendo p/ backup e reiniciando fresco…\n"
        )
        _reset_incompatible_stores()
        # RE-EXEC em vez de retry in-process: o chromadb CACHEIA o client/conexão por
        # processo, então um 2º `from_config` no MESMO processo reusa o store velho. Reiniciar
        # o processo garante chromadb/mem0 FRESCOS. `ALUY_MEM0_RESET_DONE` evita loop infinito.
        # CROSS-SO: o supervisor health-checa a PORTA (não o PID), então trocar de processo é OK
        # em Linux/macOS/Windows. `os.execv` no Windows pode falhar em casos raros (path/quoting)
        # — então caímos p/ um respawn via subprocess + saída limpa; e, em último caso, p/ um
        # retry in-process (melhor um chromadb possivelmente cacheado do que o sidecar morto).
        os.environ["ALUY_MEM0_RESET_DONE"] = "1"
        try:
            os.execv(sys.executable, [sys.executable, *sys.argv])
        except Exception:  # noqa: BLE001 — execv indisponível/falhou (ex.: Windows)
            try:
                import subprocess

                subprocess.Popen([sys.executable, *sys.argv], close_fds=True)
                os._exit(0)  # encerra ESTE processo; o novo assume a porta
            except Exception:  # noqa: BLE001 — sem respawn possível: tenta in-process
                os.makedirs(ALUY_MEMORY_DIR, mode=0o700, exist_ok=True)
                memory = Memory.from_config(config)
            else:
                return  # inalcançável após _exit — só p/ o type-checker
        else:
            return  # inalcançável (execv substitui o processo) — só p/ o type-checker

    # Store criado/aberto OK com o embedder atual — grava a marca p/ detectar troca futura.
    _write_embedder_marker()

    # Injeta no handler.
    Mem0Handler.memory = memory
    Mem0Handler.users = _load_users()

    # Cria servidor com bind explícito em loopback.
    server = ThreadingHTTPServer((args.host, args.port), Mem0Handler)

    # Graceful shutdown no SIGTERM (boot-supervisor mata com SIGTERM).
    def _shutdown(signum: int, frame: Any) -> None:
        print(f"\naluy-mem0-server: recebido sinal {signum}, desligando...", file=sys.stderr)
        server.shutdown()
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    print(f"aluy-mem0-server: escutando em http://{args.host}:{args.port}", file=sys.stderr)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("aluy-mem0-server: parado.", file=sys.stderr)


if __name__ == "__main__":
    main()
