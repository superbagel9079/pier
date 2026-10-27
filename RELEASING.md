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

Give the key a password (`cargo tauri signer generate` asks for one), and put it in
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: a copy of the key file alone then signs nothing.
A key made without one can be given one by generating a new key (see "A new key" below).

The CI hands the key only to the steps that sign, and only for a tag: a push to `main` or
a pull request is built unsigned, so nothing a branch builds (a `build.rs` of a
dependency, a cached program) ever sees it. A tag is built without any cache.

Keep a copy of the private key somewhere safe. Without it, no new version can reach the
Piers already installed: they would have to be installed again by hand, with a new key.

## Once: the repository's settings

What the CI cannot do for itself, to do on GitHub (Settings), by the owner:

- **Rules > Rulesets**: a ruleset on tags `v*` (only the owner creates, moves or deletes
  them), and one on `main` (no force push, no deletion, changes through a pull request
  whose checks passed).
- **Environments > New environment** `release`, with yourself as **required reviewer**:
  the release job waits for your approval before it makes the draft. To keep the key
  there and nowhere else, move `TAURI_SIGNING_PRIVATE_KEY` (and its password) from the
  repository's secrets to that environment's.
- **Security > Private vulnerability reporting**: on (see SECURITY.md), and **Dependabot
  alerts** and **security updates**: on (`.github/dependabot.yml` proposes the updates).

With the `gh` command line, the reporting and the alerts:

```bash
gh api -X PUT repos/superbagel9079/pier/private-vulnerability-reporting
gh api -X PUT repos/superbagel9079/pier/vulnerability-alerts
```

## Each release

1. Raise the version, the same in both files:
   - `client/src-tauri/Cargo.toml` (`version = "0.3.0"`)
   - `client/src-tauri/tauri.conf.json` (`"version": "0.3.0"`)
   and run `cargo build` once, so `Cargo.lock` follows.
2. Commit, merge into `main`, then tag and push the tag. The tag's message is what Pier
   shows as the notes of the update (Settings > Updates), followed by the release's page:
   ```bash
   git tag -a v0.3.0 -m "What changed, in a few lines."
   git push origin v0.3.0
   ```
   The CI stops if the tag is not the version of both files.
3. The CI builds Windows, macOS and Linux, signs the installers for the updater (each
   signature carries the version it was made for: Pier refuses one that does not, so an
   older release cannot be passed off as a newer one), and, once you approve the
   `release` environment, makes a **draft** release with the files, their SHA-256 and
   `latest.json`.
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

## A new key

Pier trusts one public key, the one it was built with. To move to a new key without
leaving anyone behind:

1. `cargo tauri signer generate -w ~/.tauri/pier-updater-2.key` (with a password).
2. Put the new **public** key in `tauri.conf.json`, and make a release with it, **signed
   with the old key** (the secrets unchanged). Every Pier installs it: it was signed with
   the key it trusts, and from then on trusts the new one.
3. Then put the new private key and its password in the secrets. The next releases are
   signed with it.

Keep the old key until nearly every Pier has taken the release of step 2: one that has
not can only be updated with the old key.

## If the key leaks

Someone with the key, and a way to publish a release here (a stolen GitHub session, a
workflow taken over), can make every Pier install what they want. So, at once:

1. Revoke what could publish: change the GitHub password and sessions, check the
   repository's deploy keys, tokens and Actions secrets, and look at the latest runs.
2. Delete any release you did not make, and delete the `TAURI_SIGNING_PRIVATE_KEY`
   secret.
3. Make a new key (above, step 1), and a release signed with it, with the new public key
   in `tauri.conf.json`. The Piers installed cannot take it (it is not signed with the key
   they trust): it is for new installations.
4. Tell the users, in the README and the release notes: the Piers installed must be
   installed again by hand, from that release. Until then they would accept an update
   signed with the leaked key.
