-- Global inbox hotkeys for the Productivity Tracker — the Mac counterpart of
-- inbox.ahk (Hammerspoon instead of AutoHotkey). Same keys, same split:
-- Hammerspoon only captures input and shows dialogs; inbox_cli.py does all
-- inbox HTTP. Panel actions POST straight to loopback (no Plucky on Mac, so
-- no python fallback is needed).
--   Ctrl+Alt+I -> add an item to the inbox
--   Ctrl+Alt+O -> view what's currently in the inbox
--   Ctrl+Alt+M -> hide the NOW panel for 10 seconds (POST /api/panel/hide;
--                 macOS has no external per-window hide, so the app does it)
--   Ctrl+Alt+S -> open the NOW panel's switch form (focuses the panel first)
--   Ctrl+Alt+X -> mark interrupted on the NOW panel (no focus steal)
-- Loaded by a one-line ~/.hammerspoon/init.lua: dofile("<repo>/inbox-hotkey/
-- inbox.lua"). Paths derive from this file's own location — nothing personal
-- is hardcoded here.

local src = debug.getinfo(1, 'S').source:sub(2)
local hotkeyDir = src:match('(.*/)')
local python = os.getenv('HOME') .. '/venvs/qpa/bin/python'
local cli = hotkeyDir .. 'inbox_cli.py'
-- Must resolve to the same directory inbox_cli.py's TMP does: TMPDIR is set
-- for every launchd-descended process, and the cli inherits ours anyway.
local tmp = os.getenv('TMPDIR') or hotkeyDir
local addFile = tmp .. 'inbox_add.txt'
local resultFile = tmp .. 'inbox_result.txt'

local function panelPost(action)
    hs.http.asyncPost('http://127.0.0.1:5000/api/panel/' .. action, '', nil,
                      function() end)
end

-- The panel is the only window titled exactly NOW; hs.window.find() pattern-
-- matches substrings, so compare titles exactly like inbox.ahk's title mode 3.
local function nowWindow()
    for _, w in ipairs(hs.window.allWindows()) do
        if w:title() == 'NOW' then return w end
    end
end

hs.hotkey.bind({'ctrl', 'alt'}, 'i', function()
    hs.focus()  -- the prompt can't be typed into unless Hammerspoon is frontmost
    local btn, text = hs.dialog.textPrompt('Add to inbox', '', '', 'Add', 'Cancel')
    if btn ~= 'Add' or text:match('^%s*$') then return end
    local f = io.open(addFile, 'w')
    if not f then return end
    f:write(text)
    f:close()
    os.remove(resultFile)
    local t = hs.task.new(python, function()
        local msg = 'Inbox updated'
        local r = io.open(resultFile, 'r')
        if r then
            msg = r:read('a')
            r:close()
        end
        hs.alert.show(msg, 1.8)
    end, {cli, 'add'})
    t:setWorkingDirectory(hotkeyDir)
    t:start()
end)

hs.hotkey.bind({'ctrl', 'alt'}, 'o', function()
    local t = hs.task.new(python, nil, {cli, 'view'})
    t:setWorkingDirectory(hotkeyDir)
    t:start()
end)

hs.hotkey.bind({'ctrl', 'alt'}, 'm', function()
    panelPost('hide')
end)

-- Focus the panel first so the reason field, which the panel focuses when the
-- form opens, actually receives typing (same order as inbox.ahk).
hs.hotkey.bind({'ctrl', 'alt'}, 's', function()
    local w = nowWindow()
    if w then w:focus() end
    panelPost('switch')
end)

hs.hotkey.bind({'ctrl', 'alt'}, 'x', function()
    panelPost('interrupted')
end)
