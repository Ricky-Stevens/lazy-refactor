import { describe, it, expect } from 'bun:test';

import commonRules from './common.js';
import typescriptRules from './typescript.js';
import goRules from './go.js';
import pythonRules from './python.js';
import csharpRules from './csharp.js';
import javaRules from './java.js';
import outdatedPatterns from './outdated-patterns.js';

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const REQUIRED_FIELDS = [
  'id',
  'severity',
  'category',
  'description',
  'language',
  'pattern',
  'antiPattern',
  'filePattern',
  'exclude',
  'suggestion',
  'fixable',
];

const ruleFiles = [
  { name: 'common', rules: commonRules },
  { name: 'typescript', rules: typescriptRules },
  { name: 'go', rules: goRules },
  { name: 'python', rules: pythonRules },
  { name: 'csharp', rules: csharpRules },
  { name: 'java', rules: javaRules },
];

// Collect all rules into one flat list for cross-file uniqueness checks
const allRules = ruleFiles.flatMap(({ rules }) => rules);

describe('Rule files', () => {
  for (const { name, rules } of ruleFiles) {
    describe(`${name}.js`, () => {
      it('exports an array', () => {
        expect(Array.isArray(rules)).toBe(true);
        expect(rules.length).toBeGreaterThan(0);
      });

      it('every rule has all required fields', () => {
        for (const rule of rules) {
          for (const field of REQUIRED_FIELDS) {
            expect(
              Object.prototype.hasOwnProperty.call(rule, field),
              `Rule "${rule.id ?? '(no id)'}" in ${name}.js is missing field "${field}"`
            ).toBe(true);
          }
        }
      });

      it('every severity is one of the 4 valid values', () => {
        for (const rule of rules) {
          expect(
            VALID_SEVERITIES.has(rule.severity),
            `Rule "${rule.id}" has invalid severity "${rule.severity}"`
          ).toBe(true);
        }
      });

      it('every pattern is a valid regex string', () => {
        for (const rule of rules) {
          expect(
            typeof rule.pattern,
            `Rule "${rule.id}" pattern must be a string`
          ).toBe('string');
          // Verify it compiles without throwing
          expect(() => new RegExp(rule.pattern)).not.toThrow();
        }
      });

      it('antiPattern is a string or null', () => {
        for (const rule of rules) {
          const val = rule.antiPattern;
          expect(
            val === null || typeof val === 'string',
            `Rule "${rule.id}" antiPattern must be a string or null`
          ).toBe(true);
          if (typeof val === 'string') {
            expect(() => new RegExp(val)).not.toThrow();
          }
        }
      });

      it('every filePattern is a non-empty string', () => {
        for (const rule of rules) {
          expect(
            typeof rule.filePattern === 'string' && rule.filePattern.length > 0,
            `Rule "${rule.id}" must have a non-empty filePattern string`
          ).toBe(true);
        }
      });

      it('every exclude is an array of strings', () => {
        for (const rule of rules) {
          expect(
            Array.isArray(rule.exclude),
            `Rule "${rule.id}" exclude must be an array`
          ).toBe(true);
          for (const glob of rule.exclude) {
            expect(
              typeof glob === 'string',
              `Rule "${rule.id}" exclude entries must be strings`
            ).toBe(true);
          }
        }
      });

      it('fixable is a boolean', () => {
        for (const rule of rules) {
          expect(
            typeof rule.fixable === 'boolean',
            `Rule "${rule.id}" fixable must be a boolean`
          ).toBe(true);
        }
      });
    });
  }

  describe('Cross-file uniqueness', () => {
    it('all rule ids are unique across all rule files', () => {
      const seen = new Map();
      for (const rule of allRules) {
        expect(
          seen.has(rule.id),
          `Duplicate rule id "${rule.id}" found in multiple files (first seen in ${seen.get(rule.id)})`
        ).toBe(false);
        seen.set(rule.id, rule.language);
      }
    });
  });
});

describe('outdated-patterns.js', () => {
  it('exports an object (map)', () => {
    expect(typeof outdatedPatterns).toBe('object');
    expect(Array.isArray(outdatedPatterns)).toBe(false);
    expect(outdatedPatterns).not.toBeNull();
  });

  it('has at least the 5 expected ecosystems', () => {
    const ecosystems = Object.keys(outdatedPatterns);
    for (const expected of ['javascript', 'python', 'go', 'csharp', 'java']) {
      expect(ecosystems).toContain(expected);
    }
  });

  it('each ecosystem maps to a non-empty array', () => {
    for (const [key, entries] of Object.entries(outdatedPatterns)) {
      expect(Array.isArray(entries), `${key} must be an array`).toBe(true);
      expect(entries.length, `${key} must have at least one entry`).toBeGreaterThan(0);
    }
  });

  it('each entry has from, to, description, detectPattern, severity', () => {
    const requiredFields = ['from', 'to', 'description', 'detectPattern', 'severity'];
    for (const [key, entries] of Object.entries(outdatedPatterns)) {
      for (const entry of entries) {
        for (const field of requiredFields) {
          expect(
            Object.prototype.hasOwnProperty.call(entry, field),
            `Entry "${entry.from ?? '?'}" in ecosystem "${key}" is missing field "${field}"`
          ).toBe(true);
          expect(
            typeof entry[field] === 'string' && entry[field].length > 0,
            `Entry "${entry.from ?? '?'}" in ecosystem "${key}" field "${field}" must be a non-empty string`
          ).toBe(true);
        }
      }
    }
  });

  it('each detectPattern is a valid regex string', () => {
    for (const [key, entries] of Object.entries(outdatedPatterns)) {
      for (const entry of entries) {
        expect(
          () => new RegExp(entry.detectPattern),
          `detectPattern for "${entry.from}" in "${key}" is not a valid regex`
        ).not.toThrow();
      }
    }
  });

  it('each entry severity is one of the 4 valid values', () => {
    for (const [key, entries] of Object.entries(outdatedPatterns)) {
      for (const entry of entries) {
        expect(
          VALID_SEVERITIES.has(entry.severity),
          `Entry "${entry.from}" in "${key}" has invalid severity "${entry.severity}"`
        ).toBe(true);
      }
    }
  });
});
