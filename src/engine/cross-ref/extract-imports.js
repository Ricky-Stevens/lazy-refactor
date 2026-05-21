/**
 * Extract imported symbols/modules from file content for a given language.
 * Returns array of symbol names.
 * @param {string} content
 * @param {string} language
 * @returns {string[]}
 */
export function extractImports(content, language) {
  const lines = content.split("\n");
  const imports = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (language === "typescript") {
      // import React, { useState } from 'react' — default + named together
      const mixed = trimmed.match(/^import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]+)\}\s+from/);
      if (mixed) {
        imports.push(mixed[1]);
        for (const sym of mixed[2].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[0].trim();
          if (name) imports.push(name);
        }
        continue;
      }
      // import type { Foo } from './bar'
      const typeOnly = trimmed.match(/^import\s+type\s+\{([^}]+)\}\s+from/);
      if (typeOnly) {
        for (const sym of typeOnly[1].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[0].trim();
          if (name) imports.push(name);
        }
        continue;
      }
      // import { foo, bar } from '...'
      const named = trimmed.match(/^import\s+\{([^}]+)\}\s+from/);
      if (named) {
        for (const sym of named[1].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[0].trim(); // exported name, not the local alias
          if (name) imports.push(name);
        }
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
          const name = afterColon
            .split(/\s+as\s+/)
            .pop()
            .trim();
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

    // Go imports are handled in a dedicated block after this per-line loop
    // (state tracking for `import (...)` cannot be done correctly inline here).

    if (language === "python") {
      // from module import foo, bar
      const fromImp = trimmed.match(/^from\s+\S+\s+import\s+(.+)/);
      if (fromImp) {
        for (const sym of fromImp[1].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[0].trim(); // exported name, not the local alias
          if (name && name !== "*") imports.push(name);
        }
        continue;
      }
      // import module as alias
      const imp = trimmed.match(/^import\s+(.+)/);
      if (imp) {
        for (const sym of imp[1].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[parts.length - 1].trim();
          if (name) imports.push(name);
        }
      }
    }

    if (language === "csharp") {
      // using X.Y.Z;  or  using Alias = X.Y.Z;
      // For "using Alias = X.Y.Z;" we want the alias (left of =)
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
        continue;
      }
    }

    if (language === "java") {
      // import static X.Y.Z;  or  import X.Y.Z;
      const javaMatch = trimmed.match(/^import\s+(?:static\s+)?([\w.]+)\s*;/);
      if (javaMatch) {
        const segments = javaMatch[1].split(".");
        imports.push(segments[segments.length - 1]);
      }
    }
  }

  // Go: parse imports with proper block tracking so quoted strings outside
  // an `import (...)` block don't get treated as imports.
  if (language === "go") {
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
        const alias = single[1] ?? single[2].split("/").pop();
        imports.push(alias);
        continue;
      }

      // Inside import block only: alias "path" or just "path"
      if (inImportBlock) {
        const block = trimmed.match(/^(?:([A-Za-z_.][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
        if (block) {
          const alias = block[1] ?? block[2].split("/").pop();
          imports.push(alias);
        }
      }
    }
  }

  // TypeScript: second pass over the full file to catch multi-line named imports
  // like `import {\n  foo,\n  bar,\n} from '...'` which the per-line loop misses.
  if (language === "typescript") {
    const multiLineRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
    let mlMatch;
    while ((mlMatch = multiLineRe.exec(content)) !== null) {
      for (const sym of mlMatch[1].split(",")) {
        const name = sym
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (name && !imports.includes(name)) imports.push(name);
      }
    }
  }

  return imports;
}
