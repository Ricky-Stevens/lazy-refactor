import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractExports, extractImports, scanDeadCode, scanUnusedImports } from './cross-ref.js';

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
