import { execFileSync } from "node:child_process";

// gitignore exclusion: let git itself decide what's ignored, rather than
// re-implementing .gitignore's matching rules (negation, anchoring, dir-only,
// nested .gitignore files, .git/info/exclude, the global excludesfile). We shell
// out to `git check-ignore`, which is authoritative and dep-free. It naturally
// no-ops outside a git work-tree — which is fine, since .gitignore only has
// meaning inside one. execFileSync with an argument array (never a shell string)
// keeps user-controlled paths injection-safe, matching the pattern scanner.

// Per-root opt-out, set once per scan by the entry point. A root that is never
// configured defaults to ENABLED, so direct collectFiles callers and tests
// respect .gitignore unless they opt out via the collectFiles option.
const _enabledByRoot = new Map();
// dir -> work-tree root (or null when not a git repo / git unavailable). Cached
// because resolving it spawns git and the root never changes mid-scan.
const _repoRootCache = new Map();

/**
 * Set whether .gitignore is respected for scans rooted at `root`. Called once
 * per scan from the config-reading entry point; `collectFiles`' own default is
 * already on, so this only needs calling to DISABLE.
 * @param {string} root
 * @param {boolean} enabled
 */
export function configureGitignore(root, enabled) {
  _enabledByRoot.set(root, enabled);
}

/** Reset all gitignore caches/config (test isolation). */
export function clearGitignoreConfig() {
  _enabledByRoot.clear();
  _repoRootCache.clear();
}

function gitWorkTreeRoot(dir) {
  if (_repoRootCache.has(dir)) return _repoRootCache.get(dir);
  let root = null;
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    root = out.trim() || null;
  } catch {
    // Not a git repo, or git isn't installed — gitignore respect simply no-ops.
    root = null;
  }
  _repoRootCache.set(dir, root);
  return root;
}

/**
 * Given the scanned `dir` and a list of ABSOLUTE file paths, return the subset
 * that git would ignore. Returns an empty set (no filtering) when gitignore is
 * disabled for the root, the dir is not a git work-tree, git is unavailable, or
 * nothing matched — so a missing/broken git never blocks a scan.
 * @param {string} dir
 * @param {string[]} absPaths
 * @returns {Set<string>}
 */
export function gitignoredPaths(dir, absPaths) {
  if (absPaths.length === 0) return new Set();
  if (_enabledByRoot.get(dir) === false) return new Set();
  const root = gitWorkTreeRoot(dir);
  if (!root) return new Set();

  // `git check-ignore --stdin -z`: NUL-delimited paths in (stdin) and the
  // ignored subset out (stdout). It exits 1 when NONE of the inputs are ignored
  // (not an error) and 0 when at least one is — so a status of 1 means "keep
  // everything", and any other failure means "couldn't decide → don't filter".
  let stdout;
  try {
    stdout = execFileSync("git", ["-C", root, "check-ignore", "--stdin", "-z"], {
      input: absPaths.join("\0"),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    if (err && err.status === 1) return new Set();
    return new Set();
  }

  const ignored = new Set();
  for (const p of stdout.split("\0")) {
    if (p) ignored.add(p);
  }
  return ignored;
}
