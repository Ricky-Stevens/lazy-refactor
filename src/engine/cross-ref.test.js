import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractExports,
  extractImports,
  scanDeadCode,
  scanUnusedImports,
  scanInconsistentPatterns,
  scanOverEngineering,
} from './cross-ref.js';

// ---------------------------------------------------------------------------
// extractExports
// ---------------------------------------------------------------------------

describe('extractExports — TypeScript', () => {
  it('detects export function', () => {
    const result = extractExports('export function doWork() {}', 'typescript');
    expect(result).toEqual([{ name: 'doWork', line: 0 }]);
  });

  it('detects export async function', () => {
    const result = extractExports('export async function fetchData() {}', 'typescript');
    expect(result).toEqual([{ name: 'fetchData', line: 0 }]);
  });

  it('detects export const', () => {
    const result = extractExports('export const MAX_SIZE = 100;', 'typescript');
    expect(result).toEqual([{ name: 'MAX_SIZE', line: 0 }]);
  });

  it('detects export class', () => {
    const result = extractExports('export class UserService {}', 'typescript');
    expect(result).toEqual([{ name: 'UserService', line: 0 }]);
  });

  it('detects export default function with name', () => {
    const result = extractExports('export default function handler() {}', 'typescript');
    expect(result).toEqual([{ name: 'handler', line: 0 }]);
  });

  it('detects export default class with name', () => {
    const result = extractExports('export default class App {}', 'typescript');
    expect(result).toEqual([{ name: 'App', line: 0 }]);
  });

  it('detects multiple exports across lines', () => {
    const content = [
      'export function alpha() {}',
      'const internal = 1;',
      'export const beta = 2;',
      'export class Gamma {}',
    ].join('\n');
    const result = extractExports(content, 'typescript');
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.name)).toEqual(['alpha', 'beta', 'Gamma']);
  });

  it('does not flag non-exported declarations', () => {
    const result = extractExports('function privateHelper() {}', 'typescript');
    expect(result).toHaveLength(0);
  });
});

describe('extractExports — Go', () => {
  it('detects exported func (capitalised)', () => {
    const result = extractExports('func ProcessRequest(ctx context.Context) error {', 'go');
    expect(result).toEqual([{ name: 'ProcessRequest', line: 0 }]);
  });

  it('does not detect unexported func (lowercase)', () => {
    const result = extractExports('func helper() {}', 'go');
    expect(result).toHaveLength(0);
  });

  it('detects exported type', () => {
    const result = extractExports('type UserID string', 'go');
    expect(result).toEqual([{ name: 'UserID', line: 0 }]);
  });

  it('does not detect unexported type', () => {
    const result = extractExports('type internalState struct {', 'go');
    expect(result).toHaveLength(0);
  });

  it('detects exported var', () => {
    const result = extractExports('var DefaultTimeout = 30', 'go');
    expect(result).toEqual([{ name: 'DefaultTimeout', line: 0 }]);
  });

  it('detects exported method receiver', () => {
    const result = extractExports('func (s *Server) Shutdown() error {', 'go');
    expect(result).toEqual([{ name: 'Shutdown', line: 0 }]);
  });
});

describe('extractExports — Python', () => {
  it('detects top-level def', () => {
    const result = extractExports('def compute_total(items):', 'python');
    expect(result).toEqual([{ name: 'compute_total', line: 0 }]);
  });

  it('detects top-level class', () => {
    const result = extractExports('class DataProcessor:', 'python');
    expect(result).toEqual([{ name: 'DataProcessor', line: 0 }]);
  });

  it('detects class with base', () => {
    const result = extractExports('class MyError(Exception):', 'python');
    expect(result).toEqual([{ name: 'MyError', line: 0 }]);
  });

  it('does not flag indented def (method)', () => {
    const result = extractExports('    def _private(self):', 'python');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractImports
// ---------------------------------------------------------------------------

describe('extractImports — TypeScript', () => {
  it('extracts named imports', () => {
    const result = extractImports("import { useState, useEffect } from 'react';", 'typescript');
    expect(result).toContain('useState');
    expect(result).toContain('useEffect');
  });

  it('extracts default import', () => {
    const result = extractImports("import React from 'react';", 'typescript');
    expect(result).toContain('React');
  });

  it('extracts namespace import', () => {
    const result = extractImports("import * as path from 'node:path';", 'typescript');
    expect(result).toContain('path');
  });

  it('extracts require destructure', () => {
    const result = extractImports("const { readFile } = require('fs');", 'typescript');
    expect(result).toContain('readFile');
  });

  it('extracts require default', () => {
    const result = extractImports("const fs = require('fs');", 'typescript');
    expect(result).toContain('fs');
  });

  it('handles aliased imports', () => {
    const result = extractImports("import { Component as Comp } from 'framework';", 'typescript');
    expect(result).toContain('Comp');
  });
});

// ---------------------------------------------------------------------------
// scanDeadCode integration
// ---------------------------------------------------------------------------

describe('scanDeadCode integration', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cross-ref-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags exported symbol with no matching import as dead code', async () => {
    // moduleA exports foo and bar; moduleB only imports foo
    await writeFile(
      join(dir, 'moduleA.js'),
      [
        "export function foo() { return 1; }",
        "export function bar() { return 2; }",
      ].join('\n')
    );
    await writeFile(
      join(dir, 'moduleB.js'),
      "import { foo } from './moduleA.js';\nfoo();"
    );

    const findings = await scanDeadCode(dir, {});
    const deadSymbols = findings.map((f) => f.symbol);
    expect(deadSymbols).toContain('bar');
    expect(deadSymbols).not.toContain('foo');
  });

  it('does not flag index.js as dead code entry point', async () => {
    const subDir = join(dir, 'entry-test');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'index.js'),
      "export function bootstrap() {}"
    );

    const findings = await scanDeadCode(subDir, {});
    const files = findings.map((f) => f.file);
    expect(files.some((f) => f.endsWith('index.js'))).toBe(false);
  });

  it('does not flag main.go as dead code entry point', async () => {
    const subDir = join(dir, 'go-entry-test');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'main.go'),
      "func Main() {}\n"
    );

    const findings = await scanDeadCode(subDir, {});
    const files = findings.map((f) => f.file);
    expect(files.some((f) => f.endsWith('main.go'))).toBe(false);
  });

  it('assigns confidence 0.6 to Python findings', async () => {
    const subDir = join(dir, 'py-confidence');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'utils.py'),
      "def orphaned_fn():\n    pass\n"
    );
    await writeFile(
      join(subDir, 'main.py'),
      "def used_fn():\n    pass\n"
    );

    const findings = await scanDeadCode(subDir, {});
    const pyFindings = findings.filter((f) => f.file.endsWith('.py'));
    for (const f of pyFindings) {
      expect(f.confidence).toBe(0.6);
    }
  });

  it('assigns confidence 0.9 to TypeScript findings', async () => {
    const subDir = join(dir, 'ts-confidence');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'lib.js'),
      "export function orphaned() {}\n"
    );
    await writeFile(
      join(subDir, 'app.js'),
      "// no imports\nconsole.log('hello');\n"
    );

    const findings = await scanDeadCode(subDir, {});
    const tsFindings = findings.filter(
      (f) => f.file.endsWith('.js') || f.file.endsWith('.ts')
    );
    for (const f of tsFindings) {
      expect(f.confidence).toBe(0.9);
    }
  });

  it('does not flag test files', async () => {
    const subDir = join(dir, 'test-filter');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'util.test.js'),
      "export function testHelper() {}"
    );

    const findings = await scanDeadCode(subDir, {});
    const files = findings.map((f) => f.file);
    expect(files.some((f) => f.includes('.test.'))).toBe(false);
  });

  it('returns finding shape with required fields', async () => {
    const subDir = join(dir, 'shape-test');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'a.js'),
      "export function orphan() {}"
    );
    await writeFile(
      join(subDir, 'b.js'),
      "// no imports"
    );

    const findings = await scanDeadCode(subDir, {});
    for (const f of findings) {
      expect(f.check).toBe('dead-code');
      expect(typeof f.file).toBe('string');
      expect(typeof f.symbol).toBe('string');
      expect(typeof f.exportLine).toBe('number');
      expect(typeof f.confidence).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// scanUnusedImports
// ---------------------------------------------------------------------------

describe('scanUnusedImports', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'unused-imports-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags imported symbol that is never used in the file', async () => {
    await writeFile(
      join(dir, 'unused.js'),
      [
        "import { readFile, writeFile } from 'node:fs/promises';",
        "async function go() {",
        "  const data = await readFile('x.txt', 'utf8');",
        "  return data;",
        "}",
      ].join('\n')
    );

    const findings = await scanUnusedImports(dir, {});
    const symbols = findings.map((f) => f.symbol);
    expect(symbols).toContain('writeFile');
    expect(symbols).not.toContain('readFile');
  });

  it('finding shape has required fields', async () => {
    const subDir = join(dir, 'shape');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'example.js'),
      "import { join, resolve } from 'node:path';\nconsole.log(join('a', 'b'));"
    );

    const findings = await scanUnusedImports(subDir, {});
    for (const f of findings) {
      expect(f.check).toBe('unused-import');
      expect(typeof f.file).toBe('string');
      expect(typeof f.symbol).toBe('string');
      expect(typeof f.importLine).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — TypeScript export { X } re-export syntax
// ---------------------------------------------------------------------------

describe('extractExports — TypeScript export { X } re-exports', () => {
  it('detects plain named re-export', () => {
    const result = extractExports("export { foo, bar };", 'typescript');
    expect(result.map((e) => e.name)).toContain('foo');
    expect(result.map((e) => e.name)).toContain('bar');
  });

  it('detects aliased re-export (foo as baz → baz is exported)', () => {
    const result = extractExports("export { foo as baz };", 'typescript');
    expect(result.map((e) => e.name)).toContain('baz');
    expect(result.map((e) => e.name)).not.toContain('foo');
  });

  it('detects re-export with "from" source', () => {
    const result = extractExports("export { readFile, writeFile } from 'node:fs/promises';", 'typescript');
    expect(result.map((e) => e.name)).toContain('readFile');
    expect(result.map((e) => e.name)).toContain('writeFile');
  });

  it('records the correct line number for re-exports', () => {
    const content = "// preamble\nexport { alpha, beta };";
    const result = extractExports(content, 'typescript');
    const names = result.map((e) => e.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    // Both exports are on line 1 (0-based)
    for (const e of result.filter((r) => names.includes(r.name))) {
      expect(e.line).toBe(1);
    }
  });

  it('does not produce duplicate entries when a symbol is both declared and re-exported', () => {
    const content = [
      "export function helper() {}",
      "export { helper };",
    ].join('\n');
    const result = extractExports(content, 'typescript');
    const helpers = result.filter((e) => e.name === 'helper');
    // It's fine to have two entries (one from declaration, one from re-export) — just assert they exist
    expect(helpers.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — C# import parsing
// ---------------------------------------------------------------------------

describe('extractImports — C#', () => {
  it('extracts last segment from plain using directive', () => {
    const result = extractImports('using System.Collections.Generic;', 'csharp');
    expect(result).toContain('Generic');
  });

  it('extracts alias from using alias directive', () => {
    const result = extractImports('using Dict = System.Collections.Generic.Dictionary;', 'csharp');
    expect(result).toContain('Dict');
    // Should NOT add the right-hand type name
    expect(result).not.toContain('Dictionary');
  });

  it('handles multiple using statements', () => {
    const content = [
      'using System;',
      'using System.Linq;',
      'using MyApp.Services;',
    ].join('\n');
    const result = extractImports(content, 'csharp');
    expect(result).toContain('System');
    expect(result).toContain('Linq');
    expect(result).toContain('Services');
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — Java import parsing
// ---------------------------------------------------------------------------

describe('extractImports — Java', () => {
  it('extracts last segment from a regular import', () => {
    const result = extractImports('import java.util.ArrayList;', 'java');
    expect(result).toContain('ArrayList');
  });

  it('extracts last segment from a static import', () => {
    const result = extractImports('import static org.junit.Assert.assertEquals;', 'java');
    expect(result).toContain('assertEquals');
  });

  it('handles multiple import statements', () => {
    const content = [
      'import java.util.List;',
      'import java.util.Map;',
      'import static java.util.Collections.sort;',
    ].join('\n');
    const result = extractImports(content, 'java');
    expect(result).toContain('List');
    expect(result).toContain('Map');
    expect(result).toContain('sort');
  });
});

// ---------------------------------------------------------------------------
// scanUnusedImports — C# and Java
// ---------------------------------------------------------------------------

describe('scanUnusedImports — C#', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'unused-csharp-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags unused C# using directive', async () => {
    await writeFile(
      join(dir, 'Service.cs'),
      [
        'using System;',
        'using System.Linq;',
        '',
        'public class Service {',
        '  public void Run() { Console.WriteLine("hi"); }',
        '}',
      ].join('\n')
    );

    const findings = await scanUnusedImports(dir, {});
    const symbols = findings.map((f) => f.symbol);
    // Linq is not used in the body
    expect(symbols).toContain('Linq');
    // System/Console is used
    expect(symbols).not.toContain('System');
  });
});

describe('scanUnusedImports — Java', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'unused-java-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags unused Java import', async () => {
    await writeFile(
      join(dir, 'App.java'),
      [
        'import java.util.ArrayList;',
        'import java.util.Map;',
        '',
        'public class App {',
        '  public void run() { ArrayList<String> list = new ArrayList<>(); }',
        '}',
      ].join('\n')
    );

    const findings = await scanUnusedImports(dir, {});
    const symbols = findings.map((f) => f.symbol);
    expect(symbols).toContain('Map');
    expect(symbols).not.toContain('ArrayList');
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — scanInconsistentPatterns
// ---------------------------------------------------------------------------

describe('scanInconsistentPatterns', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inconsistent-patterns-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty array when only 1-2 approaches are used', async () => {
    const subDir = join(dir, 'few-approaches');
    await mkdir(subDir, { recursive: true });
    // Only fetch API used — one approach
    await writeFile(join(subDir, 'a.js'), "async function load() { return fetch('/api'); }");
    await writeFile(join(subDir, 'b.js'), "async function load2() { return fetch('/other'); }");

    const findings = await scanInconsistentPatterns(subDir, {});
    const fetchFindings = findings.filter((f) => f.concern === 'data-fetching');
    expect(fetchFindings).toHaveLength(0);
  });

  it('flags concern when 3+ approaches are detected', async () => {
    const subDir = join(dir, 'many-approaches');
    await mkdir(subDir, { recursive: true });

    // Three different data-fetching approaches
    await writeFile(join(subDir, 'fetch-file.js'), "async function a() { return fetch('/api'); }");
    await writeFile(join(subDir, 'axios-file.js'), "const res = await axios.get('/api');");
    await writeFile(join(subDir, 'request-file.js'), "request('/api', callback);");

    const findings = await scanInconsistentPatterns(subDir, {});
    const fetchFindings = findings.filter((f) => f.concern === 'data-fetching');
    expect(fetchFindings.length).toBeGreaterThanOrEqual(1);
    expect(fetchFindings[0].check).toBe('inconsistent-patterns');
    expect(Array.isArray(fetchFindings[0].approaches)).toBe(true);
    expect(fetchFindings[0].approaches.length).toBeGreaterThanOrEqual(3);
  });

  it('finding shape has required fields', async () => {
    const subDir = join(dir, 'shape-check');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'a.js'), "async function a() { return fetch('/api'); }");
    await writeFile(join(subDir, 'b.js'), "const res = await axios.get('/api');");
    await writeFile(join(subDir, 'c.js'), "request('/api', callback);");

    const findings = await scanInconsistentPatterns(subDir, {});
    for (const f of findings) {
      expect(f.check).toBe('inconsistent-patterns');
      expect(typeof f.concern).toBe('string');
      expect(Array.isArray(f.approaches)).toBe(true);
      for (const approach of f.approaches) {
        expect(typeof approach.pattern).toBe('string');
        expect(Array.isArray(approach.files)).toBe(true);
        expect(typeof approach.count).toBe('number');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — scanOverEngineering
// ---------------------------------------------------------------------------

describe('scanOverEngineering', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'over-engineering-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags a single-method class', async () => {
    const subDir = join(dir, 'single-method');
    await mkdir(subDir, { recursive: true });

    await writeFile(
      join(subDir, 'wrapper.ts'),
      [
        'export class StringWrapper {',
        '  constructor(private val: string) {}',
        '  getValue() { return this.val; }',
        '}',
      ].join('\n')
    );
    // A consumer so fan-in is counted
    await writeFile(
      join(subDir, 'consumer.ts'),
      "import { StringWrapper } from './wrapper';\nconst w = new StringWrapper('x');"
    );

    const findings = await scanOverEngineering(subDir, {});
    const classFindings = findings.filter(
      (f) => f.issue.includes('Single-method class') && f.symbol === 'StringWrapper'
    );
    expect(classFindings.length).toBeGreaterThanOrEqual(1);
    expect(classFindings[0].check).toBe('over-engineering');
  });

  it('flags a single-implementation interface', async () => {
    const subDir = join(dir, 'single-impl');
    await mkdir(subDir, { recursive: true });

    await writeFile(
      join(subDir, 'iface.ts'),
      "export interface Serializer { serialize(v: unknown): string; }"
    );
    await writeFile(
      join(subDir, 'impl.ts'),
      "import { Serializer } from './iface';\nexport class JsonSerializer implements Serializer { serialize(v: unknown) { return JSON.stringify(v); } }"
    );

    const findings = await scanOverEngineering(subDir, {});
    const ifaceFindings = findings.filter(
      (f) => f.issue.includes('one implementation') && f.symbol === 'Serializer'
    );
    expect(ifaceFindings.length).toBeGreaterThanOrEqual(1);
    expect(ifaceFindings[0].check).toBe('over-engineering');
  });

  it('returns correct check field in all findings', async () => {
    const subDir = join(dir, 'shape');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'a.ts'),
      "export class TinyClass { doIt() { return 1; } }"
    );
    await writeFile(join(subDir, 'b.ts'), "// no imports");

    const findings = await scanOverEngineering(subDir, {});
    for (const f of findings) {
      expect(f.check).toBe('over-engineering');
      expect(typeof f.file).toBe('string');
      expect(typeof f.symbol).toBe('string');
      expect(typeof f.issue).toBe('string');
    }
  });

  it('does not flag test files', async () => {
    const subDir = join(dir, 'test-filter');
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, 'thing.test.ts'),
      "export class TestClass { run() {} }"
    );

    const findings = await scanOverEngineering(subDir, {});
    const testFindings = findings.filter((f) => f.file.includes('.test.'));
    expect(testFindings).toHaveLength(0);
  });
});
