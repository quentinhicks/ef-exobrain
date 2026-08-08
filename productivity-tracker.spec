# -*- mode: python ; coding: utf-8 -*-
# Bundles the Flask + pywebview app into one self-contained exe.
# Build: pyinstaller productivity-tracker.spec   (or run build_exe.bat)
# Paths are relative to this spec's dir (repo root) so it is CI-portable.
# The app hides its own console at startup (console=True but no window shows);
# templates/ and static/ are bundled and served from sys._MEIPASS when frozen.

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[('templates', 'templates'), ('static', 'static')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Productivity Tracker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # off: UPX-packed exes draw more AV false positives
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # hidden in-app; the windowed bootloader is unreliable here
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['assets/icon.ico'],
)
