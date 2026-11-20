"""Markdown, read and written. Run: python markdown_test.py

ONE MARKDOWN (2026-10-19) and, since 2026-11-19 (Quentin's instruction: "fix
the markdown on everything that asks for markdown — make it like VS Code"),
ONE MARKDOWN FIELD. Two functions in static/app.js answer every markdown
question in the app, and this runs them as they are, in Node:

  mdHtml       what a document READS as. The cases below are the shapes it
               used to get wrong: a nested list (the editor's own Tab writes
               one) fell out as a paragraph beginning "- ", a task with a
               **bold** word split into columns, ***bold italic*** came out
               mis-nested, and a list or heading inside a > quote was text.
  mdHighlight  what a markdown field SHOWS while it is written — the VS Code
               view, a coloured layer over the textarea. It may colour but
               never add, drop or move a character, or the caret stops
               matching the text: every document below must come back out of
               it character for character.

Needs Node; without it this prints NOT RUN and exits 0 — the VM has none. NOT
RUN is not a pass: nothing was checked.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

# (label, markdown, a piece the HTML must contain)
READS = [
    ('a nested list nests', '- a\n  - b\n  - c\n- d',
     '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>'),
    ('a list nests in an ordered one', '1. one\n2. two\n   - sub\n3. three',
     '<ol><li>one</li><li>two<ul><li>sub</li></ul></li><li>three</li></ol>'),
    ('three deep, then back out to the top', '- a\n    - b\n        - c\n- d',
     '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>'),
    ('a tab indents too', '- a\n\t- b', '<ul><li>a<ul><li>b</li></ul></li></ul>'),
    ('an ordered list keeps its first number', '3. x\n4. y', '<ol start="3"><li>x</li><li>y</li></ol>'),
    ('a task holds its inline formatting in one run of text', '- [ ] a **b** c',
     '<li class="md-task"><span class="md-box"></span>a <strong>b</strong> c</li>'),
    ('tasks nest', '- [x] done\n  - [ ] sub',
     '<li class="md-task md-done"><span class="md-box">✓</span>done<ul><li class="md-task">'
     '<span class="md-box"></span>sub</li></ul></li>'),
    ('+ is a bullet', '+ a\n+ b', '<ul><li>a</li><li>b</li></ul>'),
    ('a list inside a quote', '> - a\n> - b', '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>'),
    ('a heading inside a quote', '> ## Head\n> text', '<blockquote><h2 id="md-head">Head</h2><p>text</p></blockquote>'),
    ('a quote inside a quote', '> outer\n> > inner',
     '<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>'),
    ('***bold italic***', '***both***', '<strong><em>both</em></strong>'),
    ('___bold italic___', '___both___', '<strong><em>both</em></strong>'),
    ('a link keeps its title', '[t](https://a.example "The tip")', 'title="The tip"'),
    ('closing hashes are not text', '## Title ##', '<h2 id="md-title">Title</h2>'),
    ('a blank line between items is one list', '- a\n\n- b', '<ul><li>a</li><li>b</li></ul>'),
    ('a paragraph after a blank line closes the list', '- a\n\npara', '</li></ul><p>para</p>'),
    ('an indented line continues its item', '- a\n  more', '<li>a<br>more</li>'),
    ('an indented paragraph after a blank stays in the item', '- a\n\n  second', '<li>a<p>second</p></li>'),
    ('a bullet then a number is two lists', '- a\n1. b', '<ul><li>a</li></ul><ol><li>b</li></ol>'),
    ('a fence keeps its text as code', '```py\nx = 1  # **not bold**\n```',
     '<pre><code class="language-py">x = 1  # **not bold**</code></pre>'),
    ('a table', '| a | b |\n|:-|-:|\n| 1 | **2** |',
     '<td style="text-align:right"><strong>2</strong></td>'),
    ('a footnote', 'Note[^1].\n\n[^1]: the text', '<li id="md-fn-1">the text'),
    ('user text is escaped, never markup', '<b>x</b> & "y"', '&lt;b&gt;x&lt;/b&gt; &amp;'),
]

WRITES = [
    '# Title\n\nA paragraph with **bold**, *it*, `code`, ~~x~~, ==m==, H~2~O, X^2^ :tada:.\nSecond line.',
    '- a\n  - **b** `c`\n    - [ ] deep task\n1. one\n+ plus',
    '> q *i*\n> > deeper\n| x | y |\n|---|:-:|\n| 1 | 2 |',
    '```js\nconst s = "**no**";\n```\nafter',
    '\\*esc\\* ***bi*** __u__ ___bu___ [l](https://x "t") ![p](/a.png) :+1: ~s~ ^p^ <a&b> "q" \'s\'',
    'Term\n: definition\n\nNote[^1].\n\n[^1]: the text\n---\n## Head {#id} ##\n',
    'trailing newline\n',
    '',
]

HARNESS = r"""
const fs = require('fs');
const [appPath, commonPath, casesPath] = process.argv.slice(2);
const norm = p => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const app = norm(appPath), common = norm(commonPath);
const cut = (src, from, to) => {
  const a = src.indexOf(from);
  if (a < 0) throw new Error('not found: ' + from);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error('not found: ' + to);
  return src.slice(a, b);
};
const esc = cut(common, 'function escHtml(', '\n}\n') + '\n}\n';
const read = cut(app, 'const MD_EMOJI = {', '\n// A MARKDOWN DOCUMENT');
// The slice carries the field's DOM half too; Node has no layout to watch.
const stub = 'class ResizeObserver { observe() {} unobserve() {} }\n';
const fns = new Function(stub + esc + read + '\nreturn { mdHtml, mdHighlight };')();
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const unescape = h => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const out = [];
for (const [label, md, want] of cases.reads) {
  const html = fns.mdHtml(md);
  out.push([html.includes(want), 'reads: ' + label, html]);
}
cases.writes.forEach((md, k) => {
  const shown = unescape(fns.mdHighlight(md));
  // The layer pads a last empty line with a space so it has height.
  out.push([shown === md || (md.endsWith('\n') && shown === md + ' '), 'writes: document ' + (k + 1) + ' comes back character for character', JSON.stringify(shown)]);
});
console.log(JSON.stringify(out));
"""


def main():
    node = shutil.which('node')
    if not node:
        print('NOT RUN  markdown_test - node is not installed')
        print('         nothing was checked')
        return 0
    tmp = tempfile.mkdtemp(prefix='qpa-md-')
    harness = os.path.join(tmp, 'harness.js')
    cases = os.path.join(tmp, 'cases.json')
    with open(harness, 'w', encoding='utf-8') as f:
        f.write(HARNESS)
    with open(cases, 'w', encoding='utf-8') as f:
        json.dump({'reads': READS, 'writes': WRITES}, f)
    run = subprocess.run([node, harness, os.path.join(HERE, 'static', 'app.js'),
                          os.path.join(HERE, 'static', 'common.js'), cases],
                         capture_output=True, text=True, encoding='utf-8')
    if run.returncode:
        print('FAIL  the harness could not load mdHtml / mdHighlight out of app.js')
        print(run.stderr)
        return 1
    fails = 0
    for ok, label, got in json.loads(run.stdout):
        print(('PASS  ' if ok else 'FAIL  ') + label + ('' if ok else '\n        got: ' + got))
        fails += not ok
    print('\n%d FAILED' % fails if fails else '\nAll checks passed.')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
