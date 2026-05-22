import { describe, expect, it } from "bun:test";

import commonRules from "./common.js";
import csharpRules from "./csharp.js";
import goRules from "./go.js";
import javaRules from "./java.js";
import outdatedPatterns from "./outdated-patterns.js";
import pythonRules from "./python.js";
import typescriptRules from "./typescript.js";

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

const REQUIRED_FIELDS = [
  "id",
  "severity",
  "category",
  "description",
  "language",
  "pattern",
  "antiPattern",
  "filePattern",
  "exclude",
  "suggestion",
  "fixable",
];

const ruleFiles = [
  { name: "common", rules: commonRules },
  { name: "typescript", rules: typescriptRules },
  { name: "go", rules: goRules },
  { name: "python", rules: pythonRules },
  { name: "csharp", rules: csharpRules },
  { name: "java", rules: javaRules },
];

const allRules = ruleFiles.flatMap(({ rules }) => rules);

// ---------------------------------------------------------------------------
// Shared validation helpers — called once per rule file to avoid deep nesting
// ---------------------------------------------------------------------------

function assertExportsArray(name, rules) {
  // Invariant: every rule file exports a non-empty array (not an object/map).
  expect(Array.isArray(rules), `${name}.js must export an array`).toBe(true);
  expect(rules.length, `${name}.js must have at least one rule`).toBeGreaterThan(0);
}

function assertRequiredFields(name, rules) {
  // Invariant: the rule schema is complete — all required fields must be present.
  for (const rule of rules) {
    for (const field of REQUIRED_FIELDS) {
      expect(
        Object.hasOwn(rule, field),
        `Rule "${rule.id ?? "(no id)"}" in ${name}.js is missing field "${field}"`,
      ).toBe(true);
    }
  }
}

function assertValidSeverities(name, rules) {
  // Invariant: severity must be one of the four known values.
  for (const rule of rules) {
    expect(
      VALID_SEVERITIES.has(rule.severity),
      `Rule "${rule.id}" in ${name}.js has invalid severity "${rule.severity}"`,
    ).toBe(true);
  }
}

function assertValidPatterns(_name, rules) {
  // Invariant: pattern must be a compilable regex string — passed directly to new RegExp().
  for (const rule of rules) {
    expect(typeof rule.pattern, `Rule "${rule.id}" pattern must be a string`).toBe("string");
    expect(
      () => new RegExp(rule.pattern),
      `Rule "${rule.id}" pattern is not a valid regex`,
    ).not.toThrow();
  }
}

function assertValidAntiPatterns(_name, rules) {
  // Invariant: antiPattern is string (compilable regex) or null.
  for (const rule of rules) {
    const val = rule.antiPattern;
    expect(
      val === null || typeof val === "string",
      `Rule "${rule.id}" antiPattern must be a string or null`,
    ).toBe(true);
    if (typeof val === "string") {
      expect(
        () => new RegExp(val),
        `Rule "${rule.id}" antiPattern is not a valid regex`,
      ).not.toThrow();
    }
  }
}

function assertValidFilePatterns(_name, rules) {
  // Invariant: filePattern scopes the rule to specific file types; must be non-empty.
  for (const rule of rules) {
    expect(
      typeof rule.filePattern === "string" && rule.filePattern.length > 0,
      `Rule "${rule.id}" must have a non-empty filePattern string`,
    ).toBe(true);
  }
}

function assertValidExcludeArrays(_name, rules) {
  // Invariant: exclude is always an array of strings (possibly empty).
  for (const rule of rules) {
    expect(Array.isArray(rule.exclude), `Rule "${rule.id}" exclude must be an array`).toBe(true);
    for (const glob of rule.exclude) {
      expect(typeof glob === "string", `Rule "${rule.id}" exclude entries must be strings`).toBe(
        true,
      );
    }
  }
}

function assertFixableIsBoolean(_name, rules) {
  // Invariant: fixable drives the fixer agent's dispatch logic — must be explicit boolean.
  for (const rule of rules) {
    expect(typeof rule.fixable === "boolean", `Rule "${rule.id}" fixable must be a boolean`).toBe(
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Rule file invariant tests
// ---------------------------------------------------------------------------

describe("Rule files", () => {
  for (const { name, rules } of ruleFiles) {
    describe(`${name}.js`, () => {
      it("exports an array", () => assertExportsArray(name, rules));
      it("every rule has all required fields", () => assertRequiredFields(name, rules));
      it("every severity is one of the 4 valid values", () => assertValidSeverities(name, rules));
      it("every pattern is a valid regex string", () => assertValidPatterns(name, rules));
      it("antiPattern is a string or null", () => assertValidAntiPatterns(name, rules));
      it("every filePattern is a non-empty string", () => assertValidFilePatterns(name, rules));
      it("every exclude is an array of strings", () => assertValidExcludeArrays(name, rules));
      it("fixable is a boolean", () => assertFixableIsBoolean(name, rules));
    });
  }

  describe("Cross-file uniqueness", () => {
    // Invariant: rule IDs are stable keys in the findings store; duplicates would
    // cause one rule to silently overwrite another's findings.
    it("all rule ids are unique across all rule files", () => {
      const seen = new Map();
      for (const rule of allRules) {
        expect(
          seen.has(rule.id),
          `Duplicate rule id "${rule.id}" found (first seen in ${seen.get(rule.id)})`,
        ).toBe(false);
        seen.set(rule.id, rule.language);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// outdated-patterns.js structural contract
// ---------------------------------------------------------------------------

// outdated-patterns.js has a different shape from the rule arrays above:
// it's a map of ecosystem -> migration entries consumed by checkOutdatedDeps().

describe("outdated-patterns.js", () => {
  it("exports an object (map)", () => {
    // Invariant: must be a plain object, not an array — engine iterates with Object.entries().
    expect(typeof outdatedPatterns).toBe("object");
    expect(Array.isArray(outdatedPatterns)).toBe(false);
    expect(outdatedPatterns).not.toBeNull();
  });

  it("has at least the 5 expected ecosystems", () => {
    // Invariant: all five language ecosystems must be present.
    const ecosystems = Object.keys(outdatedPatterns);
    for (const expected of ["javascript", "python", "go", "csharp", "java"]) {
      expect(ecosystems).toContain(expected);
    }
  });

  it("each ecosystem maps to a non-empty array", () => {
    for (const [key, entries] of Object.entries(outdatedPatterns)) {
      expect(Array.isArray(entries), `${key} must be an array`).toBe(true);
      expect(entries.length, `${key} must have at least one entry`).toBeGreaterThan(0);
    }
  });

  it("each entry has from, to, description, detectPattern, severity", () => {
    // Invariant: all five required fields must be non-empty strings.
    const requiredFields = ["from", "to", "description", "detectPattern", "severity"];
    for (const [key, entries] of Object.entries(outdatedPatterns)) {
      for (const entry of entries) {
        for (const field of requiredFields) {
          expect(
            Object.hasOwn(entry, field),
            `Entry "${entry.from ?? "?"}" in "${key}" is missing field "${field}"`,
          ).toBe(true);
          expect(
            typeof entry[field] === "string" && entry[field].length > 0,
            `Entry "${entry.from ?? "?"}" in "${key}" field "${field}" must be a non-empty string`,
          ).toBe(true);
        }
      }
    }
  });

  it("each detectPattern is a valid regex string", () => {
    // Invariant: passed to new RegExp() without error handling.
    for (const [key, entries] of Object.entries(outdatedPatterns)) {
      for (const entry of entries) {
        expect(
          () => new RegExp(entry.detectPattern),
          `detectPattern for "${entry.from}" in "${key}" is not a valid regex`,
        ).not.toThrow();
      }
    }
  });

  it("each entry severity is one of the 4 valid values", () => {
    for (const [key, entries] of Object.entries(outdatedPatterns)) {
      for (const entry of entries) {
        expect(
          VALID_SEVERITIES.has(entry.severity),
          `Entry "${entry.from}" in "${key}" has invalid severity "${entry.severity}"`,
        ).toBe(true);
      }
    }
  });
});
