// EnvSync landing page. Plain DOM + SVG, no dependencies, no network requests.
// All CLI output shown on this page was captured from the repository's test fixtures.

const SVG_NS = "http://www.w3.org/2000/svg";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  if (parent) parent.appendChild(node);
  return node;
}

function html(tag, className, text, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Copy buttons                                                        */
/* ------------------------------------------------------------------ */

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
    } catch {
      return;
    }
    const hint = button.querySelector(".copy-hint") ?? button;
    const previous = hint.textContent;
    button.classList.add("copied");
    hint.textContent = "copied";
    setTimeout(() => {
      button.classList.remove("copied");
      hint.textContent = previous;
    }, 1600);
  });
}

/* ------------------------------------------------------------------ */
/* Cipher: stand-in glyphs for values EnvSync never reads              */
/* ------------------------------------------------------------------ */

const CIPHER = "░▒▓█▚▞▙▟";
const cipherNodes = [...document.querySelectorAll(".cipher")];
function scramble() {
  for (const node of cipherNodes) {
    let text = "";
    for (let i = 0; i < Number(node.dataset.len); i++) text += CIPHER[Math.floor(Math.random() * CIPHER.length)];
    node.textContent = text;
  }
}
scramble();
if (!reducedMotion) setInterval(scramble, 140);

/* ------------------------------------------------------------------ */
/* Boundary figure: lock glyphs in capsules                            */
/* ------------------------------------------------------------------ */

// Capsule labels starting with a lock get a drawn padlock instead of an emoji.
for (const text of document.querySelectorAll(".border .cap-text")) {
  if (!text.textContent.startsWith("🔒")) continue;
  text.textContent = text.textContent.replace("🔒 ", "");
  const x = Number(text.getAttribute("x"));
  text.setAttribute("x", String(x + 20));
  const lock = svg("g", { transform: `translate(${x} -7)` });
  svg("path", { d: "M3 6 V4 a3 3 0 0 1 6 0 V6", class: "lk-shackle" }, lock);
  svg("rect", { x: 1, y: 6, width: 10, height: 8, rx: 2, class: "lk-body" }, lock);
  text.parentNode.insertBefore(lock, text);
}

/* ------------------------------------------------------------------ */
/* The loom: source → contract → .env.example, scanned row by row      */
/* ------------------------------------------------------------------ */

// present: which files contain the variable before any fix. finding: what the first scan reports.
// fix: which cells get filled, and by whom, before the second scan.
const LOOM_ROWS = [
  { name: "DATABASE_URL", loc: "lib/db.ts:4", cfg: "{ secret: true }", present: [1, 1, 1] },
  { name: "NEXT_PUBLIC_SITE_URL", loc: "app/layout.tsx:9", cfg: '{ type: "url" }', present: [1, 1, 1] },
  {
    name: "STRIPE_KEY", loc: "app/api/pay/route.ts:7", cfg: "{ secret: true }", present: [1, 1, 0],
    finding: { col: 2, code: "ENV002", sev: "error", label: "no placeholder" },
    fix: { 2: "init" },
  },
  {
    name: "SENTRY_DSN", loc: "lib/sentry.ts:2", cfg: "{ required: false }", present: [1, 0, 0],
    finding: { col: 1, code: "ENV001", sev: "error", label: "undeclared" },
    fix: { 1: "you", 2: "init" },
  },
  {
    name: "LEGACY_FLAG", loc: "", cfg: "{ required: false }", present: [0, 1, 1],
    finding: { col: 0, code: "ENV003", sev: "warning", label: "never read" },
    remove: true,
  },
];

const COLUMNS = [
  { head: "src/**/*.tsx", sub: "reads" },
  { head: "envsync.config.ts", sub: "declares" },
  { head: ".env.example", sub: "documents" },
];

function loomLayout(width) {
  if (width >= 760) {
    return {
      wide: true, W: 1000, top: 108, rowH: 66, chipH: 46,
      cols: [{ x: 36, w: 290 }, { x: 386, w: 250 }, { x: 696, w: 268 }],
    };
  }
  return { wide: false, W: 360, top: 92, rowH: 72, chipH: 20, cols: [{ x: 60 }, { x: 180 }, { x: 300 }] };
}

function buildLoom(container, L) {
  container.textContent = "";
  const H = L.top + LOOM_ROWS.length * L.rowH + (L.wide ? 84 : 100);
  const root = svg("svg", { viewBox: `0 0 ${L.W} ${H}`, "aria-hidden": "true" }, container);
  const defs = svg("defs", {}, root);
  const grad = svg("linearGradient", { id: "lm-beam-grad", x1: "0", x2: "0", y1: "0", y2: "1" }, defs);
  svg("stop", { offset: "0", class: "lm-beam-stop-a" }, grad);
  svg("stop", { offset: "0.85", class: "lm-beam-stop-b" }, grad);
  svg("stop", { offset: "1", class: "lm-beam-stop-a" }, grad);

  const center = (c) => (L.wide ? L.cols[c].x + L.cols[c].w / 2 : L.cols[c].x);

  // Column heads with little file glyphs, and dashed rails beneath them.
  COLUMNS.forEach((col, c) => {
    const cx = center(c);
    const g = svg("g", {}, root);
    if (L.wide) {
      const fx = cx - 9;
      svg("path", { d: `M${fx} 26 h12 l6 6 v18 h-18z`, class: "lm-file" }, g);
      svg("path", { d: `M${fx + 12} 26 v6 h6z`, class: "lm-file-fold" }, g);
      svg("text", { x: cx, y: 70, "text-anchor": "middle", class: "lm-col-head", text: col.head }, g);
      svg("text", { x: cx, y: 88, "text-anchor": "middle", class: "lm-col-sub", text: col.sub }, g);
    } else {
      svg("text", { x: cx, y: 34, "text-anchor": "middle", class: "lm-col-head", text: ["source", "config", "example"][c] }, g);
      svg("text", { x: cx, y: 52, "text-anchor": "middle", class: "lm-col-sub", text: col.sub }, g);
    }
    svg("line", { x1: cx, x2: cx, y1: L.top - 6, y2: L.top + LOOM_ROWS.length * L.rowH - 10, class: "lm-rail" }, root);
  });

  const threadLayer = svg("g", {}, root);
  const chipLayer = svg("g", {}, root);

  const beam = svg("g", { class: "lm-beam" }, root);
  svg("rect", { x: 0, y: -L.rowH, width: L.W, height: L.rowH, class: "lm-beam-band" }, beam);
  svg("line", { x1: 0, x2: L.W, y1: 0, y2: 0, class: "lm-beam-line" }, beam);

  const rows = LOOM_ROWS.map((row, r) => {
    const y = L.top + r * L.rowH; // top of the row
    const mid = y + (L.wide ? L.chipH / 2 : 34);
    const cells = [0, 1, 2].map((c) => {
      const chip = svg("g", { class: "lm-chip" }, chipLayer);
      let left, right;
      if (L.wide) {
        const { x, w } = L.cols[c];
        svg("rect", { x, y, width: w, height: L.chipH, rx: 9 }, chip);
        const t1 = svg("text", { x: x + 14, y: y + 20 }, chip);
        const t2 = svg("text", { x: x + 14, y: y + 37, class: "lm-p" }, chip);
        if (c === 0) {
          svg("tspan", { class: "lm-p", text: "process.env." }, t1);
          svg("tspan", { class: "lm-k", text: row.name }, t1);
          t2.textContent = row.loc || "no reference found";
        } else if (c === 1) {
          svg("tspan", { class: "lm-k", text: `${row.name}:` }, t1);
          t2.textContent = row.cfg;
        } else {
          svg("tspan", { class: "lm-k", text: `${row.name}=` }, t1);
          t2.textContent = "placeholder, no value";
        }
        left = x; right = x + w;
      } else {
        const x = L.cols[c].x;
        svg("circle", { cx: x, cy: mid, r: 9, class: "lm-node idle" }, chip);
        left = x - 9; right = x + 9;
      }

      // Ghost: what should be here, outlined, with the diagnostic code.
      let ghost = null;
      if (row.finding && row.finding.col === c) {
        ghost = svg("g", { class: `lm-ghost sev-${row.finding.sev}` }, chipLayer);
        if (L.wide) {
          const { x, w } = L.cols[c];
          svg("rect", { x, y, width: w, height: L.chipH, rx: 9 }, ghost);
          svg("text", { x: x + 14, y: y + 28, text: `${row.finding.code} · ${row.finding.label}` }, ghost);
        } else {
          svg("circle", { cx: L.cols[c].x, cy: mid, r: 9, class: "" }, ghost).setAttribute("fill", "none");
          ghost.firstChild.setAttribute("stroke-dasharray", "3 3");
          ghost.firstChild.setAttribute("stroke-width", "1.6");
          ghost.firstChild.setAttribute("stroke", row.finding.sev === "error" ? "#ff6a55" : "#ffb547");
          svg("text", { x: L.cols[c].x, y: mid + 26, "text-anchor": "middle", text: row.finding.code }, ghost);
        }
      }
      return { chip, ghost, left, right };
    });

    // Name label (narrow layout only; the wide chips carry the name).
    let nameEl = null;
    if (!L.wide) {
      nameEl = svg("text", { x: 20, y: y + 12, class: "lm-name", text: row.name }, chipLayer);
    }

    // Two thread segments: source→config, config→example. Oriented from the side that exists,
    // so a broken thread grows out of the file that has the variable and stops short of the gap.
    const segs = [0, 1].map((s) => {
      const a = cells[s], b = cells[s + 1];
      const fromRight = !(row.present[s] === 0 && row.present[s + 1] === 1);
      const x1 = fromRight ? a.right : b.left;
      const x2 = fromRight ? b.left : a.right;
      const dx = x2 - x1;
      const wobble = L.wide ? 7 : 5;
      const d = `M${x1} ${mid} C ${x1 + dx * 0.35} ${mid - wobble}, ${x1 + dx * 0.65} ${mid + wobble}, ${x2} ${mid}`;
      const path = svg("path", { d, class: "lm-thread" }, threadLayer);
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len}`;
      path.style.strokeDashoffset = `${len}`;
      return { path, len };
    });

    return { row, y, mid, cells, segs, nameEl };
  });

  // Console line at the bottom.
  const cy = L.top + LOOM_ROWS.length * L.rowH + (L.wide ? 14 : 10);
  const cons = svg("g", { class: "lm-console" }, root);
  const pad = L.wide ? 36 : 14;
  // Wide: command left, result right. Narrow: result on a second line.
  svg("rect", { x: pad, y: cy, width: L.W - pad * 2, height: L.wide ? 46 : 66, rx: 10 }, cons);
  const cmd = svg("text", { x: pad + 16, y: cy + 28 }, cons);
  const dollar = svg("tspan", { class: "lm-dollar", text: "$ " }, cmd);
  const cmdText = svg("tspan", { text: "" }, cmd);
  const caret = svg("rect", { x: pad + 34, y: cy + 15, width: 8, height: 16, class: "lm-caret" }, cons);
  const result = L.wide
    ? svg("text", { x: L.W - pad - 18, y: cy + 28, "text-anchor": "end", class: "lm-res" }, cons)
    : svg("text", { x: pad + 16, y: cy + 50, class: "lm-res" }, cons);

  const setCaret = () => {
    const box = cmd.getBBox();
    caret.setAttribute("x", String(box.x + box.width + 4));
  };

  return { root, rows, beam, cons: { dollar, cmdText, result, setCaret }, L };
}

function setSeg(seg, state, fraction = 1) {
  seg.path.classList.remove("ok", "broken", "warn", "dim");
  if (state) seg.path.classList.add(state);
  seg.path.style.strokeDashoffset = `${seg.len * (1 - fraction)}`;
}

function setNode(cell, state, L) {
  if (L.wide) {
    cell.chip.classList.toggle("ok", state === "ok");
  } else {
    const node = cell.chip.querySelector("circle");
    node.setAttribute("class", `lm-node ${state}`);
  }
}

function startLoom() {
  const container = document.getElementById("loom");
  if (!container) return;

  let generation = 0;
  let visible = true;
  let currentWide = null;
  let view = null;

  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
  });
  observer.observe(container);

  // Every wait checks that this run is still current and that the figure is on screen.
  const wait = async (gen, ms) => {
    await sleep(ms);
    while (visible === false && gen === generation) await sleep(250);
    if (gen !== generation) throw new Error("stale");
  };

  async function type(gen, text) {
    view.cons.cmdText.textContent = "";
    view.cons.result.textContent = "";
    for (const ch of text) {
      view.cons.cmdText.textContent += ch;
      view.cons.setCaret();
      await wait(gen, 34);
    }
  }

  function result(text, kind) {
    view.cons.result.textContent = text;
    view.cons.result.setAttribute("class", `lm-res ${kind}`);
  }

  function moveBeam(r) {
    const { L } = view;
    const y = L.top + r * L.rowH + L.rowH - 6;
    view.beam.style.transform = `translateY(${y}px)`;
  }

  function showCells() {
    for (const { row, cells, nameEl } of view.rows) {
      cells.forEach((cell, c) => row.present[c] && cell.chip.classList.add("on"));
      nameEl?.classList.add("on");
    }
  }

  function firstScanRow(entry) {
    const { row, cells, segs } = entry;
    segs.forEach((seg, s) => {
      const a = row.present[s], b = row.present[s + 1];
      if (a && b) setSeg(seg, "ok");
      else if (a || b) setSeg(seg, row.finding?.sev === "warning" ? "warn" : "broken", 0.55);
    });
    const nodeState = row.finding ? (row.finding.sev === "warning" ? "warn" : "err") : "ok";
    cells.forEach((cell, c) => row.present[c] && setNode(cell, nodeState, view.L));
    if (row.finding) cells[row.finding.col].ghost?.classList.add("on");
  }

  function showFindings() {
    showCells();
    view.rows.forEach(firstScanRow);
    view.cons.cmdText.textContent = "envsync scan";
    view.cons.setCaret();
    result("✗ 2 errors · 1 warning · exit 1", "err");
  }

  async function run(gen) {
    const { rows } = view;
    await wait(gen, 400);

    // 1. The three files, column by column.
    for (let c = 0; c < 3; c++) {
      for (const { row, cells, nameEl } of rows) {
        if (row.present[c]) cells[c].chip.classList.add("on");
        if (c === 0) nameEl?.classList.add("on");
        await wait(gen, 70);
      }
      await wait(gen, 220);
    }

    // 2. First scan: the beam passes each row and threads what it can.
    await type(gen, "envsync scan");
    await wait(gen, 300);
    view.beam.classList.add("on");
    for (let r = 0; r < rows.length; r++) {
      moveBeam(r);
      await wait(gen, 420);
      firstScanRow(rows[r]);
      await wait(gen, 380);
    }
    view.beam.classList.remove("on");
    result("✗ 2 errors · 1 warning · exit 1", "err");
    await wait(gen, 2600);

    // 3. You edit the contract: declare SENTRY_DSN, drop LEGACY_FLAG.
    await type(gen, "vim envsync.config.ts");
    await wait(gen, 400);
    for (const entry of rows) {
      const { row, cells, segs, nameEl } = entry;
      if (row.remove) {
        cells.forEach((cell) => { cell.chip.classList.add("gone"); cell.ghost?.classList.remove("on"); });
        segs.forEach((seg) => seg.path.classList.add("dim"));
        nameEl?.classList.remove("on");
      }
      if (row.fix) {
        for (const [col, who] of Object.entries(row.fix)) {
          if (who !== "you") continue;
          cells[col].ghost?.classList.remove("on");
          cells[col].chip.classList.add("on", "fixed");
          setNode(cells[col], "ok", view.L);
        }
      }
    }
    result("declared 1 · removed 1", "note");
    await wait(gen, 1600);

    // 4. init --write appends placeholders for declared variables missing from .env.example.
    await type(gen, "envsync init --write");
    await wait(gen, 400);
    for (const { row, cells } of rows) {
      if (!row.fix) continue;
      for (const [col, who] of Object.entries(row.fix)) {
        if (who !== "init") continue;
        cells[col].ghost?.classList.remove("on");
        cells[col].chip.classList.add("on", "fixed");
        setNode(cells[col], "ok", view.L);
        await wait(gen, 260);
      }
    }
    result("appended 2 placeholders", "note");
    await wait(gen, 1600);

    // 5. Second scan: every remaining thread connects.
    await type(gen, "envsync scan");
    await wait(gen, 300);
    view.beam.classList.add("on");
    for (let r = 0; r < rows.length; r++) {
      moveBeam(r);
      await wait(gen, 300);
      const { row, cells, segs } = rows[r];
      if (!row.remove) {
        segs.forEach((seg) => setSeg(seg, "ok"));
        cells.forEach((cell) => setNode(cell, "ok", view.L));
      }
      await wait(gen, 220);
    }
    view.beam.classList.remove("on");
    result("✓ in sync · exit 0", "ok");
    await wait(gen, 4200);
  }

  async function loop() {
    const gen = ++generation;
    const wide = container.clientWidth >= 760;
    currentWide = wide;
    view = buildLoom(container, loomLayout(container.clientWidth));
    if (reducedMotion) {
      showFindings();
      return;
    }
    try {
      for (;;) {
        await run(gen);
        view = buildLoom(container, loomLayout(container.clientWidth));
      }
    } catch {
      // A newer run took over (resize); this one just stops.
    }
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if ((container.clientWidth >= 760) !== currentWide) loop();
    }, 200);
  });

  loop();
}

startLoom();

/* ------------------------------------------------------------------ */
/* Periodic table of diagnostics                                        */
/* ------------------------------------------------------------------ */

const DIAGNOSTICS = [
  {
    code: "ENV001", sym: "Ud", name: "Undeclared reference", sevs: ["error"],
    desc: "Your code reads a variable the contract doesn't declare. Reported once per name, at the first location, with a count of the others.",
    out: [
      "ENV001 error pages/api/data.ts:5:17 - MISSING_IN_CONFIG is referenced but not declared in envsync.config.ts. It is also referenced in 1 other place.",
      "  Suggestion: Add MISSING_IN_CONFIG under `variables` in envsync.config.ts, or remove the reference if it is a mistake.",
    ],
  },
  {
    code: "ENV002", sym: "Mp", name: "Missing placeholder", sevs: ["error"],
    desc: "A required variable has no line in .env.example, so the next person to clone the repo won't know to set it.",
    out: [
      "ENV002 error envsync.config.ts:4:5 - STRIPE_KEY is required by envsync.config.ts but absent from .env.example.",
      "  Suggestion: Add a placeholder line `STRIPE_KEY=` to .env.example. Do not copy a real value.",
    ],
  },
  {
    code: "ENV003", sym: "Un", name: "Possibly unused", sevs: ["warning", "info"],
    desc: "Declared, but nothing reads it statically. It drops to info when dynamic access might read it. Mark variables read by your host or tooling with external: true.",
    out: [
      "ENV003 info envsync.config.ts:6:5 - UNUSED_FLAG is declared but no static reference to it was found. It may be unused, or read by Next.js, a dependency, or the hosting platform. The project also has 1 dynamic process.env access that may read it, so this is less certain.",
      "  Suggestion: Remove the declaration if it is no longer used. If something outside the scanned source reads it, add `external: true`.",
    ],
  },
  {
    code: "ENV004", sym: "Iv", name: "Invalid definition", sevs: ["error"],
    desc: "The contract has something EnvSync would have to execute to understand, such as a spread or a call, or an invalid name or type. Config is data, never code.",
    out: [
      "ENV004 error envsync.config.ts:9:5 - Spread entries in `variables` are not supported because EnvSync never evaluates config code.",
      "  Suggestion: Declare each variable explicitly as a property with an object literal value.",
      "ENV004 error envsync.config.ts:10:5 - `lower-case` is not a valid environment variable name.",
      "  Suggestion: Use letters, digits and underscores only, not starting with a digit (for example `API_URL`).",
    ],
  },
  {
    code: "ENV005", sym: "Ex", name: "Client exposure", sevs: ["error", "warning"],
    desc: "Error: a variable declared secret reaches client JavaScript. Warning: a public name looks secret (TOKEN, SECRET, PASSWORD…). Values are never inspected.",
    out: [
      "ENV005 error next.config.js:3:5 - STRIPE_KEY is declared `secret: true` in envsync.config.ts, but next.config.js lists it under `env`, which Next.js inlines into client-side JavaScript.",
      "  Suggestion: Remove STRIPE_KEY from `env` in next.config.js and read it only in server code.",
    ],
  },
  {
    code: "ENV006", sym: "Dy", name: "Dynamic access", sevs: ["info"],
    desc: "process.env[key] can't be resolved without running code. EnvSync tells you what it can't see instead of guessing.",
    out: [
      "ENV006 info pages/api/data.ts:3:17 - Dynamic process.env access cannot be fully analyzed; variables read here are not checked.",
      "  Suggestion: Read each variable with a literal name, such as process.env.NAME or process.env[\"NAME\"].",
    ],
  },
  {
    code: "ENV007", sym: "Du", name: "Duplicate / conflict", sevs: ["error", "warning"],
    desc: "Declared twice, listed twice, or two names that differ only by case, which collide on Windows.",
    out: [
      "ENV007 warning .env.example:3 - NEXT_PUBLIC_API_URL appears more than once in .env.example (first on line 1).",
      "  Suggestion: Remove the repeated entry so the example has one placeholder per variable.",
    ],
  },
];

const DIAG_LINE = /^(ENV\d{3}) (error|warning|info) (\S+) - (.*)$/;

// Renders one line of real scan output with severity colouring. Text only, never HTML.
function renderScanLine(line, parent) {
  const match = DIAG_LINE.exec(line);
  if (match) {
    html("span", "t-code", match[1], parent);
    parent.append(" ");
    html("span", `t-${match[2]}`, match[2], parent);
    parent.append(" ");
    html("span", "t-loc", match[3], parent);
    parent.append(` - ${match[4]}`);
  } else if (line.startsWith("  Suggestion:")) {
    html("span", "t-sugg", line, parent);
  } else {
    parent.append(line);
  }
  parent.append("\n");
}

function startTable() {
  const grid = document.getElementById("ptable");
  const detail = document.getElementById("ptable-detail");
  if (!grid || !detail) return;

  const tiles = DIAGNOSTICS.map((d, i) => {
    const tile = html("button", "el", undefined, grid);
    tile.type = "button";
    tile.setAttribute("role", "tab");
    tile.id = `el-${d.code}`;
    tile.setAttribute("aria-controls", "ptable-detail");
    const num = html("span", "el-num", undefined, tile);
    html("span", "", d.code.slice(3), num);
    const sev = html("span", "el-sev", undefined, num);
    for (const s of d.sevs) html("i", `s-${s}`, undefined, sev);
    html("span", "el-sym", d.sym, tile);
    html("span", "el-name", d.name, tile);
    tile.addEventListener("click", () => select(i));
    tile.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = (i + step + DIAGNOSTICS.length) % DIAGNOSTICS.length;
      select(next);
      tiles[next].focus();
    });
    return tile;
  });

  const legend = html("div", "el legend", undefined, grid);
  legend.setAttribute("aria-hidden", "true");
  for (const [s, label] of [["error", "error"], ["warning", "warning"], ["info", "info"]]) {
    const row = html("span", "legend-row", undefined, legend);
    html("i", `s-${s}`, undefined, row);
    row.append(label);
  }

  function select(index) {
    const d = DIAGNOSTICS[index];
    tiles.forEach((tile, i) => {
      tile.setAttribute("aria-selected", String(i === index));
      tile.tabIndex = i === index ? 0 : -1;
    });
    detail.setAttribute("aria-labelledby", tiles[index].id);
    detail.textContent = "";
    html("p", "pd-code", d.code, detail);
    html("h3", "pd-title", d.name, detail);
    html("p", "pd-desc", d.desc, detail);
    const sevs = html("ul", "pd-sevs", undefined, detail);
    for (const s of d.sevs) html("li", `s-${s}`, s, sevs);
    const out = html("pre", "pd-out", undefined, detail);
    for (const line of d.out) renderScanLine(line, out);
  }

  select(4);
}

startTable();

/* ------------------------------------------------------------------ */
/* Terminal replay                                                     */
/* ------------------------------------------------------------------ */

const SESSIONS = [
  {
    tab: "scan",
    note: "# tests/fixtures/next-pages-router",
    cmd: "envsync scan",
    kind: "scan",
    out: [
      "ENV007 warning .env.example:3 - NEXT_PUBLIC_API_URL appears more than once in .env.example (first on line 1).",
      "  Suggestion: Remove the repeated entry so the example has one placeholder per variable.",
      "ENV002 error envsync.config.ts:4:5 - STRIPE_KEY is required by envsync.config.ts but absent from .env.example.",
      "  Suggestion: Add a placeholder line `STRIPE_KEY=` to .env.example. Do not copy a real value.",
      "ENV005 error envsync.config.ts:5:5 - NEXT_PUBLIC_ADMIN_SECRET is declared `secret: true` in envsync.config.ts, but the NEXT_PUBLIC_ prefix makes Next.js include its value in client-side JavaScript.",
      "  Suggestion: Rename it without NEXT_PUBLIC_ and read it only in server code, or set `secret: false` if the value is safe to publish.",
      "ENV005 error next.config.js:3:5 - STRIPE_KEY is declared `secret: true` in envsync.config.ts, but next.config.js lists it under `env`, which Next.js inlines into client-side JavaScript.",
      "  Suggestion: Remove STRIPE_KEY from `env` in next.config.js and read it only in server code.",
      "ENV006 info pages/api/data.ts:3:17 - Dynamic process.env access cannot be fully analyzed; variables read here are not checked.",
      "  Suggestion: Read each variable with a literal name, such as process.env.NAME or process.env[\"NAME\"].",
      "ENV001 error pages/api/data.ts:5:17 - MISSING_IN_CONFIG is referenced but not declared in envsync.config.ts. It is also referenced in 1 other place.",
      "  Suggestion: Add MISSING_IN_CONFIG under `variables` in envsync.config.ts, or remove the reference if it is a mistake.",
      "",
      "Found 4 errors, 1 warning and 2 info in 3 files.",
      "Dynamic process.env access in 1 place (ENV006): variables read there were not checked.",
    ],
    exit: 1,
  },
  {
    tab: "scan · healthy",
    note: "# tests/fixtures/next-app-router",
    cmd: "envsync scan",
    kind: "scan",
    out: ["No issues found in 4 files."],
    exit: 0,
  },
  {
    tab: "--format json",
    note: "# tests/fixtures/next-pages-router (first diagnostic shown)",
    cmd: "envsync scan --format json",
    kind: "json",
    out: [
      "{",
      '  "schemaVersion": 1,',
      '  "summary": {',
      '    "errors": 4,',
      '    "warnings": 1,',
      '    "infos": 2,',
      '    "filesScanned": 3,',
      '    "complete": true,',
      '    "dynamicAccesses": 1,',
      '    "strict": false,',
      '    "exitCode": 1',
      "  },",
      '  "diagnostics": [',
      "    {",
      '      "code": "ENV007",',
      '      "severity": "warning",',
      '      "message": "NEXT_PUBLIC_API_URL appears more than once in .env.example (first on line 1).",',
      '      "file": ".env.example",',
      '      "line": 3,',
      '      "variableName": "NEXT_PUBLIC_API_URL",',
      '      "suggestion": "Remove the repeated entry so the example has one placeholder per variable."',
      "    },",
      "    …",
    ],
    exit: 1,
  },
  {
    tab: "init",
    note: "# tests/fixtures/next-pages-router",
    cmd: "envsync init",
    kind: "init",
    out: [
      "EnvSync init preview (no files were written)",
      "",
      "Unchanged envsync.config.ts: already exists. EnvSync never rewrites it; edit it by hand and use `envsync scan` to check it.",
      "",
      "Append 2 entries to .env.example (existing lines are kept as they are):",
      "  | # Added by `envsync init`",
      "  | STRIPE_KEY=",
      "  | UNUSED_FLAG=",
      "",
      "Note: 1 dynamic process.env access could not be resolved to names; declare those variables by hand.",
      "Run `envsync init --write` to apply these changes. Files are checked again when writing.",
    ],
    exit: 0,
  },
  {
    tab: "doctor",
    note: "# tests/fixtures/next-app-router",
    cmd: "envsync doctor",
    kind: "doctor",
    out: [
      "PASS     node-version: Node.js 25.1.0 meets the requirement (>= 22.12.0).",
      "PASS     source-files: Found 4 source files to scan.",
      "PASS     package-json: package.json is present and valid JSON.",
      "PASS     framework: Next.js (`next`) is a dependency in package.json.",
      "PASS     config: envsync.config.ts declares 4 variables.",
      "PASS     env-example: .env.example lists 3 variables.",
      "PASS     env-files-ignored: No local env files found, and .env.local would be ignored by git.",
      "",
      "Doctor: 0 failures, 0 warnings, 7 passed.",
    ],
    exit: 0,
  },
];

function renderLine(kind, line, parent) {
  if (kind === "scan") return renderScanLine(line, parent);
  if (kind === "doctor") {
    const match = /^(PASS|WARN|FAIL|UNKNOWN|SKIP)(\s+)(.*)$/.exec(line);
    if (match) {
      html("span", `t-${match[1].toLowerCase()}`, match[1], parent);
      parent.append(match[2] + match[3]);
    } else {
      parent.append(line);
    }
  } else if (kind === "json") {
    const match = /^(\s*)("[^"]+")(: )(.*)$/.exec(line);
    if (match) {
      parent.append(match[1]);
      html("span", "t-json-k", match[2], parent);
      parent.append(match[3]);
      const value = match[4];
      const cls = value.startsWith('"') ? "t-json-s" : /^[\d-]/.test(value) ? "t-json-n" : "";
      if (cls) html("span", cls, value.replace(/,$/, ""), parent);
      else parent.append(value.replace(/,$/, ""));
      if (value.endsWith(",")) parent.append(",");
    } else {
      parent.append(line);
    }
  } else if (kind === "init" && line.startsWith("  |")) {
    html("span", "t-sugg", line, parent);
  } else {
    parent.append(line);
  }
  parent.append("\n");
}

function startTerminal() {
  const tabs = document.getElementById("term-tabs");
  const body = document.getElementById("term-body");
  if (!tabs || !body) return;

  let generation = 0;
  const buttons = SESSIONS.map((session, i) => {
    const button = html("button", "term-tab", session.tab, tabs);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => play(i));
    return button;
  });

  function writePrompt(session) {
    html("span", "t-dim", `${session.note}\n`, body);
    html("span", "t-dollar", "$ ", body);
    return html("span", "t-cmd", "", body);
  }

  function writeExit(session) {
    body.append("\n");
    html("span", "t-dim", "exit ", body);
    html("span", session.exit === 0 ? "t-pass" : "t-error", String(session.exit), body);
    body.append("\n");
    html("span", "t-dollar", "$ ", body);
    html("span", "term-cursor", "", body);
  }

  async function play(index) {
    const gen = ++generation;
    const session = SESSIONS[index];
    buttons.forEach((button, i) => button.setAttribute("aria-selected", String(i === index)));
    body.textContent = "";
    const cmd = writePrompt(session);

    if (reducedMotion) {
      cmd.textContent = session.cmd;
      body.append("\n");
      for (const line of session.out) renderLine(session.kind, line, body);
      writeExit(session);
      return;
    }

    for (const ch of session.cmd) {
      cmd.textContent += ch;
      await sleep(38);
      if (gen !== generation) return;
    }
    body.append("\n");
    await sleep(260);
    for (const line of session.out) {
      renderLine(session.kind, line, body);
      await sleep(line.startsWith("  ") ? 30 : 90);
      if (gen !== generation) return;
    }
    writeExit(session);
  }

  // Start the first replay when the terminal scrolls into view.
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      observer.disconnect();
      play(0);
    }
  }, { threshold: 0.3 });
  observer.observe(body);
  buttons.forEach((button, i) => button.setAttribute("aria-selected", String(i === 0)));
}

startTerminal();
