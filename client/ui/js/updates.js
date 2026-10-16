// Updating Pier itself: Settings > Updates, and a word in the top bar when a new Pier is
// out. The check, the download, the signature and the installation are Tauri's updater
// (update_check and update_install in lib.rs).

const UPDATE_EVERY = 6 * 3600 * 1000;
let updateFound = null; // { current, version, notes, date } once a newer Pier is known
let updateTimer = null;

function showUpdate(info) {
  updateFound = info?.version ? info : null;
  const button = $("#btn-update");
  button.hidden = !updateFound;
  button.textContent = updateFound ? `update to ${updateFound.version}` : "";
  $("#update-state").textContent = updateFound
    ? `Pier ${updateFound.current} · version ${updateFound.version} is out${updateFound.date ? ` (${updateFound.date.slice(0, 10)})` : ""}.`
    : info ? `Pier ${info.current} · up to date.` : "";
  $("#update-found").hidden = !updateFound;
  $("#update-notes").textContent = updateFound?.notes || "No notes for this version.";
}

async function checkForUpdate(quiet) {
  $("#update-error").hidden = true;
  if (!quiet) $("#update-state").textContent = "Looking for a new Pier…";
  try {
    showUpdate(await backend.updateCheck());
  } catch (e) {
    if (!quiet) showError($("#update-error"), String(e));
  }
}

function scheduleUpdateChecks() {
  clearInterval(updateTimer);
  updateTimer = null;
  if (!prefs.updateCheck) return;
  setTimeout(() => checkForUpdate(true), 8000); // once Pier is up, without slowing its start
  updateTimer = setInterval(() => checkForUpdate(true), UPDATE_EVERY);
}

$("#update-check").addEventListener("click", () => checkForUpdate(false));
$("#prefs-updatecheck").addEventListener("change", (e) => {
  prefs.updateCheck = e.target.checked;
  savePrefs();
  scheduleUpdateChecks();
});
$("#btn-update").addEventListener("click", () => {
  openPrefs();
  showPrefsPage("updates");
});

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
backend.onUpdateProgress(({ done, total }) => {
  const progress = $("#update-progress");
  progress.hidden = false;
  progress.textContent = total ? `downloading ${mb(done)} of ${mb(total)}` : `downloading ${mb(done)}`;
});

$("#update-install").addEventListener("click", async () => {
  if (!updateFound) return;
  if (!(await ask(`Install Pier ${updateFound.version} and restart? Shares are stopped first; the Pis keep running on the VM.`))) return;
  const button = $("#update-install");
  button.disabled = true;
  $("#update-error").hidden = true;
  try {
    await backend.updateInstall(); // Pier restarts once it is installed
  } catch (e) {
    showError($("#update-error"), String(e));
    $("#update-progress").hidden = true;
  } finally {
    button.disabled = false;
  }
});

scheduleUpdateChecks();
