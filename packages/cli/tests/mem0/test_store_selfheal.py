"""
Self-heal do store do aluy-mem0-server: quarentena SÓ para incompatibilidade reconhecida.

Regressão do achado ao vivo: Ollama fora do ar ⇒ `ConnectionError` no `from_config` ⇒ o antigo
`except Exception` renomeava o store inteiro (+ `global.md`) p/ `memory.incompat-<ts>`.
"""

import os
import sqlite3
import tempfile
import unittest
from importlib import util as importlib_util
from pathlib import Path

ASSET_DIR = Path(__file__).resolve().parent.parent.parent / "assets" / "mem0"
spec = importlib_util.spec_from_file_location("aluy_mem0_server_sh", ASSET_DIR / "aluy-mem0-server.py")
server = importlib_util.module_from_spec(spec)
spec.loader.exec_module(server)

UUID = "123e4567-e89b-12d3-a456-426614174000"


class FakeMemory:
    """Memory() cuja from_config devolve/levanta o que o teste mandar."""

    def __init__(self, errors):
        self.errors = list(errors)
        self.calls = 0

    def from_config(self, config):
        self.calls += 1
        if self.errors:
            e = self.errors.pop(0)
            if e is not None:
                raise e
        return "MEM"


class ClassificationTest(unittest.TestCase):
    def test_transport_errors_are_not_incompat(self):
        for exc in (
            ConnectionError("Failed to connect to Ollama. Please check that Ollama is downloaded"),
            TimeoutError("timed out"),
            ConnectionRefusedError(111, "Connection refused"),
            OSError("Temporary failure in name resolution"),
        ):
            self.assertTrue(server.is_transport_error(exc), exc)
            self.assertFalse(server.is_store_incompatible(exc), exc)

    def test_transport_wrapped_in_cause_still_transport(self):
        try:
            try:
                raise ConnectionError("Failed to connect to Ollama")
            except ConnectionError as inner:
                raise RuntimeError("embedder falhou") from inner
        except RuntimeError as outer:
            self.assertFalse(server.is_store_incompatible(outer))

    def test_transport_wins_even_if_message_mentions_incompat_words(self):
        # O transporte tem PRIORIDADE: nunca "cura" por causa de um texto ambíguo.
        exc = ConnectionError("Failed to connect to Ollama; embedding dimension unknown")
        self.assertFalse(server.is_store_incompatible(exc))
        self.assertFalse(server.is_store_incompatible(sqlite3.OperationalError("no such column: x; connection refused")))

    def test_documented_incompat_recognised(self):
        self.assertTrue(server.is_store_incompatible(KeyError("_type")))
        self.assertTrue(server.is_store_incompatible(sqlite3.OperationalError("no such column: prev_value")))
        self.assertTrue(server.is_store_incompatible(Exception("Embedding dimension 768 does not match collection dimensionality 1024")))
        self.assertTrue(server.is_store_incompatible(Exception("InvalidDimensionException: Embedding dimension 3 != 1024")))

    def test_unknown_error_is_not_incompat(self):
        self.assertFalse(server.is_store_incompatible(ValueError("algo estranho")))
        self.assertFalse(server.is_store_incompatible(KeyError("outra")))
        self.assertFalse(server.is_store_incompatible(PermissionError("denied")))


class ResetTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.mem = os.path.join(self.tmp, ".aluy", "memory")
        os.makedirs(os.path.join(self.mem, UUID))
        for n, c in (("chroma.sqlite3", "x"), ("history.db", "h"), (".embedder", "bge-m3"),
                     ("global.md", "fato global"), ("notas.txt", "do usuario")):
            Path(self.mem, n).write_text(c)
        self.saved = (server.ALUY_MEMORY_DIR, server._legacy_history_path)
        server.ALUY_MEMORY_DIR = self.mem
        server._legacy_history_path = lambda: os.path.join(self.tmp, ".mem0", "history.db")

    def tearDown(self):
        server.ALUY_MEMORY_DIR, server._legacy_history_path = self.saved
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_reset_moves_only_store_artifacts(self):
        server._reset_incompatible_stores()
        left = set(os.listdir(self.mem))
        self.assertEqual(left, {"global.md", "notas.txt"})
        backups = [d for d in os.listdir(os.path.dirname(self.mem)) if ".incompat-" in d]
        self.assertEqual(len(backups), 1)
        moved = set(os.listdir(os.path.join(os.path.dirname(self.mem), backups[0])))
        self.assertEqual(moved, {UUID, "chroma.sqlite3", "history.db", ".embedder"})
        self.assertEqual(Path(self.mem, "global.md").read_text(), "fato global")

    def test_reset_with_nothing_to_move_creates_no_backup(self):
        os.remove(os.path.join(self.mem, "chroma.sqlite3"))
        os.remove(os.path.join(self.mem, "history.db"))
        os.remove(os.path.join(self.mem, ".embedder"))
        os.rmdir(os.path.join(self.mem, UUID))
        server._reset_incompatible_stores()
        self.assertEqual([d for d in os.listdir(os.path.dirname(self.mem)) if ".incompat-" in d], [])
        self.assertTrue(os.path.exists(os.path.join(self.mem, "global.md")))

    def test_connection_error_leaves_everything_in_place(self):
        before = sorted(os.listdir(self.mem))
        fake = FakeMemory([ConnectionError("Failed to connect to Ollama")] * 50)
        with self.assertRaises(server.EmbedderUnavailable):
            server._open_memory(fake, {}, sleep=lambda s: None, wait_s=3)
        # o caminho de main() só reseta se is_store_incompatible — e não é.
        self.assertFalse(server.is_store_incompatible(ConnectionError("Failed to connect to Ollama")))
        self.assertEqual(sorted(os.listdir(self.mem)), before)
        self.assertEqual([d for d in os.listdir(os.path.dirname(self.mem)) if ".incompat-" in d], [])
        self.assertEqual(fake.calls, 4)  # 1 + 3 retentativas

    def test_retry_succeeds_when_ollama_comes_up(self):
        fake = FakeMemory([ConnectionError("Failed to connect to Ollama"), None])
        self.assertEqual(server._open_memory(fake, {}, sleep=lambda s: None, wait_s=5), "MEM")

    def test_non_transport_error_propagates_untouched(self):
        fake = FakeMemory([KeyError("_type")])
        with self.assertRaises(KeyError):
            server._open_memory(fake, {}, sleep=lambda s: None, wait_s=5)
        self.assertEqual(fake.calls, 1)


if __name__ == "__main__":
    unittest.main()
