// File tabs: a project file read from the VM, with its line numbers and its syntax in
// the theme's colors; Markdown also shown as a page.

// ============================================================================
// Viewer: one file of a project, read only
// ============================================================================

/** Opens (or shows) a project file next to the main terminal. */
function openFile(rel, project) {
  const open = workspace.tabs().find((t) => t.kind === "file" && t.params.rel === rel && t.params.project === project);
  if (open) {
    workspace.show(open);
    open.reload();
    return;
  }
  workspace.add("file", workspace.find("main")?.dock || "center", { params: { rel, project } });
}

const VIEW_HIGHLIGHT_MAX = 400 * 1024; // past this, plain text: coloring would freeze the page

// --- languages -------------------------------------------------------------

const KEYWORDS = {
  py: "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield self",
  js: "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield",
  rs: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
  sh: "if then else elif fi for while until do done case esac in function return local export set unset readonly shift exit echo",
  css: "important inherit initial unset none auto",
  toml: "true false",
  sql: "select from where insert into update delete create table drop alter join left right inner outer on group by order having limit and or not null as values set index primary key",
};
const LANGS = {
  py: { kw: KEYWORDS.py, line: "#", triple: true },
  js: { kw: KEYWORDS.js, line: "//", block: true, backtick: true },
  rs: { kw: KEYWORDS.rs, line: "//", block: true },
  go: { kw: KEYWORDS.go, line: "//", block: true, backtick: true },
  c: { kw: "auto break case char const continue default do double else enum extern float for goto if int long return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected namespace template new delete true false nullptr", line: "//", block: true },
  sh: { kw: KEYWORDS.sh, line: "#" },
  css: { kw: KEYWORDS.css, block: true },
  toml: { kw: KEYWORDS.toml, line: "#" },
  yaml: { kw: "true false null yes no", line: "#" },
  json: { kw: "true false null" },
  sql: { kw: KEYWORDS.sql, line: "--", block: true, nocase: true },
};
const EXTENSIONS = {
  py: "py", pyi: "py", js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js",
  rs: "rs", go: "go", c: "c", h: "c", cpp: "c", hpp: "c", cc: "c", java: "c", kt: "c", swift: "c", cs: "c",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh", css: "css", scss: "css", less: "css",
  toml: "toml", ini: "toml", cfg: "toml", conf: "toml", yaml: "yaml", yml: "yaml", json: "json", jsonc: "js",
  sql: "sql", md: "md", markdown: "md",
};

function languageOf(rel) {
  const name = rel.split("/").pop().toLowerCase();
  if (name === "dockerfile" || name === "makefile" || name.startsWith(".env") || name === ".gitignore") return "sh";
  return EXTENSIONS[name.includes(".") ? name.split(".").pop() : ""] || null;
}

const tokenizers = {};
/** A regexp of the language's tokens, each in a named group (see highlight). */
function tokenizer(lang) {
  if (tokenizers[lang]) return tokenizers[lang];
  const def = LANGS[lang];
  const parts = [];
  if (def.block) parts.push("(?<comment>/\\*[\\s\\S]*?(?:\\*/|$))");
  if (def.line) parts.push(`(?<lcomment>${def.line.replace(/[/]/g, "\\/")}.*)`);
  if (def.triple) parts.push("(?<tstring>[rRbBfFuU]{0,2}(?:\"\"\"[\\s\\S]*?(?:\"\"\"|$)|'''[\\s\\S]*?(?:'''|$)))");
  parts.push("(?<string>\"(?:[^\"\\\\\\n]|\\\\.)*\"?|'(?:[^'\\\\\\n]|\\\\.)*'?" + (def.backtick ? "|`(?:[^`\\\\]|\\\\[\\s\\S])*`?" : "") + ")");
  parts.push("(?<number>\\b(?:0[xX][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)\\b)");
  parts.push("(?<word>[A-Za-z_$][\\w$]*)");
  const keywords = new Set(def.kw.split(" ").map((k) => (def.nocase ? k.toLowerCase() : k)));
  tokenizers[lang] = { re: new RegExp(parts.join("|"), "g"), keywords, nocase: !!def.nocase };
  return tokenizers[lang];
}

/** text in spans of the syntax's classes, into parent (no HTML parsed: text nodes only). */
function highlight(parent, text, lang) {
  if (!lang || !LANGS[lang] || text.length > VIEW_HIGHLIGHT_MAX) {
    parent.append(document.createTextNode(text));
    return;
  }
  const { re, keywords, nocase } = tokenizer(lang);
  re.lastIndex = 0;
  let at = 0;
  let plain = "";
  const flush = () => { if (plain) parent.append(document.createTextNode(plain)); plain = ""; };
  const span = (cls, value) => { flush(); parent.append(el("span", { className: cls, textContent: value })); };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") { re.lastIndex++; continue; }
    plain += text.slice(at, m.index);
    at = m.index + m[0].length;
    const g = m.groups;
    if (g.comment || g.lcomment) span("syn-comment", m[0]);
    else if (g.tstring || g.string) span("syn-string", m[0]);
    else if (g.number) span("syn-number", m[0]);
    else if (keywords.has(nocase ? m[0].toLowerCase() : m[0])) span("syn-keyword", m[0]);
    else if (text[at] === "(" || (lang === "rs" && text[at] === "!")) span("syn-call", m[0]);
    else if (/^[A-Z][a-z]/.test(m[0]) && lang !== "css") span("syn-type", m[0]);
    else plain += m[0];
  }
  plain += text.slice(at);
  flush();
}

// --- Markdown, as a page -------------------------------------------------------

/** Inline Markdown into parent: `code`, **strong**, *em*, [text](url) (shown, not followed). */
function markdownInline(parent, text) {
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    parent.append(document.createTextNode(text.slice(at, m.index)));
    at = m.index + m[0].length;
    if (m[1] !== undefined) parent.append(el("code", { textContent: m[1] }));
    else if (m[2] !== undefined || m[3] !== undefined) { const b = el("strong"); markdownInline(b, m[2] ?? m[3]); parent.append(b); }
    else if (m[4] !== undefined) { const i = el("em"); markdownInline(i, m[4]); parent.append(i); }
    else parent.append(el("span", { className: "md-link", textContent: m[5], title: m[6] }));
  }
  parent.append(document.createTextNode(text.slice(at)));
}

function markdownPage(text) {
  const page = el("div", { className: "md-page" });
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let para = [];
  const endPara = () => {
    if (!para.length) return;
    const p = el("p");
    markdownInline(p, para.join(" "));
    page.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      endPara();
      const body = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      const pre = el("pre", { className: "md-code" });
      highlight(pre, body.join("\n"), EXTENSIONS[fence[2].toLowerCase()] || LANGS[fence[2].toLowerCase()] && fence[2].toLowerCase() || null);
      page.append(pre);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      endPara();
      const h = el(`h${Math.min(heading[1].length + 1, 6)}`, { className: "md-h" });
      markdownInline(h, heading[2]);
      page.append(h);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { endPara(); page.append(el("hr")); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      endPara();
      const table = el("table", { className: "md-table" });
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue; // the separator row
        const tr = el("tr");
        for (const cell of lines[i].trim().slice(1, -1).split("|")) {
          const td = el(table.childElementCount ? "td" : "th");
          markdownInline(td, cell.trim());
          tr.append(td);
        }
        table.append(tr);
      }
      page.append(table);
      continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      endPara();
      const list = el(/\d/.test(item[2]) ? "ol" : "ul", { className: "md-list" });
      for (; i < lines.length; i++) {
        const it = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!it) {
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.lastChild) { list.lastChild.append(" "); markdownInline(list.lastChild, lines[i].trim()); continue; }
          break;
        }
        const li = el("li");
        if (it[1].length >= 2) li.className = "md-nested";
        markdownInline(li, it[3].replace(/^\[( |x|X)\]\s+/, (_, c) => (c === " " ? "☐ " : "☑ ")));
        list.append(li);
      }
      page.append(list);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      endPara();
      const block = el("blockquote");
      const said = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) said.push(lines[i].replace(/^\s*>\s?/, ""));
      markdownInline(block, said.join(" "));
      page.append(block);
      continue;
    }
    if (!line.trim()) endPara();
    else para.push(line.trim());
    i++;
  }
  endPara();
  return page;
}

// --- the tab -------------------------------------------------------------------

function makeFile(tab) {
  const { rel, project } = tab.params;
  tab.title = rel.split("/").pop();
  const lang = languageOf(rel);
  const markdown = lang === "md";
  let asPage = markdown;
  const head = el("div", { className: "diff-head" });
  const path = el("span", { className: "path", textContent: rel, title: `${project}/${rel}` });
  const facts = el("span", { className: "dim small" });
  const view = el("button", { className: "link", textContent: "source", hidden: !markdown });
  const changes = el("button", { className: "link", textContent: "changes", title: "What changed in it: git, and Pi's edits" });
  const refresh = el("button", { className: "link", textContent: "refresh" });
  const mention = el("button", { className: "link", textContent: "mention in Pi" });
  head.append(path, facts, view, changes, refresh, mention);
  const error = el("p", { className: "error", hidden: true });
  const body = el("div", { className: "file-body" });
  tab.pane.append(head, error, body);
  let last = null;

  function draw() {
    body.replaceChildren();
    if (!last) return;
    if (last.binary) {
      body.append(el("p", { className: "dim", textContent: "A binary file: nothing to show here." }));
      return;
    }
    const text = last.text.endsWith("\n") ? last.text.slice(0, -1) : last.text;
    if (asPage) {
      body.append(markdownPage(text));
    } else {
      const count = text === "" ? 1 : text.split("\n").length;
      const code = el("div", { className: "code-view" });
      const gutter = el("pre", { className: "gutter", textContent: Array.from({ length: count }, (_, n) => n + 1).join("\n") });
      gutter.setAttribute("aria-hidden", "true");
      const src = el("pre", { className: "src" });
      highlight(src, text, markdown ? null : lang);
      code.append(gutter, src);
      body.append(code);
    }
    if (last.truncated) {
      body.append(el("p", { className: "dim small", textContent: `Only the first ${humanSize(last.text.length)} are shown, of ${humanSize(last.size)}.` }));
    }
  }

  async function reload() {
    let result;
    try {
      result = await backend.api(["file", project, rel]);
    } catch (e) {
      showError(error, String(e));
      return;
    }
    error.hidden = true;
    last = result;
    const lines = result.binary ? "" : `${(result.text.match(/\n/g)?.length || 0) + (result.text && !result.text.endsWith("\n") ? 1 : 0)} lines · `;
    facts.textContent = `${lines}${humanSize(result.size)}`;
    const top = body.scrollTop;
    draw();
    body.scrollTop = top;
  }

  view.addEventListener("click", () => {
    asPage = !asPage;
    view.textContent = asPage ? "source" : "page";
    draw();
  });
  changes.addEventListener("click", () => openDiff(rel, project));
  refresh.addEventListener("click", reload);
  mention.addEventListener("click", () => backend.api(["type", `@${rel} `, project]).catch((e) => showError(error, String(e))));
  tab.reload = reload;
  reload();
}
