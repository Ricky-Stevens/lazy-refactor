/**
 * Extract imported symbols/modules from file content for a given language.
 * Returns array of symbol names.
 * @param {string} content
 * @param {string} language
 * @returns {string[]}
 */
export function extractImports(content, language) {
  switch (language) {
    case "typescript":
      return extractTypescriptImports(content);
    case "python":
      return extractPythonImports(content);
    case "csharp":
      return extractCsharpImports(content);
    case "java":
      return extractJavaImports(content);
    case "go":
      return extractGoImports(content);
    default:
      return [];
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Split a comma-separated symbol list and return the exported name for each
 * (i.e. the part BEFORE `as`). Used for ES/Python named imports.
 */
function exportedNames(symbolList) {
  const names = [];
  for (const sym of symbolList.split(",")) {
    const name = sym.trim().split(/\s+as\s+/)[0].trim();
    if (name && name !== "*") names.push(name);
  }
  return names;
}

// ─── per-language extractors ──────────────────────────────────────────────────

function extractTypescriptImports(content) {
  const imports = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // import React, { useState } from 'react' — default + named together
    const mixed = trimmed.match(/^import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]+)\}\s+from/);
    if (mixed) {
      imports.push(mixed[1]);
      imports.push(...exportedNames(mixed[2]));
      continue;
    }

    // import type { Foo } from './bar'
    const typeOnly = trimmed.match(/^import\s+type\s+\{([^}]+)\}\s+from/);
    if (typeOnly) {
      imports.push(...exportedNames(typeOnly[1]));
      continue;
    }

    // import { foo, bar } from '...'
    const named = trimmed.match(/^import\s+\{([^}]+)\}\s+from/);
    if (named) {
      imports.push(...exportedNames(named[1]));
      continue;
    }

    // import defaultExport from '...'
    const defaultImp = trimmed.match(/^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from/);
    if (defaultImp) {
      imports.push(defaultImp[1]);
      continue;
    }

    // import * as ns from '...'
    const star = trimmed.match(/^import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from/);
    if (star) {
      imports.push(star[1]);
      continue;
    }

    // const { foo } = require('...')
    const req = trimmed.match(/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(/);
    if (req) {
      for (const sym of req[1].split(",")) {
        // Handle JS destructuring rename syntax: { foo: bar } → bar
        const renamed = sym.trim().split(":");
        const afterColon = renamed.length > 1 ? renamed[1].trim() : renamed[0].trim();
        // Also handle `as` aliases (less common in require, but possible)
        const name = afterColon.split(/\s+as\s+/).pop().trim();
        if (name) imports.push(name);
      }
      continue;
    }

    // const foo = require('...')
    const reqDefault = trimmed.match(
      /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\s*\(/,
    );
    if (reqDefault) {
      imports.push(reqDefault[1]);
      continue;
    }
  }

  // Second pass over the full file to catch multi-line named imports
  // like `import {\n  foo,\n  bar,\n} from '...'` which the per-line loop misses.
  const multiLineRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
  let mlMatch;
  while ((mlMatch = multiLineRe.exec(content)) !== null) {
    for (const sym of mlMatch[1].split(",")) {
      const name = sym.trim().split(/\s+as\s+/)[0].trim();
      if (name && !imports.includes(name)) imports.push(name);
    }
  }

  return imports;
}

function extractPythonImports(content) {
  const imports = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // from module import foo, bar
    const fromImp = trimmed.match(/^from\s+\S+\s+import\s+(.+)/);
    if (fromImp) {
      imports.push(...exportedNames(fromImp[1]));
      continue;
    }

    // import module as alias — record the alias (local name used in code)
    const imp = trimmed.match(/^import\s+(.+)/);
    if (imp) {
      for (const sym of imp[1].split(",")) {
        const parts = sym.trim().split(/\s+as\s+/);
        const name = parts[parts.length - 1].trim();
        if (name) imports.push(name);
      }
    }
  }
  return imports;
}

function extractCsharpImports(content) {
  const imports = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // using Alias = X.Y.Z; — want the alias (left of =)
    const aliasMatch = trimmed.match(/^using\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (aliasMatch) {
      imports.push(aliasMatch[1]);
      continue;
    }

    // Plain using directive — push the FULL namespace path instead of just
    // the last segment. The last segment (e.g. "Generic" from
    // "System.Collections.Generic") never matches actual type usage (List<T>),
    // causing ~250 false positives per C# project. scanDeadCode handles C#
    // via grep instead of import-set matching, so these full paths are only
    // informational.
    const plainMatch = trimmed.match(/^using\s+([\w.]+)\s*;/);
    if (plainMatch) {
      imports.push(plainMatch[1]);
    }
  }
  return imports;
}

function extractJavaImports(content) {
  const imports = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // import static X.Y.Z;  or  import X.Y.Z;
    const javaMatch = trimmed.match(/^import\s+(?:static\s+)?([\w.]+)\s*;/);
    if (javaMatch) {
      const segments = javaMatch[1].split(".");
      imports.push(segments[segments.length - 1]);
    }
  }
  return imports;
}

function extractGoImports(content) {
  const imports = [];
  const lines = content.split("\n");
  let inImportBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.match(/^import\s*\($/)) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock && trimmed === ")") {
      inImportBlock = false;
      continue;
    }

    // Single-line import (always valid)
    const single = trimmed.match(/^import\s+(?:([A-Za-z_.][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
    if (single) {
      imports.push(single[1] ?? single[2].split("/").pop());
      continue;
    }

    // Inside import block only: alias "path" or just "path"
    if (inImportBlock) {
      const block = trimmed.match(/^(?:([A-Za-z_.][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
      if (block) {
        imports.push(block[1] ?? block[2].split("/").pop());
      }
    }
  }

  return imports;
}
