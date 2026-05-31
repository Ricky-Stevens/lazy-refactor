import { globToRegex } from "./src/engine/files.js";
const patterns = ["*".repeat(50)+"x", "**/".repeat(40)+"x", "a"+"*?".repeat(30), "**".repeat(60)];
for (const p of patterns) {
  const rx = globToRegex(p);
  const t0 = performance.now(); rx.test("a".repeat(8000)); const dt = performance.now()-t0;
  process.stdout.write(`patlen=${p.length} took=${dt.toFixed(2)}ms\n`);
}
