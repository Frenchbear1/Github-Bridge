# Streamline

A simple, local GitHub project manager for Windows. A tiny Node.js server runs on your computer
(`http://localhost:4545`, loopback only) and gives you a clean browser UI to:

- **Clone** any public or private GitHub repository into any folder
- **Upload** files or whole folders to a saved repository: preview, then commit and push in one click
- **Smart exclusions**: `.git`, `node_modules`, build folders, caches, logs, secrets (`.env`, `*.pem`, `*.key`) and files over 95 MB are skipped automatically; add your own patterns in Settings
- **Update Local GitHub**: runs your existing `.github-sync\Sync-GitHubProjects.ps1` silently (no Command Prompt) and shows live output
- **Play** any saved project with one click: Streamline works out how it runs (see below)
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

## Start (no Command Prompt window)

- **Double-click `Start-Streamline.vbs`.** Nothing flashes and no console stays open: the server runs hidden and your browser opens to `http://localhost:4545`.
- **Quit** with the **Quit** button in the top right of the app (or double-click `Stop-Streamline.vbs`).
- To start it automatically at sign-in, press `Win + R`, type `shell:startup`, and put a shortcut to `Start-Streamline.vbs` in that folder.
- If something goes wrong, the server's messages are in `data\server.log`. For a visible window while troubleshooting, use `Start-Streamline-Debug.bat`.

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

### The Play button

Every saved project shows how Streamline will run it. It checks, in this order:

| It finds | Play does |
| --- | --- |
| Your own launcher (`Start-*.bat`, `Run-*.cmd`, `launch.vbs`, ...) | Runs it. Maintenance scripts (update, install, build, setup, stop, ...) are ignored. If the folder also has a Stop script, a **Stop** button runs it. |
| `package.json` with a `dev`/`start` script | Installs dependencies the first time, runs the script (npm, pnpm, yarn or bun, matching the lock file), and opens the browser when the server is ready. Knows Vite, Next, Astro, CRA, SvelteKit, Nuxt, Angular, Electron, Tauri, Expo. |
| Python (`main.py`, `app.py`, Django, Streamlit, FastAPI, Flask, pygame/tkinter) | Creates a private `.venv` once, installs `requirements.txt`, runs it. |
| .NET, Rust, Go, Flutter | `dotnet run`, `cargo run`, `go run .`, `flutter run -d windows`. |
| A built program (`dist\App.exe`, `app\App.exe`, ...) | Starts it. (It does not rebuild it.) |
| A Chrome extension (`manifest.json`) | Opens the folder and `chrome://extensions` so you can **Load unpacked**. |
| A plain HTML project | Opens `index.html` directly. If the page needs a server (ES modules, `fetch`, service worker, root-relative links), Streamline serves the folder on a local port instead and opens that; **Stop** shuts it down. |
| Nothing it can identify | Shows "No run step" instead of guessing. |

While a project runs, its output streams into Activity, the row shows **running**, and **Stop** ends the whole process tree. If a needed tool is missing (Node, Python, .NET...), the output says exactly what to install, with the `winget` command.

**Generated launchers stay out of your way.** For projects that need one, Streamline writes `Streamline-Play.bat` into the project folder, so you can also double-click it in Explorer. It adds that file (plus `node_modules/`, `.venv/` and similar, when your `.gitignore` does not already cover them) to the repository's local `.git/info/exclude`. That file is never committed or pushed, so these files do not appear as "untracked", and your sync script will not pause the project. Dependency installs never create or change a lock file, for the same reason. Streamline never overwrites a launcher it did not write, and never uploads `Streamline-Play.bat`.

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
