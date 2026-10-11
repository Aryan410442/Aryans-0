// scripts/patch-agent-kit.mjs
//
// Fixes: @inngest/agent-kit's Gemini adapter mishandles Gemini's
// `thoughtSignature` for function calls.
//
// Gemini 3.x "thinking" models attach `thoughtSignature` as a SIBLING of
// `functionCall` on the response part:
//   { functionCall: {...}, thoughtSignature: "..." }
// Passing it back nested *inside* functionCall is rejected with:
//   400 Unknown name "thoughtSignature" at '...function_call': Cannot find field.
// Omitting it entirely (agent-kit's original behavior) is rejected with:
//   400 Function call is missing a thought_signature in functionCall parts.
//
// This script normalizes the compiled dist files (both the ESM chunk used
// by `import` and the CJS file used by `require`) to the correct shape via
// a single idempotent regex pass — safe to re-run on every postinstall,
// and safe even if an earlier, incorrect version of this patch already ran.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..", "node_modules", "@inngest", "agent-kit", "dist");

const targets = [
  path.join(pkgRoot, "chunk-BSWKEFTT.js"), // ESM build (used by `import`)
  path.join(pkgRoot, "index.cjs"),         // CJS build (used by `require`)
];

const norm = (s) => s.replace(/\r\n/g, "\n");

// Google's documented sentinel for replaying function calls that don't have
// a real signature to hand: https://ai.google.dev/gemini-api/docs/thought-signatures
const SENTINEL = "skip_thought_signature_validator";

// Matches the functionCall object build in messageToContent, in ANY of these
// states, and normalizes all of them to the correct sibling-field shape:
//   - pristine (no signature handling at all)
//   - broken: thoughtSignature nested inside functionCall
//   - broken: `...(m.tools[0].signature ? {...} : {})` nested inside functionCall
//   - already correct (sibling) — left effectively unchanged
const functionCallRegex =
  /([ \t]*)functionCall: \{\n([ \t]*)name: m\.tools\[0\]\.name,\n[ \t]*args: m\.tools\[0\]\.input(?:,\n[ \t]*(?:thoughtSignature: m\.tools\[0\]\.thoughtSignature \|\| "skip_thought_signature_validator"|\.\.\.\(m\.tools\[0\]\.signature \? \{ thoughtSignature: m\.tools\[0\]\.signature \} : \{\}\)))?\n[ \t]*\}(?:,\n[ \t]*thoughtSignature: m\.tools\[0\]\.(?:thoughtSignature \|\| "skip_thought_signature_validator"|signature \|\| "skip_thought_signature_validator"))?/g;

// Matches the responseParser tool object build, in either state (missing the
// field entirely, or already carrying it), and normalizes to include it.
const responseParserRegex =
  /(name: content\.functionCall\.name,\n[ \t]*input: content\.functionCall\.args,\n[ \t]*type: "tool",\n[ \t]*id: content\.functionCall\.name)(?:,\n[ \t]*thoughtSignature: content\.thoughtSignature)?/g;

function normalize(contents) {
  let changed = false;

  contents = contents.replace(functionCallRegex, (match, indentFC, indentInner) => {
    const correct =
      `${indentFC}functionCall: {\n` +
      `${indentInner}name: m.tools[0].name,\n` +
      `${indentInner}args: m.tools[0].input\n` +
      `${indentFC}},\n` +
      `${indentFC}thoughtSignature: m.tools[0].thoughtSignature || "${SENTINEL}"`;
    if (match !== correct) changed = true;
    return correct;
  });

  contents = contents.replace(responseParserRegex, (match, base) => {
    const correct = `${base},\n              thoughtSignature: content.thoughtSignature`;
    if (match !== correct) changed = true;
    return correct;
  });

  return { contents, changed };
}

let anyPatched = false;

for (const file of targets) {
  if (!existsSync(file)) {
    console.warn(`[patch-agent-kit] Skipping missing file: ${file}`);
    continue;
  }

  const original = norm(readFileSync(file, "utf8"));
  const { contents, changed } = normalize(original);

  if (changed) {
    writeFileSync(file, contents, "utf8");
    console.log(`[patch-agent-kit] Patched ${path.basename(file)}`);
    anyPatched = true;
  } else {
    console.log(`[patch-agent-kit] ${path.basename(file)}: already correct`);
  }
}

if (!anyPatched) {
  console.log("[patch-agent-kit] No changes made this run.");
}
