"""Build a checked design-to-test index from explicit Source annotations.

Use the project's spec/step_defs virtualenv. This indexes evidence; it does not
infer semantic coverage or change any test outcome.
"""
from __future__ import annotations
import ast
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from gherkin.parser import Parser
from gherkin.pickles.compiler import Compiler
from pytest_bdd.scenario import make_python_name

ROOT=Path(__file__).resolve().parents[2]
SPEC=ROOT/'spec'
ID=re.compile(r'\b[A-Z]+_\d+\b')


def catalogue():
    result={}
    for path in sorted((SPEC/'scenarios').glob('*.feature')):
        document=Parser().parse(path.read_text());document['uri']=str(path)
        Compiler().compile(document)
        for child in document['feature']['children']:
            if 'scenario' not in child:continue
            scenario=child['scenario'];tags={t['name'] for t in scenario['tags']}
            identifiers=[tag[1:] for tag in tags if ID.fullmatch(tag[1:])]
            assert len(identifiers)==1,(path,scenario['name'])
            sid=identifiers[0];assert sid not in result,sid
            rows=sum(len(e.get('tableBody',[])) for e in scenario.get('examples',[])) or 1
            result[sid]={'title':scenario['name'],'design':path.name,'examples':rows,'decision':'@decision_needed' in tags,'excluded':'@out_of_scope' in tags,'device':'@device' in tags,'bindings':[]}
    return result


def test_bindings():
    result=[]
    for folder,module in [('contracts','backend/test_contract_scenarios.py'),('playback','frontend/test_playback_regressions.py')]:
        for path in sorted((SPEC/'features'/folder).glob('*.feature')):
            document=Parser().parse(path.read_text());previous=0
            for child in document['feature']['children']:
                if 'scenario' not in child:continue
                scenario=child['scenario'];line=scenario['location']['line']
                comments=[c['text'] for c in document['comments'] if previous<c['location']['line']<line and '# Source:' in c['text']]
                sources=ID.findall(' '.join(comments));assert sources,(path,line)
                result.append({'sources':sources,'file':str(path.relative_to(SPEC)),'line':line,'node':module+'::test_'+make_python_name(scenario['name']),'layer':'server' if folder=='contracts' else 'real-sdk'})
                previous=line
    for relative,layer in [('backend/test_ordering_and_generated.py','server-clock'),('frontend/test_controller_ordering.py','controlled-components'),('frontend/test_extended_scenarios.py','real-sdk')]:
        path=SPEC/'step_defs'/relative;source=path.read_text();lines=source.splitlines();previous=0
        for function in ast.parse(source).body:
            if not isinstance(function,(ast.FunctionDef,ast.AsyncFunctionDef)):continue
            if function.name.startswith('test_'):
                start=min([function.lineno]+[d.lineno for d in function.decorator_list])
                comments=re.findall(r'# Source:([^\n]+)','\n'.join(lines[previous:start-1]))
                sources=ID.findall(' '.join(comments));assert sources,(path,function.name)
                result.append({'sources':sources,'file':str(path.relative_to(SPEC)),'line':function.lineno,'node':relative+'::'+function.name,'layer':layer})
            previous=function.end_lineno
    return result


def collect():
    completed=subprocess.run([sys.executable,'-m','pytest','--collect-only','-q','-o','addopts='],cwd=SPEC/'step_defs',capture_output=True,text=True,check=True)
    return {line.strip() for line in completed.stdout.splitlines() if '::test_' in line}


def normalize(classname,name):
    classname=classname.removeprefix('spec.step_defs.')
    return classname.replace('.','/')+'.py::'+name


def run(records):
    designs=catalogue();bindings=test_bindings();collected=collect()
    for binding in bindings:
        nodes=sorted(n for n in collected if n==binding['node'] or n.startswith(binding['node']+'['))
        assert nodes,('uncollected binding',binding)
        binding['cases']=nodes
        for sid in binding['sources']:
            assert sid in designs,('unknown source ID',sid)
            designs[sid]['bindings'].append({k:v for k,v in binding.items() if k!='sources'})
    unbound=[sid for sid,row in designs.items() if not row['bindings'] and not row['decision'] and not row['device'] and not row['excluded']]
    assert not unbound,('designs without executable tests',unbound)
    for sid,row in designs.items():
        row['status']='今回の対象外' if row['excluded'] else '仕様判断待ち' if row['decision'] else '実機確認待ち' if not row['bindings'] and row['device'] else '自動テスト実装あり'
        nodes={n for b in row['bindings'] for n in b['cases']}
        row['observed']=dict(Counter(records[n]['status'] if n in records else 'not-run' for n in nodes))
    counts=Counter(row['status'] for row in designs.values())
    header='''# テスト実装の対応表

設計178定義と、実行可能なテストの対応です。**実装ありは合格済みを意味しません。** 失敗を検出したテストも実装に含めます。

前回未実装だった73定義すべてにテストを追加し、既存の部分実装には時計境界・SDK応答順・最後のページの実再生・30回の不正解・複合操作・表示検証などを補いました。
設計の文章を一対一で実行する方式ではなく、API契約、制御可能な本番Reactコンポーネント、実MusicKit SDKのテストを組み合わせています。各実装先の具体的な前提・assertionが検証範囲です。

SDKの実装そのもの、物理的な音声出力、実機固有の休止や割り込みは、この自動テストの完了に含めません。境界の代替実装は [テスト環境](../harness/README.md) に説明しています。
従来の仕様判断待ちは [DECISIONS.md](DECISIONS.md) で解消し、対象外4定義と実機確認1定義を区別しています。設計件数とテスト件数を割って網羅率を算出しません。

'''
    header+='\n'.join(f'- {key}: {value}定義' for key,value in counts.items())
    header+='\n\n最新の実行結果は [RESULTS.md](RESULTS.md)。機械可読な対応・展開ケースは [coverage.json](coverage.json)。この表は `spec/scripts/scenario_inventory.py` でリンク切れ・未収集の対応・未紐付けIDを確認して生成します。\n\n'
    header+='| 設計ID | 状態 | 設計 | 実装先 |\n| --- | --- | --- | --- |\n'
    lines=[]
    for sid,row in designs.items():
        refs=[]
        for binding in row['bindings']:
            link=f"[{Path(binding['file']).name}:{binding['line']}](../{binding['file']}#L{binding['line']})"
            if link not in refs:refs.append(link)
        lines.append(f"| {sid} | {row['status']} | [{row['title']}]({row['design']}) | {'<br>'.join(refs) or '—'} |")
    (SPEC/'scenarios/IMPLEMENTATION.md').write_text(header+'\n'.join(lines)+'\n')
    (SPEC/'scenarios/coverage.json').write_text(json.dumps({'note':'Explicit Source bindings, not a calculated semantic-coverage percentage. See each implementation and harness limitations.','designs':designs},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'designs':len(designs),'expanded':sum(r['examples'] for r in designs.values()),'statuses':dict(counts),'collected':len(collected)},ensure_ascii=False))
    return collected


if __name__=='__main__':
    path=SPEC/'scenarios/execution-results.json'
    records={r['nodeid']:r for r in json.loads(path.read_text())['tests']} if path.exists() else {}
    run(records)
