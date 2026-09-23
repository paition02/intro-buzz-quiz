"""Deterministic production React controller tests; SDK/transport boundaries are doubles.

These complement, and do not replace, the real MusicKit/browser tests. No source
text is patched: Bun bundles the production components with a socket adapter.
"""
from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session")
def controller_bundle(tmp_path_factory):
    out = tmp_path_factory.mktemp("controller-bundle")
    subprocess.run(["bun", str(ROOT / "spec/step_defs/frontend/build_controller.ts"), str(out)], cwd=ROOT, check=True, capture_output=True, text=True)
    return (out / "controller.js").read_text()


@pytest.fixture
def controlled_page(browser, controller_bundle, tmp_path):
    context = browser.new_context()
    page = context.new_page()
    page.set_default_timeout(1500)
    page.add_init_script(path=str(ROOT / "spec/step_defs/frontend/controlled_musickit.js"))
    page.add_init_script("""window.__sounds=[]; window.AudioContext=class {
      constructor(){window.__sounds.push('context');this.currentTime=0;this.destination={}}
      createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}}
      createOscillator(){return {frequency:{setValueAtTime(){}},connect(){},start(){},stop(){}}}
      close(){return Promise.resolve()} resume(){return Promise.resolve()}
    };""")
    def route(request):
        url = request.request.url
        if url.endswith('/entry.js'):
            request.fulfill(content_type='text/javascript',body=controller_bundle)
        elif url.endswith('/api/token'):
            request.fulfill(json={'token':'test-token','expiresAt':'2099-01-01'})
        elif request.request.resource_type == 'document':
            request.fulfill(content_type='text/html',body='<div id="root"></div><script type="module" src="/entry.js"></script>')
        else:
            request.fulfill(status=404,body='')
    page.route('**/*',route)
    page.goto('http://controller.test/')
    page.wait_for_function('() => window.harness?.ready()')
    now = datetime(2030,1,1,tzinfo=timezone.utc)
    page.clock.install(time=now)
    page.clock.pause_at(now)
    page.evaluate("harness.render('controller')")
    flush(page)
    yield page
    (tmp_path/'controller-observation.json').write_text(page.evaluate("() => JSON.stringify({sdk:sdk.snapshot(),controller:harness.inspect(),commands:harness.commands(),sounds:window.__sounds,modelTrace:sdk.modelTrace}, (key,value) => value instanceof Error ? {name:value.name,message:value.message} : value, 2)"))
    context.close()


def flush(page):
    for _ in range(4):
        page.evaluate('async () => { for(let i=0;i<20;i++) await Promise.resolve(); }')


def advance(page, ms):
    page.clock.run_for(ms)
    flush(page)


def snapshot(page):
    flush(page)
    return page.evaluate('() => ({...sdk.snapshot(),...harness.inspect()})')


def target(page, kind='prepared', song='A', name='current', next_song='B'):
    value={'kind':kind}
    if kind in ('album','albumPrepared'): value['trackId']=song
    elif kind!='stopped': value.update(songId=song,nextSongId=next_song)
    page.evaluate('([value,name]) => harness.target(value,name)',[value,name])
    flush(page)


def release(page,name,error=None):
    page.evaluate('([name,error])=>sdk.release(name,error)',[name,error]);flush(page)


def arm(page,method,name,stage='before'):
    page.evaluate('([method,name,stage])=>sdk.arm(method,name,stage)',[method,name,stage])


def prepare(page):
    target(page);advance(page,300)
    assert snapshot(page)['outcomes']['current']=='resolved'


def game_state(page,step='beforePlayback',**changes):
    state=page.evaluate('harness.initialState')
    state.update(phase='game',quizMode='intro',step=step,selectedPlaylistIds=['playlist-a'],tracks=[{'id':x,'title':'Track '+x,'artist':'Artist '+x,'albumName':'Album '+x} for x in 'ABC'],players=[{'id':x,'score':0} for x in ['P','Q']],shuffledTrackIds=list('ABC'),roundIndex=0)
    state.update(changes)
    return state


def deliver(page,state):
    page.evaluate("s=>harness.deliver('state',s)",state);flush(page)


def console(page,state=None):
    page.evaluate("harness.render('console')");deliver(page,state or game_state(page));advance(page,300)
    assert page.get_by_role('button',name='再生',exact=True).is_enabled()


def ack_command(page,event,state=None,ok=True):
    commands=page.evaluate('harness.commands()')
    indices=[i for i,c in enumerate(commands) if c['event']=='console:'+event and not c['done']]
    assert indices, (event,commands)
    if state is not None: deliver(page,state)
    page.evaluate('([i,ok])=>harness.ack(i,ok)',[indices[-1],ok]);flush(page)


def start(page,seconds=1):
    slider=page.get_by_role('slider',name='再生秒数')
    current=float(slider.get_attribute('aria-valuenow'))
    for _ in range(round(abs(seconds-current)*10)):
        slider.press('ArrowRight' if seconds>current else 'ArrowLeft')
    page.get_by_role('button',name='再生',exact=True).click()
    ack_command(page,'play',game_state(page,'playing'))
    assert snapshot(page)['playing']

@pytest.mark.parametrize('mode',['intro','jacket'])
def test_preparation_never_calls_play_at_audible_volume(controlled_page,mode):
    p=controlled_page
    # Track volume at every invocation, including transient warmup calls.
    p.evaluate("() => { const old=sdk.mk.play; sdk.volumes=[]; sdk.mk.play=function(){sdk.volumes.push(this.volume);return old.call(this)} }")
    if mode=='intro': prepare(p)
    else:
        p.evaluate("harness.render('console')");deliver(p,game_state(p,quizMode='jacket',albums=[{'id':'album','name':'Album','artist':'Artist','trackIds':['A']}],shuffledAlbumIds=['album'],roundAlbumIndex=0));advance(p,300)
    assert not snapshot(p)['playing']
    assert all(v==0 for v in p.evaluate('sdk.volumes'))

@pytest.mark.parametrize('stage',['before','after'])
@pytest.mark.parametrize('completion',['resolve','reject'])
def test_three_superseding_targets_settle_every_waiter_without_stale_error(controlled_page,stage,completion):
    p=controlled_page;prepare(p);arm(p,'play','old',stage)
    target(p,'playing',name='old');advance(p,300)
    target(p,'prepared','B',name='middle');target(p,'stopped',name='stop');target(p,'prepared','C',name='new')
    release(p,'old','obsolete failure' if completion=='reject' else None);advance(p,1000)
    s=snapshot(p)
    assert s['outcomes']['new']=='resolved',s
    assert s['id']=='C' and not s['playing']
    assert s['status']['error'] is None
    assert all(v!='pending' for v in s['outcomes'].values()),s['outcomes']

@pytest.mark.parametrize('unsupported',['missing','reject'])
def test_preload_unavailable_still_allows_loading_the_next_track(controlled_page,unsupported):
    p=controlled_page
    p.evaluate("mode=>{sdk.mk.playNext=mode==='missing'?undefined:async()=>{throw new Error('unsupported')}}",unsupported)
    target(p);advance(p,300)
    assert snapshot(p)['outcomes']['current']=='resolved'
    target(p,'prepared','B',name='next',next_song=None);advance(p,500)
    target(p,'playing','B',name='play',next_song=None);advance(p,300)
    assert snapshot(p)['playing'] and snapshot(p)['id']=='B'

@pytest.mark.parametrize('interval',[0,1,100,249,250,251,500])
def test_debounced_sdk_calls_preserve_requested_play_stop_play(controlled_page,interval):
    p=controlled_page;prepare(p)
    target(p,'playing',name='one');advance(p,300)
    target(p,'prepared',name='pause');advance(p,interval)
    target(p,'playing',name='two');advance(p,600)
    assert snapshot(p)['playing']
    assert snapshot(p)['outcomes']['two']=='resolved'
    calls=snapshot(p)['calls']
    for method in ['play','pause']:
        times=[c['at'] for c in calls if c['method']==method]
        assert all(b-a>=250 for a,b in zip(times,times[1:])),times
    target(p,'stopped',name='final');advance(p,300)
    assert not snapshot(p)['playing']

@pytest.mark.parametrize('method',['pause','seekToTime'])
def test_stop_completion_can_remain_pending_while_reset_becomes_usable(controlled_page,method):
    p=controlled_page;prepare(p);target(p,'playing',name='play');advance(p,500)
    arm(p,method,'stop','after');target(p,'prepared',name='pausing');advance(p,500)
    assert not snapshot(p)['playing']
    assert 'stop' in snapshot(p)['gates']
    target(p,'stopped',name='reset');advance(p,1000)
    assert snapshot(p)['outcomes']['reset']=='resolved'
    release(p,'stop');advance(p,500)
    assert not snapshot(p)['playing']

@pytest.mark.parametrize('method',['setQueue','play','pause'])
def test_unmounted_controller_cannot_start_audio_after_deferred_work(controlled_page,method):
    p=controlled_page;arm(p,method,'old')
    target(p,'playing',name='old');advance(p,500)
    p.evaluate("harness.unmount();harness.render('controller')")
    target(p,'stopped',name='new');advance(p,500)
    release(p,'old');advance(p,1000)
    assert not snapshot(p)['playing'],snapshot(p)

@pytest.mark.parametrize('stage',['before','after'])
def test_old_stop_for_same_track_cannot_cancel_new_controller_play(controlled_page,stage):
    p=controlled_page;prepare(p);target(p,'playing',name='oldplay');advance(p,500)
    arm(p,'pause','oldstop',stage);target(p,'stopped',name='oldstop');advance(p,500)
    p.evaluate("harness.unmount();harness.render('controller')")
    target(p,'playing',name='newplay');advance(p,1000)
    assert snapshot(p)['playing']
    release(p,'oldstop');advance(p,1000)
    assert snapshot(p)['playing'] and snapshot(p)['outcomes']['newplay']=='resolved'

@pytest.mark.parametrize('notification',['identical','players','metadata'])
def test_unrelated_state_updates_preserve_the_original_deadline(controlled_page,notification):
    p=controlled_page;console(p);start(p);advance(p,400)
    state=game_state(p,'playing')
    if notification=='players':state['players'].append({'id':'R','score':0})
    if notification=='metadata':state['tracks'][0]['title']='Updated title'
    for _ in range(10):deliver(p,deepcopy(state))
    advance(p,599);assert snapshot(p)['playing']
    advance(p,1);assert not snapshot(p)['playing']
    assert len([c for c in p.evaluate('harness.commands()') if c['event']=='console:play-ended'])==1

@pytest.mark.parametrize('delay',[0,500,2000,10000])
def test_start_delay_does_not_consume_requested_media_duration(controlled_page,delay):
    p=controlled_page;console(p);arm(p,'play','start')
    p.get_by_role('button',name='再生',exact=True).click();ack_command(p,'play',game_state(p,'playing'))
    advance(p,delay);assert not snapshot(p)['playing']
    release(p,'start');advance(p,499);assert snapshot(p)['playing']
    advance(p,1);assert not snapshot(p)['playing']

@pytest.mark.parametrize('operation',['play-rejected','play-superseded','judgment-rejected'])
def test_delayed_or_rejected_ack_cannot_trigger_obsolete_audio(controlled_page,operation):
    p=controlled_page;console(p)
    if operation=='judgment-rejected':
        deliver(p,game_state(p,'answering',answererId='P'));p.get_by_role('button',name='正解',exact=True).click()
        state=game_state(p,phase='ready',step='idle',players=[],roundIndex=-1)
        ack_command(p,'correct',state,ok=False)
    else:
        p.get_by_role('button',name='再生',exact=True).click()
        state=game_state(p,'answering',answererId='P') if operation=='play-superseded' else game_state(p)
        ack_command(p,'play',state,ok=operation!='play-rejected')
    advance(p,300)
    assert not snapshot(p)['playing'],snapshot(p)
    assert p.evaluate('window.__sounds')==[]
    if operation=='play-superseded':assert p.get_by_role('button',name='正解',exact=True).is_enabled()

@pytest.mark.parametrize('offset',[0,500,999,1000,1001])
def test_buzz_at_virtual_deadline_preserves_answer_rights(controlled_page,offset):
    p=controlled_page;console(p);start(p);advance(p,offset)
    deliver(p,game_state(p,'answering',answererId='P'));advance(p,5000)
    assert not snapshot(p)['playing']
    assert p.get_by_role('button',name='正解',exact=True).is_enabled()
    assert not [c for c in p.evaluate('harness.commands()') if c['event']=='console:play-ended' and offset<1000]

@pytest.mark.parametrize('method',['music','playNext'])
def test_unrelated_metadata_completion_cannot_extend_intro_deadline(controlled_page,method):
    p=controlled_page;console(p)
    # Preparation already has B; force an actual pending optional operation.
    if method=='playNext':p.evaluate('sdk.mk.queue.items=sdk.mk.queue.items.slice(0,1)')
    arm(p,method,'metadata')
    if method=='music':p.evaluate("() => { void sdk.mk.api.music('/metadata').catch(()=>{}); }")
    start(p);advance(p,1000)
    assert not snapshot(p)['playing']
    release(p,'metadata');advance(p,500)
    assert not snapshot(p)['playing']

@pytest.mark.parametrize('destination',['beforePlayback','results'])
@pytest.mark.parametrize('kind',['intro','jacket'])
def test_pending_reveal_cannot_leak_into_next_round_or_results(controlled_page,destination,kind):
    p=controlled_page;console(p)
    arm(p,'play','reveal')
    state=game_state(p,'reveal',quizMode=kind,albums=[{'id':'album','name':'Album','artist':'Artist','trackIds':['A']}],shuffledAlbumIds=['album'],roundAlbumIndex=0)
    deliver(p,state);advance(p,300)
    new=game_state(p,destination,roundIndex=1 if destination=='beforePlayback' else -1)
    deliver(p,new);flush(p)
    if destination=='beforePlayback':
        # An obsolete reveal must not block an independently completed next
        # preparation. Enabled controls require the NEW song to be ready.
        if p.get_by_role('button',name='ギブアップ',exact=True).is_enabled():
            current=snapshot(p)
            assert current['id']=='B' and not current['playing']
    release(p,'reveal');advance(p,1000)
    assert not snapshot(p)['playing']
    if destination=='beforePlayback':assert snapshot(p)['id']=='B'

@pytest.mark.parametrize('wait_ms',[1800000])
def test_half_hour_idle_has_no_obsolete_deadline(controlled_page,wait_ms):
    p=controlled_page;console(p);start(p);advance(p,1000)
    ack_command(p,'play-ended',game_state(p));advance(p,300)
    p.clock.fast_forward(wait_ms);flush(p);start(p);advance(p,200)
    deliver(p,game_state(p,'answering',answererId='P'));advance(p,500)
    assert not snapshot(p)['playing'] and p.get_by_role('button',name='正解',exact=True).is_enabled()

@pytest.mark.parametrize('order',['play-event-first','play-promise-first','pause-event-first','pause-promise-first','duplicate'])
def test_sdk_event_and_promise_orders_do_not_change_media_deadline(controlled_page,order):
    p=controlled_page;console(p)
    if order=='play-event-first':arm(p,'play','held','after')
    elif order=='pause-event-first':arm(p,'pause','held','after')
    elif order in ('play-promise-first','pause-promise-first'):
        method=order.split('-')[0]
        p.evaluate("method=>{const original=sdk.mk[method];sdk.mk[method]=()=>{setTimeout(()=>void original.call(sdk.mk),50);return Promise.resolve()}}",method)
    p.get_by_role('button',name='再生',exact=True).click();ack_command(p,'play',game_state(p,'playing'))
    if order=='duplicate':
        for _ in range(10):p.evaluate("sdk.emit('playbackStateDidChange',{state:2})")
    if order=='play-promise-first':advance(p,50)
    advance(p,499);assert snapshot(p)['playing']
    advance(p,1)
    at_deadline=snapshot(p)
    # A pause whose media side effect is delayed cannot physically stop before
    # that side effect. Audio must be muted at the deadline even in this case.
    assert not at_deadline['playing'] or at_deadline['volume']==0,at_deadline
    advance(p,50);assert not snapshot(p)['playing'],snapshot(p)
    events=[e for e in snapshot(p)['events'] if e['event']=='playbackStateDidChange' and e['at']>=300]
    began=next(e['at'] for e in events if e['payload'].get('state')==2)
    ended=next(e['at'] for e in events if e['payload'].get('state')==3 and e['at']>=began)
    assert ended-began==500+(50 if order=='pause-promise-first' else 0),events
    if 'held' in snapshot(p)['gates']:release(p,'held')
    advance(p,300)
    assert len([c for c in p.evaluate('harness.commands()') if c['event']=='console:play-ended'])==1

@pytest.mark.parametrize('delay',[0,250,1000,5000])
def test_audible_time_excludes_no_promise_completion_delay(controlled_page,delay):
    p=controlled_page;console(p);arm(p,'play','held','after')
    p.get_by_role('button',name='再生',exact=True).click();ack_command(p,'play',game_state(p,'playing'))
    assert snapshot(p)['playing']
    advance(p,min(delay,500))
    if delay>=500:assert not snapshot(p)['playing']
    release(p,'held');advance(p,max(0,500-delay))
    assert not snapshot(p)['playing']

@pytest.mark.parametrize('track,path',[('A','/v1/catalog/us/songs/A'),('i.A','/v1/me/library/songs/i.A/albums')])
def test_album_lookup_uses_the_track_id_namespace(controlled_page,track,path):
    p=controlled_page
    for kind in ['prepared','playing','looping','album']:
        target(p,kind,track,name=kind,next_song=None);advance(p,500)
        assert snapshot(p)['outcomes'][kind]=='resolved'
    assert [c['args'][0] for c in snapshot(p)['calls'] if c['method']=='music']==[path]
    assert snapshot(p)['playing']
    target(p,'stopped',name='end');advance(p,500);assert not snapshot(p)['playing']

@pytest.mark.parametrize('times',[1,10])
def test_redundant_authorization_events_preserve_selection_and_playback(controlled_page,times):
    p=controlled_page;console(p);start(p);before=p.evaluate('harness.commands()')
    for _ in range(times):p.evaluate("sdk.emit('authorizationStatusDidChange')")
    advance(p,1000);assert not snapshot(p)['playing']
    assert [c['event'] for c in p.evaluate('harness.commands()')[len(before):]]==['console:play-ended']

@pytest.mark.parametrize('pending',[False,True])
def test_auth_expiry_leaves_reset_and_reauthorization_usable(controlled_page,pending):
    p=controlled_page;console(p)
    if pending:arm(p,'play','old')
    p.get_by_role('button',name='再生',exact=True).click();ack_command(p,'play',game_state(p,'playing'))
    p.evaluate("sdk.mk.isAuthorized=false;sdk.emit('authorizationStatusDidChange')");flush(p)
    assert p.get_by_role('button',name='リセット',exact=True).is_enabled()
    assert p.get_by_role('button',name='ログイン',exact=True).is_enabled()
    if pending:release(p,'old')
    advance(p,1000);assert not snapshot(p)['playing']

@pytest.mark.parametrize('old_seconds',[3,30])
def test_old_intro_timer_cannot_stop_new_round_reveal_or_play(controlled_page,old_seconds):
    p=controlled_page;console(p);start(p,old_seconds);advance(p,1000)
    deliver(p,game_state(p,'answering',answererId='P'));advance(p,500)
    deliver(p,game_state(p,'reveal'));advance(p,300)
    deliver(p,game_state(p,roundIndex=1));advance(p,500)
    p.get_by_role('button',name='再生',exact=True).click();ack_command(p,'play',game_state(p,'playing',roundIndex=1));advance(p,100)
    assert snapshot(p)['playing'] and snapshot(p)['id']=='B'
    advance(p,old_seconds*1000-2000)
    assert snapshot(p)['playing'] and snapshot(p)['id']=='B'
    advance(p,2000);assert not snapshot(p)['playing']

@pytest.mark.parametrize('case',['query-change','same-title','click-enter','long-japanese'])
def test_answer_candidate_identity_and_selection_are_preserved(controlled_page,case):
    p=controlled_page;state=game_state(p,'answering',answererId='P')
    if case=='same-title':
        for track in state['tracks']:track['title']='同じ名前'
    if case=='long-japanese':
        p.set_viewport_size({'width':390,'height':844});state['tracks'][0]['title']='長い日本語の楽曲タイトル'*30;state['tracks'][0]['artist']='日本語のアーティスト名'*30
    p.evaluate("harness.render('console')");deliver(p,state);advance(p,300)
    answer=p.get_by_role('combobox',name='回答');answer.fill('同じ名前' if case=='same-title' else '長い日本語' if case=='long-japanese' else 'Track')
    if case=='query-change':
        answer.press('ArrowDown');answer.press('ArrowDown');answer.fill('Track B')
        assert p.get_by_role('option').first.get_attribute('aria-selected')=='true'
        answer.press('Enter');expected='wrong'
    elif case=='same-title':p.get_by_role('option').nth(1).click();expected='wrong'
    elif case=='click-enter':p.get_by_role('option').first.click();answer.press('Enter');expected='correct'
    else:p.get_by_role('option').first.click();expected='correct'
    commands=[c for c in p.evaluate('harness.commands()') if c['event'] in ['console:correct','console:wrong']]
    assert [c['event'] for c in commands]==['console:'+expected]
    ack_command(p,expected,game_state(p,expected,answererId='P'))
    assert p.get_by_role('button',name='リセット',exact=True).is_enabled()

@pytest.mark.parametrize('step',['beforePlayback','playing','answering','wrong','correct','reveal','results'])
def test_gameboard_hides_answers_until_reveal_and_keeps_tied_players(controlled_page,step):
    p=controlled_page;state=game_state(p,step,answererId='P',players=[{'id':'P','score':2},{'id':'Q','score':2},{'id':'R','score':0}])
    p.evaluate("harness.render('board')");deliver(p,state);flush(p);text=p.locator('body').inner_text()
    if step!='reveal':assert 'Track A' not in text and 'Album A' not in text
    else:assert 'Track A' in text
    if step=='results':
        for actor in ['P','Q','R']:assert p.get_by_label(actor,exact=True).count()>=1
        assert text.count('2')>=2 and '0' in text
    assert not snapshot(p)['playing']

@pytest.mark.parametrize('cycles',[10])
def test_repeated_mounts_release_dom_subscriptions_and_feedback_timers(controlled_page,cycles):
    p=controlled_page
    p.evaluate("""() => {
      const oldAdd=document.addEventListener,oldRemove=document.removeEventListener;sdk.dom=new Map();
      document.addEventListener=function(type,fn,...rest){if(!sdk.dom.has(type))sdk.dom.set(type,new Set());sdk.dom.get(type).add(fn);return oldAdd.call(this,type,fn,...rest)};
      document.removeEventListener=function(type,fn,...rest){sdk.dom.get(type)?.delete(fn);return oldRemove.call(this,type,fn,...rest)};
    }""")
    baseline=p.evaluate('harness.subscriptions()')
    for _ in range(cycles):
        p.evaluate("harness.render('board')");deliver(p,game_state(p));p.evaluate('harness.unmount()')
        assert p.evaluate("sdk.dom.get('fullscreenchange')?.size ?? 0")==0
        p.evaluate("harness.render('console')");deliver(p,game_state(p,'answering',answererId='P'));advance(p,300)
        p.get_by_role('button',name='不正解',exact=True).click();ack_command(p,'wrong',game_state(p,'wrong',answererId='P'))
        p.evaluate('harness.unmount()');advance(p,1800)
        assert not [c for c in p.evaluate('harness.commands()') if c['event']=='console:wrong-feedback-ended']
        assert p.evaluate('harness.subscriptions()')==baseline
    assert len(p.evaluate('window.__sounds'))==cycles


def library_console(page,selected=None):
    page.evaluate("""() => {
      sdk.responses['/v1/me/library/playlists']={data:[{id:'a',attributes:{name:'List A'}},{id:'b',attributes:{name:'List B'}}]};
      for(const id of ['a','b'])sdk.responses['/v1/me/library/playlists/'+id+'/tracks']={data:[{id:id.toUpperCase(),attributes:{name:'Track '+id,artistName:'Artist',albumName:'Album'}}]};
      sdk.urls={};sdk.urlGates={};const original=sdk.mk.api.music;
      sdk.mk.api.music=async function(url,...args){sdk.urls[url]=(sdk.urls[url]??0)+1;if(sdk.block?.includes(url))await new Promise(resolve=>sdk.urlGates[url]=resolve);return original.call(this,url,...args)};
    }""")
    state=game_state(page,phase='ready',step='idle',quizMode=None,roundIndex=-1,selectedPlaylistIds=selected or [],tracks=[])
    page.evaluate("harness.render('console')");deliver(page,state);advance(page,10)
    assert page.get_by_role('button',name='List A',exact=True).count()==1
    return state

@pytest.mark.parametrize('case',['deselect-late','reverse-completion'])
def test_playlist_response_order_preserves_the_latest_selection(controlled_page,case):
    p=controlled_page
    urls=['/v1/me/library/playlists/a/tracks','/v1/me/library/playlists/b/tracks']
    p.evaluate('urls=>sdk.block=urls',urls)
    state=library_console(p,['a'] if case=='deselect-late' else ['a','b'])
    # Opening a panel begins a query independently of selection operations.
    p.get_by_role('button',name='プレイリストを開く').first.click();advance(p,10)
    if case=='deselect-late':
        p.get_by_role('button',name='List A',exact=True).click();flush(p)
        commands=p.evaluate('harness.commands()');select=[c for c in commands if c['event']=='console:select-playlists']
        assert select[-1]['body']['selectedPlaylistIds']==[]
        state['selectedPlaylistIds']=[];ack_command(p,'select-playlists',state)
        p.evaluate('url=>{sdk.urlGates[url]()}',urls[0]);advance(p,10)
        assert p.get_by_role('button',name='List A',exact=True).get_attribute('aria-pressed')=='false'
        assert len([c for c in p.evaluate('harness.commands()') if c['event']=='console:select-playlists'])==1
    else:
        p.get_by_role('button',name='プレイリストを開く').first.click();advance(p,10)
        # Deselect and reselect A after both initial fetches resolve in reverse order.
        p.evaluate('url=>{sdk.urlGates[url]()}',urls[1]);advance(p,10)
        p.evaluate('url=>{sdk.urlGates[url]()}',urls[0]);advance(p,10)
        for name,ids in [('List A',['b']),('List A',['a','b'])]:
            p.get_by_role('button',name=name,exact=True).click();flush(p)
            command=[c for c in p.evaluate('harness.commands()') if c['event']=='console:select-playlists'][-1]
            assert command['body']['selectedPlaylistIds']==ids
            assert {t['id'] for t in command['body']['tracks']}=={v.upper() for v in ids}
            state.update(command['body']);ack_command(p,'select-playlists',state);advance(p,10)

@pytest.mark.parametrize('failure',['second-page-error','cycle','missing-data'])
def test_malformed_pagination_terminates_with_a_visible_error(controlled_page,failure):
    p=controlled_page
    p.evaluate("""failure=>{
      const original=sdk.mk.api.music;sdk.pageCalls=0;
      sdk.mk.api.music=async function(url,...args){
        if(!url.includes('/playlists'))return original.call(this,url,...args);
        sdk.pageCalls++;
        if(sdk.pageCalls>10)await new Promise(resolve=>sdk.paginationGate=resolve);
        if(failure==='missing-data')return {data:{}};
        if(url==='/v1/me/library/playlists')return {data:{data:[{id:'a',attributes:{name:'List A'}}],next:'/next/playlists'}};
        if(failure==='second-page-error')throw new Error('Injected page two failure');
        return {data:{data:[],next:'/next/playlists'}};
      };
    }""",failure)
    p.evaluate("harness.render('console')");deliver(p,game_state(p,phase='ready',step='idle',roundIndex=-1));advance(p,1000)
    assert p.evaluate('sdk.pageCalls')<=10,'pagination repeated the same next link without terminating'
    assert p.get_by_role('button',name='再読み込み',exact=True).is_enabled()
    assert p.locator('li span.text-rose').count()>0,'malformed or failed page must not be shown as a complete empty library'

@pytest.mark.parametrize('ack_order',['forward','reverse'])
def test_late_hint_acknowledgements_cannot_overwrite_latest_input(controlled_page,ack_order):
    p=controlled_page;state=game_state(p,quizMode='jacket',albums=[{'id':'album','name':'Album','artist':'Artist','trackIds':['A']}],shuffledAlbumIds=['album'],roundAlbumIndex=0)
    p.evaluate("harness.render('console')");deliver(p,state);advance(p,300)
    slider=p.get_by_role('slider',name='ヒントレベル')
    for value in [12,47,12]:
        current=int(slider.get_attribute('aria-valuenow'))
        for _ in range(abs(value-current)):slider.press('ArrowRight' if value>current else 'ArrowLeft')
    commands=p.evaluate('harness.commands()');indices=[i for i,c in enumerate(commands) if c['event']=='console:set-jacket-hint-percent']
    assert commands[indices[-1]]['body']['jacketHintPercent']==12
    state['jacketHintPercent']=12;deliver(p,state)
    for i in indices if ack_order=='forward' else reversed(indices):
        p.evaluate('i=>harness.ack(i)',i);flush(p)
        assert slider.get_attribute('aria-valuenow')=='12'

@pytest.mark.parametrize('sequence',[
    [.1,.5,1,3,10,30],[30,10,3,1,.5,.1],[.1,30,.1,30,.1],
    [.1,.2,.3,.9,1.1],[1,1,1,1,1],[3,.1,10,.5,2],[5,1],[.5,1,2,3],
])
def test_every_catalogue_duration_sequence_uses_its_own_exact_deadline(controlled_page,sequence):
    p=controlled_page;console(p)
    for seconds in sequence:
        advance(p,300);start(p,seconds)
        assert snapshot(p)['id']=='A' and snapshot(p)['position']==0
        advance(p,round(seconds*1000)-1);assert snapshot(p)['playing']
        advance(p,1);assert not snapshot(p)['playing']
        ack_command(p,'play-ended',game_state(p));advance(p,300)
        assert p.get_by_role('button',name='再生',exact=True).is_enabled()

@pytest.mark.parametrize('late',['stop','error'])
def test_immediate_wrong_judgment_survives_late_stop_or_old_play_error(controlled_page,late):
    p=controlled_page;console(p)
    if late=='error':arm(p,'play','old','after')
    start(p)
    if late=='stop':arm(p,'pause','old')
    deliver(p,game_state(p,'answering',answererId='P'));flush(p)
    assert p.get_by_role('button',name='不正解',exact=True).is_enabled()
    p.get_by_role('button',name='不正解',exact=True).click();ack_command(p,'wrong',game_state(p,'wrong',answererId='P'))
    advance(p,500);release(p,'old','late play failure' if late=='error' else None);advance(p,1300)
    assert not snapshot(p)['playing']
    ack_command(p,'wrong-feedback-ended',game_state(p));advance(p,300)
    assert p.get_by_role('button',name='再生',exact=True).is_enabled()

@pytest.mark.parametrize('recovery',[1001,5000])
def test_buffer_recovery_after_explicit_stop_cannot_resume_the_old_intro(controlled_page,recovery):
    p=controlled_page;console(p);start(p)
    # Emulate a buffering SDK whose actual motion stops while playback intent
    # remains active. A real pause must cancel that intent before recovery.
    p.evaluate("""() => {
      sdk.bufferIntent=true;const pause=sdk.mk.pause;
      sdk.mk.pause=async()=>{sdk.bufferIntent=false;return pause.call(sdk.mk)};
      void pause.call(sdk.mk);
    }""");flush(p)
    assert not snapshot(p)['playing']
    # Waiting does not consume the intro duration. End the intro
    # with an actual user interruption before checking stale buffer recovery.
    deliver(p,game_state(p,'answering',answererId='P'))
    advance(p,recovery)
    p.evaluate("() => {if(sdk.bufferIntent)void sdk.mk.play()} ");flush(p)
    assert not snapshot(p)['playing'],'buffer recovery restarted a completed intro'
    assert p.get_by_role('button',name='リセット',exact=True).is_enabled()

@pytest.mark.parametrize('condition',['network-500','next-load-3000','state-100','cpu','cold','warm'])
def test_four_rounds_under_controlled_latency_and_cache_conditions(controlled_page,condition):
    p=controlled_page;console(p)
    if condition=='cpu':
        cdp=p.context.new_cdp_session(p);cdp.send('Emulation.setCPUThrottlingRate',{'rate':4})
    state=game_state(p);state['shuffledTrackIds']=list('ABCD');state['tracks'].append({'id':'D','title':'Track D','artist':'Artist D','albumName':'Album D'})
    deliver(p,state)
    # SDK delays represent I/O at the production controller boundary, while
    # actual network and codec behavior are tested by the real SDK module.
    if condition in ['network-500','next-load-3000']:
        p.evaluate("""condition=>{for(const method of (condition==='network-500'?['setQueue','playNext']:['skipToNextItem'])){
          const original=sdk.mk[method];sdk.mk[method]=async(...args)=>{await new Promise(r=>setTimeout(r,condition==='network-500'?500:3000));return original.apply(sdk.mk,args)}
        }}""",condition)
    for index in range(4):
        state.update(step='beforePlayback',roundIndex=index,answererId=None);deliver(p,state);advance(p,4000)
        if condition=='cold':p.evaluate('sdk.mk.queue.items=sdk.mk.queue.items.slice(0,1)')
        for seconds in [.5,1,1.5]:
            slider=p.get_by_role('slider',name='再生秒数');current=float(slider.get_attribute('aria-valuenow'))
            for _ in range(round(abs(seconds-current)*10)):slider.press('ArrowRight' if seconds>current else 'ArrowLeft')
            mark=len(snapshot(p)['events'])
            p.get_by_role('button',name='再生',exact=True).click();state['step']='playing'
            if condition=='state-100':advance(p,100)
            ack_command(p,'play',state);advance(p,round(seconds*1000)+1000)
            assert not snapshot(p)['playing'] and snapshot(p)['id']==state['shuffledTrackIds'][index]
            events=[e for e in snapshot(p)['events'][mark:] if e['event']=='playbackStateDidChange' and (e['payload'].get('state')==3 or e['volume']>0)]
            began=next(e['at'] for e in events if e['payload'].get('state')==2)
            ended=next(e['at'] for e in events if e['payload'].get('state')==3 and e['at']>=began)
            assert ended-began==round(seconds*1000),(condition,index,seconds,events)
            state['step']='beforePlayback';ack_command(p,'play-ended',state);advance(p,500)
        state.update(step='answering',answererId='P');deliver(p,state);advance(p,500)
        p.get_by_role('button',name='不正解',exact=True).click();state['step']='wrong';ack_command(p,'wrong',state);advance(p,1800)
        state.update(step='beforePlayback',answererId=None);ack_command(p,'wrong-feedback-ended',state);advance(p,500)
        p.get_by_role('button',name='再生',exact=True).click();state['step']='playing';ack_command(p,'play',state);advance(p,500)
        assert snapshot(p)['playing'];state.update(step='answering',answererId='P');deliver(p,state);advance(p,500)
        p.get_by_role('button',name='正解',exact=True).click();state['step']='correct';state['players'][0]['score']=index+1;ack_command(p,'correct',state);advance(p,1800)
        state['step']='reveal';ack_command(p,'correct-feedback-ended',state);advance(p,500)
        assert snapshot(p)['playing'] and snapshot(p)['id']==state['shuffledTrackIds'][index]
    p.get_by_role('button',name='結果発表へ',exact=True).click();state.update(step='results',roundIndex=-1);ack_command(p,'show-results',state);advance(p,1000)
    assert not snapshot(p)['playing']

@pytest.mark.parametrize('operation',['setQueue','play','pause','seekToTime','skipToNextItem','playNext','music'])
def test_each_unresolved_sdk_boundary_allows_reset_without_audio_revival(controlled_page,operation):
    p=controlled_page;prepare(p)
    if operation=='seekToTime':target(p,'playing',name='before');advance(p,500)
    arm(p,operation,'old')
    if operation=='music':target(p,'album',name='pending')
    elif operation=='skipToNextItem':target(p,'prepared','B',name='pending')
    elif operation=='seekToTime':target(p,'prepared',name='pending')
    elif operation=='play':target(p,'playing',name='pending')
    else:target(p,'prepared','C',name='pending',next_song='D')
    advance(p,500);assert 'old' in snapshot(p)['gates'],snapshot(p)
    target(p,'stopped',name='reset');advance(p,1000)
    assert not snapshot(p)['playing']
    release(p,'old');advance(p,1000)
    assert not snapshot(p)['playing']
    target(p,'prepared','Z',name='newgame',next_song=None);advance(p,1000)
    assert snapshot(p)['id']=='Z' and snapshot(p)['outcomes']['newgame']=='resolved'

@pytest.mark.parametrize('games',[10])
def test_ten_games_in_one_console_do_not_accumulate_callbacks_or_timers(controlled_page,games):
    p=controlled_page;console(p)
    p.evaluate("""() => { sdk.timers=new Map();const set=window.setTimeout,clear=window.clearTimeout;
      window.setTimeout=(fn,ms,...args)=>{const id=set(()=>{sdk.timers.delete(id);fn(...args)},ms);sdk.timers.set(id,ms);return id};
      window.clearTimeout=id=>{sdk.timers.delete(id);return clear(id)};
    }""")
    listener_baseline=snapshot(p)['listeners'];timer_counts=[]
    for index in range(games):
        state=game_state(p);deliver(p,state);advance(p,500);start(p,.5);advance(p,200)
        state.update(step='answering',answererId='P');deliver(p,state);advance(p,500)
        p.get_by_role('button',name='正解',exact=True).click();state['step']='correct';state['players'][0]['score']=1;ack_command(p,'correct',state)
        advance(p,1800);state['step']='reveal';ack_command(p,'correct-feedback-ended',state);advance(p,500)
        p.get_by_role('button',name='結果発表へ',exact=True).click();state.update(step='results',roundIndex=-1,answererId=None);ack_command(p,'show-results',state);advance(p,500)
        assert not snapshot(p)['playing'] and snapshot(p)['listeners']==listener_baseline
        timer_counts.append(p.evaluate('sdk.timers.size'))
        assert len([c for c in p.evaluate('harness.commands()') if c['event']=='console:correct-feedback-ended'])==index+1
        p.get_by_role('button',name='次のゲームへ',exact=True).click();state.update(phase='ready',step='idle',players=[]);ack_command(p,'next-game',state);advance(p,500)
    assert max(timer_counts)-min(timer_counts)<=1,timer_counts
    assert len(p.evaluate('window.__sounds'))==games*2

@pytest.mark.parametrize('mode',['intro','jacket'])
@pytest.mark.parametrize('seed',[1,7,42,20260922])
def test_seeded_console_actions_match_an_independent_audio_and_score_model(controlled_page,mode,seed):
    import random
    rng=random.Random(seed);p=controlled_page;console(p)
    state=game_state(p,quizMode=mode)
    state['shuffledTrackIds']=list('ABCDEF')
    state['tracks']=[{'id':x,'title':'Track '+x,'artist':'Artist','albumName':'Album '+x} for x in 'ABCDEF']
    state['albums']=[{'id':'album-'+x,'name':'Album '+x,'artist':'Artist','trackIds':[x]} for x in 'ABCDEF']
    state['shuffledAlbumIds']=['album-'+x for x in 'ABCDEF'];state['roundAlbumIndex']=0
    for x in 'ABCDEF':p.evaluate('([x,response])=>sdk.responses["/v1/catalog/us/songs/"+x]=response',[x,{'data':[{'relationships':{'albums':{'data':[{'id':'album-'+x}]}}}]}])
    scores={'P':0,'Q':0};index=0;model='ready';trace=[]
    p.evaluate('sdk.modelTrace=[]')
    deliver(p,state);advance(p,500)
    for number in range(200):
        choices={'ready':['buzz','give-up','reset']+(['intro'] if mode=='intro' else ['hint']), 'answer':['correct','wrong','reset'],'reveal':['results','reset']+(['next'] if index<5 else []),'results':['new-game','reset']}
        action=rng.choice(choices[model]);trace.append({'seed':seed,'mode':mode,'index':number,'action':action,'round':index,'scores':dict(scores)})
        p.evaluate('event=>sdk.modelTrace.push(event)',trace[-1])
        if action=='intro':
            p.get_by_role('button',name='再生',exact=True).click();state['step']='playing';ack_command(p,'play',state);advance(p,499)
            assert snapshot(p)['playing'] and snapshot(p)['id']=='ABCDEF'[index]
            advance(p,1);state['step']='beforePlayback';ack_command(p,'play-ended',state);advance(p,300)
        elif action=='buzz':
            if mode=='intro':
                p.get_by_role('button',name='再生',exact=True).click();state['step']='playing';ack_command(p,'play',state);advance(p,100)
            state.update(step='answering',answererId=rng.choice(['P','Q']));deliver(p,state);advance(p,500);model='answer'
        elif action in ['correct','wrong']:
            p.get_by_role('button',name='正解' if action=='correct' else '不正解',exact=True).click();state['step']=action
            if action=='correct':scores[state['answererId']]+=1
            state['players']=[{'id':k,'score':v} for k,v in scores.items()];ack_command(p,action,state);advance(p,1800)
            state['step']='reveal' if action=='correct' else 'beforePlayback'
            if action=='wrong':state['answererId']=None
            ack_command(p,action+'-feedback-ended',state);advance(p,500);model='reveal' if action=='correct' else 'ready'
        elif action=='give-up':
            p.get_by_role('button',name='ギブアップ',exact=True).click();state['step']='reveal';ack_command(p,'give-up',state);advance(p,500);model='reveal'
        elif action=='next':
            p.get_by_role('button',name='次のラウンドへ',exact=True).click();index+=1;state.update(step='beforePlayback',roundIndex=index,roundAlbumIndex=index,answererId=None);ack_command(p,'next-round',state);advance(p,500);model='ready'
        elif action=='results':
            p.get_by_role('button',name='結果発表へ',exact=True).click();state.update(step='results',roundIndex=-1,roundAlbumIndex=-1,answererId=None);ack_command(p,'show-results',state);advance(p,500);model='results'
        elif action=='hint':
            p.get_by_role('slider',name='ヒントレベル').press('ArrowRight');cmd=[c for c in p.evaluate('harness.commands()') if c['event']=='console:set-jacket-hint-percent'][-1];state.update(cmd['body']);ack_command(p,'set-jacket-hint-percent',state)
        else:
            p.get_by_role('button',name='リセット' if action=='reset' else '次のゲームへ',exact=True).click()
            state.update(phase='ready',step='idle',roundIndex=-1,roundAlbumIndex=-1,players=[],answererId=None)
            ack_command(p,'reset' if action=='reset' else 'next-game',state);advance(p,500)
            index=0;scores={'P':0,'Q':0};state.update(phase='game',step='beforePlayback',roundIndex=0,roundAlbumIndex=0,players=[{'id':k,'score':v} for k,v in scores.items()]);deliver(p,state);advance(p,500);model='ready'
        media=snapshot(p)
        assert media['playing']==(model=='reveal'),trace[-1]
        if model=='reveal':assert media['id']==('ABCDEF'[index] if mode=='intro' else 'album-'+'ABCDEF'[index]),trace[-1]
        assert p.get_by_role('button',name='リセット',exact=True).is_enabled()
    p.get_by_role('button',name='リセット',exact=True).click();state.update(phase='ready',step='idle',players=[],tracks=[],albums=[],roundIndex=-1,roundAlbumIndex=-1,answererId=None);ack_command(p,'reset',state);advance(p,500)
    assert not snapshot(p)['playing'] and not snapshot(p)['gates']

@pytest.mark.parametrize('volume',[0,.4])
def test_volume_is_preserved_across_prepare_play_stop_and_next(controlled_page,volume):
    p=controlled_page;p.evaluate('v=>sdk.mk.volume=v',volume)
    for kind,song in [('prepared','A'),('playing','A'),('prepared','A'),('prepared','B'),('playing','B'),('stopped','B')]:
        target(p,kind,song,name=kind+song);advance(p,500)
        assert snapshot(p)['volume']==volume

@pytest.mark.parametrize('resolution',['wrong','correct','new-game'])
def test_third_stop_can_be_superseded_by_the_full_following_operation_chain(controlled_page,resolution):
    p=controlled_page;console(p)
    for seconds in [.5,1]:
        start(p,seconds);advance(p,round(seconds*1000));ack_command(p,'play-ended',game_state(p));advance(p,300)
    start(p,1.5);arm(p,'pause','old-stop');advance(p,1500)
    if resolution=='new-game':
        p.get_by_role('button',name='リセット',exact=True).click();ack_command(p,'reset',game_state(p,phase='ready',step='idle',tracks=[],players=[],roundIndex=-1))
        deliver(p,game_state(p,shuffledTrackIds=['C','B','A']))
    else:
        deliver(p,game_state(p,'answering',answererId='P'));flush(p)
        p.get_by_role('button',name='不正解' if resolution=='wrong' else '正解',exact=True).click()
        ack_command(p,resolution,game_state(p,resolution,answererId='P'));advance(p,1800)
        ack_command(p,resolution+'-feedback-ended',game_state(p,'beforePlayback' if resolution=='wrong' else 'reveal'))
    release(p,'old-stop');advance(p,1000)
    assert snapshot(p)['playing']==(resolution=='correct')
    assert p.get_by_role('button',name='リセット',exact=True).is_enabled()
    if resolution!='correct':assert p.get_by_role('button',name='再生',exact=True).is_enabled()
    if resolution=='new-game':assert snapshot(p)['id']=='C'

@pytest.mark.parametrize('method',['play','pause','seekToTime','music'])
def test_results_and_next_controls_remain_usable_during_pending_reveal_work(controlled_page,method):
    p=controlled_page;console(p)
    if method in ['pause','seekToTime']:start(p,1);advance(p,300)
    arm(p,method,'old')
    state=game_state(p,'reveal')
    if method=='music':state.update(quizMode='jacket',albums=[{'id':'album','name':'Album','artist':'Artist','trackIds':['A']}],shuffledAlbumIds=['album'],roundAlbumIndex=0)
    deliver(p,state);advance(p,300)
    assert 'old' in snapshot(p)['gates']
    assert p.get_by_role('button',name='結果発表へ',exact=True).is_enabled()
    p.get_by_role('button',name='結果発表へ',exact=True).click();state.update(step='results',roundIndex=-1,roundAlbumIndex=-1);ack_command(p,'show-results',state)
    release(p,'old');advance(p,1000)
    assert not snapshot(p)['playing']

@pytest.mark.parametrize('missing',['id','name'])
def test_playlist_mapping_drops_incomplete_identity_before_selection(controlled_page,missing):
    p=controlled_page
    p.evaluate("""missing=>{
      sdk.responses['/v1/me/library/playlists']={data:[{id:'a',attributes:{name:'List A'}}]};
      const bad={id:'bad',attributes:{name:'Bad song',artistName:'Artist'}};
      if(missing==='id')delete bad.id;else delete bad.attributes.name;
      sdk.responses['/v1/me/library/playlists/a/tracks']={data:[{id:'A',attributes:{name:'Good song',artistName:'Artist'}},bad]};
    }""",missing)
    p.evaluate("harness.render('console')");state=game_state(p,phase='ready',step='idle',roundIndex=-1,tracks=[],selectedPlaylistIds=[]);deliver(p,state);advance(p,50)
    p.get_by_role('button',name='List A',exact=True).click();flush(p)
    selection=[c for c in p.evaluate('harness.commands()') if c['event']=='console:select-playlists'][-1]['body']
    assert [(t['id'],t['title']) for t in selection['tracks']]==[('A','Good song')]
    state.update(selection);ack_command(p,'select-playlists',state)

@pytest.mark.parametrize('operation',['play','seekToTime','pause'])
def test_failure_at_actual_replay_boundary_is_visible_and_recoverable(controlled_page,operation):
    p=controlled_page;console(p)
    if operation=='seekToTime':
        p.evaluate("sdk.mk.seekToTime(5)");flush(p)
    arm(p,operation,'failure','reject')
    p.get_by_role('button',name='再生',exact=True).click();ack_command(p,'play',game_state(p,'playing'));advance(p,1000)
    text=p.locator('body').inner_text()
    assert 'Injected '+operation+' failure' in text
    if operation=='seekToTime':assert not snapshot(p)['playing']
    assert p.get_by_role('button',name='リセット',exact=True).is_enabled()
    p.get_by_role('button',name='リセット',exact=True).click();ack_command(p,'reset',game_state(p,phase='ready',step='idle',roundIndex=-1));advance(p,500)
    deliver(p,game_state(p));advance(p,500);start(p,.5);advance(p,500)
    assert not snapshot(p)['playing']

@pytest.mark.parametrize('first',['correct','wrong'])
def test_losing_judgment_ack_never_schedules_sound_or_feedback(controlled_page,first):
    p=controlled_page;console(p);deliver(p,game_state(p,'answering',answererId='P'));advance(p,500)
    p.evaluate("""first=>{const buttons=[...document.querySelectorAll('button')];const correct=buttons.find(b=>b.textContent==='正解');const wrong=buttons.find(b=>b.textContent==='不正解');(first==='correct'?correct:wrong).click();(first==='correct'?wrong:correct).click()}""",first);flush(p)
    requests=p.evaluate('harness.commands()');indices=[i for i,c in enumerate(requests) if c['event'] in ['console:correct','console:wrong']]
    assert indices
    deliver(p,game_state(p,first,answererId='P'))
    for order,i in enumerate(indices):p.evaluate('([i,ok])=>harness.ack(i,ok)',[i,order==0]);flush(p)
    advance(p,1800)
    assert len(p.evaluate('window.__sounds'))==1
    feedback=[c['event'] for c in p.evaluate('harness.commands()') if c['event'].endswith('-feedback-ended')]
    assert feedback==['console:'+first+'-feedback-ended']

@pytest.mark.parametrize('surface',['console','board'])
def test_connection_loss_is_visible_and_cannot_extend_the_host_deadline(controlled_page,surface):
    p=controlled_page;console(p);start(p)
    if surface=='board':p.evaluate("harness.render('board')")
    p.evaluate("harness.deliver('disconnect')");flush(p)
    assert '再接続' in p.locator('body').inner_text(),'disconnected surface has no connection-loss indication'
    if surface=='console':advance(p,1000);assert not snapshot(p)['playing']
    p.evaluate("harness.deliver('connect')");flush(p)
    assert '再接続' not in p.locator('body').inner_text()

@pytest.mark.parametrize('time_ms',[0,500,1999,2000,2001])
def test_next_round_at_each_loop_boundary_prepares_only_the_immediate_next_track(controlled_page,time_ms):
    p=controlled_page;console(p);deliver(p,game_state(p,'reveal'));advance(p,300)
    assert snapshot(p)['playing'];advance(p,time_ms)
    if time_ms>=2000:
        # Supply the SDK's loop-boundary notification before the host operation.
        p.evaluate("sdk.emit('playbackStateDidChange',{state:4})")
    p.get_by_role('button',name='次のラウンドへ',exact=True).click()
    ack_command(p,'next-round',game_state(p,roundIndex=1));advance(p,500)
    if time_ms>=2000:p.evaluate("sdk.emit('playbackStateDidChange',{state:2})");flush(p)
    assert snapshot(p)['id']=='B' and not snapshot(p)['playing']
    assert p.get_by_role('button',name='再生',exact=True).is_enabled()

@pytest.mark.parametrize('method',['setQueue','playNext'])
def test_results_supersede_reveal_load_and_preload(controlled_page,method):
    p=controlled_page;console(p)
    p.evaluate('sdk.mk.queue.items=sdk.mk.queue.items.slice(0,1)')
    arm(p,method,'old')
    state=game_state(p,'reveal',roundIndex=1 if method=='setQueue' else 0)
    deliver(p,state);advance(p,500);assert 'old' in snapshot(p)['gates']
    p.get_by_role('button',name='結果発表へ',exact=True).click();state.update(step='results',roundIndex=-1);ack_command(p,'show-results',state)
    release(p,'old');advance(p,1000)
    assert not snapshot(p)['playing']
    assert p.get_by_role('button',name='次のゲームへ',exact=True).is_enabled()

@pytest.mark.parametrize('new_kind',['stopped','playing'])
def test_unmounted_console_ack_cannot_reclaim_the_new_audio_owner(controlled_page,new_kind):
    p=controlled_page;console(p)
    p.get_by_role('button',name='再生',exact=True).click()
    deliver(p,game_state(p,'playing'))
    p.evaluate("harness.unmount();harness.render('controller')")
    if new_kind=='playing':
        target(p,'prepared','B',name='prepare-new',next_song=None);advance(p,500)
    target(p,new_kind,'B',name='new-owner',next_song=None);advance(p,500)
    before=snapshot(p)
    ack_command(p,'play');advance(p,1000)
    after=snapshot(p)
    assert after['playing']==(new_kind=='playing')
    assert after['id']==before['id']
    assert after['outcomes']['new-owner']=='resolved'
    if new_kind=='playing':assert after['position']>=before['position']

@pytest.mark.parametrize('next_seconds',[.5,5])
def test_duration_change_applies_only_to_next_play(controlled_page,next_seconds):
    p=controlled_page;console(p);start(p,3);advance(p,1000)
    slider=p.get_by_role('slider',name='再生秒数')
    for _ in range(round(abs(next_seconds-3)*10)):
        slider.press('ArrowRight' if next_seconds>3 else 'ArrowLeft')
    assert p.get_by_text('3秒再生中。早押し待ちです',exact=True).is_visible()
    advance(p,1999);assert snapshot(p)['playing']
    advance(p,1);assert not snapshot(p)['playing']
    ack_command(p,'play-ended',game_state(p));advance(p,300)
    start(p,next_seconds);advance(p,round(next_seconds*1000)-1);assert snapshot(p)['playing']
    advance(p,1);assert not snapshot(p)['playing']

@pytest.mark.parametrize('delay',[2000,10000])
def test_buffer_wait_is_excluded_from_intro_duration(controlled_page,delay):
    p=controlled_page;console(p);start(p,3);advance(p,1000)
    p.evaluate('sdk.mk.pause()');flush(p)
    advance(p,delay)
    assert not any(c['event']=='console:play-ended' for c in p.evaluate('harness.commands()'))
    p.evaluate('sdk.mk.play()');flush(p)
    advance(p,1999);assert snapshot(p)['playing']
    advance(p,1);assert not snapshot(p)['playing']
    assert any(c['event']=='console:play-ended' for c in p.evaluate('harness.commands()'))

@pytest.mark.parametrize('step',['beforePlayback','playing','answering','correct','wrong','reveal','results'])
def test_console_remount_recovers_each_game_step(controlled_page,step):
    p=controlled_page;console(p)
    state=game_state(p,step,answererId='P' if step in ['answering','correct','wrong'] else None,operationId='recover-'+step)
    state['players'][0]['score']=2
    deliver(p,state)
    p.evaluate("harness.unmount();harness.render('console')");flush(p);advance(p,300)
    if step=='playing':
        assert not snapshot(p)['playing']
        ack_command(p,'play-ended',game_state(p,operationId='waiting'));advance(p,300)
        assert p.get_by_role('button',name='再生',exact=True).is_enabled()
    elif step in ['correct','wrong']:
        advance(p,1500)
        assert any(c['event']==f'console:{step}-feedback-ended' and c['body']['operationId']=='recover-'+step for c in p.evaluate('harness.commands()'))
        assert not any(c['event'] in ['console:correct','console:wrong'] for c in p.evaluate('harness.commands()'))
    elif step=='reveal':assert snapshot(p)['playing']
    elif step=='answering':
        assert not snapshot(p)['playing']
        assert p.get_by_role('button',name='正解',exact=True).is_enabled()
    else:assert not snapshot(p)['playing']

@pytest.mark.parametrize('delivered',[True,False])
def test_missing_play_ack_returns_to_waiting_without_playing(controlled_page,delivered):
    p=controlled_page;console(p)
    p.get_by_role('button',name='再生',exact=True).click()
    if delivered:deliver(p,game_state(p,'playing',operationId='lost-ack'))
    p.evaluate("() => { const i=harness.commands().findIndex(c=>c.event==='console:play'&&!c.done); harness.failAck(i) }");flush(p);advance(p,300)
    if not delivered:deliver(p,game_state(p,'playing',operationId='lost-ack'));advance(p,300)
    assert not snapshot(p)['playing']
    ack_command(p,'play-ended',game_state(p));advance(p,300)
    assert p.get_by_role('button',name='再生',exact=True).is_enabled()

@pytest.mark.parametrize('status',[404,410,401,500])
def test_only_definitive_unavailable_track_errors_exclude_the_track(controlled_page,status):
    p=controlled_page
    p.evaluate('status=>{sdk.mk.setQueue=async()=>{throw Object.assign(new Error("load failed"),{status})}}',status)
    p.evaluate("harness.render('console')");deliver(p,game_state(p));advance(p,300)
    commands=[c for c in p.evaluate('harness.commands()') if c['event']=='console:exclude-track']
    assert bool(commands)==(status in [404,410])
    if commands:assert commands[0]['body']['trackId']=='A'

@pytest.mark.parametrize('all_unavailable',[False,True])
def test_known_unavailable_tracks_are_excluded_during_selection(controlled_page,all_unavailable):
    p=controlled_page
    p.evaluate('''allUnavailable=>{
      sdk.responses['/v1/me/library/playlists']={data:[{id:'a',attributes:{name:'List A'}}]};
      sdk.responses['/v1/me/library/playlists/a/tracks']={data:[
        {id:'missing',attributes:{name:'Unavailable',playParams:null}},
        {id:'valid',attributes:{name:'Playable',playParams:allUnavailable?null:{id:'valid'}}}
      ]};
    }''',all_unavailable)
    p.evaluate("harness.render('console')");deliver(p,game_state(p,phase='ready',step='idle',selectedPlaylistIds=[]));advance(p,300)
    p.get_by_role('button',name='List A',exact=True).click();flush(p)
    command=next(c for c in p.evaluate('harness.commands()') if c['event']=='console:select-playlists')
    assert [t['id'] for t in command['body']['tracks']]==([] if all_unavailable else ['valid'])
    ack_command(p,'select-playlists',game_state(p,phase='ready',step='idle',**command['body']))
    removed=2 if all_unavailable else 1
    assert p.get_by_text(f'1件のプレイリストから{2-removed}曲を選択しました。再生できない{removed}曲を除外しました',exact=True).is_visible()

@pytest.mark.parametrize('method',['setQueue','play'])
def test_sdk_error_event_excludes_unavailable_track_while_call_is_pending(controlled_page,method):
    p=controlled_page;arm(p,method,'never-finished')
    p.evaluate("harness.render('console')");deliver(p,game_state(p));advance(p,300)
    p.evaluate("sdk.emit('mediaPlaybackError',{error:Object.assign(new Error('deleted'),{status:404})})");flush(p)
    commands=[c for c in p.evaluate('harness.commands()') if c['event']=='console:exclude-track']
    assert commands and commands[-1]['body']['trackId']=='A'
    p.get_by_role('button',name='リセット',exact=True).click();flush(p)
    release(p,'never-finished');advance(p,300)
    assert not snapshot(p)['playing']

@pytest.mark.parametrize('status',[404,410])
def test_unavailable_event_after_play_started_stops_and_excludes_current_track(controlled_page,status):
    p=controlled_page;console(p);start(p,3);advance(p,500)
    p.evaluate("status=>sdk.emit('mediaPlaybackError',{error:Object.assign(new Error('unavailable'),{status})})",status);flush(p);advance(p,300)
    assert not snapshot(p)['playing']
    commands=[c for c in p.evaluate('harness.commands()') if c['event']=='console:exclude-track']
    assert len(commands)==1 and commands[0]['body']['trackId']=='A'
    next_state=game_state(p,shuffledTrackIds=['B','C'],operationId='after-exclusion')
    next_state['tracks']=next_state['tracks'][1:]
    ack_command(p,'exclude-track',next_state);advance(p,300)
    assert snapshot(p)['id']=='B' and not snapshot(p)['playing']
    assert p.get_by_role('button',name='再生',exact=True).is_enabled()


@pytest.mark.parametrize('track',['A','i.A'])
def test_jacket_prepares_silently_and_reveals_without_loading_again(controlled_page,track):
    p=controlled_page
    target(p,'albumPrepared',track);advance(p,500)
    media=snapshot(p)
    assert not media['playing'] and media['position']==0 and media['volume']==1
    assert all(e['volume']==0 for e in media['events'] if e['event']=='playbackStateDidChange' and e['payload'].get('state')==2)
    loads=[c for c in media['calls'] if c['method'] in ('music','setQueue')]
    # Answering and wrong/correct feedback keep the same preparation target.
    target(p,'albumPrepared',track);advance(p,300)
    target(p,'album',track);advance(p,300)
    media=snapshot(p)
    assert media['playing'] and media['volume']==1
    assert len([c for c in media['calls'] if c['method'] in ('music','setQueue')])==len(loads)
    assert p.evaluate('sdk.mk.repeatMode')==2


@pytest.mark.parametrize('method',['music','setQueue','play','pause'])
@pytest.mark.parametrize('destination',['album','albumPrepared','stopped'])
def test_late_album_preparation_obeys_latest_target(controlled_page,method,destination):
    p=controlled_page
    p.evaluate("sdk.responses['/v1/catalog/us/songs/B']={data:[{relationships:{albums:{data:[{id:'album-B'}]}}}]}")
    arm(p,method,'preparation')
    target(p,'albumPrepared',name='old');advance(p,300)
    target(p,destination,'B' if destination=='albumPrepared' else 'A',name='new');advance(p,500)
    release(p,'preparation');advance(p,1000)
    media=snapshot(p)
    assert media['playing']==(destination=='album')
    assert media['volume']==1
    if destination!='stopped':assert media['id']==('album-B' if destination=='albumPrepared' else 'album-A')


def test_album_preparation_failure_can_retry_on_reveal(controlled_page):
    p=controlled_page;arm(p,'music','failed')
    target(p,'albumPrepared');release(p,'failed','temporary network failure');advance(p,300)
    assert not snapshot(p)['playing']
    target(p,'album');advance(p,500)
    assert snapshot(p)['playing'] and snapshot(p)['volume']==1
