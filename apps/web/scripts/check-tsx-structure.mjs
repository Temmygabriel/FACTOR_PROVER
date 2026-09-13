#!/usr/bin/env node
/**
 * Structural check for the frontend, which has no local type-checker.
 *
 * WHY THIS EXISTS. All heavy compute for this project happens on GitHub Actions:
 * the development machine has 8GB of RAM and a local `npm install` is banned, so
 * there is no `node_modules` and therefore no TypeScript and no Next.js. For the
 * agent that is workable — Node 24's type stripping runs the `.ts` directly. It
 * does NOT work for `.tsx`: Node rejects the extension outright
 * (`ERR_UNKNOWN_FILE_EXTENSION`), and type stripping would not transform JSX even
 * if it did not. So every frontend edit was unverified until CI ran, and a
 * dropped `</div>` would be found by the build rather than by the person who
 * typed it.
 *
 * This fills the part of that gap that can be filled without a compiler: BRACKET
 * AND JSX-TAG BALANCE. It is not a parser and does not claim to be — it will not
 * catch a wrong prop name or a type error, and CI remains the real gate. It
 * catches the class of mistake an edit actually makes.
 *
 * USE:  node apps/web/scripts/check-tsx-structure.mjs $(find apps/web -name '*.tsx')
 *       (or pass files explicitly). Exits 1 and names the line if anything is
 *       unbalanced.
 *
 * IT WAS TESTED AGAINST KNOWN-BROKEN INPUT BEFORE BEING TRUSTED, and it needed
 * three fixes to get there — each one found by running it over the whole
 * codebase and reading every report rather than assuming the reports were true:
 *
 *   1. Generic type arguments. `Record<SessionPhase, string>` and
 *      `useState<VerifyState>(…)` look exactly like JSX tags to a scanner that
 *      only checks the next character is a letter, and reporting them made
 *      twelve files read as broken. A `<` after an identifier character, a
 *      closing bracket or a dot is a type argument or a comparison — except
 *      after a bare `return` on the previous line.
 *   2. Closing tags had to be exempted from that rule. `</h2>` follows JSX text
 *      ending in a full stop, so the type-argument test skipped it and every
 *      heading in the codebase desynchronised the stack.
 *   3. Fragments and comments inside attribute lists. `<>` was scanned past its
 *      own `>`, and a prose comment between two JSX props — `// the log's own
 *      cursor` — opened a phantom string at the apostrophe that ran to the next
 *      apostrophe in the file and swallowed the tag's terminator.
 *
 * After those, all 22 `.tsx` files report BALANCED and three separately injected
 * breakages (a dropped `</div>`, a dropped `}`, a stray `)`) are each caught with
 * the right line. Both halves matter: a checker that never fires proves nothing,
 * and neither does one that fires on correct code.
 *
 * WHY IT IS COMMITTED RATHER THAN KEPT IN A SCRATCH DIR. The other local
 * harnesses (`_dbg*.mjs`, `_e2e.mjs`, `_scratch/`) are gitignored because they
 * stub out packages and would mislead a reader into thinking the real thing was
 * exercised. This one has no stubs and no dependencies — it reads source text —
 * so it can be run by anyone, including CI if the frontend ever needs a gate
 * cheaper than a full build.
 */

import { readFileSync } from 'node:fs';

const BS = String.fromCharCode(92);
const isNameStart = (c) => /[A-Za-z_$]/.test(c);
const isNameChar = (c) => /[A-Za-z0-9_$.\-]/.test(c);

function scan(src) {
  const st = [];
  let i = 0;
  const n = src.length;
  const lineOf = (k) => src.slice(0, k).split('\n').length;
  const fail = (msg) => ({ ok: false, msg });

  // Index of the `>` that closed the most recent JSX tag. `<div><span/></div>` is
  // only recognised if `<span` is accepted with a `>` immediately before it,
  // which is otherwise the shape of a comparison.
  let lastTagCloseAt = -1;

  const push = (kind, name, at) => st.push({ kind, name, at });
  const pop = (kind, name, at) => {
    const open = st.pop();
    if (!open) return fail(`line ${lineOf(at)}: closing \`${name}\` with nothing open`);
    if (open.kind !== kind || open.name !== name) {
      return fail(
        `line ${lineOf(at)}: expected to close \`${open.name}\` (${open.kind}, opened line ${lineOf(open.at)}), found closing \`${name}\``,
      );
    }
    return null;
  };

  /**
   * For an OPENING `<`: a `<` directly after an identifier character, a closing
   * bracket or a dot is a type argument or a comparison, not a tag. The
   * exceptions are JSX beginning on the line after a bare `return`, and JSX
   * immediately following another JSX tag.
   */
  const isOpenTagStart = (k) => {
    if (k < 0) return true;
    if (k === lastTagCloseAt) return true;
    const prev = src[k];
    const prev2 = k >= 1 ? src[k - 1] : '';
    if (prev === '>') return prev2 === '=';
    if (!/[A-Za-z0-9_$)\].]/.test(prev)) return true;
    let w = k;
    while (w >= 0 && /[A-Za-z0-9_$]/.test(src[w])) w--;
    const word = src.slice(w + 1, k + 1);
    return word === 'return' || word === 'default';
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }

    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === BS) { i += 2; continue; }
        if (src[i] === q) break;
        i++;
      }
      i++; continue;
    }

    if (c === '`') {
      i++;
      while (i < n) {
        if (src[i] === BS) { i += 2; continue; }
        if (src[i] === '`') break;
        // Template interpolation is code, not text, and may itself contain JSX.
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2; let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          continue;
        }
        i++;
      }
      i++; continue;
    }

    if (c === '<' && (isNameStart(d) || d === '/' || d === '>')) {
      const at = i;
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;

      let j = i + 1;
      // A closing tag is unambiguous: `</` cannot begin a type argument or a
      // comparison anywhere in TypeScript. This must NOT be subjected to the
      // type-argument test — `</h2>` follows JSX text ending in a full stop.
      const closing = src[j] === '/';
      if (closing) j++;
      const fragment = src[j] === '>';
      if (!closing && !isOpenTagStart(k)) { i++; continue; }

      let name = '';
      if (fragment) { j++; } else {
        while (j < n && isNameChar(src[j])) { name += src[j]; j++; }
      }

      let closedAt = -1;
      let selfClosing = false;
      if (fragment) {
        // `<` `>` is already complete: `j` was advanced past the `>`, so there is
        // nothing left to scan for. Running the attribute scan anyway makes it
        // swallow text until the NEXT `>` in the file.
        closedAt = j - 1;
      } else {
        // Scan the rest of the tag for its terminating `>`, skipping strings and
        // comments and counting braces so `attr={a > b}` does not end it.
        let depth = 0;
        while (j < n) {
          const t = src[j];
          // Comments inside an attribute list. These must be skipped, and the
          // reason is an apostrophe: `// the log's own cursor` would otherwise
          // open a "string" that runs until the next apostrophe anywhere in the
          // file, swallowing the `>` that ends the tag.
          if (t === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue; }
          if (t === '/' && src[j + 1] === '*') {
            j += 2;
            while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
            j += 2; continue;
          }
          if (t === "'" || t === '"' || t === '`') {
            const q = t; j++;
            while (j < n) {
              if (src[j] === BS) { j += 2; continue; }
              if (src[j] === q) break;
              j++;
            }
            j++; continue;
          }
          if (t === '{') { depth++; j++; continue; }
          if (t === '}') { depth--; j++; continue; }
          if (t === '>' && depth === 0) {
            selfClosing = src[j - 1] === '/';
            closedAt = j;
            break;
          }
          j++;
        }
      }
      if (closedAt === -1) return fail(`line ${lineOf(at)}: tag \`<${name}\` is never closed with '>'`);

      const key = fragment ? '<>' : name;
      if (closing) {
        const bad = pop('tag', key, at);
        if (bad) return bad;
      } else if (!selfClosing) {
        push('tag', key, at);
      }
      lastTagCloseAt = closedAt;
      i = closedAt + 1;
      continue;
    }

    if (c === '{' || c === '(' || c === '[') { push('bracket', c, i); i++; continue; }
    if (c === '}' || c === ')' || c === ']') {
      const want = c === '}' ? '{' : c === ')' ? '(' : '[';
      const open = st.pop();
      if (!open) return fail(`line ${lineOf(i)}: '${c}' with nothing open`);
      if (open.name !== want) {
        const closeOf = open.name === '{' ? '}' : open.name === '(' ? ')' : ']';
        return fail(
          `line ${lineOf(i)}: expected '${closeOf}' to close the '${open.name}' opened at line ${lineOf(open.at)}, found '${c}'`,
        );
      }
      i++; continue;
    }

    i++;
  }

  if (st.length) {
    const o = st[st.length - 1];
    const what = o.kind === 'tag' ? 'JSX tag' : 'bracket';
    return fail(`unclosed ${what} \`${o.name}\` opened at line ${lineOf(o.at)}`);
  }
  return { ok: true, msg: 'BALANCED' };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node apps/web/scripts/check-tsx-structure.mjs <file.tsx> [more.tsx ...]');
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  const r = scan(readFileSync(f, 'utf8'));
  if (!r.ok) bad++;
  console.log(`${r.ok ? 'BALANCED' : 'BROKEN  '}  ${f}`);
  if (!r.ok) console.log(`          ${r.msg}`);
}
console.log(
  `\n${files.length - bad}/${files.length} balanced. This checks bracket and tag nesting only — ` +
    `it is not a type-check, and CI is still the gate that catches prop and type errors.`,
);
process.exit(bad === 0 ? 0 : 1);
