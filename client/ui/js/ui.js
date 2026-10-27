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

/** A path of the VM as the user reads it: /home/<them>/x as ~/x. */
const projectLabel = (path) => String(path || "").replace(/^\/home\/[^/]+/, "~");
