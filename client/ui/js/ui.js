// What the panels build lists with: a link-like button, the two-line list row, a notice line,
// a VM path shortened to ~. (el, visibleText and the dialogs: core.js and resources.js.)

/** A list to choose from with its own search on top (the models, as the proposals' 1B):
 *  each item's name on the left, where it comes from on the right, a check on the one in
 *  use. ↑ ↓ choose, Enter takes, Esc or a click elsewhere closes, the anchor again too.
 *  items: [{ value, label, detail }]. custom(text): a value for a text that matches
 *  nothing (a model Pi does not list), or null. */
function pickPalette(anchor, { items, current = null, placeholder, custom = null, onPick }) {
  const open = document.querySelector(".menu.palette");
  if (open) {
    open.close();
    if (open.anchor === anchor) return;
  }
  closeMenu(false);
  const search = el("input", { type: "search", placeholder, spellcheck: false, autocomplete: "off" });
  search.setAttribute("aria-label", placeholder);
  const list = el("div", { className: "palette-list" });
  list.setAttribute("role", "listbox");
  const box = el("div", { className: "menu palette" }, el("label", { className: "palette-search" }, svgIcon("search"), search), list);
  box.anchor = anchor;
  let shown = [];
  let at = 0;
  const mark = (i) => {
    at = i;
    [...list.children].forEach((b, j) => b.classList.toggle("on", j === i));
    list.children[i]?.scrollIntoView({ block: "nearest" });
  };
  const draw = () => {
    const typed = search.value.trim();
    const q = typed.toLowerCase();
    shown = items.filter((it) => !q || `${it.label} ${it.detail || ""} ${it.value}`.toLowerCase().includes(q));
    const own = typed && custom ? custom(typed) : null;
    if (own && !items.some((it) => it.value === own)) shown.push({ value: own, label: `Use “${typed}”`, detail: "as typed" });
    list.replaceChildren(...shown.map((it) => {
      const b = el("button", { type: "button", title: it.value || it.label },
        el("span", { className: "menu-icon" }, ...(it.value === current ? [svgIcon("check")] : [])),
        el("span", { className: "label", textContent: it.label }), el("span", { className: "k", textContent: it.detail || "" }));
      b.setAttribute("role", "option");
      b.addEventListener("pointerdown", (e) => e.preventDefault()); // the search keeps the keyboard
      b.addEventListener("click", () => take(it));
      return b;
    }));
    if (!shown.length) list.append(el("p", { className: "palette-none", textContent: "Nothing matches" }));
  };
  const outside = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); };
  const close = () => {
    box.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
  };
  const take = (it) => { close(); anchor.focus(); onPick(it.value); };
  box.close = close;
  search.addEventListener("input", () => { draw(); mark(0); });
  search.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && shown.length) {
      e.preventDefault();
      mark((at + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[at]) take(shown[at]);
    } else if (e.key === "Escape") {
      e.preventDefault(); // the palette closes, the settings stay
      e.stopPropagation();
      close();
      anchor.focus();
    }
  });
  document.body.append(box);
  draw();
  const r = anchor.getBoundingClientRect();
  box.style.width = `${Math.max(r.width, 340)}px`;
  // From its button's left edge when it fits, else ending at its right edge.
  const left = r.left + box.offsetWidth <= innerWidth - 8 ? r.left : r.right - box.offsetWidth;
  box.style.left = `${Math.max(8, Math.min(left, innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${r.bottom + 4 + box.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - box.offsetHeight - 4) : r.bottom + 4}px`;
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", outside, true);
  mark(Math.max(0, shown.findIndex((it) => it.value === current)));
  search.focus();
}

/** A select drawn as the mock-up's pick: a button with the chosen text and ▾ whose list is
 *  Pier's own menu. The select stays, hidden: it keeps the value, the change event, the
 *  code that sets it (its value and options followed here). */
function pickify(select, variant = "") {
  if (select.dataset.pick) return;
  select.dataset.pick = "1";
  const b = el("button", { type: "button", className: `pick ${variant}`.trim(), title: select.title || "" }, el("span"));
  b.setAttribute("aria-haspopup", "menu");
  const label = () => {
    $("span", b).textContent = select.selectedOptions[0]?.text || "";
    b.disabled = select.disabled;
  };
  const name = select.labels?.[0]?.textContent.trim() || select.getAttribute("aria-label") || select.title;
  if (name) b.setAttribute("aria-label", name);
  b.addEventListener("click", () => showMenu(b, [...select.options].map((o) => [o.text, () => {
    select.value = o.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    label();
  }, o.disabled, { icon: o.value === select.value ? "check" : null, current: o.value === select.value }])));
  // Set in code (prefs.js fills and sets them): the button follows.
  const own = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(select, "value", { get() { return own.get.call(this); }, set(v) { own.set.call(this, v); label(); } });
  new MutationObserver(label).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  select.hidden = true;
  select.after(b);
  label();
}

/** A number field with − and + on its sides (within its min and max); each step is a change. */
function stepper(input) {
  const step = (up) => {
    if (up) input.stepUp(); else input.stepDown();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const button = (up) => {
    const b = el("button", { type: "button", className: "step", tabIndex: -1, ariaLabel: up ? "More" : "Less" }, svgIcon(up ? "plus" : "minus"));
    b.addEventListener("click", () => step(up));
    return b;
  };
  const box = el("span", { className: "stepper" });
  input.replaceWith(box);
  box.append(button(false), input, button(true));
  return box;
}

/** A button in the look of a link: "open", "copy link", "stop". */
function linkButton(text, title, run) {
  const b = text === "×" ? el("button", { className: "link icon-link", title }, svgIcon("x")) : el("button", { className: "link", textContent: text, title });
  b.addEventListener("click", run);
  return b;
}

/** A row of a list (.resource-items): name and actions, then each detail on its own line
 *  (a string or a list; empty ones left out). title: the row's tooltip. */
function itemLine(name, details, title, ...actions) {
  return el("li", { className: "two-lines", title: title || "" },
    el("div", { className: "line" }, el("span", { className: "name", textContent: name }), el("span", { className: "dim" }), ...actions),
    ...[].concat(details || []).filter(Boolean).map((text) => el("div", { className: "desc dim small", textContent: text })));
}

/** say(text) for a page's notice paragraph: shown with the text, hidden without. */
function noticeSetter(node) {
  return (text) => { node.hidden = !text; node.textContent = text || ""; };
}

/** container's list drawn again by rebuild() keeping the user's place: the focused control
 *  (found by data-key, then by text) and the scroll. */
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

/** A path where its end matters, in a narrow place: the folder (cut if need be), then the
 *  whole name. The whole path in the title. */
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

// Every list of Pier as a pick with Pier's menu, those drawn later too (dialogs, Repository,
// Labs...): the system's own list is drawn by Windows, out of the theme. Looked for once a
// frame at most, whatever the number of changes (a conversation streams many).
let pickFrame = 0;
const pickAllSelects = () => {
  pickFrame = 0;
  for (const select of document.querySelectorAll("select:not([data-pick]):not([multiple])")) pickify(select);
};
pickAllSelects();
new MutationObserver(() => { if (!pickFrame) pickFrame = requestAnimationFrame(pickAllSelects); }).observe(document.body, { childList: true, subtree: true });

// A field left empty or wrong: Pier's own line under it, not the browser's bubble (drawn by
// Chromium, out of the theme). The first such field of the form gets the keyboard.
document.addEventListener("invalid", (event) => {
  const field = event.target;
  event.preventDefault();
  const v = field.validity;
  const text = v.valueMissing ? "Needed." : v.typeMismatch || v.patternMismatch ? "Not in the expected form." : field.validationMessage;
  let line = field.nextElementSibling?.classList.contains("field-error") ? field.nextElementSibling : null;
  if (!line) {
    line = el("span", { className: "field-error", id: `field-error-${Math.random().toString(36).slice(2, 8)}` });
    field.after(line);
    field.setAttribute("aria-describedby", line.id);
    field.addEventListener("input", () => { line.remove(); field.removeAttribute("aria-invalid"); field.removeAttribute("aria-describedby"); }, { once: true });
  }
  line.textContent = text;
  field.setAttribute("aria-invalid", "true");
  if (!field.form || field.form.querySelector(":invalid") === field) field.focus();
}, true);

// Settings: a row's name is not a button. A click on it no longer flips its switch or opens
// its list (only the control does); a text field still takes the keyboard from its name.
document.addEventListener("click", (event) => {
  const label = event.target.closest(".set > label.what, .setting-head > label");
  if (!label || event.target.closest("input, select, button, textarea")) return;
  const control = label.control;
  if (control && !control.matches("textarea, input:not([type=checkbox], [type=radio], [type=range], [type=color])")) event.preventDefault();
}, true);


// Pier's hints (the proposals' C), in place of the system's: after a short rest on anything
// with a title, a card under it: its name in bold with its shortcut, then what it does in
// grey. Titles are taken off as soon as they appear (kept as data-tip), so Windows never
// draws its own, even on a row redrawn under a still pointer; an element named only by its
// title keeps that name (aria-label).
{
  const takeTitle = (node) => {
    const title = node.getAttribute("title");
    if (title === null) return;
    node.removeAttribute("title");
    if (!title || title === "null" || title === "undefined") { delete node.dataset.tip; return; }
    node.dataset.tip = title;
    if (!node.getAttribute("aria-label") && !(node.textContent || "").trim()) node.setAttribute("aria-label", title);
  };
  document.querySelectorAll("[title]").forEach(takeTitle);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") takeTitle(r.target);
      else for (const n of r.addedNodes) if (n.nodeType === 1) { takeTitle(n); n.querySelectorAll("[title]").forEach(takeTitle); }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });

  const hint = el("div", { className: "hint-card", role: "tooltip", hidden: true });
  document.body.append(hint);
  let over = null, timer = 0, watch = 0;
  const pointer = { x: 0, y: 0 };
  document.addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true, capture: true });
  const SHORTCUT = /\s*[(,]?\s*((?:Ctrl|Alt|Shift|Win|Cmd)(?:\+[A-Za-z0-9,.\/;'\[\]=-]+)+|F\d{1,2}|Esc)\)?\s*$/;
  /** Name and words of an element: its label (else its text, else the tip's first part),
   *  the tip for the words when it says more; a shortcut at the end of either, apart. */
  function parts(node, tip) {
    // A row's name, not all its text (a project's mark letter, a conversation's age).
    let name = node.getAttribute("aria-label") || (node.querySelector(":scope > .title, :scope > .row-main > .title")?.textContent || node.textContent || "").trim() || "";
    let keys = "";
    const pull = (text) => { const m = text.match(SHORTCUT); if (!m) return text; keys ||= m[1]; return text.slice(0, m.index).trim(); };
    let words = pull(tip);
    name = pull(name);
    if (!name || name.length > 40) {
      const cut = words.search(/[:.;]\s|\s[(·]/);
      name = cut > 0 ? words.slice(0, cut) : words;
      words = cut > 0 ? words.slice(cut).replace(/^[:.;·\s(]+|\)$/g, "") : "";
    }
    if (words.toLowerCase() === name.toLowerCase()) words = "";
    return { name, words, keys };
  }
  function hide() {
    clearTimeout(timer);
    clearInterval(watch);
    hint.hidden = true;
    over = null;
  }
  function show(node) {
    const tip = node.dataset.tip;
    if (!tip || !node.isConnected) { hide(); return; }
    const { name, words, keys } = parts(node, tip);
    // replaceChildren writes a null out as "null": only what there is.
    hint.replaceChildren(...[el("b", {}, el("span", { textContent: name }), keys ? el("kbd", { textContent: keys }) : null),
      words ? el("span", { className: "hint-words", textContent: words }) : null].filter(Boolean));
    let box = node.getBoundingClientRect();
    // A big area (a list, a tree): by the pointer, not under the whole area.
    if (box.height > 64) box = { left: pointer.x - 8, width: 16, top: pointer.y - 8, bottom: pointer.y + 12 };
    hint.hidden = false;
    const w = hint.offsetWidth, h = hint.offsetHeight;
    const x = Math.min(Math.max(8, box.left + box.width / 2 - w / 2), innerWidth - w - 8);
    let y = box.bottom + 8;
    if (y + h > innerHeight - 8) y = Math.max(8, box.top - h - 8); // no room under it: above
    hint.style.left = `${Math.round(x)}px`;
    hint.style.top = `${Math.round(y)}px`;
    // Its element gone (a list redrawn): the card goes too.
    watch = setInterval(() => { if (!over?.isConnected) hide(); }, 250);
  }
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    const node = e.target.closest?.("[data-tip]");
    if (node === over) return;
    hide();
    if (!node) return;
    over = node;
    timer = setTimeout(() => { if (over === node) show(node); }, 450);
  }, true);
  document.addEventListener("pointerout", (e) => {
    if (over && !over.contains(e.relatedTarget)) hide();
  }, true);
  for (const type of ["pointerdown", "keydown", "wheel", "blur"]) window.addEventListener(type, hide, true);
}


/** A word by an element for a moment (a button with nothing to open, say): the hints' card,
 *  beside it when it is at the window's left edge, else under it. */
function bubbleBy(anchor, text) {
  document.querySelector(".bubble-by")?.remove();
  const card = el("div", { className: "hint-card bubble-by", role: "status", textContent: text });
  document.body.append(card);
  const box = anchor.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  const beside = box.left < 80;
  card.style.left = `${Math.round(beside ? box.right + 8 : Math.min(Math.max(8, box.left + box.width / 2 - w / 2), innerWidth - w - 8))}px`;
  card.style.top = `${Math.round(beside ? box.top + box.height / 2 - h / 2 : box.bottom + 8)}px`;
  setTimeout(() => card.remove(), 1600);
}
