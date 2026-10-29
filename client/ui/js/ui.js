// What the panels build their lists with, written once: a button that reads as a link,
// the two-line row of a list (a name and its actions, then its details), the notice line
// of a page, a path of the VM shortened to ~. (el, visibleText, the dialogs: core.js and
// resources.js.)

/** A button in the look of a link: "open", "copy link", "stop". */
function linkButton(text, title, run) {
  const b = el("button", { className: "link", textContent: text, title });
  b.addEventListener("click", run);
  return b;
}

/** A row of a list (.resource-items): the name, then its actions on the right, then each
 *  detail on a line of its own (a string, or a list of them; empty ones left out). title:
 *  the whole row's tooltip. */
function itemLine(name, details, title, ...actions) {
  return el("li", { className: "two-lines", title: title || "" },
    el("div", { className: "line" }, el("span", { className: "name", textContent: name }), el("span", { className: "dim" }), ...actions),
    ...[].concat(details || []).filter(Boolean).map((text) => el("div", { className: "desc dim small", textContent: text })));
}

/** say(text) for a page's notice paragraph: shown with the text, hidden without. */
function noticeSetter(node) {
  return (text) => { node.hidden = !text; node.textContent = text || ""; };
}

/** container's list drawn again by rebuild(), without losing the user's place: the
 *  focused control (found again in its row by data-key, then by its text) and the
 *  scroll. A list redrawn every few seconds no longer throws the focus away. */
function keepPlace(container, rebuild) {
  const active = document.activeElement;
  const row = container.contains(active) ? active.closest("[data-key]") : null;
  const key = row?.dataset.key;
  const text = active?.textContent;
  const scroll = container.scrollTop;
  rebuild();
  container.scrollTop = scroll;
  if (key == null) return;
  const again = [...container.querySelectorAll("[data-key]")].find((n) => n.dataset.key === key);
  const target = again && ([...again.querySelectorAll(active.tagName)].find((n) => n.textContent === text) || again);
  target?.focus?.({ preventScroll: true });
}

/** A row that works by keyboard too: Tab reaches it, Enter or Space does what a click
 *  does, Shift+Enter what a double-click does (mention it in Pi). */
function pressable(node) {
  node.tabIndex = 0;
  if (!node.getAttribute("role")) node.setAttribute("role", "button");
  node.addEventListener("keydown", (e) => {
    if (e.target !== node) return;
    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); node.click(); }
  });
  return node;
}

/** A path where its end matters, in a narrow place: the folder (cut short if need be)
 *  then the name, always whole; "rapport-…-long.txt.exe" no longer shows as "rapport-…".
 *  The whole path in the title. */
function splitPath(path, className = "path") {
  const text = visibleText(path);
  const cut = text.lastIndexOf("/");
  return el("span", { className: `${className} split-path`, title: text },
    cut >= 0 ? el("span", { className: "dir", textContent: text.slice(0, cut + 1) }) : null,
    el("span", { className: "base", textContent: text.slice(cut + 1) }));
}

/** node, marked as the row of key for keepPlace. */
function keyed(key, node) {
  node.dataset.key = key;
  return node;
}

/** A path of the VM as the user reads it: /home/<them>/x as ~/x. */
const projectLabel = (path) => String(path || "").replace(/^\/home\/[^/]+/, "~");
