# THE COACH (2026-10-22, Quentin's instruction): a page before Now that
# keeps a plan for the day WITH him and says the one thing to do next, for
# the days the stressors and the executive dysfunction win.
#
# It is a real Claude Code session, run by THIS process — the desktop
# window's — because that is where `claude` is installed and signed in to his
# plan. The VM has neither, so the page works in the desktop window only and
# says so elsewhere. One long-lived `claude -p` speaking stream-json; a
# message in is one JSON line on its stdin, and each reply is pushed to the
# page through `emit` (evaluate_js), so a check-in's answer arrives the same
# way his own does.
#
# It reaches the app ONLY through the assistant tools (mcp/), with no
# built-in tools at all — no shell, no files — so it can do what the
# interface can and nothing the interface cannot, and every write is logged
# in Settings -> AI changes like any assistant's.
#
# ONE SESSION A DAY. The transcript is the data dir's coach/YYYY-MM-DD.json
# (gitignored with the rest of the data plane): the page reads it back after
# a reload, and a restarted window resumes that day's session by its id.
import json
import os
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import date as date_cls, datetime

COACH_DIR = 'coach'

PROMPT = """You are Quentin's day coach, a page inside his productivity app (ef-exobrain).
He has ADHD-style executive dysfunction. Your job is to keep a running plan for the
day WITH him and to tell him the ONE thing to do next, especially when stress,
worry or overwhelm make starting hard.

How every reply looks:
- The FIRST line is always `NEXT: <one concrete physical action he can start in
  under two minutes>`. The app shows that line large at the top of the page.
- Then at most four short lines. No menus of options unless he asks for them.

Work INSIDE the app's plan — it is his, and these are his preferences:
- The block running now says what these hours are for. Steer toward it.
- The to-do list is ordered on purpose (Mark Forster's Final Version Perfected):
  the LAST dotted item is the current task. Never reorder it, never suggest
  sorting by priority or deadline; help him work the method.
- Gates are commitments with real money behind them. Get him to each one in
  time. Never suggest calling one off or easing it unless he asks.
- His Horizons (Areas, Goals, Purpose) and his rules for you, when the context
  carries them, say what matters. Follow his rules for you over these defaults.

His life is his call. Do not tell him what to prioritise beyond what the app's
plan already says, what he should want, or how to feel. You sequence and you
shrink; he decides.

When something comes up — a worry, an errand, a new idea — capture it to the
app's inbox (POST /api/inbox with {"content": ...}) so it is out of his head,
say in a few words that it is captured, and come back to NEXT. Do not debate it.
"Stuck" means make the step smaller: the first physical motion. No pep talk.
"Done" means move on; complete a to-do in the app only when the to-do itself is
finished, and ask if you cannot tell.

You have the app's tools (app_request reaches any /api route; the blocks_ and
gates_ tools carry their own rules). Read the app rather than asking him for
facts it knows. Every write needs a reason, which he sees. Before anything that
moves money, cancels a commitment or deletes something, ask first. The routes
you will want most:
- GET /api/inbox/active — every available action. The to-do list is the ones
  with kind 'item' and no on_projects, oldest first (entered_at, else
  captured_at); a started_at means dotted. The context already carries it.
- POST /api/inbox {"content": "..."} — capture to the inbox.
- PATCH /api/inbox/<id> {"started_at": "<ISO time>"} dots a to-do, null undots;
  {"entered_at": "now", "started_at": null} is FVP's re-entry (worked on, not
  finished: back to the end of the list).
- DELETE /api/inbox/<id> — completes it (completion deletes the row).
- GET /api/engage/day, /api/blocks/day?date=YYYY-MM-DD, /api/gates/day?date=...
- GET /api/settings — horizon_areas, horizon_goals, horizon_purpose, coach_rules.

Each message begins with a [context] block the app wrote at that moment; trust
it over anything you remember. A message marked [check-in] is the app's timer,
not him: be brief — restate NEXT if it still stands, or ask one short question."""


def _today():
    return date_cls.today().isoformat()


def _claude():
    return shutil.which('claude')


class Coach:
    def __init__(self, server, repo_dir, emit):
        self.server = server
        self.repo_dir = repo_dir
        self.emit = emit
        self.lock = threading.Lock()
        self.proc = None
        self.busy = False
        self.day = None
        self.session_id = None
        self.messages = []
        self.docs_sent = None
        self._load(_today())

    def _path(self, day):
        return os.path.join(COACH_DIR, day + '.json')

    def _load(self, day):
        self.day = day
        self.session_id = None
        self.messages = []
        self.docs_sent = None
        try:
            with open(self._path(day), encoding='utf-8') as f:
                saved = json.load(f)
            self.session_id = saved.get('session_id')
            self.messages = saved.get('messages') or []
        except (FileNotFoundError, json.JSONDecodeError):
            pass

    def _save(self):
        os.makedirs(COACH_DIR, exist_ok=True)
        tmp = self._path(self.day) + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'session_id': self.session_id, 'messages': self.messages}, f, indent=1)
        os.replace(tmp, self._path(self.day))

    def history(self):
        with self.lock:
            self._roll()
            return {'available': bool(_claude()), 'day': self.day,
                    'busy': self.busy, 'messages': self.messages}

    # A new local day is a new session: yesterday's plan is not today's.
    def _roll(self):
        if self.day == _today():
            return
        self._stop()
        self._load(_today())

    def _stop(self):
        proc, self.proc = self.proc, None
        self.busy = False
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass

    def _mcp_config(self):
        # The assistant tools, pointed at the server this window reads. A
        # frozen exe's sys.executable is the app, not an interpreter.
        python = 'python' if getattr(sys, 'frozen', False) else sys.executable
        servers = {name: {'command': python,
                          'args': [os.path.join(self.repo_dir, 'mcp', name + '_mcp.py')],
                          'env': {'QPA_URL': self.server}}
                   for name in ('app', 'blocks', 'gates')}
        path = os.path.abspath(os.path.join(COACH_DIR, 'mcp.json'))
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'mcpServers': servers}, f, indent=1)
        return path

    def _start(self):
        os.makedirs(COACH_DIR, exist_ok=True)
        args = [_claude(), '-p', '--input-format', 'stream-json',
                '--output-format', 'stream-json', '--verbose',
                '--tools', '', '--mcp-config', self._mcp_config(), '--strict-mcp-config',
                '--allowedTools', 'mcp__app', 'mcp__blocks', 'mcp__gates',
                '--permission-prompts', 'none', '--disable-slash-commands',
                '--append-system-prompt', PROMPT, '-n', 'Coach ' + self.day]
        if self.session_id:
            args += ['--resume', self.session_id]
        else:
            self.session_id = str(uuid.uuid4())
            args += ['--session-id', self.session_id]
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
        # Its own working directory, so no project's CLAUDE.md or .mcp.json
        # rides along — the tools above are the whole of what it gets.
        self.proc = subprocess.Popen(args, cwd=os.path.abspath(COACH_DIR),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, encoding='utf-8',
                                     bufsize=1, creationflags=flags)
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()

    # kind: 'user' (he wrote it) or 'checkin' (the page's timer). context is
    # the app's own reading of the moment; docs his standing preferences,
    # sent to the session only when they changed since it last saw them.
    def send(self, kind, text, context, docs):
        if not _claude():
            return {'error': 'Claude Code is not installed on this computer'}
        with self.lock:
            self._roll()
            if self.busy:
                return {'error': 'The coach is still answering'}
            if not self.proc or self.proc.poll() is not None:
                self.docs_sent = None
                self._start()
            stamp = datetime.now().strftime('%H:%M')
            parts = ['[context — written by the app at %s]\n%s' % (stamp, context.strip())]
            if docs and docs != self.docs_sent:
                parts.append('[his preferences]\n' + docs.strip())
                self.docs_sent = docs
            parts.append('[/context]')
            parts.append('[check-in] ' + text if kind == 'checkin' else text)
            msg = {'type': 'user', 'message': {'role': 'user', 'content': '\n\n'.join(parts)}}
            try:
                self.proc.stdin.write(json.dumps(msg) + '\n')
                self.proc.stdin.flush()
            except OSError:
                self._stop()
                return {'error': 'The coach stopped — send again to restart it'}
            self.messages.append({'role': kind, 'text': text, 'at': stamp})
            self.busy = True
            self._save()
        return {'ok': True}

    def _read(self, proc):
        text, tools = [], []
        for line in proc.stdout:
            try:
                evt = json.loads(line)
            except ValueError:
                continue
            if evt.get('type') == 'assistant':
                for block in evt.get('message', {}).get('content') or []:
                    if block.get('type') == 'text' and block.get('text', '').strip():
                        text.append(block['text'].strip())
                    elif block.get('type') == 'tool_use':
                        name = block.get('name', '').split('__')[-1]
                        tools.append(name)
                        self.emit({'type': 'tool', 'name': name})
            elif evt.get('type') == 'result':
                self._finish(proc, '\n\n'.join(text) or evt.get('result') or '', tools,
                             evt.get('is_error'))
                text, tools = [], []
        # The process ended. Mid-answer, that answer is lost and says so.
        with self.lock:
            if proc is self.proc:
                self.proc = None
                if self.busy:
                    self.busy = False
                    # A session that never answered was never saved, and
                    # resuming it would fail the same way every time.
                    if not any(m['role'] == 'coach' for m in self.messages):
                        self.session_id = None
                        self._save()
                    self.emit({'type': 'error', 'text': 'The coach stopped — send again to restart it'})

    def _finish(self, proc, reply, tools, failed):
        with self.lock:
            if proc is not self.proc:
                return
            self.busy = False
            msg = {'role': 'coach', 'text': reply, 'at': datetime.now().strftime('%H:%M'),
                   'tools': tools}
            if failed:
                msg['error'] = True
            self.messages.append(msg)
            self._save()
        self.emit({'type': 'reply', 'message': msg})

    def reset(self):
        with self.lock:
            self._stop()
            self.session_id = None
            self.messages = []
            self.docs_sent = None
            self._save()
        return {'ok': True}
