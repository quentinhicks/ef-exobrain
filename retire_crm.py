"""Archive and drop the CRM tables, once the data is safely in ef-crm.

  python retire_crm.py --verify-against /path/to/crm.db
  python retire_crm.py --yes                        (no crm.db to hand)

RUN THIS BY HAND. It is deliberately NOT an init_db migration, unlike every
other retirement in storage.py: the VM auto-updates from `main` every five
minutes, so a destructive drop wired into startup would run there the moment
this is pushed — quite possibly before `crm_import.py` had been run on that
machine, which is where the only live copy of the data is.

What it does, in order:

  1. counts the five tables
  2. --verify-against: opens that crm.db READ-ONLY and refuses unless every
     table matches. This is the mechanical version of "are you sure": a row
     count that disagrees means the export is not the export you think it is.
  3. archives every row to backups/retired-crm-YYYY-MM-DD.json
  4. DROPs the five tables
  5. records what happened in setting.crm_retired

Step 5 is the `operating_experiments_retired` idiom: history that outlives a
schema is the daybook's whole premise, and a dropped table is gone from every
future daybook file — so the drop says where the rows went rather than being
silent. Never clear that setting to "re-run" this: the tables are gone, so a
second pass would archive nothing and overwrite the note saying where they are.

AFTER this has run everywhere that matters, daybook.py's entries for these five
tables can come out too. They are kept until then because daybook classifies
whatever the LIVE db actually holds, and an unclassified table is a
daybook_test failure by design.
"""

import io
import json
import os
import sqlite3
import sys
from datetime import date as date_cls

import storage

# Dropped child-first, so a drop never leaves a row pointing at a missing
# parent even for the instant between statements.
TABLES = ['crm_night', 'person_bucket', 'interaction', 'bucket', 'person']


def _counts(conn, tables):
    out = {}
    for t in tables:
        try:
            out[t] = conn.execute(f'SELECT COUNT(*) AS n FROM "{t}"').fetchone()['n']
        except sqlite3.OperationalError:
            out[t] = None           # already gone, or never existed here
    return out


def retire(verify_against=None, assume_yes=False):
    conn = storage.get_conn()

    done = conn.execute("SELECT value FROM setting WHERE key = 'crm_retired'").fetchone()
    if done:
        print(f'already retired — {done["value"]}')
        conn.close()
        return 0

    here = _counts(conn, TABLES)
    if all(v is None for v in here.values()):
        print('none of the CRM tables are in this db; nothing to do.')
        conn.close()
        return 0

    print(f'in {os.path.abspath(storage.DB_PATH)}:')
    for t in TABLES:
        print(f'  {t:<14} {"absent" if here[t] is None else here[t]}')

    if verify_against:
        if not os.path.exists(verify_against):
            print(f'\nno such file: {verify_against}')
            conn.close()
            return 1
        other = sqlite3.connect(f'file:{verify_against}?mode=ro', uri=True)
        other.row_factory = sqlite3.Row
        there = _counts(other, TABLES)
        other.close()
        print(f'\nagainst {os.path.abspath(verify_against)}:')
        ok = True
        for t in TABLES:
            mine = here[t] or 0
            theirs = there[t] or 0
            match = mine == theirs
            ok = ok and match
            print(f'  {"ok  " if match else "FAIL"} {t:<14} {mine:>5} here -> {theirs:>5} there')
        if not ok:
            print('\nRow counts disagree. The export is not complete — nothing dropped.')
            conn.close()
            return 1
    elif not assume_yes:
        print('\nNo --verify-against given, so nothing has checked that the data')
        print('is safely in ef-crm. Pass --verify-against <crm.db>, or --yes if')
        print('you have already satisfied yourself.')
        conn.close()
        return 1

    # Archive BEFORE dropping, and only claim the drop if the file is written.
    dump = {}
    for t in TABLES:
        if here[t] is None:
            continue
        dump[t] = [dict(r) for r in conn.execute(f'SELECT * FROM "{t}"').fetchall()]
    rows = sum(len(v) for v in dump.values())
    where = ''
    if rows:
        folder = os.path.join(os.path.dirname(os.path.abspath(storage.DB_PATH)), 'backups')
        os.makedirs(folder, exist_ok=True)
        where = os.path.join(folder, f'retired-crm-{date_cls.today().isoformat()}.json')
        with io.open(where, 'w', encoding='utf-8') as f:
            json.dump(dump, f, indent=2, ensure_ascii=False)
        print(f'\narchived {rows} row(s) -> {where}')

    for t in TABLES:
        conn.execute(f'DROP TABLE IF EXISTS "{t}"')
    conn.execute(
        "INSERT OR REPLACE INTO setting (key, value) VALUES ('crm_retired', ?)",
        (f'{date_cls.today().isoformat()}: dropped {", ".join(TABLES)}, {rows} row(s)'
         + (f' archived to {where}' if rows else ', none to archive')
         + ' — the CRM is ef-crm now',))
    conn.commit()
    conn.close()
    print('dropped. The CRM is ef-crm now.')
    return 0


if __name__ == '__main__':
    args = sys.argv[1:]
    target = None
    if '--verify-against' in args:
        i = args.index('--verify-against')
        if i + 1 >= len(args):
            print(__doc__)
            sys.exit(2)
        target = args[i + 1]
    sys.exit(retire(target, '--yes' in args))
