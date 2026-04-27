# Signing StickyInc installers

Unsigned installers work — users just see a Gatekeeper (macOS) or SmartScreen (Windows) warning on first launch. Below is the optional path to properly signed + notarized releases.

## macOS (signed + notarized `.dmg`)

1. **Apple Developer Program** — $99/year at [developer.apple.com/programs](https://developer.apple.com/programs/).
2. In Xcode → Settings → Accounts, add your Apple ID. Create a **Developer ID Application** certificate.
3. Export the cert as a `.p12` with a password.
4. Create an [app-specific password](https://support.apple.com/en-us/HT204397) for your Apple ID (for notarization).
5. In the GitHub repo → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | 10-character team ID |

Next tag push → CI produces a signed + notarized `.dmg`.

## Windows (signed `.msi`)

1. Obtain a code-signing cert — [SSL.com](https://www.ssl.com/certificates/ev-code-signing/) / [Sectigo](https://www.sectigo.com/). EV certs avoid SmartScreen; standard certs have a reputation warm-up period.
2. Export to `.pfx` with a password.
3. Add to `pane/src-tauri/tauri.conf.json` under `bundle.windows`:
   ```json
   "windows": {
     "certificateThumbprint": "<thumbprint or null>",
     "digestAlgorithm": "sha256",
     "timestampUrl": "http://timestamp.digicert.com"
   }
   ```
4. Add GitHub secrets for the cert and wire them into a custom workflow step using `signtool sign`. (tauri-action itself doesn't handle Windows code signing directly; see the [Tauri docs](https://v2.tauri.app/distribute/sign/windows/) for the official approach.)

## Releasing with the auto-updater

The pane checks `https://github.com/Astralchemist/stickyinc/releases/latest/download/latest.json` ~15s after launch and surfaces a one-line bulge if a newer signed bundle is available. To produce a tagged release that this update flow will accept, the CI build must sign the bundle with the same minisign keypair whose public half ships inside the binary.

### One-time setup (per repo)

1. **Generate a keypair.** From a checkout of this repo:
   ```bash
   cd pane && pnpm tauri signer generate -w ~/.tauri/stickyinc.key
   ```
   Pick a strong password when prompted. This produces two files:
   - `~/.tauri/stickyinc.key` — the **private** key (keep this secret).
   - `~/.tauri/stickyinc.key.pub` — the **public** key.

2. **Ship the public half.** Copy the entire contents of `~/.tauri/stickyinc.key.pub` into `pane/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, replacing whatever placeholder is there. Commit that change. Every installed binary will refuse to apply an update that wasn't signed by the matching private key, so a leaked or rotated key means every installed user is stuck on their current version until they reinstall.

3. **Add the private half as GitHub Actions secrets.** Repo → Settings → Secrets and variables → Actions → New repository secret. Add two:

   | Secret | Value |
   |---|---|
   | `TAURI_SIGNING_PRIVATE_KEY` | full contents of `~/.tauri/stickyinc.key` (the file, not the path) |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you typed during `signer generate` |

   The workflow at `.github/workflows/build.yml` reads both and passes them to tauri-action. Empty values cause tauri-action to fail with `Missing comment in secret key` — keep both set or unset together.

4. **Cut a release.** Push a tag (`git tag v0.5.2 && git push --tags`); the workflow builds signed installers, generates `latest.json`, and uploads everything to the release. From this point installed clients will pick it up on next launch.

## Until you set these up

The CI workflow still runs. Secrets that are unset evaluate to empty strings, and tauri-action happily produces unsigned artifacts. First-launch warnings on the user's OS are expected.
