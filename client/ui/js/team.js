// The Team page of Setup, giving a conversation to a colleague, and what waits for this
// account's Pis wherever the user is.

// ============================================================================
// Colleagues each have their Pier, their VM and their Pis; they meet in the repository
// (see "the team" in the picker): tasks are issues labelled pi-task, a Pi asks another
// account's Pis for a review, a conversation is handed to a colleague on a pi-handoff/
// branch. Pier starts a Pi on a task or a review with a fixed prompt the picker writes
// (--agent-task): never with what a colleague wrote.
// ============================================================================

const AGENT_WAKE_LABELS = {
  off: ["Do nothing", "Tasks, reviews and conversations for you are listed here; nothing else happens."],
  ask: ["Notify me", "A notification for each new one; a Pi starts on your click."],
  auto: ["Start a Pi by itself", "While Pier is connected, a Pi starts on each new review asked of you and each new task a human wrote (not one a Pi wrote), one every two minutes, 3 an hour and 10 a day at most. Merges still follow the Git page's setting."],
};

const projectLabel = (path) => String(path || "").replace(/^\/home\/[^/]+/, "~");

/** A new Pi on a task or a review: the picker gives it its prompt. */
function startAgentPi(project, kind, number) {
  openPiTerminal(project, projectLabel(project), ["--agent-task", kind, String(number)]);
}

/** A colleague's conversation taken over, then opened with a word on where their work is
 *  (typed into that Pi, not sent: the user reads it first). Only fixed words are typed:
 *  their note, written by whoever pushed the branch, is shown in Pier, never given to
 *  Pi as if the user had written it. */
async function takeHandoff(project, branch) {
  const taken = await backend.handoffTake(project, branch);
  const tab = openPiTerminal(project, projectLabel(project), ["--session", taken.session]);
  const words = ["I'm continuing a colleague's conversation here."];
  if (taken.branch) words.push(`Their work is on the branch ${taken.branch} (fetched into origin/${taken.branch}): switch to it before going on.`);
  // The tab learns its Pi's tmux session once attached: typed there, not in another Pi of the project.
  setTimeout(() => backend.api(["type", words.join(" "), project, tab?.slot || ""]).catch(() => {}), 4000);
  return taken;
}

/** What a colleague's handoff says about itself, as Pier shows it: their name and note
 *  come from the branch, which anyone who may push to the repository can write. */
const handoffSaid = (taken) => [
  `${visibleText(taken.from || "Their")} conversation is yours now${taken.branch ? `, with the branch ${taken.branch}` : ""}.`,
  taken.note ? `Their note (from the branch, not verified): ${visibleText(taken.note)}` : "",
].filter(Boolean).join(" ");

function makeTeamManager(box, currentProject) {
  const error = el("p", { className: "error", hidden: true });
  const notice = el("p", { className: "notice", hidden: true });
  const body = el("div");
  const refresh = el("button", { className: "link", textContent: "refresh", title: "Ask the forge again" });
  refresh.addEventListener("click", () => load());
  const bar = el("div", { className: "toolbar resource-bar" }, el("span", { className: "dim small", textContent: "Tasks, reviews and conversations shared with your colleagues' Pis." }), refresh);
  box.replaceChildren(bar, error, notice, body);
  const say = (text) => { notice.hidden = !text; notice.textContent = text || ""; };
  let data = null;

  async function load() {
    const project = currentProject();
    if (!project) return;
    showError(error, "");
    try {
      data = await backend.api(["team", project]);
    } catch (e) {
      showError(error, String(e));
      return;
    }
    if (data.errors?.length) showError(error, data.errors.join(" · "));
    render();
  }

  const action = (text, title, run) => {
    const b = el("button", { className: "link", textContent: text, title });
    b.addEventListener("click", run);
    return b;
  };
  const line = (name, detail, title, ...actions) => el("li", { className: "two-lines", title: title || "" },
    el("div", { className: "line" }, el("span", { className: "name", textContent: name }), el("span", { className: "dim" }), ...actions),
    detail ? el("div", { className: "desc dim small", textContent: detail }) : null);
  const copyLink = (url) => action("copy link", "Its address, to open in a browser", async () => {
    try { await backend.copyText(url || ""); say(`Copied: ${url}`); } catch (e) { showError(error, String(e)); }
  });

  function render() {
    body.innerHTML = "";
    bar.hidden = !data?.link;
    if (!data) return;
    if (!data.link) {
      body.append(el("p", { className: "dim small", textContent: "Connect this project to a repository first, in the Git page: the team meets there." }));
      return;
    }
    const project = currentProject();
    const waiting = (data.waiting || []).filter((w) => w.kind !== "task");
    if (waiting.length) {
      body.append(el("h2", { textContent: "For you" }));
      const ul = el("ul", { className: "resource-items" });
      for (const w of waiting) {
        if (w.kind === "review") {
          ul.append(line(`Review #${w.number} ${w.title || ""}`, `asked by ${w.from || "a colleague"}`, "",
            action("let a Pi review it", "A new Pi reads the pull request and posts its review", () => startAgentPi(project, "review", w.number))));
        } else if (w.kind === "handoff") {
          ul.append(line(`A conversation from ${w.from || "a colleague"}`, w.branch, "",
            action("take it over", "It joins your conversations here and opens in a Pi", async () => {
              try {
                const taken = await takeHandoff(project, w.branch);
                say(handoffSaid(taken));
                load();
              } catch (e) { showError(error, String(e)); }
            })));
        }
      }
      body.append(ul);
    }

    body.append(el("h2", { textContent: `Tasks · ${data.tasks.length}` }));
    const tasks = el("ul", { className: "resource-items" });
    for (const t of data.tasks) {
      const state = t.taken ? `taken by ${t.taken_by}'s Pi` : "free";
      tasks.append(line(`#${t.number} ${t.title}`, [state, t.author ? `from ${t.author}` : ""].filter(Boolean).join(" · "), t.url || "",
        copyLink(t.url), ...(t.taken ? [] : [action("let a Pi do it", "A new Pi takes this task, works on pi/task-N and opens a pull request", () => startAgentPi(project, "task", t.number))])));
    }
    if (!data.tasks.length) tasks.append(el("li", { className: "dim small note", textContent: "No task yet. A task is an issue labelled pi-task: add one here, or ask a Pi to split a large piece of work." }));
    body.append(tasks);
    const add = el("button", { className: "secondary", textContent: "New task…" });
    add.addEventListener("click", () => taskDialog());
    body.append(el("div", { className: "toolbar" }, add));

    body.append(el("h2", { textContent: `Who works on what · ${data.prs.length}` }));
    const prs = el("ul", { className: "resource-items" });
    for (const pr of data.prs) {
      const [mark, label] = CHECK_MARKS[pr.checks || "none"] || CHECK_MARKS.none;
      const asked = pr.requested?.length ? `review asked: ${pr.requested.join(", ")}` : "";
      prs.append(line(`#${pr.number} ${pr.title}`, [pr.author === data.login ? "you" : pr.author, pr.head, mark && `${mark} ${label}`, asked].filter(Boolean).join(" · "),
        pr.url || "", copyLink(pr.url)));
    }
    if (!data.prs.length) prs.append(el("li", { className: "dim small note", textContent: "No open pull request." }));
    body.append(prs);

    body.append(el("h2", { textContent: "When something waits for your Pis" }));
    const wake = el("select", { id: "team-wake" });
    for (const [value, [label]] of Object.entries(AGENT_WAKE_LABELS)) wake.add(new Option(label, value));
    wake.value = data.link.agents || "ask";
    const wakeHint = el("p", { className: "hint", textContent: AGENT_WAKE_LABELS[wake.value][1] });
    wake.addEventListener("change", async () => {
      wakeHint.textContent = AGENT_WAKE_LABELS[wake.value][1];
      try {
        Object.assign(data.link, await backend.repoSettings(project, data.link.mode, data.link.merge_method, wake.value));
      } catch (e) {
        showError(error, String(e));
        wake.value = data.link.agents || "ask";
      }
    });
    body.append(el("div", { className: "grid" }, el("label", { htmlFor: "team-wake", textContent: "Pier" }), wake), wakeHint,
      el("p", { className: "hint", textContent: `You are ${data.login} on the forge. A Pi takes a task before working on it, so two Pis never do the same one; a pull request gets at most 3 reviews from one account's Pis, then a human decides. What colleagues and their Pis wrote reaches your Pi as data to read, never as orders.` }));
  }

  function taskDialog() {
    const title = el("input", { placeholder: "what to do, in a line", spellcheck: false });
    const description = el("textarea", { className: "editor", rows: 8, placeholder: "the details: what done looks like, files, constraints", spellcheck: false });
    const problem = dialogError();
    const go = el("button", { textContent: "Add the task" });
    const dialog = resourceDialog("A task for the Pis", [
      el("div", { className: "grid fields" }, el("label", { textContent: "Title" }), title), description,
      el("p", { className: "hint", textContent: "An issue labelled pi-task in the repository: every Pi of the team can take it." }), problem], [go]);
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        const task = await backend.taskCreate(currentProject(), title.value.trim(), description.value);
        dialog.close();
        say(`Task #${task.number} added.`);
        load();
      } catch (e) { showError(problem, String(e)); } finally { go.disabled = false; }
    });
    title.focus();
  }

  let loadedFor = null;
  return {
    load,
    shown() { if (currentProject() !== loadedFor) { loadedFor = currentProject(); load(); } },
  };
}

/** "Give to a colleague…" on a conversation: who, a note, and what leaves the VM. */
async function giveDialog(project, session) {
  let people = { collaborators: [] };
  try { people = await backend.api(["collaborators", project]); } catch (e) {
    flashStatus(String(e));
    return;
  }
  const OTHER = "__other__";
  const who = el("select");
  for (const name of people.collaborators) who.add(new Option(name, name));
  who.add(new Option("Someone else…", OTHER));
  const other = el("input", { placeholder: "their login on the forge", spellcheck: false, hidden: people.collaborators.length > 0 });
  if (!people.collaborators.length) who.value = OTHER;
  who.addEventListener("change", () => { other.hidden = who.value !== OTHER; if (!other.hidden) other.focus(); });
  const note = el("textarea", { className: "editor", rows: 4, placeholder: "a word for them: where you stopped, what is left (optional)", spellcheck: false });
  const problem = dialogError();
  const go = el("button", { textContent: "Give it" });
  const dialog = resourceDialog(`Give "${conversationTitle(session)}" to a colleague`, [
    el("div", { className: "grid fields" }, el("label", { textContent: "To" }), el("div", {}, who, other)), note,
    el("p", { className: "hint", textContent: "The whole conversation goes to the repository, on a branch for them: everything said in it, including what was pasted (a key, a password) and what Pi read. Everyone who can read this repository can read it too, and it stays readable by its commit after the branch is deleted: Pier refuses a public repository. Its branch, if it is a pi/… one, is pushed too. They take it from their Team page; the branch is then deleted." }),
    problem], [go]);
  go.addEventListener("click", async () => {
    const to = who.value === OTHER ? other.value.trim() : who.value;
    go.disabled = true;
    try {
      const given = await backend.handoffGive(project, session.path, to, note.value);
      dialog.close();
      flashStatus(`Given to ${given.to}${given.branch ? `, with ${given.branch}` : ""}`);
    } catch (e) { showError(problem, String(e)); } finally { go.disabled = false; }
  });
}

// What waits for this account's Pis, wherever the user is: a notification for each new
// one, and with the repository set to "Start a Pi by itself", a Pi on it (one per round,
// AUTO_PER_HOUR an hour and AUTO_PER_DAY a day at most, never on a task a Pi wrote:
// Pis asking each other would otherwise start Pis without end).
const AUTO_PER_HOUR = 3;
const AUTO_PER_DAY = 10;
const AUTO_KEY = "pier.team.autoStarted";

/** Whether one more Pi may start by itself now; counted in this PC's storage. */
function autoStartAllowed() {
  let times = [];
  try { times = JSON.parse(localStorage.getItem(AUTO_KEY) || "[]"); } catch { times = []; }
  const now = Date.now();
  times = (Array.isArray(times) ? times : []).filter((t) => typeof t === "number" && now - t < 86400000);
  if (times.length >= AUTO_PER_DAY || times.filter((t) => now - t < 3600000).length >= AUTO_PER_HOUR) return false;
  times.push(now);
  try { localStorage.setItem(AUTO_KEY, JSON.stringify(times)); } catch { /* counted for this window only */ }
  return true;
}

(() => {
  const seen = new Set();
  let first = true;
  vm.on("team", (message) => {
    const waiting = message.data?.waiting || [];
    let started = false;
    for (const w of waiting) {
      const key = `${w.repo}|${w.kind}|${w.number || w.branch}`;
      if (seen.has(key)) continue;
      if (first || w.agents === "off") { seen.add(key); continue; } // there before this window: listed in Team, not announced
      const what = w.kind === "review" ? `${w.from || "A colleague"} asks your Pis to review #${w.number}`
        : w.kind === "handoff" ? `${w.from || "A colleague"} gives you a conversation`
        : `New task #${w.number}: ${w.title || ""}`;
      if (w.agents === "auto" && (w.kind === "review" || w.kind === "task") && !w.by_pi) {
        if (started) continue; // one Pi per round: this one at the next
        if (!autoStartAllowed()) {
          seen.add(key);
          backend.notify("For your Pis", `${projectLabel(w.project)}: ${what}. Pier started ${AUTO_PER_HOUR} Pis this hour or ${AUTO_PER_DAY} today by themselves: start this one from Setup > Team.`).catch(() => {});
          continue;
        }
        started = true;
        seen.add(key);
        startAgentPi(w.project, w.kind, w.number);
        backend.notify("A Pi started for the team", `${projectLabel(w.project)}: ${what}.`).catch(() => {});
        continue;
      }
      seen.add(key);
      backend.notify("For your Pis", `${projectLabel(w.project)}: ${what}. See Setup > Team.`).catch(() => {});
      flashStatus(`${what}: Setup > Team`);
    }
    first = false;
  });
})();
