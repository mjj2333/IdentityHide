# iOS build via GitHub Actions (no Mac required)

This builds Redact.ID for iOS on a GitHub-hosted **Apple-Silicon macOS runner**
with the latest Xcode, signs it, and uploads it to **TestFlight**. You then
install it on your iPhone from the TestFlight app. No local Mac needed to build
or submit (an Intel Mac can still run Safari Web Inspector to debug the WebView).

Files:
- `.github/workflows/ios.yml` — the pipeline (manual trigger)
- `ios/App/fastlane/Fastfile` + `Appfile` + `Gemfile` — build + upload
- `ios/App/App.xcodeproj/.../xcschemes/App.xcscheme` — shared scheme (required by CI)

## One-time setup

### 1. Create an App Store Connect API key
1. App Store Connect → **Users and Access** → **Integrations** tab → **App Store Connect API**.
2. **Generate API Key** (Team Keys). Give it a name (e.g. "GitHub CI") and the
   **Admin** role. *(Admin is the safe choice — it can both upload to TestFlight
   and create the signing certificate/profile that automatic signing needs.
   "App Manager" can upload but may fail to create signing assets.)*
3. **Download the `.p8` file** — you only get one chance to download it. Also
   note the **Key ID** (next to the key) and the **Issuer ID** (top of the Keys
   list).

### 2. Base64-encode the .p8
GitHub secrets are single-line, so encode the key file. On **Windows PowerShell**:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\AuthKey_XXXXXXXXXX.p8")) | Set-Clipboard
```
(That copies the base64 string to your clipboard.)

### 3. Add the GitHub repository secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**.
Add these four:

| Secret name         | Value                                                        |
|---------------------|-------------------------------------------------------------|
| `ASC_KEY_ID`        | the API **Key ID** from step 1                              |
| `ASC_ISSUER_ID`     | the **Issuer ID** from step 1                               |
| `ASC_KEY_P8_BASE64` | the base64 string from step 2                               |
| `APPLE_TEAM_ID`     | `2MG33HGYPM`                                                 |

## Running a build
Repo → **Actions** tab → **iOS TestFlight** → **Run workflow** → Run.
It takes ~10–15 min. On success the build appears in App Store Connect →
TestFlight (after a few minutes of Apple-side processing), and you install it
on your iPhone via the **TestFlight** app.

## Notes / gotchas
- **Trigger is manual** (`workflow_dispatch`) on purpose — macOS runner minutes
  are limited (and 10x-weighted on private repos). Build when you mean to.
- **Build number** = the CI run number, so it always increases. App version
  stays `1.0` (MARKETING_VERSION) until you bump it in the Xcode project.
- **Ad IDs are still Google TEST ids** in the code — that's intended through
  testing. Swap to the real iOS ids at release (see `project_ios_launch` memo).
- **First run may fail on signing.** If `-allowProvisioningUpdates` can't create
  the distribution cert/profile headlessly, switch to Fastlane `match` (see the
  note at the bottom of the Fastfile). Everything else stays the same.
- The **first TestFlight upload** requires you to answer the export-compliance
  question in App Store Connect once (Redact.ID uses only standard HTTPS, so the
  answer is typically "no" to proprietary encryption — set
  `ITSAppUsesNonExemptEncryption` in Info.plist later to skip the prompt).
