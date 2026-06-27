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
EMBEDDER_MODEL = "nomic-embed-text"
# LLM local p/ extração de fatos (mem0 add infer=True). SEM isto o mem0 cai no
# default OpenAI → 401. Local-first: tudo via Ollama loopback, zero credencial.
LLM_MODEL = "qwen2.5:0.5b"
USERS_FILE = os.path.join(ALUY_MEMORY_DIR, "aluy_users.json")


# ── Mem0 config ───────────────────────────────────────────────────────────
def _build_mem0_config() -> dict[str, Any]:
    """Monta a config do mem0ai com paths locais absolutos."""
    return {
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

        # mem0ai 2.0.7: entity params via filters=, paginação via top_k= (não user_id/limit).
        resp = self.memory.search(query, filters={"user_id": user_id}, top_k=limit)

        # mem0ai.search retorna {"results": [...]}
        results = resp.get("results", []) if isinstance(resp, dict) else []

        self._send_json(200, {"results": results})

    def _handle_list_users(self) -> None:
        """GET /v1/users/ → lista scopes com memory_count."""
        # Reconcilia tracking file com o estado real (get_all de cada user).
        users_list = []
        for user_id in list(self.users.keys()):
            try:
                # mem0ai 2.0.7: get_all usa filters= e retorna {"results": [...]}.
                all_mems = self.memory.get_all(filters={"user_id": user_id})
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

    # Instancia Memory() UMA vez.
    config = _build_mem0_config()
    memory = Memory.from_config(config)

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
