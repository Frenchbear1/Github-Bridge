# Streamline

A simple, local GitHub project manager for Windows. A tiny Node.js server runs on your computer
(`http://localhost:4545`, loopback only) and gives you a clean browser UI to:

- **Clone** any public or private GitHub repository into any folder
- **Upload** files or whole folders to a saved repository: preview, then commit and push in one click
- **Smart exclusions**: `.git`, `node_modules`, build folders, caches, logs, secrets (`.env`, `*.pem`, `*.key`) and files over 95 MB are skipped automatically; add your own patterns in Settings
- **Update Local GitHub**: runs your existing `.github-sync\Sync-GitHubProjects.ps1` silently (no Command Prompt) and shows live output
- **Remember** your projects and where they live
- Show every clone, upload and update in an **Activity** panel with progress, errors and results

There are no npm dependencies, so there is nothing to `npm install`.

## Install (Windows)

You need three things. If you already use `Sync-GitHubProjects.ps1`, you already have Git and the GitHub CLI.

1. **Node.js 18 or newer** (LTS): download from https://nodejs.org, or in a terminal run `winget install OpenJS.NodeJS.LTS`.
2. **Git for Windows**: https://git-scm.com/download/win (already installed if the sync script works).
3. **GitHub CLI**: https://cli.github.com (already installed if the sync script works).

Then get Streamline:

1. Download this repository (green **Code** button, then **Download ZIP**) and unzip it, for example to `C:\Streamline`. Or, if you have Git: `git clone https://github.com/Frenchbear1/Github-Bridge C:\Streamline`.
2. That's it. No install step.

## Start

- **Double-click `Start-Streamline.bat`.** A small window stays open while the server runs, and your browser opens to `http://localhost:4545`. Close the window to stop it.
- Prefer no window at all? Double-click **`Start-Streamline-Hidden.vbs`** instead. Stop it later with **`Stop-Streamline.bat`**.
- To start it automatically at sign-in, press `Win + R`, type `shell:startup`, and put a shortcut to `Start-Streamline-Hidden.vbs` in that folder.

## First-time setup (2 minutes)

1. Open the **Settings** tab. Streamline looks for your `GitHub Projects` folder and `.github-sync\Sync-GitHubProjects.ps1` automatically; check that both paths are right and save. (If you move the folder later, change it here.)
2. Click **Sign in to GitHub** (top right) if it is shown. Your browser opens, you enter the one-time code that appears in the Activity panel, and you are done. If you are already signed in (the sync script's "existing Windows GitHub sign-in"), nothing is needed.
3. In **Projects**, click **Import from projects folder** to save every repository that is already in your GitHub Projects folder.

## Using it

| You want to | Do this |
| --- | --- |
| Refresh everything from GitHub | Click **Update Local GitHub** (top right). Output streams into Activity. |
| Clone a repo | **Clone** tab, paste the URL, pick a folder, **Clone**. It is saved automatically. |
| Upload files/folders | **Upload** tab: pick the repo, **Add files / Add folder** (or paste a path), look at the preview, click **Upload to GitHub**. |
| Upload into a sub-folder of the repo | Fill in "Put them in this folder of the repo". |
| Skip more things | **Settings** > Custom exclusions (one pattern per line: `*.psd`, `secrets/`, `docs/drafts`). Untick any smart exclusion you do not want. |
| Pull a single repo | **Projects** > **Pull** (fast-forward only; it never overwrites your work). |

### Update Local GitHub: exit codes

The script is run exactly as `1 - Refresh GitHub Projects.bat` runs it (`powershell -NoProfile -ExecutionPolicy Bypass -File ...`), just without a window, and it is never modified.

| Exit code | Shown as |
| --- | --- |
| `0` | Success: "Finished. GitHub Projects are up to date" with the project count from `last-run.json` |
| `1` | Warning: "Some checks could not finish. See "Sync status.txt" and try again later." |
| `2` | Warning: "Another refresh is already running. Wait for it to finish before trying again." |
| anything else | Error: "Refresh could not finish. See the output above." |

### How uploads work

- Streamline works inside the repository's local folder. Files you add from elsewhere are **copied in**; files already inside the repo are used in place.
- It fetches first and fast-forwards if GitHub is ahead. If both sides changed, it stops and tells you.
- Only files it listed in the preview are staged. If the repo already has unrelated staged changes, it refuses rather than sweeping them into the commit.
- Uploads add and update files. They never delete anything from the repository.
- Files that the repo's own `.gitignore` ignores are skipped and listed in the preview.

## Security

- The server listens on `127.0.0.1` only, checks the `Host` and `Origin` headers, and requires a custom header on every change, so other websites cannot drive it.
- **Streamline never stores or sees your GitHub token.** Git and the GitHub CLI use your existing Windows sign-in (Git Credential Manager or `gh`). The browser UI never receives credentials, and anything resembling a token is scrubbed from logs.
- Git is run without a console and with prompts disabled (`GIT_TERMINAL_PROMPT=0`), so a signed-out state produces a clear error instead of a hidden password prompt.
- Local data (saved projects, settings, activity) lives in the `data` folder next to the app and is git-ignored.

## Troubleshooting

- **"Sign in" button keeps appearing**: run `gh auth login` once in a terminal, then reload.
- **Push or clone says authentication failed**: sign in (top right), then retry.
- **Commit failed: "tell me who you are"**: run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.
- **Port 4545 is taken**: start with a different port: `set PORT=4600 && node server.js --open`.
- **Browse buttons do nothing**: they open Windows dialogs through PowerShell; you can always paste a path instead.

## Development

```
node server.js          # start
npm test                # unit + integration tests (needs git; no network)
```

Layout: `server.js` (HTTP + API), `lib/` (git, clone, upload, sync, exclusions, activity log), `public/` (UI), `test/`.
