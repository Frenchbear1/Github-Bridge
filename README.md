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

- **Double-click `Start-Streamline.vbs`**. Nothing flashes and no console stays open: the server runs hidden and your browser opens to `http://localhost:4545`.
- **Quit by closing the browser tab.** About 12 seconds after the last Streamline tab closes, the server stops by itself (a reload or quick reopen keeps it running). It will not stop while an upload, clone, refresh or a project started with Play is still running; reopening `Start-Streamline.vbs` just reopens the app. `Stop-Streamline.vbs` stops it immediately.
- To start it automatically at sign-in, press `Win + R`, type `shell:startup`, and put a shortcut to `Start-Streamline.vbs` in that folder.
- If something goes wrong, the server's messages are in `data\server.log`. For a visible window while troubleshooting, use `Start-Streamline-Debug.bat`.

## Desktop app (Streamline.exe)

Prefer a real app with its own taskbar icon instead of a browser tab and a start file? Download it from the repository's **Releases** page:

- **Streamline-Setup.exe** (recommended): installs for your user only (no admin needed), adds Start menu and desktop shortcuts, and starts quickly. Pin it to the taskbar from the Start menu.
- **Streamline-Portable.exe**: a single file you can run from anywhere; it unpacks itself on every launch, so it opens a little slower.

It is the same Streamline in its own window. On first run it brings over your saved projects and settings from a browser-version install if it finds one. Closing the window quits Streamline, unless programs you started with **Play** are still running: then it stays in the system tray (click the tray icon to reopen; its menu has **Quit**, which also stops those programs). Its data lives in `%APPDATA%\Streamline`.

Windows may show a "Windows protected your PC" (SmartScreen) notice because the app is not code-signed: choose **More info**, then **Run anyway**.

**Building it yourself:** the exe is built on GitHub's servers by `.github/workflows/build-exe.yml`. Open the **Actions** tab, pick **Build Windows app**, and click **Run workflow** (the files appear under the run's Artifacts), or push a tag such as `v1.0.1` to publish a new Release. Locally: `cd desktop && npm install && npm run dist` on Windows.

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

**Command-line tools that wait for typing** (for example a Python script that calls `input()`) are detected and opened in their own console window that stays open, because a hidden run has no keyboard and would fail with an input error. Check all projects only runs their setup, never the tool itself.

Once a program is up, Activity marks the run as a **success: running in the background** (not as "working"), so something you leave on 24/7 does not look stuck. The row still shows **running** with a **Stop** button. While a project runs, its output streams into Activity, the row shows **running**, and **Stop** ends the whole process tree. If a needed tool is missing (Node, Python, .NET...), the output says exactly what to install, with the `winget` command.

**Generated launchers stay out of your way.** For projects that need one, Streamline writes `Streamline-Play.bat` into the project folder, so you can also double-click it in Explorer. It adds that file (plus `node_modules/`, `.venv/` and similar, when your `.gitignore` does not already cover them) to the repository's local `.git/info/exclude`. That file is never committed or pushed, so these files do not appear as "untracked", and your sync script will not pause the project. Dependency installs never create or change a lock file, for the same reason. Streamline never overwrites a launcher it did not write, and never uploads `Streamline-Play.bat`.

- **Row buttons** are grouped: **Play** and **Open in...** on the first line, **Pull**, **Upload** and **Remove** on the second.
- **Sort** the list by recently changed (default, newest file edit, ignoring node_modules and build folders), recently used in Streamline, or name; your choice is remembered.
- **Open in...** on each row pops up File Explorer, the project's GitHub repository page, plus every code editor Streamline finds on your PC (VS Code, Cursor, Windsurf, VSCodium, Notepad++, Sublime, Zed, Visual Studio, JetBrains IDEs, Android Studio, Notepad, Windows Terminal). Folder-capable editors open the whole project; Notepad opens the main file (README, package.json...). The browser only sends the editor's name, never a path, so nothing else can be launched.

### When Play does not work: check everything, then let ChatGPT fix it

- **Failed checks can be ignored.** Open a failed row and click **Ignore**: it leaves the banner and the ChatGPT prompt until you click **Stop ignoring**. A project whose last check failed does not show a Play button (re-check to bring it back); there is no "Set up Play" button on rows, use the failed tag's **Fix with ChatGPT** or **Change...**.
- **Check all projects** (Projects tab) tries every project's Play button in the background, one at a time, with nothing opening in your browser. Web pages, built programs and extensions are verified to exist; servers are started, watched for a web address or a stable running state, then stopped; desktop apps only run their setup steps (installs) and are never launched, so no windows pop up. Each row gets **works**, **failed** (click it to see the error output), or **not tested** (your own launchers are left alone). Checking can install dependencies, the same as pressing Play would.
- **Fix failures with ChatGPT** builds one prompt covering every failed project: folder listing, key build and config files, and the error each one hit (`.env`, keys and anything that looks like a secret are left out; you can read the exact text before copying it). Paste it into ChatGPT, paste its single reply back into the app, review what will be applied per project, and click **Apply and re-check**. Streamline saves the setups and re-tests those projects itself.
- For a single project, use **Set up Play...** (or **Change...**) on its row for the same flow with just that project.
- **A pasted reply is treated as untrusted.** Only well-known programs run (npm, node, python, dotnet, cargo, go, and similar), one plain command per step, no shell operators or quotes, every path must stay inside the project, no downloads, and you see the exact commands before anything is saved.

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
