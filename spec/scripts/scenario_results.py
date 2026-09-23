"""Merge incremental JUnit observations, then validate them against collection.

Pass XML files in execution order. Later observations replace earlier ones for
the same node, including failures. This never changes pytest outcomes.
"""
from collections import Counter, defaultdict
from datetime import date
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

from scenario_inventory import SPEC, ROOT, collect, normalize


def main(paths):
    destination = SPEC / 'scenarios/execution-results.json'
    previous = json.loads(destination.read_text()) if destination.exists() else {'tests': []}
    records = {row['nodeid']: row for row in previous['tests']}
    for path in paths:
        for case in ET.parse(path).iter('testcase'):
            node = normalize(case.attrib['classname'], case.attrib['name'])
            status = next((name for name in ('error', 'failure', 'skipped') if case.find(name) is not None), 'passed')
            status = {'failure': 'failed', 'error': 'error', 'skipped': 'skipped', 'passed': 'passed'}[status]
            records[node] = {'nodeid': node, 'status': status, 'source': Path(path).name}
    collected = collect()
    retired = previous.get('retired_tests', []) + [row for node, row in records.items() if node not in collected]
    records = {node: row for node, row in records.items() if node in collected}
    assert collected == records.keys(), {'missing': sorted(collected-records.keys()), 'uncollected': sorted(records.keys()-collected)}
    groups = defaultdict(Counter)
    for node, row in records.items():
        groups[node.split('::')[0]][row['status']] += 1
    result = {
        'date': date.today().isoformat(),
        'application_commit': subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, text=True).strip(),
        'note': 'Latest per-case observations from incremental runs, not one full-suite execution. Application fixes are in the working tree; application_commit is the base commit. Existing cases were also rerun. Credential-dependent cases use separate servers. These results do not certify physical audio output. See FIXES.md for changes and execution-before-fix.json for the baseline.',
        'summary': dict(Counter(row['status'] for row in records.values())),
        'modules': {name: dict(counts) for name, counts in sorted(groups.items())},
        'tests': sorted(records.values(), key=lambda row: row['nodeid']),
        'retired_tests': retired,
    }
    source_hashes = {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for folder in ('client', 'server', 'type')
        for path in sorted((ROOT / folder).rglob('*'))
        if path.is_file() and path.suffix in ('.ts', '.tsx', '.html', '.css')
    }
    result['application_sources_at_aggregation'] = source_hashes
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    failures = ['# 失敗したテスト\n', 'ケースごとの最新の観測です。同じ原因を複数の条件で検出しているため、件数は独立した不具合の数ではありません。条件と期待値はリンク先のテストを参照してください。\n']
    if all(row['status'] == 'passed' for row in records.values()):
        failures.append('現在、未解消の失敗はありません。修正前の失敗は [execution-before-fix.json](execution-before-fix.json)、変更内容は [FIXES.md](FIXES.md) に記録しています。\n')
    for module, counts in sorted(groups.items()):
        rows = [row for node, row in sorted(records.items()) if node.startswith(module+'::') and row['status'] != 'passed']
        if not rows:
            continue
        failures.append(f'## [{module}](../step_defs/{module})\n')
        failures.extend(f"- `{row['nodeid'].split('::', 1)[1]}` — {row['status']}（{row['source']}）" for row in rows)
        failures.append('')
    (SPEC/'scenarios/FAILURES.md').write_text('\n'.join(failures)+'\n')
    print(json.dumps({'summary': result['summary'], 'modules': result['modules']}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
