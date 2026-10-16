# Releasing Pier

Pier updates itself: it reads `latest.json` in the latest release of this repository,
and installs a new version only if it was signed with the project's updater key. So a
release is a tag, a CI run, and one click.

## Once: the updater's key

The key pair is made with `cargo tauri signer generate`. The public half is in
`client/src-tauri/tauri.conf.json` (`plugins > updater > pubkey`); the private half stays
off the repository, on the computer that made it and in the repository's secrets:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY -R superbagel9079/pier < ~/.tauri/pier-updater.key
```

The key has no password: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is only needed for a key
made with one (GitHub refuses an empty secret; the workflow passes an empty value itself).

Keep a copy of the private key somewhere safe. Without it, no new version can reach the
Piers already installed: they would have to be installed again by hand, with a new key.

## Each release

1. Raise the version, the same in both files:
   - `client/src-tauri/Cargo.toml` (`version = "0.3.0"`)
   - `client/src-tauri/tauri.conf.json` (`"version": "0.3.0"`)
   and run `cargo build` once, so `Cargo.lock` follows.
2. Commit, merge into `main`, then tag and push the tag:
   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```
3. The CI builds Windows, macOS and Linux, signs the installers for the updater, and
   makes a **draft** release with the files, their SHA-256 and `latest.json`.
4. On GitHub, open the draft, write what changed (the notes are generated from the pull
   requests, edit them freely), and **Publish**.

From then on, every Pier finds the new version within six hours (or at once with
Settings > Updates > Check now), shows "update to 0.3.0" in its top bar, and installs it
on a click. The picker on the VM follows: the new Pier carries it and updates it.

## If something goes wrong

- **No latest.json in the release**: the `TAURI_SIGNING_PRIVATE_KEY` secret is missing or
  empty; the CI log of the release job says "no updater signatures".
- **Pier says the signature is invalid**: the files were changed after signing, or signed
  with another key. Build the release again from its tag.
- **A release to withdraw**: delete it (or turn it back into a draft) on GitHub; Pier then
  sees the previous one as the latest.
