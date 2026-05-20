import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  tokenize,
  normalizeTokens,
  rollingHash,
  findMatches,
  verifyMatch,
  scanDuplicates,
} from './duplicates.js';

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('splits on whitespace and operators', () => {
    const tokens = tokenize('a + b');
    expect(tokens).toEqual(['a', '+', 'b']);
  });

  it('handles function declaration', () => {
    const tokens = tokenize('function add(x, y) { return x + y; }');
    expect(tokens).toContain('function');
    expect(tokens).toContain('add');
    expect(tokens).toContain('return');
    expect(tokens).toContain('+');
  });

  it('emits string literals as a single STR-sentinel token', () => {
    const tokens = tokenize('"hello world"');
    expect(tokens).toEqual(['"..."']);
  });

  it('handles single-quoted strings', () => {
    const tokens = tokenize("const x = 'foo';");
    expect(tokens).toContain('"..."');
    expect(tokens).not.toContain('foo');
  });

  it('handles backtick strings', () => {
    const tokens = tokenize('const msg = `hello ${name}`;');
    // backtick string is emitted as one sentinel; the interpolated part is consumed
    expect(tokens.filter((t) => t === '"..."').length).toBeGreaterThanOrEqual(1);
  });

  it('strips line comments', () => {
    const tokens = tokenize('x = 1; // this is a comment\ny = 2;');
    expect(tokens).not.toContain('this');
    expect(tokens).not.toContain('comment');
    expect(tokens).toContain('x');
    expect(tokens).toContain('y');
  });

  it('strips block comments', () => {
    const tokens = tokenize('/* block comment */ x = 1;');
    expect(tokens).not.toContain('block');
    expect(tokens).toContain('x');
  });

  it('handles numeric literals', () => {
    const tokens = tokenize('const n = 42;');
    expect(tokens).toContain('42');
  });

  it('handles operators as individual tokens', () => {
    const tokens = tokenize('a === b');
    expect(tokens).toContain('=');
    expect(tokens).toContain('=');
    expect(tokens).toContain('a');
    expect(tokens).toContain('b');
  });
});

// ---------------------------------------------------------------------------
// normalizeTokens
// ---------------------------------------------------------------------------

describe('normalizeTokens', () => {
  it('replaces identifiers with IDENT', () => {
    const result = normalizeTokens(['myVar']);
    expect(result).toEqual(['IDENT']);
  });

  it('replaces numbers with NUM', () => {
    const result = normalizeTokens(['42', '3.14', '0xFF']);
    expect(result).toEqual(['NUM', 'NUM', 'NUM']);
  });

  it('replaces string sentinel with STR', () => {
    const result = normalizeTokens(['"..."']);
    expect(result).toEqual(['STR']);
  });

  it('keeps keywords as-is', () => {
    const keywords = ['if', 'else', 'for', 'while', 'return', 'function', 'class', 'const', 'let', 'var', 'import', 'export'];
    const result = normalizeTokens(keywords);
    expect(result).toEqual(keywords);
  });

  it('keeps Go keywords as-is', () => {
    const goKeywords = ['func', 'defer', 'go', 'select', 'chan', 'range'];
    const result = normalizeTokens(goKeywords);
    expect(result).toEqual(goKeywords);
  });

  it('keeps Python keywords as-is', () => {
    const pyKeywords = ['def', 'pass', 'with', 'as', 'from', 'lambda', 'yield'];
    const result = normalizeTokens(pyKeywords);
    expect(result).toEqual(pyKeywords);
  });

  it('keeps operator tokens as-is', () => {
    const ops = ['+', '-', '=', '{', '}', '(', ')', ';'];
    const result = normalizeTokens(ops);
    expect(result).toEqual(ops);
  });

  it('normalises a realistic snippet', () => {
    const tokens = tokenize('function add(x, y) { return x + y; }');
    const normalised = normalizeTokens(tokens);
    expect(normalised).toContain('function');
    expect(normalised).toContain('return');
    expect(normalised).toContain('IDENT');
    expect(normalised).not.toContain('add');
    expect(normalised).not.toContain('x');
    expect(normalised).not.toContain('y');
  });
});

// ---------------------------------------------------------------------------
// rollingHash
// ---------------------------------------------------------------------------

describe('rollingHash', () => {
  it('returns empty array when tokens fewer than window', () => {
    const result = rollingHash(['a', 'b'], 5);
    expect(result).toEqual([]);
  });

  it('returns one entry when tokens exactly equal window', () => {
    const tokens = ['a', 'b', 'c'];
    const result = rollingHash(tokens, 3);
    expect(result).toHaveLength(1);
    expect(result[0].startIndex).toBe(0);
    expect(result[0].endIndex).toBe(2);
  });

  it('returns tokens.length - windowSize + 1 entries', () => {
    const tokens = ['a', 'b', 'c', 'd', 'e'];
    const result = rollingHash(tokens, 3);
    expect(result).toHaveLength(3);
  });

  it('produces the same hash for identical token windows', () => {
    const tokensA = ['if', 'IDENT', '===', 'NUM', '{', 'return', 'NUM', '}'];
    const tokensB = ['if', 'IDENT', '===', 'NUM', '{', 'return', 'NUM', '}'];
    const hashA = rollingHash(tokensA, 4);
    const hashB = rollingHash(tokensB, 4);
    // First windows should have identical hashes
    expect(hashA[0].hash).toBe(hashB[0].hash);
  });

  it('produces different hashes for different token windows', () => {
    const tokensA = ['if', 'IDENT', '===', 'NUM'];
    const tokensB = ['while', 'IDENT', '!==', 'STR'];
    const hashA = rollingHash(tokensA, 4);
    const hashB = rollingHash(tokensB, 4);
    expect(hashA[0].hash).not.toBe(hashB[0].hash);
  });

  it('consecutive windows share overlapping token positions', () => {
    const tokens = ['a', 'b', 'c', 'd'];
    const result = rollingHash(tokens, 3);
    expect(result[0]).toEqual({ hash: expect.any(Number), startIndex: 0, endIndex: 2 });
    expect(result[1]).toEqual({ hash: expect.any(Number), startIndex: 1, endIndex: 3 });
  });
});

// ---------------------------------------------------------------------------
// verifyMatch
// ---------------------------------------------------------------------------

describe('verifyMatch', () => {
  it('returns 1.0 for identical windows', () => {
    const tokens = ['if', 'IDENT', '===', 'NUM', 'return'];
    const sim = verifyMatch(tokens, tokens, 0, 0, 5);
    expect(sim).toBe(1.0);
  });

  it('returns 0.0 for completely different windows', () => {
    const a = ['a', 'b', 'c', 'd'];
    const b = ['w', 'x', 'y', 'z'];
    const sim = verifyMatch(a, b, 0, 0, 4);
    expect(sim).toBe(0.0);
  });

  it('returns intermediate value for partial match', () => {
    const a = ['a', 'b', 'c', 'd'];
    const b = ['a', 'b', 'x', 'y'];
    const sim = verifyMatch(a, b, 0, 0, 4);
    expect(sim).toBe(0.5);
  });

  it('respects startIndex offsets', () => {
    const a = ['x', 'y', 'a', 'b'];
    const b = ['m', 'n', 'a', 'b'];
    const sim = verifyMatch(a, b, 2, 2, 2);
    expect(sim).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// findMatches
// ---------------------------------------------------------------------------

describe('findMatches', () => {
  it('returns empty array when no cross-file matches', () => {
    const hashMaps = [
      { file: 'a.js', hashes: [{ hash: 1, startIndex: 0, endIndex: 4 }] },
      { file: 'b.js', hashes: [{ hash: 2, startIndex: 0, endIndex: 4 }] },
    ];
    expect(findMatches(hashMaps)).toHaveLength(0);
  });

  it('finds a pair when both files share a hash', () => {
    const hashMaps = [
      { file: 'a.js', hashes: [{ hash: 42, startIndex: 0, endIndex: 4 }] },
      { file: 'b.js', hashes: [{ hash: 42, startIndex: 10, endIndex: 14 }] },
    ];
    const pairs = findMatches(hashMaps);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fileA).toBe('a.js');
    expect(pairs[0].fileB).toBe('b.js');
  });

  it('does not report same-file matches', () => {
    const hashMaps = [
      {
        file: 'a.js',
        hashes: [
          { hash: 42, startIndex: 0, endIndex: 4 },
          { hash: 42, startIndex: 10, endIndex: 14 },
        ],
      },
    ];
    expect(findMatches(hashMaps)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scanDuplicates end-to-end
// ---------------------------------------------------------------------------

describe('scanDuplicates integration', () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dup-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Build a code block that, when tokenised and normalised, produces >= 50 tokens
  function makeCodeBlock(varA, varB, returnVal) {
    return `
function compute(${varA}, ${varB}) {
  const result = ${varA} + ${varB};
  const doubled = result * 2;
  const squared = doubled * doubled;
  const clamped = squared > 1000 ? 1000 : squared;
  const offset = clamped - 5;
  const scaled = offset * 3;
  const final = scaled + ${returnVal};
  if (final > 100) {
    return final - 100;
  }
  return final;
}
`.trim();
  }

  it('detects two files with same logic but different variable names as duplicates', async () => {
    const subDir = join(dir, 'dup-basic');
    await mkdir(subDir, { recursive: true });

    await writeFile(join(subDir, 'fileA.js'), makeCodeBlock('alpha', 'beta', 'alpha'));
    await writeFile(join(subDir, 'fileB.js'), makeCodeBlock('foo', 'bar', 'foo'));

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7 });
    expect(findings.length).toBeGreaterThan(0);
    const files = findings.flatMap((f) => [f.fileA, f.fileB]);
    expect(files.some((f) => f.endsWith('fileA.js'))).toBe(true);
    expect(files.some((f) => f.endsWith('fileB.js'))).toBe(true);
  });

  it('respects the similarity threshold — below threshold is not flagged', async () => {
    const subDir = join(dir, 'dup-threshold');
    await mkdir(subDir, { recursive: true });

    // File A: standard block
    await writeFile(join(subDir, 'a.js'), makeCodeBlock('x', 'y', 'x'));
    // File B: completely different content
    await writeFile(
      join(subDir, 'b.js'),
      `
class EventEmitter {
  constructor() { this.listeners = {}; }
  on(event, handler) { (this.listeners[event] = this.listeners[event] || []).push(handler); }
  emit(event, data) { (this.listeners[event] || []).forEach(h => h(data)); }
  off(event, handler) { this.listeners[event] = (this.listeners[event] || []).filter(h => h !== handler); }
  once(event, handler) { const wrap = (d) => { handler(d); this.off(event, wrap); }; this.on(event, wrap); }
}
`.trim()
    );

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.95 });
    // With high similarity threshold, the very different file should not match
    expect(findings).toHaveLength(0);
  });

  it('does not flag blocks shorter than minTokens', async () => {
    const subDir = join(dir, 'dup-minTokens');
    await mkdir(subDir, { recursive: true });

    // Tiny blocks — same content, but far fewer than minTokens=100
    const tiny = 'function tiny() { return 1; }';
    await writeFile(join(subDir, 'tiny1.js'), tiny);
    await writeFile(join(subDir, 'tiny2.js'), tiny);

    // minTokens set high so these blocks are not considered
    const findings = await scanDuplicates(subDir, { minTokens: 100, similarity: 0.8 });
    expect(findings).toHaveLength(0);
  });

  it('finding shape has required fields', async () => {
    const subDir = join(dir, 'dup-shape');
    await mkdir(subDir, { recursive: true });

    await writeFile(join(subDir, 'x.js'), makeCodeBlock('a', 'b', 'a'));
    await writeFile(join(subDir, 'y.js'), makeCodeBlock('p', 'q', 'p'));

    const findings = await scanDuplicates(subDir, { minTokens: 10, similarity: 0.7 });
    for (const f of findings) {
      expect(f.check).toBe('duplicate');
      expect(typeof f.fileA).toBe('string');
      expect(typeof f.fileB).toBe('string');
      expect(typeof f.startLineA).toBe('number');
      expect(typeof f.endLineA).toBe('number');
      expect(typeof f.startLineB).toBe('number');
      expect(typeof f.endLineB).toBe('number');
      expect(typeof f.similarity).toBe('number');
      expect(f.similarity).toBeGreaterThanOrEqual(0);
      expect(f.similarity).toBeLessThanOrEqual(1);
      expect(typeof f.tokenCount).toBe('number');
    }
  });

  it('returns empty array when fewer than 2 files have enough tokens', async () => {
    const subDir = join(dir, 'dup-single');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'only.js'), makeCodeBlock('a', 'b', 'a'));

    const findings = await scanDuplicates(subDir, { minTokens: 5 });
    expect(findings).toHaveLength(0);
  });
});
