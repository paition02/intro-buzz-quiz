"""Actual server tests with an isolated controllable clock."""
from __future__ import annotations
import json
import os
from pathlib import Path
import random
import socket
import subprocess
import time
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import httpx
import pytest
from quiz_transport import SocketClient
from backend.helpers import make_tracks

ROOT=Path(__file__).resolve().parents[3]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]


@pytest.fixture(scope='module')
def clock_server(tmp_path_factory):
    port,control=free_port(),free_port()
    log=(tmp_path_factory.mktemp('clock-server')/'server.log').open('w+')
    process=subprocess.Popen(['bun',str(ROOT/'spec/harness/clock-server.ts')],cwd=ROOT,env={**os.environ,'PORT':str(port),'TEST_CLOCK_PORT':str(control)},stdout=log,stderr=log)
    url=f'http://127.0.0.1:{port}';clock=f'http://127.0.0.1:{control}'
    try:
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            if process.poll() is not None:
                log.seek(0);raise AssertionError(log.read())
            try:
                if httpx.get(url,timeout=.5).status_code==200:break
            except httpx.HTTPError:pass
            time.sleep(.05)
        else:raise AssertionError('test server failed to start')
        yield url,clock
    finally:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()


@pytest.fixture
def model_server(clock_server,tmp_path):
    url,clock=clock_server
    client=SocketClient(url);client.wait_for_state();client.emit('console:reset')
    http=httpx.Client(base_url=url,timeout=5);clock_http=httpx.Client(base_url=clock,timeout=5)
    trace=[];now=2_000_000_000_000
    def tick(delta=300):
        nonlocal now
        now+=delta;clock_http.get('/',params={'now':now}).raise_for_status()
    tick(0)
    def command(event,body=None):
        before=deepcopy(client.state);result=client.emit('console:'+event,body)
        trace.append({'command':event,'body':body,'ack':client.last_ack,'before':before,'after':deepcopy(result),'time':now})
        assert client.last_ack['ok'],trace[-1]
        return result
    def press(actor):
        before=deepcopy(client.state);response=http.post('/api/act/'+actor)
        trace.append({'actor':actor,'status':response.status_code,'before':before,'time':now})
        return response.status_code
    yield client,http,tick,command,press,trace
    (tmp_path/'server-ordering-trace.json').write_text(json.dumps(trace,ensure_ascii=False,indent=2))
    client.close();http.close();clock_http.close()


def game(model,mode='intro',count=6,players=('P','Q','R')):
    client,http,tick,command,press,trace=model
    command('ready')
    for p in players:assert press(p)==200
    command('select-playlists',{'selectedPlaylistIds':['A'],'tracks':make_tracks(count)})
    command('start',{'quizMode':mode});tick()


# Source: CONTROL_014 GAP_007
@pytest.mark.parametrize('elapsed,status',[(0,429),(1,429),(249,429),(250,200),(251,200)])
def test_cooldown_exact_millisecond_boundaries(model_server,elapsed,status):
    c,h,t,cmd,press,trace=model_server
    assert press('P')==200;c.wait_for_state();t(elapsed)
    assert press('P')==status
    if status==200:c.wait_for_state(players=[])
    else:assert [p['id'] for p in c.state['players']]==['P']


# Source: BUZZ_010
@pytest.mark.parametrize('first',['feedback','buzz'])
def test_wrong_feedback_and_buzz_in_both_receive_orders(model_server,first):
    c,h,t,cmd,press,trace=model_server;game(model_server)
    cmd('play');assert press('P')==200;c.wait_for_state(step='answering');cmd('wrong')
    if first=='buzz':assert press('Q')==204
    cmd('wrong-feedback-ended');assert press('Q')==200;c.wait_for_state(answererId='Q')
    assert c.state['roundIndex']==0 and all(p['score']==0 for p in c.state['players'])


# Source: RESET_007
@pytest.mark.parametrize('first',['reset','correct'])
def test_reset_and_correct_in_both_receive_orders(model_server,first):
    c,h,t,cmd,press,trace=model_server;game(model_server)
    cmd('play');assert press('P')==200;c.wait_for_state(step='answering')
    if first=='correct':cmd('correct')
    cmd('reset')
    if first=='reset':
        c.emit('console:correct');assert not c.last_ack['ok']
    assert c.state['players']==[] and c.state['phase']=='initialization'
    game(model_server)
    assert all(p['score']==0 for p in c.state['players'])


# Source: CONTROL_005
@pytest.mark.parametrize('mode',['intro','jacket'])
def test_repeated_start_keeps_first_shuffle_and_round(model_server,mode):
    c,h,t,cmd,press,trace=model_server;game(model_server,mode)
    before=deepcopy(c.state)
    for _ in range(5):
        c.emit('console:start',{'quizMode':mode});assert not c.last_ack['ok'];assert c.state==before


# Source: SESSION_003 SESSION_004
@pytest.mark.parametrize('step',['answering','reveal','results','next-round'])
def test_reconnected_clients_receive_current_answer_and_round(model_server,step):
    c,h,t,cmd,press,trace=model_server;game(model_server)
    old=SocketClient(c.server_url);old.wait_for_state();old.close()
    if step=='answering':cmd('play');assert press('P')==200;c.wait_for_state(answererId='P')
    else:
        cmd('give-up')
        if step=='results':cmd('show-results')
        elif step=='next-round':cmd('next-round')
    new=SocketClient(c.server_url)
    try:assert new.wait_for_state()==c.state
    finally:new.close()


# Source: FLOW_007 BUZZ_009
@pytest.mark.parametrize('mode',['intro','jacket'])
def test_twenty_players_burst_then_host_can_judge(model_server,mode):
    c,h,t,cmd,press,trace=model_server;actors=[f'P{i}' for i in range(20)];game(model_server,mode,players=actors)
    if mode=='intro':cmd('play')
    def burst(actor):return [(actor,httpx.post(c.server_url+'/api/act/'+actor).status_code) for _ in range(3)]
    with ThreadPoolExecutor(max_workers=20) as pool:responses=[r for batch in pool.map(burst,actors) for r in batch]
    accepted=[actor for actor,status in responses if status==200]
    assert len(accepted)==1,responses
    c.wait_for_state(answererId=accepted[0],step='answering')
    assert all(status in (200,204,429) for _,status in responses)
    cmd('wrong');cmd('wrong-feedback-ended')
    assert c.state['answererId'] is None and all(p['score']==0 for p in c.state['players'])


# Source: FLOW_010
@pytest.mark.parametrize('mode',['intro','jacket'])
@pytest.mark.parametrize('seed',[1,7,42,20260922])
def test_two_hundred_seeded_commands_preserve_independent_score_and_round_invariants(model_server,mode,seed):
    c,h,t,cmd,press,trace=model_server;rng=random.Random(seed)
    trace.append({'seed':seed,'mode':mode});game(model_server,mode)
    scores={p:0 for p in ('P','Q','R')};answered=None;index=0;phase='round';played=False
    order=list(c.state['shuffledTrackIds' if mode=='intro' else 'shuffledAlbumIds'])
    for i in range(200):
        t()
        choices={'round':['give-up','reset']+(['play'] if mode=='intro' else ['buzz']), 'playing':['play-ended','buzz','reset'], 'answering':['correct','wrong','reset'], 'correct':['correct-feedback-ended','reset'], 'wrong':['wrong-feedback-ended','reset'], 'reveal':['show-results','reset']+(['next-round'] if index<len(order)-1 else []), 'results':['next-game','reset']}
        if phase=='round' and played:choices['round'].append('buzz')
        action=rng.choice(choices[phase])
        if action=='buzz':
            answered=rng.choice(list(scores));assert press(answered)==200;c.wait_for_state(answererId=answered);phase='answering'
        elif action in ('reset','next-game'):
            cmd(action)
            if action=='next-game':cmd('reset')
            game(model_server,mode);scores={p:0 for p in scores};answered=None;index=0;phase='round';played=False
            order=list(c.state['shuffledTrackIds' if mode=='intro' else 'shuffledAlbumIds'])
        else:
            cmd(action)
            if action=='play':phase='playing';played=True
            elif action=='play-ended':phase='round'
            elif action=='correct':scores[answered]+=1;phase='correct'
            elif action=='wrong':phase='wrong'
            elif action=='wrong-feedback-ended':phase='round';answered=None
            elif action in ('give-up','correct-feedback-ended'):phase='reveal'
            elif action=='next-round':index+=1;phase='round';played=False;answered=None
            elif action=='show-results':phase='results';answered=None
        state=c.state
        assert {p['id']:p['score'] for p in state['players']}==scores,(seed,i,trace[-1])
        assert state['answererId']==answered,(seed,i,trace[-1])
        assert state['shuffledTrackIds' if mode=='intro' else 'shuffledAlbumIds']==order
        expected_index=-1 if phase=='results' else index
        assert state['roundIndex' if mode=='intro' else 'roundAlbumIndex']==expected_index
    cmd('reset');assert c.state['players']==[]


# Source: RESET_004 RESET_005 RESET_006 RESET_010
@pytest.mark.parametrize('notification',['play-ended','correct-feedback-ended','wrong-feedback-ended'])
@pytest.mark.parametrize('token',[None,'not-the-current-operation'])
def test_completion_requires_the_current_operation_token(model_server,notification,token):
    c,h,t,cmd,press,trace=model_server;game(model_server);cmd('play')
    if notification!='play-ended':
        assert press('P')==200;c.wait_for_state(step='answering')
        cmd(notification.split('-')[0])
    before=deepcopy(c.state)
    # Bypass the helper's default current token to exercise malformed clients.
    payload={} if token is None else {'operationId':token}
    result=c.sio.call('console:'+notification,data=payload,timeout=5)
    assert not result['ok'];assert c.state==before
    cmd(notification)


# Source: INTRO_009 RESET_004 RESET_010
@pytest.mark.parametrize('replays',[1,3,10])
def test_previous_play_completion_cannot_stop_a_later_play_in_the_same_round(model_server,replays):
    c,h,t,cmd,press,trace=model_server;game(model_server);cmd('play')
    old={'operationId':c.state['operationId']}
    for _ in range(replays):cmd('play-ended');cmd('play')
    before=deepcopy(c.state)
    c.emit('console:play-ended',old)
    assert not c.last_ack['ok'];assert c.state==before
    cmd('play-ended');assert c.state['step']=='beforePlayback'


# Source: LIBRARY_013
@pytest.mark.parametrize('count',[1,3])
@pytest.mark.parametrize('mode',['intro','jacket'])
def test_unavailable_tracks_are_removed_without_reordering_remaining_rounds(model_server,count,mode):
    c,h,t,cmd,press,trace=model_server;game(model_server,mode,count)
    while c.state['tracks']:
        before=deepcopy(c.state)
        if mode=='intro':track=before['shuffledTrackIds'][before['roundIndex']]
        else:
            album=next(a for a in before['albums'] if a['id']==before['shuffledAlbumIds'][before['roundAlbumIndex']])
            track=album['trackIds'][0]
        cmd('exclude-track',{'operationId':before['operationId'],'trackId':track})
        assert all(x['id']!=track for x in c.state['tracks'])
        assert c.state['shuffledTrackIds']==[x for x in before['shuffledTrackIds'] if x!=track]
        assert c.state['operationId']!=before['operationId']
        assert c.state['players']==before['players']
    assert c.state['step']=='results'


# Source: LIBRARY_013 RESET_010
@pytest.mark.parametrize('token',['missing','stale'])
def test_old_unavailability_cannot_remove_new_game_tracks(model_server,token):
    c,h,t,cmd,press,trace=model_server;game(model_server)
    before=deepcopy(c.state)
    body={'trackId':before['tracks'][0]['id']}
    if token=='stale':body['operationId']='old-game'
    c.emit('console:exclude-track',body)
    assert not c.last_ack['ok']
    assert c.state==before
