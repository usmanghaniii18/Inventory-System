import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules of Hooks, enforced statically.
 *
 * React requires every hook to run on every render, so a hook may never appear
 * after an early `return` in a component body. A closed <PaymentSheet /> ran six
 * hooks and an open one ran seven, and pressing "Charge" therefore threw
 * "Rendered more hooks than during the previous render" straight into the error
 * boundary — the whole POS screen replaced by "Something went wrong".
 *
 * Nothing caught it: TypeScript cannot see hook ordering, and ESLint (which has
 * the react-hooks/rules-of-hooks rule for exactly this) is not a dependency of
 * this project and has no config, so `next build` never ran it. This file is the
 * stand-in — it re-reads the source and fails if a hook ever drifts below an
 * early return, or into a branch, again.
 *
 * If ESLint with react-hooks is added later, this becomes redundant and can go.
 */

const FEATURE_DIR = join(__dirname, "..");
const HOOK =
  /\b(useState|useEffect|useRef|useMemo|useCallback|useReducer|useLayoutEffect|useSyncExternalStore|useTransition|useDeferredValue|useImperativeHandle|useId|useOptimistic|useActionState)\s*[<(]/;
/** An unconditional bail-out at the top level of a component body. */
const EARLY_RETURN = /^ {2}if \(.*\) return (null|undefined);\s*$/;
/** A new top-level function/component declaration resets the tracking. */
const COMPONENT_START = /^(export )?(default )?function \w+|^(export )?const \w+ = \(?function/;
const NEWLINE = /\r?\n/;

/** Every .tsx file below a directory. */
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

interface Violation { file: string; line: number; text: string }

const rel = (f: string) => f.replace(/.*[\\/]src[\\/]/, "src/").replace(/\\/g, "/");

/** Violation class 1: a hook below an early return — the PaymentSheet bug. */
function findAfterEarlyReturn(file: string): Violation[] {
  const lines = readFileSync(file, "utf8").split(NEWLINE);
  const out: Violation[] = [];
  let sawEarlyReturn = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMPONENT_START.test(line)) { sawEarlyReturn = false; continue; }
    if (EARLY_RETURN.test(line)) { sawEarlyReturn = true; continue; }
    // Only component-body hooks (exactly two spaces of indentation) count;
    // anything deeper is inside a callback, which is a different shape.
    if (sawEarlyReturn && HOOK.test(line) && /^ {2}\S/.test(line)) {
      out.push({ file, line: i + 1, text: line.trim() });
    }
  }
  return out;
}

/**
 * Violation class 2: a hook nested inside a conditional or a loop. Component
 * -body hooks here always sit at exactly two spaces; a hook deeper than that,
 * shortly after a branch keyword, is conditionally called.
 */
function findNestedInBranch(file: string): Violation[] {
  const lines = readFileSync(file, "utf8").split(NEWLINE);
  const out: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!HOOK.test(line)) continue;
    const indent = line.length - line.replace(/^ +/, "").length;
    if (indent <= 2) continue; // component-body hook — fine
    // Must look like a call site, not a mention inside a string or comment.
    if (!/^\s*((const|let|var)\s+.*=\s*)?use[A-Z]/.test(line)) continue;
    const prev = lines.slice(Math.max(0, i - 4), i).join("\n");
    if (/\b(if|else|for|while|switch|try|catch)\b\s*[({]/.test(prev)) {
      out.push({ file, line: i + 1, text: line.trim() });
    }
  }
  return out;
}

describe("Rules of Hooks — static enforcement", () => {
  const roots = [FEATURE_DIR, join(FEATURE_DIR, "..", "components")];
  const files = [...new Set(roots.flatMap((r) => { try { return tsxFiles(r); } catch { return []; } }))];

  it("scans a meaningful number of component files", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("finds no hook called below an early return in any component", () => {
    const report = files.flatMap(findAfterEarlyReturn)
      .map((v) => `${rel(v.file)}:${v.line}  ${v.text}`).join("\n");
    expect(report).toBe("");
  });

  it("finds no hook nested inside a conditional or loop", () => {
    const report = files.flatMap(findNestedInBranch)
      .map((v) => `${rel(v.file)}:${v.line}  ${v.text}`).join("\n");
    expect(report).toBe("");
  });

  it("PaymentSheet calls every one of its hooks before its early return", () => {
    // The exact component that crashed the till when Charge was pressed. Its
    // hook count must be identical whether the sheet is open or closed.
    const file = files.find((f) => f.endsWith("PaymentSheet.tsx"));
    expect(file).toBeTruthy();
    const lines = readFileSync(file!, "utf8").split(NEWLINE);
    const guard = lines.findIndex((l) => EARLY_RETURN.test(l));
    expect(guard).toBeGreaterThan(-1);

    const hooksBefore = lines.slice(0, guard).filter((l) => HOOK.test(l) && /^ {2}\S/.test(l));
    const hooksAfter = lines.slice(guard + 1).filter((l) => HOOK.test(l) && /^ {2}\S/.test(l));

    expect(hooksAfter).toEqual([]);      // nothing conditional
    expect(hooksBefore.length).toBe(7);  // 4 useState + useRef + 2 useEffect
  });

  it("detects the regression pattern if it is ever reintroduced", () => {
    // Guards the detector itself.
    const sample = [
      "function Sheet({ open }) {",
      "  const [a, setA] = useState(0);",
      "  if (!open) return null;",
      "  const ref = useRef(null);",
      "  return null;",
      "}",
    ];
    let sawEarly = false;
    const hits: number[] = [];
    sample.forEach((line, i) => {
      if (COMPONENT_START.test(line)) { sawEarly = false; return; }
      if (EARLY_RETURN.test(line)) { sawEarly = true; return; }
      if (sawEarly && HOOK.test(line) && /^ {2}\S/.test(line)) hits.push(i + 1);
    });
    expect(hits).toEqual([4]);
  });
});
