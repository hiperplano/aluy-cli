"""
EST-1138 · C4 — testes do handler HTTP do aluy-mem0-server.

Testa o Mem0Handler isoladamente (sem subir Ollama, sem I/O de rede):
- Mock do Memory() do mem0ai
- Cada endpoint bate com o que mem0-memory-engine.ts espera
- /health → 200 {"ok": true}
- Bind loopback (127.0.0.1 via --host default)
"""

import json
import sys
import unittest
from importlib import util as importlib_util
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

# ── Carrega o módulo com nome de arquivo que contém hífen ──────────────
ASSET_DIR = Path(__file__).resolve().parent.parent.parent / "assets" / "mem0"
SCRIPT_PATH = ASSET_DIR / "aluy-mem0-server.py"

spec = importlib_util.spec_from_file_location("aluy_mem0_server", SCRIPT_PATH)
if spec is None or spec.loader is None:
    raise ImportError(f"Não foi possível carregar {SCRIPT_PATH}")
server = importlib_util.module_from_spec(spec)
spec.loader.exec_module(server)


class MockRequest:
    """Simula um request HTTP (BaseHTTPRequestHandler espera um socket)."""

    def __init__(self, method: str, path: str, body: dict | None = None):
        self._method = method
        self._path = path
        self._body = body

    def makefile(self, mode: str) -> BytesIO:
        if mode == "rb" and self._body is not None:
            return BytesIO(json.dumps(self._body).encode("utf-8"))
        return BytesIO(b"")


class MockServer:
    """Simula o servidor para o handler."""

    def __init__(self):
        self.server_address = ("127.0.0.1", 11435)


class TestMem0Handler(unittest.TestCase):
    """Testa cada endpoint do Mem0Handler com Memory mockado."""

    def setUp(self):
        # Mock do Memory.
        self.memory_mock = MagicMock()
        # Configura o handler com o Memory mock.
        server.Mem0Handler.memory = self.memory_mock
        server.Mem0Handler.users = {}

    # ── GET /health ──────────────────────────────────────────────────────

    def test_health_returns_200_ok(self):
        handler = self._create_handler("GET", "/health")
        handler.do_GET()

        self.assertEqual(handler._response_status, 200)
        self.assertEqual(handler._response_body, {"ok": True})

    # ── POST /v1/memories/ ──────────────────────────────────────────────

    def test_add_returns_id(self):
        self.memory_mock.add.return_value = [{"id": "mem-001"}]

        body = {
            "user_id": "test-user",
            "messages": [{"role": "user", "content": "fato importante"}],
            "metadata": {"source": "test"},
        }
        handler = self._create_handler("POST", "/v1/memories/", body)
        handler.do_POST()

        self.assertEqual(handler._response_status, 200)
        self.assertIn("id", handler._response_body)
        self.assertEqual(handler._response_body["id"], "mem-001")
        # Verifica que memory.add foi chamado.
        self.memory_mock.add.assert_called_once()
        call_kwargs = self.memory_mock.add.call_args.kwargs
        self.assertEqual(call_kwargs["user_id"], "test-user")
        self.assertEqual(call_kwargs["metadata"], {"source": "test"})
        # infer=False: store direto (qwen0.5b fraco p/ extração; semântica da porta).
        self.assertEqual(call_kwargs["infer"], False)

    def test_add_without_messages_returns_400(self):
        body = {"user_id": "test-user", "messages": []}
        handler = self._create_handler("POST", "/v1/memories/", body)
        handler.do_POST()

        self.assertEqual(handler._response_status, 400)

    def test_add_default_user_id(self):
        self.memory_mock.add.return_value = [{"id": "mem-default"}]

        body = {"messages": [{"role": "user", "content": "fato"}]}
        handler = self._create_handler("POST", "/v1/memories/", body)
        handler.do_POST()

        self.assertEqual(handler._response_status, 200)
        call_kwargs = self.memory_mock.add.call_args.kwargs
        self.assertEqual(call_kwargs["user_id"], "default")

    # ── GET /v1/memories/?... ───────────────────────────────────────────

    def test_search_returns_results(self):
        self.memory_mock.search.return_value = {
            "results": [
                {"id": "h1", "memory": "lembrete", "score": 0.95},
            ]
        }

        handler = self._create_handler("GET", "/v1/memories/?user_id=u1&query=teste&limit=5")
        handler.do_GET()

        self.assertEqual(handler._response_status, 200)
        self.assertIn("results", handler._response_body)
        self.assertEqual(len(handler._response_body["results"]), 1)
        self.assertEqual(handler._response_body["results"][0]["id"], "h1")

        # Verifica chamada ao memory.search (mem0ai 2.0.7: filters=/top_k=).
        self.memory_mock.search.assert_called_once_with(
            "teste", filters={"user_id": "u1"}, top_k=5
        )

    # ── GET /v1/users/ ──────────────────────────────────────────────────

    def test_list_users_returns_users(self):
        # Popula tracking com um user e faz get_all retornar itens.
        server.Mem0Handler.users = {
            "user-a": {"created_at": "2025-01-01T00:00:00Z"},
        }
        self.memory_mock.get_all.return_value = [
            {"id": "x1"}, {"id": "x2"},
        ]

        handler = self._create_handler("GET", "/v1/users/")
        handler.do_GET()

        self.assertEqual(handler._response_status, 200)
        users = handler._response_body.get("users", [])
        self.assertEqual(len(users), 1)
        self.assertEqual(users[0]["user_id"], "user-a")
        self.assertEqual(users[0]["memory_count"], 2)

    def test_list_users_transient_error_preserves_tracking(self):
        # F100 — get_all LANÇANDO (hiccup transitório) NÃO pode destruir o tracking de
        # um scope com memórias. Preserva o user (omite só desta resposta).
        server.Mem0Handler.users = {"proj-cheio": {"created_at": None}}
        self.memory_mock.get_all.side_effect = RuntimeError("backend hiccup")

        handler = self._create_handler("GET", "/v1/users/")
        with patch.object(server, "_save_users", lambda u: None):
            handler.do_GET()

        self.assertEqual(handler._response_status, 200)
        # O scope continua TRACKEADO (não foi deletado pelo erro transitório).
        self.assertIn("proj-cheio", server.Mem0Handler.users)

    def test_list_users_proven_empty_untracks(self):
        # Não-regressão: vazio COMPROVADO (get_all OK retornando 0) ⇒ untrack legítimo.
        server.Mem0Handler.users = {"proj-vazio": {"created_at": None}}
        self.memory_mock.get_all.return_value = {"results": []}

        handler = self._create_handler("GET", "/v1/users/")
        with patch.object(server, "_save_users", lambda u: None):
            handler.do_GET()

        self.assertEqual(handler._response_status, 200)
        self.assertEqual(handler._response_body.get("users", []), [])
        # Vazio comprovado ⇒ removido do tracking.
        self.assertNotIn("proj-vazio", server.Mem0Handler.users)

    # ── DELETE /v1/memories/?user_id=... ──────────────────────────────────

    def test_delete_returns_204(self):
        handler = self._create_handler("DELETE", "/v1/memories/?user_id=u1")
        handler.do_DELETE()

        self.assertEqual(handler._response_status, 204)
        self.memory_mock.delete_all.assert_called_once_with(user_id="u1")

    # ── OPTIONS (CORS) ───────────────────────────────────────────────────

    def test_options_returns_200(self):
        handler = self._create_handler("OPTIONS", "/v1/memories/")
        handler.do_OPTIONS()

        self.assertEqual(handler._response_status, 200)

    # ── Rotas inexistentes ──────────────────────────────────────────────

    def test_unknown_route_returns_404(self):
        handler = self._create_handler("GET", "/unknown")
        handler.do_GET()
        self.assertEqual(handler._response_status, 404)

    # ── Bind loopback ───────────────────────────────────────────────────

    def test_default_host_is_loopback(self):
        self.assertEqual(server.DEFAULT_HOST, "127.0.0.1")

    def test_default_port_is_11435(self):
        self.assertEqual(server.DEFAULT_PORT, 11435)

    # ── Helpers ──────────────────────────────────────────────────────────

    def _create_handler(
        self,
        method: str,
        path: str,
        body: dict | None = None,
    ) -> "server.Mem0Handler":
        """Cria um handler com request mockado."""
        mock_req = MockRequest(method, path, body)
        mock_srv = MockServer()

        # Cria o handler SEM __init__ (que chamaria BaseHTTPRequestHandler).
        handler = server.Mem0Handler.__new__(server.Mem0Handler)
        handler.request = mock_req  # type: ignore[attr-defined]
        handler.client_address = ("127.0.0.1", 0)  # type: ignore[attr-defined]
        handler.server = mock_srv  # type: ignore[attr-defined]

        # Atributos que o handler usa.
        handler.command = method
        handler.path = path
        handler.headers = {}  # type: ignore[attr-defined]
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            handler.headers["Content-Length"] = str(len(raw))  # type: ignore[index]
            handler.rfile = BytesIO(raw)  # type: ignore[attr-defined]
        else:
            handler.headers["Content-Length"] = "0"  # type: ignore[index]
            handler.rfile = BytesIO(b"")  # type: ignore[attr-defined]

        # Captura a resposta.
        handler._response_status = 0
        handler._response_body = None

        def _send_response(status: int) -> None:
            handler._response_status = status

        def _send_header(k: str, v: str) -> None:
            pass

        def _end_headers() -> None:
            pass

        orig_send_json = handler._send_json
        def _send_json(status: int, body: object) -> None:
            handler._response_status = status
            handler._response_body = body
            # Não escreve no wfile real.

        orig_send_no_content = handler._send_no_content
        def _send_no_content() -> None:
            handler._response_status = 204
            handler._response_body = None

        handler.send_response = _send_response  # type: ignore[method-assign]
        handler.send_header = _send_header  # type: ignore[method-assign]
        handler.end_headers = _end_headers  # type: ignore[method-assign]
        handler._send_json = _send_json  # type: ignore[method-assign]
        handler._send_no_content = _send_no_content  # type: ignore[method-assign]
        # wfile dummy.
        handler.wfile = BytesIO()  # type: ignore[attr-defined]

        return handler


if __name__ == "__main__":
    unittest.main()
