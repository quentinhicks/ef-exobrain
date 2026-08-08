# Inbox hotkeys

Global hotkeys to capture inbox items without switching to the app.
Both windows open centered on the mouse cursor.

- **Ctrl+Alt+I** — pops a one-line box; type an item, Enter, done.
- **Ctrl+Alt+O** — opens a small window showing what's in the inbox now
  (Esc to close). Opens instantly (window first, data fetched after), and if
  you add an item (Ctrl+Alt+I) while it's open, it refreshes itself.
- **Ctrl+Alt+M** — hides the always-on-top NOW panel and brings it back after
  10 seconds. Pure local window op (`WinHide`/`WinShow` on the window titled
  `NOW`) — no network. Needs the app running (the panel must exist).
- **Ctrl+Alt+S** — opens the NOW panel's switch form (log a re-decision). This
  one activates the panel first, so the reason field gets your typing.
- **Ctrl+Alt+X** — marks "interrupted" on the NOW panel. Fire-and-forget; it
  never takes focus, so it won't interrupt what you're doing.

Ctrl+Alt+S and Ctrl+Alt+X POST to `localhost:5000/api/panel/…` **directly from
AHK** (WinHttp to `127.0.0.1`), and the app calls into the panel window's JS
(`evaluate_js`) — that's why interrupted can fire without stealing focus.
Loopback isn't the internet, so Plucky lets it through; spawning `python.exe`
per keypress was too slow (~700ms). `panel_cli.py` (raw socket, no `urllib`)
remains as a fallback that AHK falls back to if the direct call ever throws.

## How it works (and why it's split this way)

- `inbox.ahk` (AutoHotkey v2) only captures the keystroke + text and positions
  the windows at the cursor. It makes **no** network calls — Plucky's filter
  would kill a non-allowlisted app's internet (WinError 10053).
- `inbox_cli.py` does all HTTP through `python.exe`, which **is** allowlisted.
  - **Add:** tries `localhost:5000/api/inbox` first (canonical, append-safe;
    the app then syncs to the cloud). If the app is closed, it appends
    directly to the Cloudflare Worker's inbox blob — so capture works whether
    or not the app is running.
  - **View:** reads the app if it's up, otherwise the cloud blob. It shows the
    window immediately, then fetches in a background thread so the network is
    off the critical path.

### Both surfaces stay in sync after an add

- **Running app:** `POST /api/inbox` writes the app's DB *and* pushes to the
  cloud (app.py). The frontend's `syncTodoFromCloud()` re-fetches `/api/inbox`
  and re-renders on focus (visibilitychange), every 60s, and on reconnect — so
  a hotkey add shows up the moment you switch back to the app.
- **View popup:** refreshes **event-driven**, not on a timer. The add command
  rewrites `inbox_result.txt`; the popup watches that file's mtime (a cheap
  local `stat` every 400 ms) and only re-fetches when it changes. No idle
  network traffic — important since a timer would hammer the Worker whenever
  the app is closed. (Adds made from the app UI itself show on next reopen.)

Reads the Worker URL + secret from the app's `config.json`. No secrets live here.

## Run it

Double-click `inbox.ahk` (AutoHotkey v2 is installed). A green "H" appears in
the tray; the hotkeys are now live.

## Starts automatically with the app

`app.py` launches this script itself at startup (`_start_inbox_hotkeys`), so the
desktop shortcut / `run.bat` / the bundled exe all bring the hotkeys up with the
app — nothing to double-click. It finds `AutoHotkey64.exe` in the standard
`C:\Program Files\AutoHotkey\v2` location; set `autohotkey_path` in
`config.json` if yours lives elsewhere. `#SingleInstance Force` means a launch
just replaces any instance already running, so you never get two. The AHK
process is independent and keeps running after the app closes (capture is meant
to work app-closed), and if AutoHotkey isn't installed the app just skips it.

## Start automatically at login

Also worth keeping so the hotkeys are live before the app is opened. Run this
once (drops a shortcut in the Startup folder):

```powershell
$s = (New-Object -ComObject WScript.Shell).CreateShortcut(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\inbox-hotkey.lnk")
$s.TargetPath = "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe"
$s.Arguments  = '"C:\path\to\ef-exobrain\inbox-hotkey\inbox.ahk"'
$s.Save()
```

## macOS (Hammerspoon)

`inbox.lua` is the Mac counterpart of `inbox.ahk` — same five hotkeys
(⌃⌥I/O/M/S/X), same split: Hammerspoon captures input and shows the dialogs,
`inbox_cli.py` does the inbox HTTP (unchanged — the view popup is tkinter and
runs fine on Mac). Differences from Windows:

- Panel posts go straight from Hammerspoon (`hs.http`) — no Plucky on Mac, so
  no python fallback is needed.
- ⌃⌥M can't hide another process's window on macOS, so it POSTs the app's
  `/api/panel/hide` route and the panel hides itself for 10 seconds.
- Setup: Hammerspoon.app in /Applications, `~/.hammerspoon/init.lua` is one
  line — `dofile("<repo>/inbox-hotkey/inbox.lua")`. Auto-starts at login
  (Hammerspoon preference) and `app.py` also `open -ga`'s it at launch.
- Grant Hammerspoon **Accessibility** (System Settings → Privacy & Security):
  the hotkeys fire without it, but ⌃⌥S needs it to focus the NOW panel.
- The add prompt is a normal dialog (not at the cursor), and its result toast
  is `hs.alert`.

## Change the hotkeys

Edit the `^!i` (Ctrl+Alt+I), `^!o` (Ctrl+Alt+O), `^!m` (Ctrl+Alt+M), `^!s`
(Ctrl+Alt+S), and `^!x` (Ctrl+Alt+X) lines in `inbox.ahk`.
`^`=Ctrl, `!`=Alt, `+`=Shift, `#`=Win.

After editing, reload the running script (right-click the tray "H" → Reload
Script, or just re-run `inbox.ahk`) so the change takes effect.
