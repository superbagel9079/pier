// Conversation tabs: Pi in RPC mode (the picker's --rpc-attach), drawn as the mock-up's
// conversation: what you asked, what Pi thought and did as steps, its answer, a composer.

/** Opens a conversation of project: new (args []), the last one (--continue), a file
 *  (--session FILE) or a Pi running in RPC mode (--slot NAME). */
function openChat(project, label, args = []) {
  return workspace.add("chat", "center", { params: { project, label, args } });
}

// What a tool did, in a few words; the file it touched, when it has one.
const STEP_WORDS = {
  read: ["Read", "path"], write: ["Wrote", "path"], edit: ["Edited", "path"], bash: ["Ran", "command"],
  grep: ["Searched", "pattern"], find: ["Looked for", "pattern"], ls: ["Listed", "path"],
};
const FILE_TOOLS = new Set(["read", "write", "edit"]);
const PREVIEW_LINES = 6; // a result longer than this shows its first lines, a fade, "Show N more"

function makeChat(tab) {
  const { project, label } = tab.params;
  tab.title = label || "Pi";
  const pane = tab.pane;
  pane.classList.add("chat-pane");
  const col = el("div", { className: "chat-col" });
  const scroller = el("div", { className: "chat" }, col);
  const input = el("textarea", { placeholder: "Message Pi. Enter sends, Shift+Enter for a new line, @ for a file", spellcheck: true });
  input.setAttribute("aria-label", "Message Pi");
  const send = el("button", { className: "send", title: "Send", type: "button" });
  send.setAttribute("aria-label", "Send");
  send.append(svgIcon("arrow-up"));
  const plus = el("button", { className: "icon-btn", title: "Add to the message", type: "button" });
  plus.setAttribute("aria-label", "Add to the message");
  plus.append(svgIcon("plus"));
  const modelBtn = el("button", { className: "pickish", type: "button", textContent: "model ▾" });
  const thinkBtn = el("button", { className: "pickish", type: "button", textContent: "thinking ▾" });
  const cost = el("span", { className: "chat-cost dim small" });
  const composer = el("div", { className: "composer" }, input, el("div", { className: "bar" }, plus, modelBtn, thinkBtn, el("span", { className: "head-gap" }), cost, send));
  pane.append(scroller, composer);

  let id = null;          // the channel (term.rs), while attached
  let slot = null;        // the Pi's name on the VM: to come back to it
  let working = false;
  let lineBuf = "";
  const decoder = new TextDecoder();
  let asked = 0;
  const waiting = new Map(); // command id -> what to do with its response
  let turn = null;           // the assistant message being written
  const steps = new Map();   // toolCallId -> its step
  let spent = 0;
  let state = {};

  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  const keepDown = (was) => { if (was) scroller.scrollTop = scroller.scrollHeight; };

  /** One command to Pi; then(data) with its response when one is wanted. */
  function command(cmd, then = null) {
    if (id === null) return;
    const key = `p${++asked}`;
    if (then) waiting.set(key, then);
    backend.termWrite(id, `${JSON.stringify({ ...cmd, id: key })}\n`);
  }

  function notice(text, kind = "") {
    const was = atBottom();
    col.append(el("p", { className: `chat-notice ${kind}`, textContent: text }));
    keepDown(was);
  }

  function setWorking(on) {
    working = on;
    composer.classList.toggle("working", on);
    send.title = on && !input.value.trim() ? "Stop" : on ? "Steer: tell Pi this now" : "Send";
    send.setAttribute("aria-label", send.title);
    send.classList.toggle("stop", on && !input.value.trim());
  }

  // --- drawing ---------------------------------------------------------------------

  function you(text) {
    const was = atBottom();
    col.append(el("div", { className: "you", textContent: text }));
    keepDown(was);
  }

  /** The assistant's message: a timeline of steps (thinking, tools), then its text. */
  function startTurn() {
    const tl = el("div", { className: "tl" });
    const text = el("div", { className: "answer" });
    const box = el("div", { className: "turn" }, tl, text);
    col.append(box);
    turn = { box, tl, text, raw: "", thought: null };
    return turn;
  }

  function lines(text, max = Infinity) {
    const all = String(text ?? "").replace(/\n$/, "").split("\n");
    return el("div", { className: "file" }, ...all.slice(0, max).map((t, i) => el("div", {}, el("span", { textContent: String(i + 1) }), el("span", { textContent: t }))));
  }

  /** A step's body: short shows whole; long shows its first lines, a fade, then "Show N more". */
  function body(node, count) {
    if (count <= PREVIEW_LINES) return el("div", { className: "step-body" }, node);
    const more = el("button", { className: "more", type: "button" }, svgIcon("chevrons-up-down"), el("span", { textContent: `Show ${count - 4} more lines` }));
    const box = el("div", { className: "step-body clipbox" }, el("div", { className: "clip" }, node), el("div", { className: "fade" }), more);
    more.addEventListener("click", () => {
      const open = box.classList.toggle("open");
      more.lastChild.textContent = open ? "Show less" : `Show ${count - 4} more lines`;
    });
    return box;
  }

  function step(t, { icon = "loader-circle", what, meta = "", path = null }) {
    const row = el("button", { className: "fold-btn", type: "button" }, el("span", { className: "what" }, ...what), el("span", { className: "meta", textContent: meta }));
    row.setAttribute("aria-expanded", "false");
    const node = el("span", { className: "node" }, svgIcon(icon));
    const srow = el("div", { className: "srow" }, row);
    if (path) {
      const open = el("button", { className: "icon-btn open-tab", title: "Open in a tab", type: "button" }, svgIcon("external-link"));
      open.setAttribute("aria-label", `Open ${path} in a tab`);
      open.addEventListener("click", () => openFile(path, project));
      srow.append(open);
    }
    const s = el("div", { className: "step" }, node, srow);
    row.addEventListener("click", () => {
      const b = $(":scope > .step-body", s);
      if (!b) return;
      b.hidden = !b.hidden;
      row.setAttribute("aria-expanded", String(!b.hidden));
    });
    t.tl.append(s);
    return { s, node, row, meta: $(".meta", row) };
  }

  function setBody(st, node, count) {
    $(":scope > .step-body", st.s)?.remove();
    const b = body(node, count);
    b.hidden = st.row.getAttribute("aria-expanded") !== "true";
    st.s.append(b);
  }

  const relPath = (p) => (p && p.startsWith(`${project}/`) ? p.slice(project.length + 1) : p);

  function toolStep(t, call) {
    const args = call.arguments || call.args || {};
    const [verb, key] = STEP_WORDS[call.name] || [call.name, null];
    const target = key ? String(args[key] ?? "") : "";
    const path = FILE_TOOLS.has(call.name) && args.path ? relPath(String(args.path)) : null;
    const st = step(t, { what: [`${verb} `, el("span", { className: "path", textContent: path || target })], path });
    steps.set(call.id, st);
    return st;
  }

  function finishStep(st, result, isError, ms) {
    st.node.replaceChildren(svgIcon(isError ? "circle-alert" : "circle-check"));
    st.s.classList.toggle("failed", Boolean(isError));
    if (ms !== undefined) st.meta.textContent = ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
    const text = (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (text) setBody(st, lines(text, 400), text.split("\n").length);
  }

  function thinking(t, text) {
    if (!t.thought) {
      t.thought = step(t, { icon: "loader-circle", what: ["Thinking"] });
      t.thoughtText = "";
    }
    t.thoughtText += text;
    const para = el("div", { className: "thought" }, ...t.thoughtText.split(/\n{2,}/).map((p) => el("p", { textContent: p })));
    setBody(t.thought, para, Math.ceil(t.thoughtText.length / 80));
  }

  function endThinking(t) {
    if (t.thought) t.thought.node.replaceChildren(svgIcon("circle-check"));
  }

  /** The answer as Markdown, its files as links that open in a tab. */
  function answer(t, text) {
    t.text.replaceChildren(markdownPage(text));
    for (const code of t.text.querySelectorAll("code")) {
      const p = code.textContent;
      if (/^[\w./-]+\.\w{1,8}$/.test(p) && !p.startsWith("/")) {
        const ref = el("button", { className: "ref", type: "button", textContent: p, title: "Open in a tab" });
        ref.addEventListener("click", () => openFile(p, project));
        code.replaceWith(ref);
      }
    }
  }

  /** A whole message from Pi's history (get_messages). */
  function drawMessage(m) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text) you(text);
    } else if (m.role === "assistant") {
      const t = startTurn();
      let text = "";
      for (const c of m.content || []) {
        if (c.type === "thinking" && c.thinking) { thinking(t, c.thinking); endThinking(t); }
        else if (c.type === "toolCall") toolStep(t, c);
        else if (c.type === "text") text += c.text;
      }
      if (text) answer(t, text);
      spent += m.usage?.cost?.total || 0;
    } else if (m.role === "toolResult") {
      const st = steps.get(m.toolCallId);
      if (st) finishStep(st, m, m.isError);
    }
  }

  // --- what Pi says ------------------------------------------------------------------

  function onEvent(e) {
    const was = atBottom();
    switch (e.type) {
      case "pier_attached":
        slot = e.slot;
        tab.params.args = ["--slot", slot]; // a reconnection comes back to this Pi
        command({ type: "get_state" }, (data) => { state = data || {}; showState(); setWorking(Boolean(state.isStreaming)); });
        command({ type: "get_messages" }, (data) => { col.replaceChildren(); steps.clear(); spent = 0; (data?.messages || []).forEach(drawMessage); showCost(); scroller.scrollTop = scroller.scrollHeight; });
        break;
      case "pier_error": notice(e.error, "error"); break;
      case "pier_text": if (e.text.trim()) notice(e.text, "dim"); break;
      case "pier_exit":
        notice("Pi has stopped. Its conversation is saved: continue it from the list.", "dim");
        setWorking(false);
        input.disabled = true;
        break;
      case "response": {
        const then = waiting.get(e.id);
        waiting.delete(e.id);
        if (e.success === false) notice(`${e.command}: ${e.error}`, "error");
        else then?.(e.data);
        break;
      }
      case "agent_start": setWorking(true); break;
      case "agent_settled": setWorking(false); break;
      case "message_start":
        if (e.message?.role === "user") drawMessage(e.message);
        else if (e.message?.role === "assistant") startTurn();
        break;
      case "message_update": {
        const a = e.assistantMessageEvent || {};
        const t = turn || startTurn();
        if (a.type === "text_delta") { t.raw += a.delta; endThinking(t); t.text.textContent = t.raw; }
        else if (a.type === "thinking_delta") thinking(t, a.delta);
        else if (a.type === "toolcall_end" && a.toolCall) { endThinking(t); toolStep(t, a.toolCall); }
        break;
      }
      case "message_end":
        if (e.message?.role === "assistant" && turn) {
          const text = (e.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
          endThinking(turn);
          if (text) answer(turn, text);
          spent += e.message.usage?.cost?.total || 0;
          showCost();
          turn = null;
        }
        break;
      case "tool_execution_start": {
        if (!steps.has(e.toolCallId)) toolStep(turn || startTurn(), { id: e.toolCallId, name: e.toolName, arguments: e.args });
        break;
      }
      case "tool_execution_update": {
        const st = steps.get(e.toolCallId);
        const text = (e.partialResult?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        if (st && text) setBody(st, lines(text, 400), text.split("\n").length);
        break;
      }
      case "tool_execution_end": {
        const st = steps.get(e.toolCallId);
        if (st) finishStep(st, e.result, e.isError, e.durationMs);
        break;
      }
      case "extension_ui_request": askFromExtension(e); break;
      default: break;
    }
    keepDown(was);
  }

  /** What an extension of Pi asks (a choice, a yes or no, a text): answered here.
   *  shortcut: the fields (method, title, message, options) are read from Pi's docs, not
   *  yet checked against a real Pi; check them once it runs on the VM. */
  function askFromExtension(e) {
    const reply = (fields) => { backend.termWrite(id, `${JSON.stringify({ type: "extension_ui_response", id: e.id, ...fields })}\n`); card.remove(); };
    const card = el("div", { className: "card chat-ask" }, el("h2", { textContent: e.title || "Pi asks" }), e.message ? el("p", { textContent: e.message }) : null);
    const actions = el("div", { className: "approval-actions" });
    if (e.method === "notify") { flashStatus(e.message || e.title || ""); return; }
    if (Array.isArray(e.options) && e.options.length) {
      for (const option of e.options) {
        const value = typeof option === "string" ? option : option.value ?? option.label;
        const b = el("button", { className: "secondary", textContent: typeof option === "string" ? option : option.label ?? String(value) });
        b.addEventListener("click", () => reply({ value }));
        actions.append(b);
      }
    } else if (e.method === "input" || e.method === "editor") {
      const field = el("input", { value: e.placeholder ? "" : e.value || "" });
      const ok = el("button", { textContent: "Send" });
      ok.addEventListener("click", () => reply({ value: field.value }));
      card.append(field);
      actions.append(ok);
    } else {
      const no = el("button", { className: "secondary", textContent: "No" });
      const yes = el("button", { textContent: "Yes" });
      no.addEventListener("click", () => reply({ confirmed: false }));
      yes.addEventListener("click", () => reply({ confirmed: true }));
      actions.append(no, yes);
    }
    const cancel = el("button", { className: "link", textContent: "cancel" });
    cancel.addEventListener("click", () => reply({ cancelled: true }));
    actions.prepend(cancel);
    card.append(actions);
    col.append(card);
  }

  function onBytes(bytes) {
    lineBuf += decoder.decode(bytes, { stream: true });
    let at;
    while ((at = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, at).trim();
      lineBuf = lineBuf.slice(at + 1);
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { notice(line, "dim"); continue; }
      onEvent(e);
    }
  }

  // --- the composer --------------------------------------------------------------------

  function showState() {
    const m = state.model;
    modelBtn.textContent = `${m ? m.id || m.name || m : "model"} ▾`;
    thinkBtn.textContent = `thinking: ${state.thinkingLevel || "default"} ▾`;
    if (state.sessionName) { tab.title = state.sessionName; workspace.show(tab); }
  }
  function showCost() { cost.textContent = spent ? dollars(spent) : ""; }

  function submit() {
    const text = input.value.trim();
    if (!text) { if (working) command({ type: "abort" }); return; }
    // While Pi works, a message steers it (taken at its next step); otherwise a prompt.
    command({ type: working ? "steer" : "prompt", message: text });
    input.value = "";
    setWorking(working);
  }
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  input.addEventListener("input", () => setWorking(working));
  plus.addEventListener("click", () => showMenu(plus, [
    ["Mention a project file (@)", () => { input.value += "@"; input.focus(); }, false, { icon: "at-sign" }],
  ]));
  modelBtn.addEventListener("click", () => command({ type: "get_available_models" }, (data) => {
    const models = data?.models || [];
    showMenu(modelBtn, models.length ? models.map((m) => [`${m.provider}/${m.id}`, () => command({ type: "set_model", provider: m.provider, modelId: m.id },
      () => command({ type: "get_state" }, (d) => { state = d || {}; showState(); }))]) : [["No other model", () => {}, true]]);
  }));
  thinkBtn.addEventListener("click", () => command({ type: "get_available_thinking_levels" }, (data) => {
    const levels = data?.levels || [];
    showMenu(thinkBtn, levels.map((level) => [level, () => command({ type: "set_thinking_level", level },
      () => command({ type: "get_state" }, (d) => { state = d || {}; showState(); }))]));
  }));

  // --- the channel ---------------------------------------------------------------------

  async function attach() {
    try {
      id = await backend.termOpen("chat", 80, 24, onBytes, { project, args: tab.params.args });
      tab.termId = id; // the channel's end reaches onExit (terminal.js)
    } catch (e) {
      notice(String(e), "error");
    }
  }
  tab.onExit = (clean) => {
    id = null;
    tab.termId = null;
    setWorking(false);
    if (!clean) {
      const again = el("button", { className: "link", textContent: "join it again" });
      again.addEventListener("click", () => { again.parentElement.remove(); attach(); });
      col.append(el("p", { className: "chat-notice dim" }, "The connection dropped; Pi works on, on the VM. ", again));
    }
  };
  tab.onClose = () => { if (id !== null) backend.termClose(id); };
  tab.onShow = () => input.focus();
  attach();
}
