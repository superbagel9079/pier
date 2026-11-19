// The Repository panel: the project's repository (Git) and the colleagues met there (Team),
// for the Pi in use.

/** The right side's Repository view (Details' panel), opened. */
function showRepository() {
  if (!workspace.find("project")) workspace.add("project");
  workspace.find("project")?.showRepository?.();
}

function makeRepository(tab) {
  tab.pane.append($("#tpl-repository").content.cloneNode(true));
  const $$ = (sel) => $(sel, tab.pane);
  const project = () => target?.path || null;
  // No repository connected: no Team to switch to (it works through the repository).
  const gitManager = makeGitManager($$(".git-manager"), project, (data) => {
    const linked = Boolean(data?.link);
    $$(".repository-pages").hidden = !linked;
    if (!linked && page === "team") showPage("git");
  });
  const teamManager = makeTeamManager($$(".team-manager"), project);
  let page = prefs.repositoryPage === "team" ? "team" : "git";

  function showPage(next) {
    page = next === "team" ? "team" : "git";
    for (const b of tab.pane.querySelectorAll(".repository-pages .mode")) b.classList.toggle("active", b.dataset.page === page);
    $$(".repository-git").hidden = page !== "git";
    $$(".repository-team").hidden = page !== "team";
    if (prefs.repositoryPage !== page) { prefs.repositoryPage = page; savePrefs(); }
    if (tab.shown !== false) (page === "git" ? gitManager : teamManager).shown();
  }
  for (const b of tab.pane.querySelectorAll(".repository-pages .mode")) b.addEventListener("click", () => showPage(b.dataset.page));
  const where = $$(".repository-project");
  const label = () => { where.textContent = project() ? projectLabel(project()) : "no Pi in use: start one in a project"; };

  tab.showPage = showPage;
  tab.onTargetChange = () => { label(); showPage(page); };
  tab.onShow = () => { label(); showPage(page); };
  const unlistenApprovals = vm.on("approvals", () => { if (page === "git" && tab.shown !== false) gitManager.load(); });
  const unlistenTeam = vm.on("team", () => { if (page === "team" && tab.shown !== false) teamManager.load(); });
  tab.onClose = () => { unlistenApprovals(); unlistenTeam(); };
  label();
  showPage(page);
}
