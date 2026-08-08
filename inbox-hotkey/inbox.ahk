#Requires AutoHotkey v2.0
#SingleInstance Force

; Global inbox hotkeys for the Productivity Tracker.
; AHK never touches the network (Plucky would block it) — it only captures
; input and shells out to python.exe (Plucky-allowlisted), which does all HTTP.
;   Ctrl+Alt+I  -> add an item to the inbox
;   Ctrl+Alt+O  -> view what's currently in the inbox
;   Ctrl+Alt+M  -> hide the NOW panel for 10 seconds (it returns on its own)
;   Ctrl+Alt+S  -> open the NOW panel's switch form (focuses the panel to type)
;   Ctrl+Alt+X  -> mark interrupted on the NOW panel (no focus steal)
; Both inbox windows open at the mouse cursor. Hide/show is a pure local window
; operation; switch/interrupted go through python.exe like the inbox commands.

pythonExe := "python"                        ; full path if not on PATH
cli       := A_ScriptDir "\inbox_cli.py"
panelCli  := A_ScriptDir "\panel_cli.py"
addFile   := A_Temp "\inbox_add.txt"
resultFile := A_Temp "\inbox_result.txt"

^!i:: {
    global pythonExe, cli, addFile, resultFile
    w := 380, h := 130
    pos := CursorBox(w, h)
    ib := InputBox("", "Add to inbox", "w" w " h" h " x" pos.x " y" pos.y)
    if (ib.Result != "OK" || Trim(ib.Value) = "")
        return
    try FileDelete(addFile)
    FileAppend(ib.Value, addFile, "UTF-8-RAW")
    try FileDelete(resultFile)
    RunWait('"' pythonExe '" "' cli '" add', A_ScriptDir, "Hide")
    msg := "Inbox updated"
    try msg := FileRead(resultFile, "UTF-8")
    ToolTip(msg)
    SetTimer(() => ToolTip(), -1800)
}

^!o:: {
    global pythonExe, cli
    Run('"' pythonExe '" "' cli '" view', A_ScriptDir, "Hide")
}

; Hide the always-on-top NOW panel and bring it back after 10 seconds.
^!m:: {
    SetTitleMatchMode(3)              ; exact title
    if !WinExist("NOW")               ; only the panel is titled exactly "NOW"
        return
    WinHide("NOW")
    SetTimer(ShowNowPanel, -10000)    ; one-shot, 10s
}

ShowNowPanel() {
    DetectHiddenWindows(true)         ; the panel is hidden right now
    SetTitleMatchMode(3)
    if WinExist("NOW")
        WinShow("NOW")
}

; Open the switch form. Activate the panel first so the reason field, which the
; panel focuses when the form opens, actually receives typing.
^!s:: {
    SetTitleMatchMode(3)
    if !WinExist("NOW")
        return
    WinActivate("NOW")
    PanelPost("switch")
}

; Mark interrupted — fire and forget, never takes focus.
^!x:: {
    PanelPost("interrupted")
}

; Drive the panel. Hit the local endpoint DIRECTLY from AHK (WinHttp to
; loopback) — spawning python.exe per keypress costs ~700ms, which made the
; switch form feel sluggish. Loopback isn't the internet, so Plucky lets it
; through; if it ever doesn't, Send() throws and we fall back to python.exe.
PanelPost(action) {
    global pythonExe, panelCli
    try {
        req := ComObject("WinHttp.WinHttpRequest.5.1")
        req.Open("POST", "http://127.0.0.1:5000/api/panel/" action, false)
        req.SetProxy(1)                       ; direct, never a proxy for localhost
        req.SetTimeouts(300, 300, 1000, 3000)
        req.Send("")
    } catch {
        Run('"' pythonExe '" "' panelCli '" ' action, A_ScriptDir, "Hide")
    }
}

; Top-left x,y so a w x h window is centered on the cursor and fully inside
; the work area of whichever monitor the cursor is on.
CursorBox(w, h) {
    MouseGetPos(&mx, &my)
    x := mx - w // 2
    y := my - h // 2
    loop MonitorGetCount() {
        MonitorGetWorkArea(A_Index, &l, &t, &r, &b)
        if (mx >= l && mx < r && my >= t && my < b) {
            x := Min(Max(x, l), r - w)
            y := Min(Max(y, t), b - h)
            break
        }
    }
    return { x: x, y: y }
}
