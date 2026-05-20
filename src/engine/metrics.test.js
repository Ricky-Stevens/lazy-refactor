import { describe, test, expect, beforeAll } from 'bun:test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeFileMetrics, isPythonFile, computeMetrics } from './metrics.js';

// ---------------------------------------------------------------------------
// isPythonFile
// ---------------------------------------------------------------------------
describe('isPythonFile', () => {
  test('returns true for .py files', () => {
    expect(isPythonFile('foo.py')).toBe(true);
    expect(isPythonFile('/some/path/script.py')).toBe(true);
    expect(isPythonFile('script.PY')).toBe(true);
  });

  test('returns false for non-Python files', () => {
    expect(isPythonFile('foo.ts')).toBe(false);
    expect(isPythonFile('foo.js')).toBe(false);
    expect(isPythonFile('foo.go')).toBe(false);
    expect(isPythonFile('foo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeFileMetrics — JS/TS (brace-based nesting)
// ---------------------------------------------------------------------------
describe('computeFileMetrics — JS brace-based nesting', () => {
  test('counts lines correctly', () => {
    const content = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const metrics = computeFileMetrics(content, 'foo.js');
    expect(metrics.lineCount).toBe(3);
  });

  test('tracks max nesting depth via braces', () => {
    const content = [
      'function outer() {',      // depth 1
      '  if (true) {',           // depth 2
      '    for (;;) {',          // depth 3
      '    }',                   // depth 2
      '  }',                     // depth 1
      '}',                       // depth 0
    ].join('\n');
    const metrics = computeFileMetrics(content, 'foo.js');
    expect(metrics.maxNestingDepth).toBe(3);
  });

  test('counts branch points', () => {
    // if, else, for, while, switch, ternary, &&, ||
    const content = [
      'if (a && b || c) {',   // if + && + ||  = 3
      '  x ? 1 : 2;',         // ternary = 1
      '} else {',              // else = 1
      '  for (let i;;) {}',    // for = 1
      '  while (x) {}',        // while = 1
      '  switch (y) {}',       // switch = 1
      '}',
    ].join('\n');
    const metrics = computeFileMetrics(content, 'foo.js');
    // Total: if(1) && (1) ||(1) ternary(1) else(1) for(1) while(1) switch(1) = 8
    expect(metrics.branchPointCount).toBe(8);
  });

  test('comment-to-code ratio', () => {
    const content = [
      '// comment 1',
      '// comment 2',
      'const x = 1;',
      'const y = 2;',
    ].join('\n');
    const metrics = computeFileMetrics(content, 'foo.js');
    // 2 comment lines, 2 code lines -> ratio = 1.00
    expect(metrics.commentToCodeRatio).toBe(1.00);
  });

  test('comment-to-code ratio is 0 when there are no comments', () => {
    const content = 'const x = 1;\nconst y = 2;';
    const metrics = computeFileMetrics(content, 'foo.js');
    expect(metrics.commentToCodeRatio).toBe(0);
  });

  test('export count', () => {
    const content = [
      'export function foo() {}',
      'export const bar = 1;',
      'const baz = 2;',
    ].join('\n');
    const metrics = computeFileMetrics(content, 'foo.js');
    expect(metrics.exportCount).toBe(2);
  });

  test('import count', () => {
    const content = [
      "import { foo } from './foo.js';",
      "import bar from './bar.js';",
      "const baz = require('./baz');",
      'const x = 1;',
    ].join('\n');
    const metrics = computeFileMetrics(content, 'foo.js');
    expect(metrics.importCount).toBe(3);
  });

  test('complexityScore formula: nestingDepth*3 + branchPoints*2 + lineCount/50', () => {
    const content = [
      'function f() {',       // depth 1
      '  if (a) {',           // depth 2, branch: if
      '  }',
      '}',
    ].join('\n');
    const metrics = computeFileMetrics(content, 'foo.js');
    const expected = metrics.maxNestingDepth * 3 + metrics.branchPointCount * 2 + metrics.lineCount / 50;
    expect(metrics.complexityScore).toBeCloseTo(expected, 5);
  });
});

// ---------------------------------------------------------------------------
// computeFileMetrics — Python (indent-based nesting)
// ---------------------------------------------------------------------------
describe('computeFileMetrics — Python indent-based nesting', () => {
  test('uses indent-based nesting for .py files', () => {
    const content = [
      'def outer():',          // indent 0, depth starts at 1 after this
      '    if True:',          // indent 4, depth 2
      '        for x in y:',  // indent 8, depth 3
      '            pass',     // indent 12, depth 4
      '    return 1',          // indent 4, back to depth 2
    ].join('\n');
    const metrics = computeFileMetrics(content, 'script.py');
    expect(metrics.maxNestingDepth).toBeGreaterThanOrEqual(3);
  });

  test('Python file has no brace-based nesting miscounting', () => {
    // A Python file with {} in string literals should not affect nesting
    const content = [
      'data = {"key": "value"}',
      'def foo():',
      '    return data',
    ].join('\n');
    // maxNestingDepth should be 1 (inside def foo body), NOT confused by {}
    const metrics = computeFileMetrics(content, 'foo.py');
    // Python uses indent: "def foo():" is top-level (0), body is indent 1
    expect(metrics.maxNestingDepth).toBeGreaterThanOrEqual(1);
    // Should not be inflated by { } characters
    expect(metrics.maxNestingDepth).toBeLessThan(5);
  });

  test('comments detected via # prefix', () => {
    const content = [
      '# this is a comment',
      'x = 1',
      '# another comment',
      'y = 2',
    ].join('\n');
    const metrics = computeFileMetrics(content, 'foo.py');
    expect(metrics.commentToCodeRatio).toBe(1.00);
  });
});

// ---------------------------------------------------------------------------
// computeMetrics — directory scan with thresholds
// ---------------------------------------------------------------------------
describe('computeMetrics — directory scan', () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'metrics-test-'));

    // A simple short file — should produce no threshold findings
    await writeFile(
      join(tmpDir, 'simple.js'),
      'export const x = 1;\nexport const y = 2;\n'
    );

    // A deeply-nested file that exceeds maxNesting=2
    const deeplyNested = [
      'function f() {',
      '  if (a) {',
      '    for (;;) {',
      '      while (b) {',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    await writeFile(join(tmpDir, 'complex.js'), deeplyNested);

    // A long file exceeding maxFileLines=5
    const longContent = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join('\n');
    await writeFile(join(tmpDir, 'long.ts'), longContent);
  });

  test('returns fileMetrics for all source files', async () => {
    const result = await computeMetrics(tmpDir, { languages: ['typescript', 'javascript'] });
    expect(result.fileMetrics.length).toBeGreaterThanOrEqual(3);
    const files = result.fileMetrics.map((m) => m.file);
    expect(files.some((f) => f.includes('simple.js'))).toBe(true);
    expect(files.some((f) => f.includes('complex.js'))).toBe(true);
    expect(files.some((f) => f.includes('long.ts'))).toBe(true);
  });

  test('each file metric has the expected shape', async () => {
    const result = await computeMetrics(tmpDir, { languages: ['javascript'] });
    for (const m of result.fileMetrics) {
      expect(typeof m.file).toBe('string');
      expect(typeof m.lineCount).toBe('number');
      expect(typeof m.maxNestingDepth).toBe('number');
      expect(typeof m.branchPointCount).toBe('number');
      expect(typeof m.commentToCodeRatio).toBe('number');
      expect(typeof m.exportCount).toBe('number');
      expect(typeof m.importCount).toBe('number');
      expect(typeof m.complexityScore).toBe('number');
    }
  });

  test('emits finding for files exceeding maxFileLines threshold', async () => {
    const result = await computeMetrics(tmpDir, {
      maxFileLines: 5,
      languages: ['typescript'],
    });
    const longFileFinding = result.findings.find(
      (f) => f.ruleId === 'metrics-long-file' && f.file.includes('long.ts')
    );
    expect(longFileFinding).toBeDefined();
    expect(longFileFinding.severity).toBe('medium');
  });

  test('emits finding for files exceeding maxNesting threshold', async () => {
    const result = await computeMetrics(tmpDir, {
      maxNesting: 2,
      languages: ['javascript'],
    });
    const nestingFinding = result.findings.find(
      (f) => f.ruleId === 'metrics-deep-nesting' && f.file.includes('complex.js')
    );
    expect(nestingFinding).toBeDefined();
  });

  test('no findings for a simple file within all thresholds', async () => {
    const result = await computeMetrics(tmpDir, {
      maxFileLines: 300,
      maxComplexity: 100,
      maxNesting: 10,
      languages: ['javascript'],
    });
    const simpleFindings = result.findings.filter((f) => f.file.includes('simple.js'));
    expect(simpleFindings.length).toBe(0);
  });

  test('emits finding for files exceeding maxComplexity', async () => {
    // Force a very low complexity threshold
    const result = await computeMetrics(tmpDir, {
      maxComplexity: 0,
      languages: ['javascript'],
    });
    // At least one file should exceed complexity 0
    const complexityFindings = result.findings.filter(
      (f) => f.ruleId === 'metrics-high-complexity'
    );
    expect(complexityFindings.length).toBeGreaterThan(0);
  });
});
