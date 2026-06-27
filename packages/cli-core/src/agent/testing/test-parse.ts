// ADR-0112 · EST-RT-1 — parser PURO multi-dialeto de saída de testes.
//
// Parseia a saída STREAMING de 16 frameworks principais linha-a-linha,
// emitindo eventos estruturados (pass/fail/file-done/summary) + placar exato.
// PURO (sem `node:*`, sem I/O) — testável sem spawnar.
// Parte do @hiperplano/aluy-cli-core (§8): a execução/streaming é porta injetada no @hiperplano/aluy-cli.
//
// TRAVAS:
//   • Anti-ReDoS — regex LINEAR/ancorada; MAX_LINE_BYTES ANTES do match.
//   • Tetos anti-OOM — MAX_FAILURES_SHOWN, MAX_FAIL_MESSAGE_BYTES.
//   • PLACAR SEMPRE EXATO (contagem passed/failed/total); SÓ o detalhe das
//     falhas é capado (lição do F6: cortar detalhe ≠ cortar verdade do agregado).
//   • DEGRADAÇÃO HONESTA — formato desconhecido ⇒ unknownFormat:true.

// ── Constantes de segurança ────────────────────────────────────────────────

/** Teto de bytes por linha: linhas maiores que isto são ignoradas no parse
 *  (anti-ReDoS: regex nunca roda em string gigante). */
export const MAX_LINE_BYTES = 8_192;

/** Máximo de falhas cujo detalhe é armazenado (o PLACAR é sempre exato). */
export const MAX_FAILURES_SHOWN = 50;

/** Máximo de bytes por mensagem de falha (CLI-SEC-8). */
export const MAX_FAIL_MESSAGE_BYTES = 2_048;

// ── Eventos ────────────────────────────────────────────────────────────────

/** Um evento de progresso de teste, emitido linha-a-linha pelo parser. */
export type TestEvent =
  | { readonly kind: 'pass'; readonly name: string }
  | { readonly kind: 'fail'; readonly name: string; readonly message?: string }
  | {
      readonly kind: 'file-done';
      readonly file: string;
      readonly passed: number;
      readonly failed: number;
    }
  | {
      readonly kind: 'summary';
      readonly passed: number;
      readonly failed: number;
      readonly total: number;
      readonly durationMs?: number;
    };

// ── Dialeto ────────────────────────────────────────────────────────────────

/** Contrato de um dialeto de parsing. Cada framework implementa um. */
export interface TestDialect {
  /** Identificador curto (ex.: "vitest", "pytest"). */
  readonly id: string;
  /**
   * Tenta casar o CABEÇALHO da saída (primeiras linhas) p/ detectar o dialeto.
   * Retorna `true` se este dialeto reconhece o formato.
   */
  matches(firstLines: string): boolean;
  /**
   * Parseia UMA linha da saída e devolve um `TestEvent` (ou `null` se a linha
   * não produz evento — ex.: linha de stack trace, linha em branco de padding).
   */
  parseLine(line: string): TestEvent | null;
}

// ── Vitest ─────────────────────────────────────────────────────────────────

const vitestDialect: TestDialect = {
  id: 'vitest',
  matches(head: string): boolean {
    // Vitest emite cabeçalho característico: "RUN  vX.Y.Z ..." ou "vitest vX.Y.Z"
    return /^\s*RUN\s+v[\d.]+\s|^\s*vitest\s+v[\d.]+/m.test(head);
  },
  parseLine(line: string): TestEvent | null {
    // ✓ test name  (pass)
    const passMatch = line.match(/^\s*✓\s+(.+?)(?:\s+\d+ms)?\s*$/);
    if (passMatch) return { kind: 'pass', name: passMatch[1]!.trim() };

    // ✗ test name  (fail)
    const failMatch = line.match(/^\s*[✗×x]\s+(.+?)(?:\s+\d+ms)?\s*$/);
    if (failMatch) return { kind: 'fail', name: failMatch[1]!.trim() };

    // Tests  N passed | M failed (summary de arquivo)
    const fileDoneMatch = line.match(
      /^\s*Tests\s+(\d+)\s+passed\s*(?:\(\d+\))?\s*\|\s*(\d+)\s+failed/,
    );
    if (fileDoneMatch) {
      const passed = parseInt(fileDoneMatch[1]!, 10);
      const failed = parseInt(fileDoneMatch[2]!, 10);
      return { kind: 'file-done', file: '', passed, failed };
    }

    // Test Files  N passed | M failed (N) — summary global do vitest
    const summaryMatch = line.match(
      /^\s*Test\s+Files\s+(\d+)\s+passed(?:\s*\(\d+\))?\s*\|\s*(\d+)\s+failed/,
    );
    if (summaryMatch) {
      const passed = parseInt(summaryMatch[1]!, 10);
      const failed = parseInt(summaryMatch[2]!, 10);
      return { kind: 'summary', passed, failed, total: passed + failed };
    }

    // Tests  N passed | M total — vitest sem falhas
    const allPassMatch = line.match(
      /^\s*Tests\s+(\d+)\s+passed(?:\s*\(\d+\))?\s*\|\s*(\d+)\s+total/,
    );
    if (allPassMatch) {
      const passed = parseInt(allPassMatch[1]!, 10);
      const total = parseInt(allPassMatch[2]!, 10);
      return { kind: 'summary', passed, failed: total - passed, total };
    }

    return null;
  },
};

// ── Jest ───────────────────────────────────────────────────────────────────

const jestDialect: TestDialect = {
  id: 'jest',
  matches(head: string): boolean {
    return /PASS\s|FAIL\s|jest\s+v[\d.]+|Test\s+Suites:/m.test(head);
  },
  parseLine(line: string): TestEvent | null {
    // ✓ test name (pass — jest também usa ✓)
    const passMatch = line.match(/^\s*✓\s+(.+?)(?:\s+\(\d+\s*ms?\))?\s*$/);
    if (passMatch) return { kind: 'pass', name: passMatch[1]!.trim() };

    // ✕ test name (fail)
    const failMatch = line.match(/^\s*[✕×✗x]\s+(.+?)(?:\s+\(\d+\s*ms?\))?\s*$/);
    if (failMatch) return { kind: 'fail', name: failMatch[1]!.trim() };

    // PASS src/file.test.ts
    const filePassMatch = line.match(/^\s*PASS\s+(\S+)/);
    if (filePassMatch) {
      return { kind: 'file-done', file: filePassMatch[1]!, passed: 0, failed: 0 };
    }

    // FAIL src/file.test.ts
    const fileFailMatch = line.match(/^\s*FAIL\s+(\S+)/);
    if (fileFailMatch) {
      return { kind: 'file-done', file: fileFailMatch[1]!, passed: 0, failed: 0 };
    }

    // Test Suites: N passed, M failed, K total — ignoramos p/ placar de testes
    const suiteSummary = line.match(
      /^\s*Test\s+Suites:\s+(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+total/,
    );
    if (suiteSummary) return null;

    // Tests: N passed, M failed, K total
    const testSummary = line.match(
      /^\s*Tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+total/,
    );
    if (testSummary) {
      const passed = parseInt(testSummary[1]!, 10);
      const failed = parseInt(testSummary[2]!, 10);
      const total = parseInt(testSummary[3]!, 10);
      return { kind: 'summary', passed, failed, total };
    }

    // ● test name (fail detail — jest usa ● para cabeçalho de falha)
    const bulletFailMatch = line.match(/^\s*●\s+(.+)/);
    if (bulletFailMatch) {
      return { kind: 'fail', name: bulletFailMatch[1]!.trim() };
    }

    return null;
  },
};

// ── Pytest ─────────────────────────────────────────────────────────────────

const pytestDialect: TestDialect = {
  id: 'pytest',
  matches(head: string): boolean {
    return (
      /^={3,}\s+test\s+session\s+starts\s+={3,}/m.test(head) ||
      /^platform\s+(linux|darwin|win32)/m.test(head) ||
      /^rootdir:/m.test(head) ||
      /^collected\s+\d+\s+items?/m.test(head) ||
      /^test_.+\.py\s+\./m.test(head)
    );
  },
  parseLine(line: string): TestEvent | null {
    // Modo verbose: "test_file.py::test_name PASSED [ 50%]"
    const verbosePass = line.match(/^(\S+?)::(\S+?)\s+PASSED\s+\[\s*\d+%\]/);
    if (verbosePass) {
      return { kind: 'pass', name: `${verbosePass[1]}::${verbosePass[2]}` };
    }

    // Modo verbose: "test_file.py::test_name FAILED [ 50%]"
    const verboseFail = line.match(/^(\S+?)::(\S+?)\s+FAILED\s+\[\s*\d+%\]/);
    if (verboseFail) {
      return { kind: 'fail', name: `${verboseFail[1]}::${verboseFail[2]}` };
    }

    // Modo verbose sem porcentagem: "test_file.py::test_name PASSED"
    const verbosePass2 = line.match(/^(\S+?)::(\S+?)\s+PASSED\s*$/);
    if (verbosePass2) {
      return { kind: 'pass', name: `${verbosePass2[1]}::${verbosePass2[2]}` };
    }

    // Modo verbose sem porcentagem: "test_file.py::test_name FAILED"
    const verboseFail2 = line.match(/^(\S+?)::(\S+?)\s+FAILED\s*$/);
    if (verboseFail2) {
      return { kind: 'fail', name: `${verboseFail2[1]}::${verboseFail2[2]}` };
    }

    // "====== N passed, M failed in X.XXs ======"
    const summaryMatch = line.match(
      /^={3,}\s+([\d,]+)\s+passed(?:,\s+([\d,]+)\s+failed)?(?:,\s+([\d,]+)\s+errors?)?(?:.*?in\s+([\d.]+)s)?\s+={3,}/,
    );
    if (summaryMatch) {
      const passed = summaryMatch[1] ? parseInt(summaryMatch[1].replace(/,/g, ''), 10) : 0;
      const failed = summaryMatch[2] ? parseInt(summaryMatch[2].replace(/,/g, ''), 10) : 0;
      const errors = summaryMatch[3] ? parseInt(summaryMatch[3].replace(/,/g, ''), 10) : 0;
      const dur = summaryMatch[4] ? parseFloat(summaryMatch[4]) * 1000 : undefined;
      const evt: TestEvent = {
        kind: 'summary',
        passed,
        failed: failed + errors,
        total: passed + failed + errors,
      };
      if (dur !== undefined) (evt as { durationMs?: number }).durationMs = dur;
      return evt;
    }

    // "N passed in X.XXs" — forma compacta
    const compactSummary = line.match(/^([\d,]+)\s+passed\s+in\s+([\d.]+)s\s*$/);
    if (compactSummary) {
      const passed = parseInt(compactSummary[1]!.replace(/,/g, ''), 10);
      const dur = parseFloat(compactSummary[2]!) * 1000;
      const evt: TestEvent = { kind: 'summary', passed, failed: 0, total: passed };
      if (dur !== undefined) (evt as { durationMs?: number }).durationMs = dur;
      return evt;
    }

    // "N failed, M passed in X.XXs"
    const failedSummary = line.match(
      /^([\d,]+)\s+failed,\s+([\d,]+)\s+passed\s+in\s+([\d.]+)s\s*$/,
    );
    if (failedSummary) {
      const failed = parseInt(failedSummary[1]!.replace(/,/g, ''), 10);
      const passed = parseInt(failedSummary[2]!.replace(/,/g, ''), 10);
      const dur = parseFloat(failedSummary[3]!) * 1000;
      const evt: TestEvent = { kind: 'summary', passed, failed, total: passed + failed };
      if (dur !== undefined) (evt as { durationMs?: number }).durationMs = dur;
      return evt;
    }

    // FAILED test_file.py::test_name — header no report de falhas
    const failHeader = line.match(/^FAILED\s+(\S+)/);
    if (failHeader) {
      return { kind: 'fail', name: failHeader[1]! };
    }

    return null;
  },
};

// ── Go Test ────────────────────────────────────────────────────────────────

const goTestDialect: TestDialect = {
  id: 'go-test',
  matches(head: string): boolean {
    // "ok  pkg/path  0.123s" mas NÃO "ok N - name" (TAP do node-test)
    if (/^ok\s+\S+\s+[\d.]+s/m.test(head)) return true;
    if (/^ok\s+\S+\s+\(cached\)/m.test(head)) return true;
    if (/^FAIL\s+\S+\s+[\d.]+s/m.test(head)) return true;
    if (/^FAIL\s+\S+\s+\[build failed\]/m.test(head)) return true;
    if (/^\?\s+\S+\s+\[no test files\]/m.test(head)) return true;
    if (/^---\s+(PASS|FAIL):/m.test(head)) return true;
    if (/^=== RUN\s+/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // --- PASS: TestName (0.00s)
    const passMatch = line.match(/^---\s+PASS:\s+(\S+)\s/);
    if (passMatch) return { kind: 'pass', name: passMatch[1]! };

    // --- FAIL: TestName (0.00s)
    const failMatch = line.match(/^---\s+FAIL:\s+(\S+)\s/);
    if (failMatch) return { kind: 'fail', name: failMatch[1]! };

    // ok  pkg/path  0.123s
    const okPkg = line.match(/^ok\s+(\S+)\s+(?:\(cached\)\s+)?([\d.]+)s/);
    if (okPkg) {
      return { kind: 'file-done', file: okPkg[1]!, passed: 0, failed: 0 };
    }

    // ok  pkg/path  (cached) — sem tempo
    const okPkgCached = line.match(/^ok\s+(\S+)\s+\(cached\)/);
    if (okPkgCached) {
      return { kind: 'file-done', file: okPkgCached[1]!, passed: 0, failed: 0 };
    }

    // FAIL  pkg/path  0.123s
    const failPkg = line.match(/^FAIL\s+(\S+)\s+([\d.]+)s/);
    if (failPkg) {
      return { kind: 'file-done', file: failPkg[1]!, passed: 0, failed: 0 };
    }

    // FAIL [build failed]
    const failBuild = line.match(/^FAIL\s+(\S+)\s+\[build failed\]/);
    if (failBuild) {
      return { kind: 'file-done', file: failBuild[1]!, passed: 0, failed: 0 };
    }

    return null;
  },
};

// ── Mocha ──────────────────────────────────────────────────────────────────

const mochaDialect: TestDialect = {
  id: 'mocha',
  matches(head: string): boolean {
    // Mocha inicia com linhas de teste (✓/✗) SEM cabeçalho de runner,
    // e termina com "N passing" / "M failing". Diferencia de vitest/jest
    // pela AUSÊNCIA de "RUN  v", "PASS/FAIL arquivo", "Test Suites:".
    // Detectamos pela presença de "✓"/"✗" + "passing" sem marcas de vitest/jest.
    const hasMochaMarker =
      /^\s*(?:✓|[✗×x])\s+.+$/m.test(head) ||
      /^\s+\d+\s+passing/m.test(head) ||
      /^\s+\d+\s+failing/m.test(head);
    if (!hasMochaMarker) return false;
    // Exclui vitest (RUN  v) e jest (PASS/FAIL arquivo, Test Suites)
    if (/^\s*RUN\s+v[\d.]+/m.test(head)) return false;
    if (/^\s*(?:PASS|FAIL)\s+\S+/m.test(head)) return false;
    if (/Test\s+Suites:/m.test(head)) return false;
    if (/^\s*Test\s+Files\s+/m.test(head)) return false;
    return true;
  },
  parseLine(line: string): TestEvent | null {
    // ✓ test name (pass)
    const passMatch = line.match(/^\s*✓\s+(.+?)(?:\s+\(\d+\s*ms?\))?\s*$/);
    if (passMatch) return { kind: 'pass', name: passMatch[1]!.trim() };

    // ✗ test name (fail)
    const failMatch = line.match(/^\s*[✗×x]\s+(.+?)(?:\s+\(\d+\s*ms?\))?\s*$/);
    if (failMatch) return { kind: 'fail', name: failMatch[1]!.trim() };

    // N passing (Xms) — summary: passed
    const passingMatch = line.match(/^\s+(\d+)\s+passing\s*(?:\(([\d.]+)\s*ms?\))?/);
    if (passingMatch) {
      const passed = parseInt(passingMatch[1]!, 10);
      return { kind: 'summary', passed, failed: 0, total: passed };
    }

    // M failing — summary: failed (parse da linha seguinte ao passing)
    const failingMatch = line.match(/^\s+(\d+)\s+failing\s*$/);
    if (failingMatch) {
      const failed = parseInt(failingMatch[1]!, 10);
      return { kind: 'summary', passed: 0, failed, total: failed };
    }

    // - test name (pending — ignorado)
    return null;
  },
};

// ── Node-test (node:test) ──────────────────────────────────────────────────

const nodeTestDialect: TestDialect = {
  id: 'node-test',
  matches(head: string): boolean {
    // TAP: "TAP version 13"
    if (/^TAP\s+version\s+\d+/m.test(head)) return true;
    // Spec reporter: "▶ test_file" ou "✔"/"✖"
    if (/^▶\s+\S+/m.test(head)) return true;
    // TAP lines: "ok N - ..." / "not ok N - ..."
    if (/^\s*(?:ok|not ok)\s+\d+\s+-/m.test(head)) return true;
    // Summary footer: "# pass N", "# fail M", "# tests T"
    if (/^#\s+(?:pass|fail|tests)\s+\d+/m.test(head)) return true;
    // Spec summary footer: "ℹ pass N", "ℹ fail M"
    if (/^ℹ\s+(?:pass|fail|tests)\s+\d+/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // TAP: ok N - name
    const tapPass = line.match(/^\s*ok\s+\d+\s+-\s+(.+?)\s*$/);
    if (tapPass) return { kind: 'pass', name: tapPass[1]!.trim() };

    // TAP: not ok N - name
    const tapFail = line.match(/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/);
    if (tapFail) return { kind: 'fail', name: tapFail[1]!.trim() };

    // Spec reporter: ✔ name (ms)
    const specPass = line.match(/^\s*✔\s+(.+?)(?:\s+\(\d+\.?\d*ms\))?\s*$/);
    if (specPass) return { kind: 'pass', name: specPass[1]!.trim() };

    // Spec reporter: ✖ name (ms)
    const specFail = line.match(/^\s*✖\s+(.+?)(?:\s+\(\d+\.?\d*ms\))?\s*$/);
    if (specFail) return { kind: 'fail', name: specFail[1]!.trim() };

    // TAP summary: # pass N
    const tapPassSum = line.match(/^#\s+pass\s+(\d+)/);
    if (tapPassSum) {
      const passed = parseInt(tapPassSum[1]!, 10);
      return { kind: 'summary', passed, failed: 0, total: passed };
    }

    // TAP summary: # fail N
    const tapFailSum = line.match(/^#\s+fail\s+(\d+)/);
    if (tapFailSum) {
      const failed = parseInt(tapFailSum[1]!, 10);
      return { kind: 'summary', passed: 0, failed, total: failed };
    }

    // TAP summary: # tests N
    const tapTestsSum = line.match(/^#\s+tests\s+(\d+)/);
    if (tapTestsSum) {
      const total = parseInt(tapTestsSum[1]!, 10);
      return { kind: 'summary', passed: 0, failed: 0, total };
    }

    // Spec summary: ℹ pass N
    const specPassSum = line.match(/^ℹ\s+pass\s+(\d+)/);
    if (specPassSum) {
      const passed = parseInt(specPassSum[1]!, 10);
      return { kind: 'summary', passed, failed: 0, total: passed };
    }

    // Spec summary: ℹ fail N
    const specFailSum = line.match(/^ℹ\s+fail\s+(\d+)/);
    if (specFailSum) {
      const failed = parseInt(specFailSum[1]!, 10);
      return { kind: 'summary', passed: 0, failed, total: failed };
    }

    // Spec summary: ℹ tests N
    const specTestsSum = line.match(/^ℹ\s+tests\s+(\d+)/);
    if (specTestsSum) {
      const total = parseInt(specTestsSum[1]!, 10);
      return { kind: 'summary', passed: 0, failed: 0, total };
    }

    return null;
  },
};

// ── Python unittest ────────────────────────────────────────────────────────

const unittestDialect: TestDialect = {
  id: 'unittest',
  matches(head: string): boolean {
    // Summary lines UNIQUE to unittest: "Ran N tests in X.XXs", "FAILED (failures=M)" ou "OK"
    if (/^Ran\s+\d+\s+tests?\s+in\s+[\d.]+s/m.test(head)) return true;
    if (/^FAILED\s*\(failures=\d+/m.test(head)) return true;
    if (/^OK\s*$/m.test(head)) return true;
    // Cabeçalho: "test_xxx (module.Class)" seguido de progresso
    if (/^test_\S+\s+\(.*\)\s+\.\.\.\s+/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // Progress line: ".F...E." — cada . = pass, F = fail, E = error (fail)
    if (/^[.FEs]+$/.test(line)) {
      // Emite apenas o primeiro evento da linha (os demais são contados
      // pelo summary exato). Prioriza falhas primeiro.
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === 'F' || ch === 'E') {
          return { kind: 'fail', name: `fail #${i}` };
        }
      }
      // Se só tem passes
      if (line.length > 0 && line[0] === '.') {
        return { kind: 'pass', name: `pass` };
      }
    }

    // "Ran N tests in X.XXs"
    const ranMatch = line.match(/^Ran\s+(\d+)\s+tests?\s+in\s+([\d.]+)s/);
    if (ranMatch) {
      const total = parseInt(ranMatch[1]!, 10);
      const dur = parseFloat(ranMatch[2]!) * 1000;
      // waited for FAILED/OK next line to set passed/failed
      const evt: TestEvent = { kind: 'summary', passed: 0, failed: 0, total };
      (evt as { durationMs?: number }).durationMs = dur;
      return evt;
    }

    // "FAILED (failures=M)" ou "FAILED (failures=M, errors=E)"
    const failedMatch = line.match(/^FAILED\s*\(failures=(\d+)(?:,\s*errors=(\d+))?\)/);
    if (failedMatch) {
      const failures = parseInt(failedMatch[1]!, 10);
      const errors = failedMatch[2] ? parseInt(failedMatch[2]!, 10) : 0;
      const failed = failures + errors;
      return { kind: 'summary', passed: 0, failed, total: 0 };
    }

    // "OK"
    if (line.trim() === 'OK') {
      return { kind: 'summary', passed: 0, failed: 0, total: 0 };
    }

    // "FAIL: test_name (module.Class)" — detalhe de falha
    const failDetail = line.match(/^(?:FAIL|ERROR):\s+(.+?)\s+\(/);
    if (failDetail) {
      return { kind: 'fail', name: failDetail[1]!.trim() };
    }

    return null;
  },
};

// ── Cargo-test (Rust) ──────────────────────────────────────────────────────

const cargoTestDialect: TestDialect = {
  id: 'cargo-test',
  matches(head: string): boolean {
    // "running N tests"
    if (/^running\s+\d+\s+tests?/m.test(head)) return true;
    // "test result: ok. N passed"  /  "test result: FAILED."
    if (/^test\s+result:\s+(?:ok|FAILED)/m.test(head)) return true;
    // "test path::name ... ok" / "test path::name ... FAILED"
    if (/^test\s+\S+::\S+\s+\.{3}\s+(?:ok|FAILED)/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // test path::name ... ok
    const passMatch = line.match(/^test\s+(\S+)\s+\.{3}\s+ok\s*$/);
    if (passMatch) return { kind: 'pass', name: passMatch[1]! };

    // test path::name ... FAILED
    const failMatch = line.match(/^test\s+(\S+)\s+\.{3}\s+FAILED\s*$/);
    if (failMatch) return { kind: 'fail', name: failMatch[1]! };

    // test result: ok. N passed; M failed; I ignored; ... finished in X.XXs
    const summaryMatch = line.match(
      /^test\s+result:\s+(?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored.*?(?:finished\s+in\s+([\d.]+)s)?/,
    );
    if (summaryMatch) {
      const passed = parseInt(summaryMatch[1]!, 10);
      const failed = parseInt(summaryMatch[2]!, 10);
      const ignored = parseInt(summaryMatch[3]!, 10);
      const dur = summaryMatch[4] ? parseFloat(summaryMatch[4]) * 1000 : undefined;
      const evt: TestEvent = {
        kind: 'summary',
        passed,
        failed,
        total: passed + failed + ignored,
      };
      if (dur !== undefined) (evt as { durationMs?: number }).durationMs = dur;
      return evt;
    }

    return null;
  },
};

// ── RSpec (Ruby) ───────────────────────────────────────────────────────────

const rspecDialect: TestDialect = {
  id: 'rspec',
  matches(head: string): boolean {
    // "N examples, M failures" — assinatura ÚNICA do RSpec
    if (/^\s*\d+\s+examples?,\s+\d+\s+failures?/m.test(head)) return true;
    // "Failures:" com padrão numerado RSpec: "  1) ..."
    if (/^Failures:/m.test(head) && /^\s+\d+\)\s+/m.test(head)) return true;
    // "Finished in X.XX seconds (files took ...)" — padrão RSpec único
    if (/^Finished\s+in\s+[\d.]+\s+seconds?\s+\(files\s+took/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // Progress line: "....F.." — cada . = pass, F = fail
    if (/^[.F*]+$/.test(line)) {
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === 'F') {
          return { kind: 'fail', name: `fail #${i + 1}` };
        }
      }
      if (line.length > 0 && line[0] === '.') {
        return { kind: 'pass', name: 'pass' };
      }
    }

    // "N examples, M failures"
    const summaryMatch = line.match(/^\s*(\d+)\s+examples?,\s+(\d+)\s+failures?/);
    if (summaryMatch) {
      const total = parseInt(summaryMatch[1]!, 10);
      const failed = parseInt(summaryMatch[2]!, 10);
      return { kind: 'summary', passed: total - failed, failed, total };
    }

    // "Finished in X.XX seconds"
    const finishedMatch = line.match(/^Finished\s+in\s+([\d.]+)\s+seconds?/);
    if (finishedMatch) {
      const dur = parseFloat(finishedMatch[1]!) * 1000;
      const evt: TestEvent = { kind: 'summary', passed: 0, failed: 0, total: 0 };
      (evt as { durationMs?: number }).durationMs = dur;
      return evt;
    }

    return null;
  },
};

// ── Minitest (Ruby) ────────────────────────────────────────────────────────

const minitestDialect: TestDialect = {
  id: 'minitest',
  matches(head: string): boolean {
    // "Run options: --seed N" — assinatura ÚNICA do minitest
    if (/^Run\s+options:/m.test(head)) return true;
    // "# Running:" — marcador minitest
    if (/^#\s+Running:/m.test(head)) return true;
    // "N runs, A assertions, M failures, E errors, S skips" — assinatura ÚNICA
    if (/^\d+\s+runs?,\s+\d+\s+assertions?/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // Progress line: "....F..E." — . = pass, F = fail, E = error, S = skip
    if (/^[.FES]+$/.test(line)) {
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === 'F' || ch === 'E') {
          return { kind: 'fail', name: `fail #${i + 1}` };
        }
      }
      if (line.length > 0 && line[0] === '.') {
        return { kind: 'pass', name: 'pass' };
      }
    }

    // "N runs, A assertions, M failures, E errors, S skips"
    const summaryMatch = line.match(
      /^\s*(\d+)\s+runs?,\s+(\d+)\s+assertions?,\s+(\d+)\s+failures?,\s+(\d+)\s+errors?(?:,\s+(\d+)\s+skips?)?/,
    );
    if (summaryMatch) {
      const total = parseInt(summaryMatch[1]!, 10);
      const failures = parseInt(summaryMatch[3]!, 10);
      const errors = parseInt(summaryMatch[4]!, 10);
      const failed = failures + errors;
      return { kind: 'summary', passed: total - failed, failed, total };
    }

    // "Finished in X.XXXXs"
    const finishedMatch = line.match(/^Finished\s+in\s+([\d.]+)s/);
    if (finishedMatch) {
      const dur = parseFloat(finishedMatch[1]!) * 1000;
      const evt: TestEvent = { kind: 'summary', passed: 0, failed: 0, total: 0 };
      (evt as { durationMs?: number }).durationMs = dur;
      return evt;
    }

    return null;
  },
};

// ── JUnit (Java/Kotlin via Gradle ou Maven) ────────────────────────────────

const junitDialect: TestDialect = {
  id: 'junit',
  matches(head: string): boolean {
    // Gradle: "> Task :test"
    if (/^>\s+Task\s+:test/m.test(head)) return true;
    // Maven surefire: "Tests run: N, Failures: M"
    if (/^Tests\s+run:\s+\d+,\s+Failures:\s+\d+/m.test(head)) return true;
    // Gradle test result: "ClassName > methodName() PASSED/FAILED"
    if (/^\s*\S+\s*>\s*\S+\(\)\s+(?:PASSED|FAILED)/m.test(head)) return true;
    // "BUILD SUCCESSFUL" / "BUILD FAILED"
    if (/^BUILD\s+(?:SUCCESSFUL|FAILED)/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // Gradle: ClassName > methodName() PASSED
    const gradlePass = line.match(/^\s*(\S+\s*>\s*\S+\(\))\s+PASSED/);
    if (gradlePass) return { kind: 'pass', name: gradlePass[1]!.trim() };

    // Gradle: ClassName > methodName() FAILED
    const gradleFail = line.match(/^\s*(\S+\s*>\s*\S+\(\))\s+FAILED/);
    if (gradleFail) return { kind: 'fail', name: gradleFail[1]!.trim() };

    // Maven: Tests run: N, Failures: M, Errors: E, Skipped: S
    const mavenSummary = line.match(
      /^Tests\s+run:\s+(\d+),\s+Failures:\s+(\d+),\s+Errors:\s+(\d+),\s+Skipped:\s+(\d+)/,
    );
    if (mavenSummary) {
      const total = parseInt(mavenSummary[1]!, 10);
      const failures = parseInt(mavenSummary[2]!, 10);
      const errors = parseInt(mavenSummary[3]!, 10);
      const failed = failures + errors;
      return { kind: 'summary', passed: total - failed, failed, total };
    }

    // Gradle: "N tests completed, M failed"
    const gradleSummary = line.match(/^\s*(\d+)\s+tests?\s+completed,\s+(\d+)\s+failed/);
    if (gradleSummary) {
      const total = parseInt(gradleSummary[1]!, 10);
      const failed = parseInt(gradleSummary[2]!, 10);
      return { kind: 'summary', passed: total - failed, failed, total };
    }

    return null;
  },
};

// ── dotnet-test (.NET) ─────────────────────────────────────────────────────

const dotnetTestDialect: TestDialect = {
  id: 'dotnet-test',
  matches(head: string): boolean {
    // "Microsoft (R) Test Execution Command Line Tool"
    if (/Microsoft\s+\(R\)\s+Test\s+Execution/m.test(head)) return true;
    // "Passed! - Failed: N, Passed: M, Skipped: S, Total: T"
    if (/^(?:Passed|Failed)!\s*-/m.test(head)) return true;
    // "A total of N test files matched"
    if (/^A\s+total\s+of\s+\d+\s+test\s+files?/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // "Passed! - Failed: 0, Passed: N, Skipped: S, Total: T"
    const passedSummary = line.match(
      /^Passed!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/,
    );
    if (passedSummary) {
      const failed = parseInt(passedSummary[1]!, 10);
      const passed = parseInt(passedSummary[2]!, 10);
      const total = parseInt(passedSummary[4]!, 10);
      return { kind: 'summary', passed, failed, total };
    }

    // "Failed! - Failed: M, Passed: N, Skipped: S, Total: T"
    const failedSummary = line.match(
      /^Failed!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/,
    );
    if (failedSummary) {
      const failed = parseInt(failedSummary[1]!, 10);
      const passed = parseInt(failedSummary[2]!, 10);
      const total = parseInt(failedSummary[4]!, 10);
      return { kind: 'summary', passed, failed, total };
    }

    // "  Passed test_name [< 1 ms]"
    const passMatch = line.match(/^\s+Passed\s+(.+?)\s+\[/);
    if (passMatch) return { kind: 'pass', name: passMatch[1]!.trim() };

    // "  Failed test_name [< 1 ms]"
    const failMatch = line.match(/^\s+Failed\s+(.+?)\s+\[/);
    if (failMatch) return { kind: 'fail', name: failMatch[1]!.trim() };

    return null;
  },
};

// ── PHPUnit ────────────────────────────────────────────────────────────────

const phpunitDialect: TestDialect = {
  id: 'phpunit',
  matches(head: string): boolean {
    // "PHPUnit X.Y.Z by Sebastian Bergmann"
    if (/^PHPUnit\s+[\d.]+/m.test(head)) return true;
    // Progress: ".F.." com "N / N (100%)"
    if (/^\s*\d+\s*\/\s*\d+\s*\(\s*\d+%\s*\)/m.test(head)) return true;
    // Summary: "OK (N tests, M assertions)" ou "Tests: N, Assertions: A, Failures: M."
    if (/^OK\s*\(\d+\s+tests?/m.test(head)) return true;
    if (/^Tests:\s+\d+,\s+Assertions:/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // Progress line with dots: "..F..  5 / 5 (100%)"
    const progressMatch = line.match(/^([.FESI]+)\s+\d+\s*\/\s*\d+/);
    if (progressMatch) {
      const chars = progressMatch[1]!;
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i]!;
        if (ch === 'F' || ch === 'E') {
          return { kind: 'fail', name: `fail #${i + 1}` };
        }
      }
      if (chars.length > 0 && chars[0] === '.') {
        return { kind: 'pass', name: 'pass' };
      }
    }

    // "OK (N tests, M assertions)"
    const okMatch = line.match(/^OK\s*\(\s*(\d+)\s+tests?,\s*(\d+)\s+assertions?\)/);
    if (okMatch) {
      const total = parseInt(okMatch[1]!, 10);
      return { kind: 'summary', passed: total, failed: 0, total };
    }

    // "Tests: N, Assertions: A, Failures: M." ou "Tests: N, Assertions: A, Errors: E, Failures: M."
    const testsSummary = line.match(
      /^Tests:\s*(\d+),\s*Assertions:\s*(?:\d+),\s*(?:Errors:\s*(\d+),\s*)?Failures:\s*(\d+)\.?/,
    );
    if (testsSummary) {
      const total = parseInt(testsSummary[1]!, 10);
      const errors = testsSummary[2] ? parseInt(testsSummary[2]!, 10) : 0;
      const failures = parseInt(testsSummary[3]!, 10);
      const failed = failures + errors;
      return { kind: 'summary', passed: total - failed, failed, total };
    }

    // Failure detail: "N) Class::method"
    const failDetail = line.match(/^\s*\d+\)\s+(\S+)/);
    if (failDetail && line.includes('::')) {
      return { kind: 'fail', name: failDetail[1]!.trim() };
    }

    return null;
  },
};

// ── Pest (PHP) ─────────────────────────────────────────────────────────────

const pestDialect: TestDialect = {
  id: 'pest',
  matches(head: string): boolean {
    // "PASS  Tests\Class" — backslash é namespace PHP, único do pest
    if (/^\s*PASS\s+Tests\\/m.test(head)) return true;
    if (/^\s*FAIL\s+Tests\\/m.test(head)) return true;
    // "PEST" no início
    if (/^PEST/m.test(head)) return true;
    // Summary "Tests:  M failed, N passed" — ordem "failed" primeiro, único
    if (/^\s*Tests:\s+\d+\s+failed,\s+\d+\s+passed/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // ✓ test name
    const passMatch = line.match(/^\s*✓\s+(.+?)\s*$/);
    if (passMatch) return { kind: 'pass', name: passMatch[1]!.trim() };

    // ⨯ test name
    const failMatch = line.match(/^\s*⨯\s+(.+?)\s*$/);
    if (failMatch) return { kind: 'fail', name: failMatch[1]!.trim() };

    // PASS Tests\Class — início de arquivo/suite
    const filePass = line.match(/^\s*PASS\s+(Tests\\.+)/);
    if (filePass) {
      return { kind: 'file-done', file: filePass[1]!, passed: 0, failed: 0 };
    }

    // FAIL Tests\Class
    const fileFail = line.match(/^\s*FAIL\s+(Tests\\.+)/);
    if (fileFail) {
      return { kind: 'file-done', file: fileFail[1]!, passed: 0, failed: 0 };
    }

    // "Tests:  M failed, N passed" — note a ordem! failed primeiro
    const summaryMatch = line.match(/^\s*Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed/);
    if (summaryMatch) {
      const failed = parseInt(summaryMatch[1]!, 10);
      const passed = parseInt(summaryMatch[2]!, 10);
      return { kind: 'summary', passed, failed, total: passed + failed };
    }

    // "Tests:  N passed, M failed" — ordem alternativa
    const summaryMatch2 = line.match(/^\s*Tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
    if (summaryMatch2) {
      const passed = parseInt(summaryMatch2[1]!, 10);
      const failed = parseInt(summaryMatch2[2]!, 10);
      return { kind: 'summary', passed, failed, total: passed + failed };
    }

    return null;
  },
};

// ── ExUnit (Elixir) ────────────────────────────────────────────────────────

const exunitDialect: TestDialect = {
  id: 'exunit',
  matches(head: string): boolean {
    // "Randomized with seed N" — assinatura ÚNICA do ExUnit
    if (/^Randomized\s+with\s+seed/m.test(head)) return true;
    // Failure detail com path Elixir: "test/calc_test.exs:12"
    if (/^\s+\d+\)\s+test\s+.+\(.+\)\s*$/m.test(head) && /_test\.exs:\d+/m.test(head)) return true;
    // "N tests, M failures" — padrão único (rspec usa "examples", minitest "runs")
    if (/^\s*\d+\s+tests?,\s+\d+\s+failures?/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // Progress dot line: "....F.." — . = pass, F = fail
    if (/^[.F]+$/.test(line)) {
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === 'F') {
          return { kind: 'fail', name: `fail #${i + 1}` };
        }
      }
      if (line.length > 0 && line[0] === '.') {
        return { kind: 'pass', name: 'pass' };
      }
    }

    // "N tests, M failures"
    const summaryMatch = line.match(/^\s*(\d+)\s+tests?,\s+(\d+)\s+failures?/);
    if (summaryMatch) {
      const total = parseInt(summaryMatch[1]!, 10);
      const failed = parseInt(summaryMatch[2]!, 10);
      return { kind: 'summary', passed: total - failed, failed, total };
    }

    // "Finished in X.X seconds"
    const finishedMatch = line.match(/^Finished\s+in\s+([\d.]+)\s+seconds?/);
    if (finishedMatch) {
      const dur = parseFloat(finishedMatch[1]!) * 1000;
      const evt: TestEvent = { kind: 'summary', passed: 0, failed: 0, total: 0 };
      (evt as { durationMs?: number }).durationMs = dur;
      return evt;
    }

    // "1) test name (Module)" — failure detail
    const failDetail = line.match(/^\s*\d+\)\s+(.+?)\s+\(/);
    if (failDetail) {
      return { kind: 'fail', name: failDetail[1]!.trim() };
    }

    return null;
  },
};

// ── Google Test (C++) ──────────────────────────────────────────────────────

const gtestDialect: TestDialect = {
  id: 'gtest',
  matches(head: string): boolean {
    // "[==========] Running N tests from M test suites."
    if (/^\[=+\]\s+Running\s+\d+\s+tests?/m.test(head)) return true;
    // "[ RUN      ] Suite.Name"
    if (/^\[ RUN\s+\]\s+\S+/m.test(head)) return true;
    // "[       OK ] Suite.Name"
    if (/^\[ {3,}OK\s+\]\s+\S+/m.test(head)) return true;
    // "[  FAILED  ] Suite.Name"
    if (/^\[ {1,2}FAILED\s+\]\s+\S+/m.test(head)) return true;
    return false;
  },
  parseLine(line: string): TestEvent | null {
    // [       OK ] Suite.Name (X ms)
    const passMatch = line.match(/^\[ {3,}OK\s+\]\s+(\S+?)\s*(?:\(\d+\s*ms\))?\s*$/);
    if (passMatch) return { kind: 'pass', name: passMatch[1]! };

    // [  FAILED  ] Suite.Name (X ms)
    const failMatch = line.match(/^\[ {1,2}FAILED\s+\]\s+(\S+?)\s*(?:\(\d+\s*ms\))?\s*$/);
    if (failMatch) return { kind: 'fail', name: failMatch[1]! };

    // [  PASSED  ] N tests.
    const passedSum = line.match(/^\[ {1,2}PASSED\s+\]\s+(\d+)\s+tests?\./);
    if (passedSum) {
      const passed = parseInt(passedSum[1]!, 10);
      return { kind: 'summary', passed, failed: 0, total: passed };
    }

    // [  FAILED  ] M tests.
    const failedSum = line.match(/^\[ {1,2}FAILED\s+\]\s+(\d+)\s+tests?\./);
    if (failedSum) {
      const failed = parseInt(failedSum[1]!, 10);
      return { kind: 'summary', passed: 0, failed, total: failed };
    }

    // [==========] N tests from M test suites ran. (X ms total)
    const totalMatch = line.match(/^\[=+\]\s+(\d+)\s+tests?\s+from/);
    if (totalMatch) {
      const total = parseInt(totalMatch[1]!, 10);
      return { kind: 'summary', passed: 0, failed: 0, total };
    }

    return null;
  },
};

// ── Detecção ───────────────────────────────────────────────────────────────

const ALL_DIALECTS: readonly TestDialect[] = [
  vitestDialect,
  pestDialect,
  jestDialect,
  pytestDialect,
  cargoTestDialect,
  gtestDialect,
  nodeTestDialect,
  goTestDialect,
  junitDialect,
  dotnetTestDialect,
  mochaDialect,
  unittestDialect,
  rspecDialect,
  minitestDialect,
  phpunitDialect,
  exunitDialect,
];

/**
 * Detecta o dialeto pelas primeiras linhas da saída. Retorna `null` se
 * nenhum dialeto reconhecer o formato (⇒ degradação honesta).
 */
export function detectDialect(head: string): TestDialect | null {
  for (const d of ALL_DIALECTS) {
    if (d.matches(head)) return d;
  }
  return null;
}

// ── Acumulador ─────────────────────────────────────────────────────────────

/** Snapshot do placar corrente. */
export interface TestScore {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly durationMs?: number;
  /** Quando `true`, o formato não foi reconhecido — placar indisponível. */
  readonly unknownFormat: boolean;
  /** Lista de falhas (capada em MAX_FAILURES_SHOWN). */
  readonly failures: readonly TestFailure[];
}

/** Uma falha registrada (detalhe capado). */
export interface TestFailure {
  readonly name: string;
  readonly message: string;
}

/**
 * Acumulador de eventos de teste. Consome linhas via `feed(line)`, detecta o
 * dialeto automaticamente e mantém o PLACAR EXATO (passed/failed/total). SÓ o
 * detalhe das falhas é capado (MAX_FAILURES_SHOWN / MAX_FAIL_MESSAGE_BYTES).
 */
export class TestRunAccumulator {
  private dialect: TestDialect | null = null;
  private _passed = 0;
  private _failed = 0;
  private _total = 0;
  private _durationMs: number | undefined;
  private _failures: TestFailure[] = [];
  private _currentFile = '';
  private _filePassed = 0;
  private _fileFailed = 0;
  private _headBuffer = '';
  private _detected = false;
  private _detectAttempts = 0;
  private _lastFailName = '';
  private _summaryEmitted = false;
  /** Pending summary fragments (passed, failed, total) for multi-line summaries. */
  private _pendingSummary: { passed?: number; failed?: number; total?: number; dur?: number } = {};

  /** Alimenta UMA linha da saída do comando. Devolve o evento parseado (ou null). */
  feed(line: string): TestEvent | null {
    // Anti-ReDoS: linha maior que o teto ⇒ ignora (não roda regex).
    if (line.length > MAX_LINE_BYTES) return null;

    // Buffer de cabeçalho p/ detecção do dialeto (primeiras 4 KB).
    // Continua crescendo enquanto o dialeto não foi identificado.
    if (this.dialect === null && this._headBuffer.length < 4096) {
      this._headBuffer += line + '\n';
    }

    // Detecta o dialeto quando ainda não detectado ou quando a tentativa
    // anterior falhou (dot-frameworks têm assinatura atrasada: "....." vem
    // antes de "N examples, M failures"). Re-tenta até 30 linhas.
    if (!this._detected || (this.dialect === null && this._detectAttempts < 30)) {
      this.dialect = detectDialect(this._headBuffer);
      this._detectAttempts += 1;
      if (!this._detected) this._detected = true;
    }

    // Sem dialeto ⇒ sem parse (degradação honesta).
    if (!this.dialect) return null;

    const event = this.dialect.parseLine(line);
    if (!event) {
      this.captureContext(line);
      return null;
    }

    // Acumula no placar e na lista de falhas.
    switch (event.kind) {
      case 'pass':
        this._passed += 1;
        this._total += 1;
        this._filePassed += 1;
        break;
      case 'fail':
        this._failed += 1;
        this._total += 1;
        this._fileFailed += 1;
        this._lastFailName = event.name;
        if (this._failures.length < MAX_FAILURES_SHOWN) {
          this._failures.push({ name: event.name, message: event.message ?? '' });
        }
        break;
      case 'file-done': {
        const file = event.file || this._currentFile;
        const fp = event.passed > 0 || event.failed > 0 ? event.passed : this._filePassed;
        const ff = event.passed > 0 || event.failed > 0 ? event.failed : this._fileFailed;
        this._currentFile = '';
        this._filePassed = 0;
        this._fileFailed = 0;
        return { kind: 'file-done', file, passed: fp, failed: ff };
      }
      case 'summary': {
        // Multi-line summary support: acumula fragmentos (ex.: mocha "N passing" + "M failing",
        // node-test "# pass N" + "# fail M" + "# tests T", gtest "[  PASSED  ] N" + "[  FAILED  ] M").
        if (event.passed > 0) this._pendingSummary.passed = event.passed;
        if (event.failed > 0)
          this._pendingSummary.failed = (this._pendingSummary.failed ?? 0) + event.failed;
        // Só guarda total do evento se for maior que a soma atual
        // (evita que fragmento como "1 failing" sobrescreva total=4)
        if (event.total > (this._pendingSummary.total ?? 0))
          this._pendingSummary.total = event.total;
        if (event.durationMs !== undefined) this._pendingSummary.dur = event.durationMs;

        // Decide se o sumário está "completo" para emitir.
        const p = this._pendingSummary;
        const mergedPassedFailed = (p.passed ?? 0) + (p.failed ?? 0);
        // Total: usa o maior entre o total explícito e a soma passed+failed
        const mergedTotal = Math.max(p.total ?? 0, mergedPassedFailed);

        // Emite quando temos passed+failed > 0 E total > 0, OU evento já completo.
        const isComplete =
          (mergedTotal > 0 && mergedPassedFailed > 0) ||
          (event.passed > 0 && event.failed > 0 && event.total > 0);

        if (isComplete && !this._summaryEmitted) {
          // Guarda original: só sobrescreve se o sumário cobre pelo menos
          // o total que já contamos via eventos individuais.
          if (mergedPassedFailed >= this._total) {
            this._summaryEmitted = true;
            // Se temos total e failed mas não passed, computa passed = total - failed
            const finalPassed = p.passed ?? mergedTotal - (p.failed ?? 0);
            this._passed = finalPassed;
            this._failed = p.failed ?? this._failed;
            this._total = mergedTotal;
            if (p.dur !== undefined) this._durationMs = p.dur;
            this._pendingSummary = {};

            const sevt: TestEvent = {
              kind: 'summary',
              passed: this._passed,
              failed: this._failed,
              total: this._total,
            };
            if (this._durationMs !== undefined)
              (sevt as { durationMs?: number }).durationMs = this._durationMs;
            return sevt;
          }
        }
        return null;
      }
    }
    return event;
  }

  private captureContext(line: string): void {
    // Detecta nome de arquivo: "❯ path/to/file.test.ts (N tests | M failed)"
    const fileHeader = line.match(/^\s*[❯>]\s*(\S+)\s*\(/);
    if (fileHeader) {
      this._currentFile = fileHeader[1]!;
      this._filePassed = 0;
      this._fileFailed = 0;
      return;
    }

    // Acumula mensagem de falha (linhas após um ✗, indentadas ou com stack trace).
    if (this._lastFailName && this._failures.length > 0) {
      const last = this._failures[this._failures.length - 1]!;
      if (last.name === this._lastFailName) {
        const trimmed = line.trim();
        if (trimmed) {
          const newMsg = last.message ? `${last.message}\n${trimmed}` : trimmed;
          const capped =
            newMsg.length > MAX_FAIL_MESSAGE_BYTES
              ? newMsg.slice(0, MAX_FAIL_MESSAGE_BYTES) + '…[truncado]'
              : newMsg;
          this._failures[this._failures.length - 1] = {
            ...last,
            message: capped,
          };
        }
      }
    }

    // Ao ver uma linha "PASS" / "FAIL" (jest) ou próximo arquivo, limpa contexto de falha.
    if (/^\s*(PASS|FAIL)\s+\S/.test(line) || /^\s*[❯>]\s*\S/.test(line)) {
      this._lastFailName = '';
    }
  }

  /** Snapshot imutável do placar corrente. */
  snapshot(): TestScore {
    const s: TestScore = {
      passed: this._passed,
      failed: this._failed,
      total: this._total,
      unknownFormat: this.dialect === null,
      failures: this._failures,
    };
    if (this._durationMs !== undefined)
      (s as { durationMs?: number }).durationMs = this._durationMs;
    return s;
  }

  /** Se o formato é desconhecido (degradação honesta). */
  get unknownFormat(): boolean {
    return this._detected && this.dialect === null;
  }
}

/** Redige o summary ENXUTO (placar + falhas capadas) p/ a observação ao modelo. */
export function renderTestSummary(score: TestScore): string {
  if (score.unknownFormat) {
    return 'resultado dos testes: formato não reconhecido — placar indisponível.';
  }
  let out = `resultado dos testes: ${score.passed} passaram, ${score.failed} falharam`;
  if (score.total > 0) out += ` (total: ${score.total})`;
  if (score.durationMs !== undefined) {
    out += ` em ${(score.durationMs / 1000).toFixed(2)}s`;
  }
  if (score.failures.length > 0) {
    out += `\nfalhas (${Math.min(score.failures.length, score.failed)}):`;
    for (const f of score.failures) {
      out += `\n  ✗ ${f.name}`;
      if (f.message) {
        const oneLine = f.message.split('\n')[0] ?? '';
        out += `: ${oneLine.slice(0, 120)}`;
      }
    }
  }
  return out;
}
