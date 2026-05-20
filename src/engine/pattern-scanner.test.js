import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildGrepCommand,
  scanPatterns,
  isRipgrepAvailable,
} from './pattern-scanner.js';

// ---------------------------------------------------------------------------
// buildGrepCommand
// ---------------------------------------------------------------------------
describe('buildGrepCommand', () => {
  test('ripgrep command includes -Pn --no-heading and glob flags', () => {
    const cmd = buildGrepCommand('TODO', '**/*.js', ['node_modules/**'], true);
    expect(cmd).toContain('rg -Pn --no-heading');
    expect(cmd).toContain("--glob '!node_modules/**'");
    expect(cmd).toContain("'**/*.js'");
    expect(cmd).toContain('TODO');
  });

  test('ripgrep command with multiple excludes', () => {
    const cmd = buildGrepCommand('FIXME', '**/*.ts', ['node_modules/**', '**/*.test.*'], true);
    expect(cmd).toContain("--glob '!node_modules/**'");
    expect(cmd).toContain("--glob '!**/*.test.*'");
  });

  test('grep fallback command uses find + xargs + grep -Pn', () => {
    const cmd = buildGrepCommand('TODO', '**/*.{js,ts}', ['node_modules/**'], false);
    expect(cmd).toContain('find .');
    expect(cmd).toContain('grep -Pn');
    expect(cmd).toContain('*.js');
    expect(cmd).toContain('*.ts');
    expect(cmd).toContain('TODO');
  });

  test('grep fallback includes extension filter from filePattern', () => {
    const cmd = buildGrepCommand('pattern', '**/*.py', [], false);
    expect(cmd).toContain("*.py");
  });

  test('ripgrep command with no excludes still produces valid command', () => {
    const cmd = buildGrepCommand('foo', '**/*.go', [], true);
    expect(cmd).toContain('rg -Pn --no-heading');
    expect(cmd).not.toContain('--glob !');
    expect(cmd).toContain('foo');
  });
});

// ---------------------------------------------------------------------------
// scanPatterns — integration tests with temp directory
// ---------------------------------------------------------------------------
describe('scanPatterns', () => {
  let tmpDir;

  /** @type {import('./pattern-scanner.js').Rule} */
  const consoleRule = {
    id: 'console-log',
    severity: 'medium',
    category: 'debugging-leftovers',
    description: 'console.log left in code',
    language: 'typescript',
    pattern: 'console\\.log\\s*\\(',
    antiPattern: null,
    filePattern: '**/*.{ts,tsx,js,jsx}',
    exclude: ['**/*.test.*', '**/node_modules/**'],
    suggestion: 'Remove console.log',
    fixable: true,
  };

  /** Rule with an anti-pattern: match "TODO" but not in files that contain "SKIP" */
  const todoRule = {
    id: 'todo-comment',
    severity: 'low',
    category: 'tech-debt',
    description: 'TODO comment found',
    language: 'common',
    pattern: 'TODO',
    antiPattern: 'SKIP_TODO_CHECK',
    filePattern: '**/*.{ts,js}',
    exclude: [],
    suggestion: 'Resolve the TODO',
    fixable: false,
  };

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scanner-test-'));

    // File that triggers console-log rule
    await writeFile(
      join(tmpDir, 'app.js'),
      [
        'function hello() {',
        '  console.log("hello");',
        '  return 42;',
        '}',
      ].join('\n')
    );

    // File that should NOT trigger console-log (it's a .test.js file)
    await writeFile(
      join(tmpDir, 'app.test.js'),
      'console.log("test output");'
    );

    // File with TODO that should be found
    await writeFile(
      join(tmpDir, 'todo.ts'),
      'const x = 1; // TODO: fix this later\n'
    );

    // File with TODO but also has the anti-pattern SKIP_TODO_CHECK
    await writeFile(
      join(tmpDir, 'skip.ts'),
      '// SKIP_TODO_CHECK\n// TODO: this should be ignored\nconst y = 2;\n'
    );

    // File to test extra exclude globs
    await writeFile(
      join(tmpDir, 'vendor.js'),
      'console.log("vendor code");'
    );
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('returns findings with correct shape', async () => {
    const findings = await scanPatterns(tmpDir, [consoleRule], {});
    // app.js should match (vendor.js is not excluded by the rule itself)
    const appFinding = findings.find((f) => f.file.includes('app.js') && !f.file.includes('test'));
    expect(appFinding).toBeDefined();
    expect(appFinding.ruleId).toBe('console-log');
    expect(typeof appFinding.file).toBe('string');
    expect(typeof appFinding.line).toBe('number');
    expect(typeof appFinding.match).toBe('string');
    expect(appFinding.severity).toBe('medium');
    expect(appFinding.category).toBe('debugging-leftovers');
    expect(typeof appFinding.description).toBe('string');
    expect(typeof appFinding.suggestion).toBe('string');
    expect(typeof appFinding.fixable).toBe('boolean');
  });

  test('rule exclude patterns filter out matched files', async () => {
    const findings = await scanPatterns(tmpDir, [consoleRule], {});
    // app.test.js should be excluded by rule's exclude: ['**/*.test.*']
    const testFinding = findings.find((f) => f.file.includes('app.test.js'));
    expect(testFinding).toBeUndefined();
  });

  test('extra exclude globs in options filter out files', async () => {
    const findings = await scanPatterns(tmpDir, [consoleRule], {
      exclude: ['**/vendor.js'],
    });
    const vendorFinding = findings.find((f) => f.file.includes('vendor.js'));
    expect(vendorFinding).toBeUndefined();
  });

  test('anti-pattern exclusion: file containing antiPattern is skipped', async () => {
    const findings = await scanPatterns(tmpDir, [todoRule], {});
    // todo.ts should produce a finding
    const todoFinding = findings.find((f) => f.file.includes('todo.ts'));
    expect(todoFinding).toBeDefined();
    // skip.ts should NOT produce a finding (it contains SKIP_TODO_CHECK)
    const skipFinding = findings.find((f) => f.file.includes('skip.ts'));
    expect(skipFinding).toBeUndefined();
  });

  test('language filter: rules not matching requested languages are skipped', async () => {
    const findings = await scanPatterns(tmpDir, [consoleRule], {
      languages: ['python'], // console-log rule is 'typescript', not 'python'
    });
    expect(findings.length).toBe(0);
  });

  test('language filter: common rules apply regardless of language filter', async () => {
    // todoRule has language: 'common', should match even when filtering by 'typescript'
    const findings = await scanPatterns(tmpDir, [todoRule], {
      languages: ['typescript'],
    });
    const todoFinding = findings.find((f) => f.file.includes('todo.ts'));
    expect(todoFinding).toBeDefined();
  });

  test('returns empty array when no files match the pattern', async () => {
    const noMatchRule = {
      id: 'no-match',
      severity: 'low',
      category: 'test',
      description: 'Should not match anything',
      language: 'common',
      pattern: 'XYZZY_NEVER_MATCHES_12345',
      antiPattern: null,
      filePattern: '**/*.{ts,js}',
      exclude: [],
      suggestion: 'N/A',
      fixable: false,
    };
    const findings = await scanPatterns(tmpDir, [noMatchRule], {});
    expect(findings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isRipgrepAvailable
// ---------------------------------------------------------------------------
describe('isRipgrepAvailable', () => {
  test('returns a boolean', async () => {
    const result = await isRipgrepAvailable();
    expect(typeof result).toBe('boolean');
  });

  test('result is cached (second call returns same value)', async () => {
    const first = await isRipgrepAvailable();
    const second = await isRipgrepAvailable();
    expect(first).toBe(second);
  });
});
