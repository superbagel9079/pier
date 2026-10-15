// Starting up: loaded last, once every part is defined.

// ============================================================================
// Start
// ============================================================================

applyTheme();
backend.setLogLevel(prefs.debugLogs).catch(() => {});
(async () => {
  settings = await backend.loadSettings();
  if (settings) toLogin();
  else {
    fillSetup(null);
    showConnect("setup");
  }
})();
