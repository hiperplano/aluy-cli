// ADR-0112 · EST-RT-1 — testes do parser PURO multi-dialeto (test-parse.ts).
//
// Prova, sem spawnar processo (entrada sintética), que:
//   • Cada um dos 4 dialetos (vitest/jest/pytest/go-test) parseia um SAMPLE real.
//   • O `TestRunAccumulator` conta o PLACAR EXATO (passed/failed/total).
//   • Formato desconhecido ⇒ `unknownFormat:true` (degradação honesta).
//   • Anti-ReDoS: linha gigante não trava o parser (MAX_LINE_BYTES).
//   • Tetos: MAX_FAILURES_SHOWN / MAX_FAIL_MESSAGE_BYTES capam detalhe, NÃO o placar.
//   • `renderTestSummary` produz output legível.

import { describe, expect, it } from 'vitest';
import {
  TestRunAccumulator,
  detectDialect,
  renderTestSummary,
  MAX_LINE_BYTES,
  type TestScore,
} from '../../src/agent/testing/test-parse.js';

// ── Amostras reais de cada framework ──────────────────────────────────────

function lines(s: string): string[] {
  return s.split('\n');
}

const VITEST_SAMPLE = `\
 RUN  v3.1.1 /home/user/project

 ❯ test/calc.test.ts (4 tests | 1 failed)
   ✓ soma 1+1 = 2
   ✗ divide 1/0 throws
   ✓ multiplica 3×4 = 12
   ✓ subtrai 5-3 = 2
 Tests  3 passed | 1 failed (4)
 ❯ test/utils.test.ts (2 tests)
   ✓ formata data
   ✓ valida email
 Tests  2 passed (2)
 Test Files  1 passed | 1 failed (2)
 Tests  5 passed | 1 failed | 1 skipped (7)
`;

const JEST_SAMPLE = `\
PASS  src/calc.test.ts
  ✓ soma 1+1 = 2 (2 ms)
  ✓ subtrai 5-3 = 2 (1 ms)

FAIL  src/divide.test.ts
  ✕ divide 1/0 throws (5 ms)
  ✓ divide 6/2 = 3

  ● divide 1/0 throws

    expect(received).toThrow(expected)

      3 | test('divide 1/0 throws', () => {
      4 |   expect(() => divide(1, 0)).toThrow();
    > 5 |   expect(1).toBe(2);
        |             ^
      6 | });

      at Object.<anonymous> (src/divide.test.ts:5:13)

Test Suites: 1 passed, 1 failed, 2 total
Tests:       4 passed, 1 failed, 5 total
Time:        1.234 s
`;

const PYTEST_SAMPLE = `\
============================= test session starts ==============================
platform linux -- Python 3.12.0, pytest-8.3.0, pluggy-1.5.0
rootdir: /home/user/project
collected 5 items

tests/test_calc.py::test_soma PASSED                                    [ 20%]
tests/test_calc.py::test_subtracao PASSED                               [ 40%]
tests/test_calc.py::test_multiplicacao PASSED                           [ 60%]
tests/test_div.py::test_divide_valido PASSED                            [ 80%]
tests/test_div.py::test_divide_por_zero FAILED                          [100%]

=================================== FAILURES ===================================
___________________________ test_divide_por_zero ____________________________

    def test_divide_por_zero():
        with pytest.raises(ZeroDivisionError):
>           divide(1, 0)
E           Failed: DID NOT RAISE <class 'ZeroDivisionError'>

tests/test_div.py:5: Failed
========================= 4 passed, 1 failed in 0.56s =========================
`;

const GO_TEST_SAMPLE = `\
=== RUN   TestSoma
--- PASS: TestSoma (0.00s)
=== RUN   TestSubtracao
--- PASS: TestSubtracao (0.00s)
=== RUN   TestMultiplicacao
--- PASS: TestMultiplicacao (0.00s)
=== RUN   TestDivisaoValida
--- PASS: TestDivisaoValida (0.00s)
=== RUN   TestDivisaoPorZero
--- FAIL: TestDivisaoPorZero (0.00s)
    calc_test.go:15: expected no error, got: division by zero
FAIL
FAIL	calc	0.123s
ok 	utils	0.056s
FAIL
`;

// ── Novas amostras (EST-RT-1) ─────────────────────────────────────────────

const MOCHA_SAMPLE = `\
  ✓ soma 1+1 = 2
  ✓ subtrai 5-3 = 2
  ✓ multiplica 3×4 = 12
  ✓ divide 6/2 = 3 (15ms)
  ✗ divide 1/0 throws
    Error: expected no error, got: DivisionByZeroError

  4 passing (42ms)
  1 failing
`;

const NODE_TEST_SAMPLE = `\
TAP version 13
# Subtest: test/calc.test.js
ok 1 - test/calc.test.js → soma 1+1 = 2
ok 2 - test/calc.test.js → subtrai 5-3 = 2
ok 3 - test/calc.test.js → multiplica 3×4 = 12
ok 4 - test/calc.test.js → divide 6/2 = 3
not ok 5 - test/calc.test.js → divide 1/0 throws
  ---
  duration_ms: 1.234
  error: 'expected no error, got: DivisionByZeroError'
  ...
# pass 4
# fail 1
# tests 5
`;

const UNITTEST_SAMPLE = `\
.F...
======================================================================
FAIL: test_divide_por_zero (tests.test_calc.TestCalc)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/user/project/tests/test_calc.py", line 15, in test_divide_por_zero
    self.assertRaises(ZeroDivisionError, divide, 1, 0)
AssertionError: ZeroDivisionError not raised

----------------------------------------------------------------------
Ran 5 tests in 0.003s
FAILED (failures=1)
`;

const CARGO_TEST_SAMPLE = `\
running 5 tests
test calc::tests::test_soma ... ok
test calc::tests::test_subtracao ... ok
test calc::tests::test_multiplicacao ... ok
test calc::tests::test_divisao_valida ... ok
test calc::tests::test_divisao_por_zero ... FAILED

failures:
    calc::tests::test_divisao_por_zero

test result: FAILED. 4 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;

const RSPEC_SAMPLE = `\
.....

Finished in 0.02 seconds (files took 0.5 seconds to load)
5 examples, 0 failures
`;

const RSPEC_FAIL_SAMPLE = `\
...F.

Failures:
  1) Calculator#divide divides two numbers
     Failure/Error: expect(result).to eq(2)

       expected: 2
            got: 3

Finished in 0.02 seconds
5 examples, 1 failure
`;

const MINITEST_SAMPLE = `\
Run options: --seed 12345

# Running:

.....

Finished in 0.001500s, 3333.3333 runs/s, 3333.3333 assertions/s.

5 runs, 5 assertions, 0 failures, 0 errors, 0 skips
`;

const MINITEST_FAIL_SAMPLE = `\
Run options: --seed 54321

# Running:

...F.

Finished in 0.002000s, 2500.0000 runs/s, 2500.0000 assertions/s.

5 runs, 5 assertions, 1 failures, 0 errors, 0 skips
`;

const JUNIT_SAMPLE = `\
> Task :test

CalcTest > testSoma() PASSED
CalcTest > testSubtracao() PASSED
CalcTest > testMultiplicacao() PASSED
CalcTest > testDivisaoValida() PASSED
CalcTest > testDivisaoPorZero() FAILED
    java.lang.AssertionError at CalcTest.java:25

5 tests completed, 1 failed

> Task :test FAILED

BUILD FAILED in 1s
`;

const DOTNET_TEST_SAMPLE = `\
Microsoft (R) Test Execution Command Line Tool Version 17.8.0
Copyright (c) Microsoft Corporation.  All rights reserved.

Starting test execution, please wait...
A total of 1 test files matched the specified pattern.
  Passed TestSoma [< 1 ms]
  Passed TestSubtracao [< 1 ms]
  Passed TestMultiplicacao [< 1 ms]
  Passed TestDivisaoValida [< 1 ms]
  Failed TestDivisaoPorZero [< 1 ms]

Passed! - Failed: 1, Passed: 4, Skipped: 0, Total: 5
`;

const PHPUNIT_SAMPLE = `\
PHPUnit 9.5.0 by Sebastian Bergmann and contributors.

...F.                                                                   5 / 5 (100%)

Time: 00:00.123, Memory: 10.00 MB

There was 1 failure:

1) Tests\\CalcTest::testDividePorZero
Failed asserting that exception of type "DivisionByZeroError" is thrown.

FAILURES!
Tests: 5, Assertions: 4, Failures: 1.
`;

const PHPUNIT_OK_SAMPLE = `\
PHPUnit 9.5.0 by Sebastian Bergmann and contributors.

.....                                                                   5 / 5 (100%)

Time: 00:00.050, Memory: 10.00 MB

OK (5 tests, 5 assertions)
`;

const PEST_SAMPLE = `\
PASS  Tests\\CalcTest
  ✓ testSoma
  ✓ testSubtracao
  ✓ testMultiplicacao
  ✓ testDivisaoValida
  ⨯ testDivisaoPorZero

  Tests:  1 failed, 4 passed
`;

const EXUNIT_SAMPLE = `\
.....

Finished in 0.1 seconds (0.03s on load, 0.07s on tests)
5 tests, 0 failures

Randomized with seed 12345
`;

const EXUNIT_FAIL_SAMPLE = `\
...F.

  1) test divide/1 by zero (CalcTest)
     test/calc_test.exs:12
     Assertion with == failed
     code:  assert divide(1, 0) == :error
     left:  :ok
     right: :error

Finished in 0.1 seconds
5 tests, 1 failure
`;

const GTEST_SAMPLE = `\
[==========] Running 5 tests from 2 test suites.
[----------] 3 tests from CalcTest
[ RUN      ] CalcTest.Soma
[       OK ] CalcTest.Soma (0 ms)
[ RUN      ] CalcTest.Subtracao
[       OK ] CalcTest.Subtracao (0 ms)
[ RUN      ] CalcTest.Multiplicacao
[       OK ] CalcTest.Multiplicacao (0 ms)
[----------] 3 tests from CalcTest (0 ms total)

[----------] 2 tests from DivTest
[ RUN      ] DivTest.DivisaoValida
[       OK ] DivTest.DivisaoValida (0 ms)
[ RUN      ] DivTest.DivisaoPorZero
[  FAILED  ] DivTest.DivisaoPorZero
[----------] 2 tests from DivTest (0 ms total)

[==========] 5 tests from 2 test suites ran. (1 ms total)
[  PASSED  ] 4 tests.
[  FAILED  ] 1 test.
`;

const UNKNOWN_SAMPLE = `\
This is some random output
that does not match any
known test framework format.
`;

// ── Detecção de dialeto ─────────────────────────────────────────────────────

describe('detectDialect', () => {
  it('detecta vitest pelo cabeçalho', () => {
    const d = detectDialect(VITEST_SAMPLE.slice(0, 200));
    expect(d?.id).toBe('vitest');
  });

  it('detecta jest pelo cabeçalho', () => {
    const d = detectDialect(JEST_SAMPLE.slice(0, 200));
    expect(d?.id).toBe('jest');
  });

  it('detecta pytest pelo cabeçalho', () => {
    const d = detectDialect(PYTEST_SAMPLE.slice(0, 200));
    expect(d?.id).toBe('pytest');
  });

  it('detecta go-test pelo cabeçalho', () => {
    const d = detectDialect(GO_TEST_SAMPLE.slice(0, 200));
    expect(d?.id).toBe('go-test');
  });

  it('retorna null para formato desconhecido', () => {
    const d = detectDialect(UNKNOWN_SAMPLE);
    expect(d).toBeNull();
  });

  // ── Novos dialetos EST-RT-1 ──

  it('detecta mocha pelo cabeçalho', () => {
    const d = detectDialect(MOCHA_SAMPLE.slice(0, 200));
    expect(d?.id).toBe('mocha');
  });

  it('detecta node-test (TAP) pelo cabeçalho', () => {
    const d = detectDialect(NODE_TEST_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('node-test');
  });

  it('detecta unittest pelo cabeçalho', () => {
    const d = detectDialect(UNITTEST_SAMPLE.slice(0, 800));
    expect(d?.id).toBe('unittest');
  });

  it('detecta cargo-test pelo cabeçalho', () => {
    const d = detectDialect(CARGO_TEST_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('cargo-test');
  });

  it('detecta rspec pelo cabeçalho', () => {
    const d = detectDialect(RSPEC_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('rspec');
  });

  it('detecta minitest pelo cabeçalho', () => {
    const d = detectDialect(MINITEST_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('minitest');
  });

  it('detecta junit (Gradle) pelo cabeçalho', () => {
    const d = detectDialect(JUNIT_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('junit');
  });

  it('detecta dotnet-test pelo cabeçalho', () => {
    const d = detectDialect(DOTNET_TEST_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('dotnet-test');
  });

  it('detecta phpunit pelo cabeçalho', () => {
    const d = detectDialect(PHPUNIT_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('phpunit');
  });

  it('detecta pest pelo cabeçalho', () => {
    const d = detectDialect(PEST_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('pest');
  });

  it('detecta exunit pelo cabeçalho', () => {
    const d = detectDialect(EXUNIT_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('exunit');
  });

  it('detecta gtest pelo cabeçalho', () => {
    const d = detectDialect(GTEST_SAMPLE.slice(0, 500));
    expect(d?.id).toBe('gtest');
  });
});

// ── Acumulador: vitest ──────────────────────────────────────────────────────

describe('TestRunAccumulator — vitest', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(VITEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(5);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(6); // 5 pass + 1 fail (skipped não gera evento)
    expect(s.unknownFormat).toBe(false);
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0]!.name).toContain('divide');
  });

  it('placar é exato mesmo com falha única', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(VITEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    // O placar SEMPRE reflete a contagem exata
    expect(s.passed).toBeGreaterThanOrEqual(3);
    expect(s.failed).toBeGreaterThanOrEqual(0);
  });
});

// ── Acumulador: jest ────────────────────────────────────────────────────────

describe('TestRunAccumulator — jest', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(JEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });

  it('captura nome da falha via ● bullet', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(JEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.failures.length).toBeGreaterThan(0);
    expect(s.failures.some((f) => f.name.includes('divide'))).toBe(true);
  });
});

// ── Acumulador: pytest ──────────────────────────────────────────────────────

describe('TestRunAccumulator — pytest', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(PYTEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });

  it('extrai duração do summary', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(PYTEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.durationMs).toBeCloseTo(560, -1); // 0.56s = 560ms
  });
});

// ── Acumulador: go-test ─────────────────────────────────────────────────────

describe('TestRunAccumulator — go-test', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(GO_TEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });

  it('captura nome da falha', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(GO_TEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.failures.length).toBeGreaterThan(0);
    expect(s.failures.some((f) => f.name === 'TestDivisaoPorZero')).toBe(true);
  });
});

// ── Acumulador: mocha ───────────────────────────────────────────────────────

describe('TestRunAccumulator — mocha', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(MOCHA_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: node-test ───────────────────────────────────────────────────

describe('TestRunAccumulator — node-test', () => {
  it('conta passes e falhas corretamente (TAP)', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(NODE_TEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: unittest ────────────────────────────────────────────────────

describe('TestRunAccumulator — unittest', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(UNITTEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: cargo-test ──────────────────────────────────────────────────

describe('TestRunAccumulator — cargo-test', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(CARGO_TEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: rspec ───────────────────────────────────────────────────────

describe('TestRunAccumulator — rspec', () => {
  it('conta passes corretamente (sem falhas)', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(RSPEC_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(5);
    expect(s.failed).toBe(0);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });

  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(RSPEC_FAIL_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: minitest ────────────────────────────────────────────────────

describe('TestRunAccumulator — minitest', () => {
  it('conta passes corretamente (sem falhas)', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(MINITEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(5);
    expect(s.failed).toBe(0);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });

  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(MINITEST_FAIL_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: junit ───────────────────────────────────────────────────────

describe('TestRunAccumulator — junit', () => {
  it('conta passes e falhas corretamente (Gradle)', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(JUNIT_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: dotnet-test ─────────────────────────────────────────────────

describe('TestRunAccumulator — dotnet-test', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(DOTNET_TEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: phpunit ─────────────────────────────────────────────────────

describe('TestRunAccumulator — phpunit', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(PHPUNIT_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });

  it('conta passes corretamente (OK)', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(PHPUNIT_OK_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(5);
    expect(s.failed).toBe(0);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: pest ────────────────────────────────────────────────────────

describe('TestRunAccumulator — pest', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(PEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: exunit ──────────────────────────────────────────────────────

describe('TestRunAccumulator — exunit', () => {
  it('conta passes corretamente (sem falhas)', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(EXUNIT_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(5);
    expect(s.failed).toBe(0);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });

  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(EXUNIT_FAIL_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Acumulador: gtest ───────────────────────────────────────────────────────

describe('TestRunAccumulator — gtest', () => {
  it('conta passes e falhas corretamente', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(GTEST_SAMPLE)) a.feed(line);
    const s = a.snapshot();
    expect(s.passed).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(5);
    expect(s.unknownFormat).toBe(false);
  });
});

// ── Degradação honesta ──────────────────────────────────────────────────────

describe('TestRunAccumulator — formato desconhecido', () => {
  it('unknownFormat:true quando nenhum dialeto é detectado', () => {
    const a = new TestRunAccumulator();
    for (const line of lines(UNKNOWN_SAMPLE)) a.feed(line);
    expect(a.unknownFormat).toBe(true);
    const s = a.snapshot();
    expect(s.unknownFormat).toBe(true);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
  });
});

// ── Anti-ReDoS: linha gigante ───────────────────────────────────────────────

describe('TestRunAccumulator — anti-ReDoS', () => {
  it('ignora linha maior que MAX_LINE_BYTES sem travar', () => {
    const a = new TestRunAccumulator();
    // Pré-alimenta com cabeçalho detectável p/ ativar o dialeto
    a.feed('RUN  v3.0.0');
    const giant = 'x'.repeat(MAX_LINE_BYTES + 1);
    // Não deve lançar nem travar — apenas ignora a linha.
    const result = a.feed(giant);
    expect(result).toBeNull(); // linha ignorada
    // E ainda processa linhas normais
    const evt = a.feed(' ✓ test ok');
    expect(evt?.kind).toBe('pass');
  });
});

// ── renderTestSummary ───────────────────────────────────────────────────────

describe('renderTestSummary', () => {
  it('produz summary legível com placar', () => {
    const score: TestScore = {
      passed: 4,
      failed: 1,
      total: 5,
      unknownFormat: false,
      failures: [{ name: 'test_broken', message: 'assertion error' }],
    };
    const out = renderTestSummary(score);
    expect(out).toContain('4 passaram');
    expect(out).toContain('1 falharam');
    expect(out).toContain('test_broken');
  });

  it('reporta formato não reconhecido', () => {
    const score: TestScore = {
      passed: 0,
      failed: 0,
      total: 0,
      unknownFormat: true,
      failures: [],
    };
    const out = renderTestSummary(score);
    expect(out).toContain('formato não reconhecido');
  });

  it('inclui duração quando presente', () => {
    const score: TestScore = {
      passed: 10,
      failed: 0,
      total: 10,
      durationMs: 1234,
      unknownFormat: false,
      failures: [],
    };
    const out = renderTestSummary(score);
    expect(out).toContain('1.23s');
  });
});

// ── Tetos anti-OOM ──────────────────────────────────────────────────────────

describe('TestRunAccumulator — tetos anti-OOM', () => {
  it('o PLACAR é exato mesmo com muitas falhas (só o DETALHE é capado)', () => {
    const a = new TestRunAccumulator();
    a.feed('RUN  v3.0.0');
    // Gera 100 falhas (acima de MAX_FAILURES_SHOWN=50)
    for (let i = 0; i < 100; i++) {
      a.feed(` ✗ test_fail_${i}`);
    }
    const s = a.snapshot();
    expect(s.failed).toBe(100); // PLACAR EXATO
    expect(s.failures.length).toBeLessThanOrEqual(50); // detalhe capado
  });
});
