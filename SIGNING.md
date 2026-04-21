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

## Tauri auto-updater (optional, any OS)

For in-app auto-updates:

```bash
cd pane && pnpm tauri signer generate -w ~/.tauri/stickyinc.key
```

Add the **private** key (`~/.tauri/stickyinc.key`) to GitHub secrets as `TAURI_SIGNING_PRIVATE_KEY`, and its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Ship the **public** key inside `tauri.conf.json` under `plugins.updater.pubkey`.

## Until you set these up

The CI workflow still runs. Secrets that are unset evaluate to empty strings, and tauri-action happily produces unsigned artifacts. First-launch warnings on the user's OS are expected.
