// Cross-check every element the client looks up against the markup that has to
// provide it.
//
// A missing id is not a crash — `getElementById` returns null and the failure surfaces
// later as a dead slider or a `Cannot read properties of null`, in whichever handler
// happens to fire first. Neither `node --check` nor `vite build` can see it, because
// both of them only ever look at the JavaScript. This is the cheapest thing that can.
//
//   npm run ids        (also runs first as part of `npm run verify`)

import { readFileSync, readdirSync } from 'node:fs';

const markup = Object.fromEntries(['index', 'review'].map((page) => {
  const html = readFileSync(`client/${page}.html`, 'utf8');
  return [page, {
    ids: new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])),
    dataAttrs: new Set([...html.matchAll(/\bdata-([a-z-]+)=/g)].map((m) => m[1])),
    classes: new Set(
      [...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
    ),
  }];
}));

const problems = [];
const checked = [];

for (const file of readdirSync('client/src').filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(`client/src/${file}`, 'utf8');
  const page = file === 'review.js' ? markup.review : markup.index;
  const wanted = new Set(
    [...src.matchAll(/(?:getElementById|\$)\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
  );
  for (const id of wanted) {
    checked.push(id);
    if (!page.ids.has(id)) problems.push(`${file} looks up #${id}, which its markup does not define`);
  }

  // The selectors and dataset keys the panel drives its groups with. A typo here is
  // the same class of silent nothing as a missing id.
  for (const [, sel] of src.matchAll(/querySelectorAll\(\s*'\.([a-z-]+)'\s*\)/g)) {
    checked.push(`.${sel}`);
    if (!page.classes.has(sel)) problems.push(`${file} queries .${sel}, which nothing in its markup wears`);
  }
  // A dataset key only has to be in the markup if nothing in JS writes it: `hud.js`
  // builds its own slot nodes and stamps `data-wep` on them, so the static document
  // is right not to carry one.
  const written = new Set([...src.matchAll(/dataset\.([a-zA-Z]+)\s*=/g)].map((m) => m[1]));
  for (const [, key] of src.matchAll(/dataset\.([a-zA-Z]+)/g)) {
    if (written.has(key)) continue;
    const attr = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    checked.push(`data-${attr}`);
    if (!page.dataAttrs.has(attr)) problems.push(`${file} reads dataset.${key}, but no data-${attr} exists`);
  }
}

const markupIdCount = markup.index.ids.size + markup.review.ids.size;
console.log(`${new Set(checked).size} distinct lookups checked against ${markupIdCount} ids across both pages`);
if (problems.length) {
  for (const p of problems) console.log(`FAIL  ${p}`);
  process.exit(1);
}
console.log('ALL PASS — every lookup resolves');
