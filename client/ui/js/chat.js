// Conversation tabs: Pi in RPC mode (the picker's --rpc-attach), drawn as the mock-up's
// conversation. Each request is a run: what you asked, Pi's steps as a timeline (folded
// into one line once Pi is done), its answer, how long it took; a composer below.

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

/** "1 min 07", "42 s": how long a run took. */
const runTime = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`; };
const clockTime = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const times = (n, one, many) => (n === 1 ? one : n === 2 && many === "times" ? "twice" : `${n} ${many}`);

/** A run in a few words: "Thought twice, read 2 files, edited 1". */
function runSummary(counts) {
  const parts = [];
  if (counts.thinking) parts.push(`thought ${times(counts.thinking, "once", "times")}`);
  if (counts.read) parts.push(`read ${counts.read} file${counts.read > 1 ? "s" : ""}`);
  if (counts.edit) parts.push(`edited ${counts.edit}`);
  if (counts.write) parts.push(`wrote ${counts.write}`);
  if (counts.bash) parts.push(`ran ${counts.bash} command${counts.bash > 1 ? "s" : ""}`);
  if (counts.other) parts.push(`used ${counts.other} tool${counts.other > 1 ? "s" : ""}`);
  const text = parts.join(", ");
  return text ? text[0].toUpperCase() + text.slice(1) : "Answered";
}

function makeChat(tab) {
  const { project, label } = tab.params;
  tab.title = label || "Pi";
  const pane = tab.pane;
  pane.classList.add("chat-pane");
  const col = el("div", { className: "chat-col" });
  const scroller = el("div", { className: "chat" }, col);
  const input = el("textarea", { placeholder: "Message Pi. / for commands, @ for files", spellcheck: true });
  input.setAttribute("aria-label", "Message Pi");
  const send = el("button", { className: "send", title: "Send", type: "button" });
  send.setAttribute("aria-label", "Send");
  send.append(svgIcon("arrow-up"));
  const plus = el("button", { className: "icon-btn", title: "Add to the message", type: "button" });
  plus.setAttribute("aria-label", "Add to the message");
  plus.setAttribute("aria-haspopup", "menu");
  plus.append(svgIcon("plus"));
  const modelBtn = el("button", { className: "pickish", type: "button", textContent: "model ▾" });
  const thinkBtn = el("button", { className: "pickish", type: "button", textContent: "thinking ▾" });
  // The context ring: fills as the conversation grows; orange past 80 %, red past 95 %.
  const ring = el("button", { className: "icon-btn ring", type: "button", hidden: true });
  ring.setAttribute("aria-haspopup", "dialog");
  ring.setAttribute("aria-expanded", "false");
  // Built node by node: Pier's CSP refuses innerHTML (trusted-types 'none').
  const svgNode = (tag, attrs) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const ringSvg = svgNode("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" });
  ringSvg.append(svgNode("circle", { class: "track", cx: 8, cy: 8, r: 6 }),
    svgNode("circle", { class: "used", cx: 8, cy: 8, r: 6, pathLength: 100, "stroke-dasharray": "0 100" }));
  ring.append(ringSvg);
  const composer = el("div", { className: "composer" }, input, el("div", { className: "bar" }, plus, modelBtn, thinkBtn, el("span", { className: "head-gap" }), ring, send));
  // Before the first message: what this tab is, where Pi starts.
  const empty = el("div", { className: "chat-empty" }, el("p", { textContent: `New conversation in ${label || projectLabel(project)}` }),
    el("p", { textContent: "Ask Pi something. It starts in this folder, in its sandbox." }));
  new MutationObserver(() => { empty.hidden = Boolean(col.childElementCount); }).observe(col, { childList: true });
  scroller.append(empty);
  pane.append(scroller, composer);

  let id = null;          // the channel (term.rs), while attached
  let working = false;
  let lineBuf = "";
  const decoder = new TextDecoder();
  let asked = 0;
  const waiting = new Map(); // command id -> what to do with its response
  let run = null;            // the request being answered: its timeline, answers, counts
  let message = null;        // the assistant message being written in it
  const steps = new Map();   // toolCallId -> its step
  let spent = 0;
  let lastUsage = null;
  let state = {};
  let clock = null;

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
    send.title = on && !input.value.trim() ? "Stop" : on ? "Steer: tell Pi this now" : "Send";
    send.setAttribute("aria-label", send.title);
    send.classList.toggle("stop", on && !input.value.trim());
    composer.classList.toggle("working", on); // its frame takes the gradient while Pi works
  }

  // --- a run: the request, the steps, the answers ------------------------------------

  function you(text) {
    col.append(el("div", { className: "you", textContent: text }));
  }

  /** A new run, after what you asked: its timeline, then Pi's answers. */
  function startRun(live) {
    const tl = el("div", { className: "tl" });
    const fold = el("button", { className: "fold-btn run-fold", type: "button", hidden: true },
      el("span", { className: "arrow", "aria-hidden": "true" }, svgIcon("chevron-right")), el("span", { className: "what" }), el("span", { className: "meta" }));
    fold.setAttribute("aria-expanded", "true");
    fold.addEventListener("click", () => {
      const open = fold.getAttribute("aria-expanded") !== "true";
      fold.setAttribute("aria-expanded", String(open));
      tl.hidden = !open;
    });
    const box = el("div", { className: "run" }, fold, tl);
    const answers = el("div", { className: "answers" });
    col.append(box, answers);
    run = { box, tl, fold, answers, counts: {}, started: live ? Date.now() : null, live, work: null };
    if (live) {
      run.work = el("div", { className: "working" }, "Working · ", el("span", { className: "num", textContent: "0:00" }));
      col.append(run.work);
      clearInterval(clock);
      clock = setInterval(() => { if (run?.work) $(".num", run.work).textContent = clockTime(Date.now() - run.started); }, 1000);
    }
    return run;
  }

  /** The run done: its steps folded behind one line, how long it took under the answer. */
  function endRun(model) {
    if (!run) return;
    clearInterval(clock);
    run.work?.remove();
    const any = run.tl.childElementCount > 0;
    run.fold.hidden = !any;
    $(".what", run.fold).textContent = runSummary(run.counts);
    $(".meta", run.fold).textContent = run.started ? runTime(Date.now() - run.started) : "";
    run.fold.setAttribute("aria-expanded", "false");
    run.tl.hidden = true;
    if (run.started) {
      const took = runTime(Date.now() - run.started).replace(" min ", "m ").replace(/ s$/, "s");
      col.append(el("div", { className: "foot-note", textContent: `Worked for ${took}${model ? ` · ${model}` : ""}` }));
    }
    run = null;
  }

  const count = (kind) => { run.counts[kind] = (run.counts[kind] || 0) + 1; };

  function lines(text, max = Infinity) {
    const all = String(text ?? "").replace(/\n$/, "").split("\n");
    return el("div", { className: "file" }, ...all.slice(0, max).map((t, i) => el("div", {}, el("span", { textContent: String(i + 1) }), el("span", { textContent: t }))));
  }

  /** A step's body: short shows whole; long shows its first lines, a fade, then "Show N more". */
  function body(node, n, unit = "lines") {
    if (n <= PREVIEW_LINES) return el("div", { className: "step-body" }, node);
    const label = unit === "thought" ? "Show the whole thought" : `Show ${n - 4} more lines`;
    const more = el("button", { className: "more", type: "button" }, svgIcon("chevrons-up-down"), el("span", { textContent: label }));
    const box = el("div", { className: "step-body clipbox" }, el("div", { className: `clip ${unit === "thought" ? "thought" : "lines"}` }, node), el("div", { className: "fade" }), more);
    more.addEventListener("click", () => {
      const open = box.classList.toggle("open");
      more.lastChild.textContent = open ? "Show less" : label;
    });
    return box;
  }

  function step({ icon = "loader-circle", what, meta = "", path = null }) {
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
    (run || startRun(false)).tl.append(s);
    return { s, node, row, meta: $(".meta", row) };
  }

  function setBody(st, node, n, unit) {
    $(":scope > .step-body", st.s)?.remove();
    const b = body(node, n, unit);
    b.hidden = st.row.getAttribute("aria-expanded") !== "true";
    st.s.append(b);
  }

  const relPath = (p) => (p && p.startsWith(`${project}/`) ? p.slice(project.length + 1) : p);

  function toolStep(call) {
    const args = call.arguments || call.args || {};
    const [verb, key] = STEP_WORDS[call.name] || [call.name, null];
    const target = key ? String(args[key] ?? "") : "";
    const path = FILE_TOOLS.has(call.name) && args.path ? relPath(String(args.path)) : null;
    const st = step({ what: [`${verb} `, el("span", { className: "path", textContent: path || target })], path });
    count(["read", "edit", "write", "bash"].includes(call.name) ? call.name : "other");
    steps.set(call.id, st);
    return st;
  }

  function finishStep(st, result, isError, ms) {
    st.node.replaceChildren(svgIcon(isError ? "circle-alert" : "circle-check"));
    st.s.classList.toggle("failed", Boolean(isError));
    const text = (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const n = text ? text.split("\n").length : 0;
    st.meta.textContent = ms !== undefined ? (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`) : n ? `${n} line${n > 1 ? "s" : ""}` : "";
    if (text) setBody(st, lines(text, 400), n);
  }

  function thinking(m, text) {
    if (!m.thought) {
      m.thought = step({ what: ["Thinking"] });
      m.thoughtText = "";
      m.thoughtStart = Date.now();
      count("thinking");
    }
    m.thoughtText += text;
    const para = el("div", { className: "thought" }, ...m.thoughtText.split(/\n{2,}/).map((p) => el("p", { textContent: p })));
    const n = Math.ceil(m.thoughtText.length / 80);
    setBody(m.thought, para, n, "thought");
  }

  function endThinking(m, live) {
    if (!m.thought || m.thoughtDone) return;
    m.thoughtDone = true;
    m.thought.node.replaceChildren(svgIcon("circle-check"));
    if (live) m.thought.meta.textContent = runTime(Date.now() - m.thoughtStart);
  }

  /** The answer as Markdown, its files as links that open in a tab. */
  function answer(box, text) {
    box.replaceChildren(markdownPage(text));
    for (const code of box.querySelectorAll("code")) {
      const p = code.textContent;
      if (/^[\w./-]+\.\w{1,8}$/.test(p) && !p.startsWith("/")) {
        const ref = el("button", { className: "ref", type: "button", textContent: p, title: "Open in a tab" });
        ref.addEventListener("click", () => openFile(p, project));
        code.replaceWith(ref);
      }
    }
  }

  /** An assistant message being written: its own answer box in the run. */
  function startMessage(live) {
    const r = run || startRun(live);
    const text = el("div", { className: "answer" });
    r.answers.append(text);
    message = { text, raw: "", thought: null };
    return message;
  }

  /** A whole message from Pi's history (get_messages). */
  function drawMessage(m) {
    if (m.role === "user") {
      if (run) endRun(null);
      const text = typeof m.content === "string" ? m.content : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text) you(text);
      startRun(false);
    } else if (m.role === "assistant") {
      const msg = startMessage(false);
      let text = "";
      for (const c of m.content || []) {
        if (c.type === "thinking" && c.thinking) { thinking(msg, c.thinking); endThinking(msg, false); }
        else if (c.type === "toolCall") toolStep(c);
        else if (c.type === "text") text += c.text;
      }
      if (text) answer(msg.text, text);
      spent += m.usage?.cost?.total || 0;
      if (m.usage) lastUsage = m.usage;
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
        if (tab.params.args?.[0] === "--session") tab.params.file = tab.params.args[1]; // still its row in the list
        tab.params.args = ["--slot", e.slot]; // a reconnection comes back to this Pi
        if (currentTab === tab) for (const t of workspace.tabs()) t.onShownTab?.(); // the list and Details follow it
        command({ type: "get_state" }, (data) => { state = data || {}; showState(); setWorking(Boolean(state.isStreaming)); });
        command({ type: "get_messages" }, (data) => {
          col.replaceChildren();
          steps.clear();
          run = null;
          spent = 0;
          (data?.messages || []).forEach(drawMessage);
          if (run) endRun(null);
          showContext();
          scroller.scrollTop = scroller.scrollHeight;
        });
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
      case "agent_settled": setWorking(false); endRun(state.model?.id || state.model?.name || ""); break;
      case "message_start":
        if (e.message?.role === "user") {
          if (run) endRun(null);
          const m = e.message;
          you(typeof m.content === "string" ? m.content : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n"));
          startRun(true);
        } else if (e.message?.role === "assistant") startMessage(true);
        break;
      case "message_update": {
        const a = e.assistantMessageEvent || {};
        const m = message || startMessage(true);
        if (a.type === "text_delta") { m.raw += a.delta; endThinking(m, true); m.text.textContent = m.raw; }
        else if (a.type === "thinking_delta") thinking(m, a.delta);
        else if (a.type === "toolcall_end" && a.toolCall) { endThinking(m, true); toolStep(a.toolCall); }
        break;
      }
      case "message_end":
        if (e.message?.role === "assistant" && message) {
          const text = (e.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
          endThinking(message, true);
          if (text) answer(message.text, text);
          else message.text.remove();
          spent += e.message.usage?.cost?.total || 0;
          if (e.message.usage) lastUsage = e.message.usage;
          showContext();
          message = null;
        }
        break;
      case "tool_execution_start":
        if (!steps.has(e.toolCallId)) toolStep({ id: e.toolCallId, name: e.toolName, arguments: e.args });
        break;
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
    if (e.method === "notify") { flashStatus(e.message || e.title || ""); return; }
    const card = el("div", { className: "card chat-ask" }, el("h2", { textContent: e.title || "Pi asks" }), e.message ? el("p", { textContent: e.message }) : null);
    const reply = (fields) => { backend.termWrite(id, `${JSON.stringify({ type: "extension_ui_response", id: e.id, ...fields })}\n`); card.remove(); };
    const actions = el("div", { className: "btns" });
    if (Array.isArray(e.options) && e.options.length) {
      for (const option of e.options) {
        const value = typeof option === "string" ? option : option.value ?? option.label;
        const b = el("button", { className: "secondary", textContent: typeof option === "string" ? option : option.label ?? String(value) });
        b.addEventListener("click", () => reply({ value }));
        actions.append(b);
      }
    } else if (e.method === "input" || e.method === "editor") {
      const field = el("input", { value: e.value || "" });
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

  let saidOld = false; // the old-picker notice, once
  function onBytes(bytes) {
    lineBuf += decoder.decode(bytes, { stream: true });
    let at;
    while ((at = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, at).trim();
      lineBuf = lineBuf.slice(at + 1);
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch {
        // Not JSON: a picker from before the conversation view started its own screen
        // instead (its traceback, line by line). Said once, plainly, with the way out.
        if (!saidOld) {
          saidOld = true;
          notice("The picker on the VM is too old for this view. Reconnect: Pier offers to update it (or Settings > Connection). Until then, Settings > Terminals > Pi in tmux works.", "error");
        }
        continue;
      }
      onEvent(e);
    }
  }

  // --- the composer --------------------------------------------------------------------

  function showState() {
    const m = state.model;
    modelBtn.textContent = `${m ? m.id || m.name || m : "model"} ▾`;
    thinkBtn.textContent = `thinking: ${state.thinkingLevel || "default"} ▾`;
    if (state.sessionName) { tab.title = state.sessionName; workspace.show(tab); }
    showContext();
  }

  /** The ring: the context Pi's last message used, against the model's window. */
  function showContext() {
    const window = state.model?.contextWindow;
    const used = lastUsage ? (lastUsage.input || 0) + (lastUsage.cacheRead || 0) + (lastUsage.cacheWrite || 0) + (lastUsage.output || 0) : 0;
    ring.hidden = !window || !used;
    tab.context = ring.hidden ? null : { pct: Math.min(100, Math.round((used / window) * 100)), used, window, spent, model: state.model?.id, usage: lastUsage };
    for (const t of workspace.tabs()) t.onContext?.(); // Details' Context card (project.js)
    if (ring.hidden) return;
    const pct = Math.min(100, Math.round((used / window) * 100));
    ring.dataset.level = pct >= 95 ? "full" : pct >= 80 ? "high" : "ok";
    $(".used", ring).setAttribute("stroke-dasharray", `${pct} 100`);
    ring.title = `Context: ${pct}% used`;
    ring.setAttribute("aria-label", ring.title);
    ring.dataset.pct = pct;
    ring.dataset.used = used;
  }

  ring.addEventListener("click", () => {
    const w = state.model?.contextWindow || 0;
    const u = lastUsage || {};
    const kv = (k, v) => el("div", { className: "kv" }, el("span", { textContent: k }), el("span", { textContent: v }));
    const card = el("div", { className: "ctxcard" },
      el("h3", {}, "Context", el("span", { textContent: `${ring.dataset.pct}%` })),
      el("div", { className: "meter" }, el("i", { style: `width: ${ring.dataset.pct}%` })),
      kv("Used", `${tokens(Number(ring.dataset.used))} of ${tokens(w)} tokens`),
      el("hr"), kv("This conversation", dollars(spent) || "cost unknown"),
      kv("Tokens in", `${tokens(u.input || 0)}${u.cacheRead ? `, ${tokens(u.cacheRead)} cached` : ""}`), kv("Tokens out", tokens(u.output || 0)),
      el("hr"), kv("Model", state.model?.id || "?"));
    popCard(ring, card);
  });

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
  /** text (an @reference) typed into the message, after a space. */
  function mention(text) {
    input.value += `${input.value && !input.value.endsWith(" ") ? " " : ""}${text} `;
    input.focus();
  }
  tab.mention = mention;

  // +: a file from this PC (saved in the project, then mentioned), or a file of the project.
  plus.addEventListener("click", () => showMenu(plus, [
    ["Add a file from this PC", async () => {
      const paths = await backend.pickFiles();
      if (!paths.length) return;
      const results = (await backend.pasteFiles(paths, project).catch((e) => { notice(String(e), "error"); return []; })) || [];
      for (const r of results) {
        if (r.error) notice(r.error, "error");
        else if (r.reference) mention(r.reference);
      }
      input.focus();
    }, false, { icon: "paperclip" }],
    ["Mention a project file (@)", () => { input.value += "@"; input.focus(); }, false, { icon: "at-sign" }],
  ]));
  // The model: the palette of Settings (ui.js), above the composer: search, the name, its
  // provider, a check on the one in use.
  modelBtn.addEventListener("click", () => command({ type: "get_available_models" }, (data) => {
    const models = data?.models || [];
    const key = (m) => `${m.provider}/${m.id}`;
    pickPalette(modelBtn, {
      items: models.map((m) => ({ value: key(m), label: m.id, detail: m.provider })),
      current: state.model ? `${state.model.provider}/${state.model.id}` : null,
      placeholder: "Search models",
      onPick: (v) => {
        const m = models.find((x) => key(x) === v);
        if (m) command({ type: "set_model", provider: m.provider, modelId: m.id }, () => command({ type: "get_state" }, (d) => { state = d || {}; showState(); }));
      },
    });
  }));
  thinkBtn.addEventListener("click", () => command({ type: "get_available_thinking_levels" }, (data) => {
    const levels = data?.levels || [];
    showMenu(thinkBtn, levels.map((level) => [level, () => command({ type: "set_thinking_level", level },
      () => command({ type: "get_state" }, (d) => { state = d || {}; showState(); })), false, { icon: level === state.thinkingLevel ? "check" : null }]));
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
  tab.onClose = () => { clearInterval(clock); if (id !== null) backend.termClose(id); };
  tab.onShow = () => input.focus();
  attach();
}

/** A small card over an anchor (the context ring's): closed by Escape, a click elsewhere,
 *  or the anchor clicked again. */
function popCard(anchor, card) {
  const open = document.querySelector(".pop-card");
  if (open) {
    open.close();
    if (open.anchor === anchor) return;
  }
  const box = el("div", { className: "pop-card", tabIndex: -1 }, card);
  box.anchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", anchor.getAttribute("aria-label") || "");
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.right - box.offsetWidth, innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.max(8, r.top - box.offsetHeight - 6)}px`;
  box.focus();
  box.close = () => {
    box.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", close, true);
    document.removeEventListener("keydown", close, true);
  };
  // A click on the anchor is left to it: its own click closes the card (above).
  const close = (e) => {
    if (e.type === "keydown" ? e.key !== "Escape" : box.contains(e.target) || anchor.contains(e.target)) return;
    box.close();
    if (e.type === "keydown") anchor.focus();
  };
  document.addEventListener("pointerdown", close, true);
  document.addEventListener("keydown", close, true);
}
