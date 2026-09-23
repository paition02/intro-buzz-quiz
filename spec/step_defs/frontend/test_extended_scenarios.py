"""Real UI and MusicKit integration tests for playback and input boundaries."""
from __future__ import annotations
import math
import re
from pathlib import Path
from dataclasses import replace
from copy import deepcopy
import pytest
from playwright.sync_api import expect
from frontend import test_playback_regressions as r
from frontend.test_playback_regressions import playback_probe
from frontend.musickit_mock import set_musickit_library_data


@pytest.fixture
def intro(frontend_page,socket_client,http,playback_probe):
    r.prepared_intro(frontend_page,socket_client,http,playback_probe,'player-1')
    return frontend_page


def update_round(client,probe):
    probe['round_id']=client.state['shuffledTrackIds'][client.state['roundIndex']]
    probe['round_index']=client.state['roundIndex']

@pytest.mark.parametrize('operation',['short-track','first-reveal','repeated-reveal','disclosure'])
def test_short_track_and_reveal_never_leak_the_next_answer(intro,socket_client,playback_probe,operation):
    p=intro;current=playback_probe['round_id']
    if operation=='short-track':
        r.start_intro(p,socket_client,playback_probe,5)
        mark=playback_probe['active']['mark'];p.wait_for_timeout(2500)
        r._assert_stopped(p)
        assert socket_client.state['step']=='beforePlayback'
        samples=p.evaluate('mark=>window.__introProbe.samples.filter(s=>s.at>=mark&&s.playing&&s.volume>0)',mark)
        assert samples and {s['id'] for s in samples}=={current}
        assert max(s['at'] for s in samples)-min(s['at'] for s in samples)<2300, 'short track looped past its end'
        assert max(s['position'] for s in samples)>1.5, 'track stopped before its natural end'
        p.wait_for_timeout(2700);r._assert_stopped(p)
    else:
        if operation=='repeated-reveal':r.replay_sequence(p,socket_client,playback_probe,'0.5,1,1.5')
        mark=p.evaluate('window.__introProbe.mark()');r.click_actual(p,'ギブアップ');r.expected_reveal(p,socket_client)
        if operation=='disclosure':
            p.wait_for_timeout(600)
            before=p.evaluate('MusicKit.getInstance().currentPlaybackTime')
            r.click_actual(p,'曲情報を開く');r.click_actual(p,'曲情報を閉じる')
            after=p.evaluate('MusicKit.getInstance().currentPlaybackTime')
            assert after>=before and after-before<.8
        p.wait_for_timeout(6300)
        samples=p.evaluate('mark=>window.__introProbe.samples.filter(s=>s.at>=mark&&s.playing&&s.volume>0)',mark)
        assert samples and {s['id'] for s in samples}=={current}
        assert socket_client.state['roundIndex']==0 and socket_client.state['step']=='reveal'
        assert all(player['score']==0 for player in socket_client.state['players'])
        r.click_actual(p,'結果発表へ');r.no_results_media(p,socket_client)

@pytest.mark.parametrize('case',['long-interrupt','wrong-new-duration','other-after-wrong','same-after-wrong','unjoined'])
def test_buzzing_and_wrong_recovery_follow_the_audio(intro,socket_client,http,playback_probe,case):
    p=intro
    # Q joins through the actual API before a fresh game, so no state injection.
    if case=='other-after-wrong':
        r.click_actual(p,'リセット');r._wait_state(socket_client,phase='ready')
        assert http.post('/api/act/Q').status_code==200
        assert http.post('/api/act/player-1').status_code==200
        r.new_game_after_reset(p,socket_client,playback_probe)
    seconds=10 if case=='long-interrupt' else 1.5
    r.start_intro(p,socket_client,playback_probe,seconds)
    if case=='unjoined':
        assert http.post('/api/act/unknown').status_code==409
        r.active_deadline(p,socket_client,playback_probe)
        assert socket_client.state['answererId'] is None;return
    if case=='long-interrupt':p.wait_for_timeout(1000)
    r.buzz(p,socket_client,http,'player-1');r.stopped_answering(p,socket_client,'player-1')
    r.click_actual(p,'不正解');r.playable_again(p,socket_client,playback_probe)
    if case=='wrong-new-duration':r.replay_sequence(p,socket_client,playback_probe,'2')
    actor='Q' if case=='other-after-wrong' else 'player-1'
    assert http.post('/api/act/'+actor).status_code==200;r._wait_state(socket_client,answererId=actor)
    r._assert_stopped(p);r.click_actual(p,'正解');r._wait_state(socket_client,step='reveal')
    assert next(v['score'] for v in socket_client.state['players'] if v['id']==actor)==1
    r.expected_reveal(p,socket_client)

@pytest.mark.parametrize('input_kind',['mouse','touch','keyboard','cancel','second-finger','inside'])
def test_slider_native_inputs_and_pointer_lifecycle(intro,socket_client,playback_probe,input_kind):
    p=intro;slider=p.get_by_role('slider',name='再生秒数');slider.scroll_into_view_if_needed()
    box=slider.bounding_box();assert box
    def point(value,identifier=1):
        angle=(value-.1)/29.9*2*math.pi-math.pi/2
        return {'x':box['x']+box['width']/2+box['width']/2*78/93*math.cos(angle),'y':box['y']+box['height']/2+box['height']/2*78/93*math.sin(angle),'id':identifier}
    if input_kind=='keyboard':r._set_seconds(p,2.5)
    elif input_kind=='mouse':
        a,b=point(.5),point(2.5);p.mouse.move(a['x'],a['y']);p.mouse.down();p.mouse.move(b['x'],b['y'],steps=5);p.mouse.up()
    elif input_kind=='inside':
        before=slider.get_attribute('aria-valuenow');p.mouse.click(box['x']+box['width']/2,box['y']+box['height']/2)
        p.mouse.wheel(0,100);p.wait_for_timeout(100)
        assert slider.get_attribute('aria-valuenow')==before;r._assert_stopped(p);return
    else:
        cdp=p.context.new_cdp_session(p)
        cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[point(.5)]})
        if input_kind=='cancel':
            cdp.send('Input.dispatchTouchEvent',{'type':'touchCancel','touchPoints':[]})
            cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[point(1,2)]})
            cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[point(2.5,2)]})
            before=slider.get_attribute('aria-valuenow')
            slider.dispatch_event('pointermove',{'pointerId':1,'pointerType':'touch','clientX':point(20)['x'],'clientY':point(20)['y']})
            assert slider.get_attribute('aria-valuenow')==before
        elif input_kind=='second-finger':
            cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[point(.5),point(20,2)]})
            cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[point(.5)]})
            cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[point(2.5)]})
        else:cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[point(2.5)]})
        cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});cdp.detach()
    expect(slider).to_have_attribute('aria-valuenow','2.5')
    # replay_sequence normally sets duration; here assert native input first so
    # the helper cannot silently repair a broken pointer interaction.
    r.replay_sequence(p,socket_client,playback_probe,'2.5')


def album_lookup_failure(lookups):
    def fail(route):
        headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'}
        if route.request.method=='OPTIONS':
            route.fulfill(status=204,headers=headers)
        else:
            lookups.append(route.request.url)
            route.fulfill(status=500,json={'errors':[{'detail':'Injected album lookup failure'}]},headers=headers)
    return fail


def test_jacket_reveal_retries_failed_preparation_after_network_recovers(frontend_page,socket_client,playback_probe):
    p=frontend_page;r.selected_track_count(p,socket_client,playback_probe,3)
    pattern='**/api.music.apple.com/v1/catalog/*/songs/*'
    lookups=[];fail=album_lookup_failure(lookups)
    p.route(pattern,fail)
    r.click_actual(p,'ジャケットで開始')
    state=r._wait_state(socket_client,step='beforePlayback',quizMode='jacket')
    album=state['shuffledAlbumIds'][state['roundAlbumIndex']]
    expect(p.locator('p').filter(has_text='MusicKit:').first).to_be_visible(timeout=10000)
    assert lookups,'preparation lookup fault was not reached'
    r._assert_stopped(p)
    assert not p.evaluate('window.__introProbe.samples.some(s=>s.playing && s.volume>0)')
    p.unroute(pattern,fail)
    with p.expect_response(lambda response: '/v1/catalog/' in response.url and '/songs/' in response.url and response.request.method=='GET') as retry:
        r.click_actual(p,'ギブアップ')
    assert retry.value.status==200
    r.expected_reveal(p,socket_client)
    expect(p.locator('p').filter(has_text='MusicKit:')).to_have_count(0)
    state=socket_client.state
    assert state['shuffledAlbumIds'][state['roundAlbumIndex']]==album
    r.click_actual(p,'結果発表へ');r.no_results_media(p,socket_client)

@pytest.mark.parametrize('case',['next','hint','image-failure','album-failure','prepared-album-reuse','single-album-track'])
def test_jacket_progress_survives_display_and_album_boundaries(frontend_page,socket_client,playback_probe,case):
    p=frontend_page;r.selected_track_count(p,socket_client,playback_probe,3)
    if case=='single-album-track':
        mock=getattr(p,'music_kit_api_mock')
        for album in mock.data.albums.values():album.track_ids[:]=album.track_ids[:1]
    if case=='image-failure':p.route('**/example.test/**',lambda route:route.abort())
    if case=='album-failure':
        lookups=[]
        p.route('**/api.music.apple.com/v1/catalog/*/songs/*', album_lookup_failure(lookups))
        r.click_actual(p,'ジャケットで開始')
        r._wait_state(socket_client,step='beforePlayback',quizMode='jacket')
        expect(p.locator('p').filter(has_text='MusicKit:').first).to_be_visible(timeout=10000)
        assert lookups,'preparation lookup fault was not reached'
        r._assert_stopped(p)
    else:
        r.start_mode(p,socket_client,playback_probe,'jacket')
    if case=='hint':
        slider=p.get_by_role('slider',name='ヒントレベル')
        for target in [12,47,12]:
            current=int(slider.get_attribute('aria-valuenow'))
            for _ in range(abs(target-current)):slider.press('ArrowRight' if target>current else 'ArrowLeft')
        r._wait_state(socket_client,jacketHintPercent=12);expect(slider).to_have_attribute('aria-valuenow','12')
    if case=='prepared-album-reuse':
        lookups=[]
        p.route('**/api.music.apple.com/v1/catalog/*/songs/*',album_lookup_failure(lookups))
    if case=='album-failure':
        before=len(lookups)
        with p.expect_response(lambda response: '/v1/catalog/' in response.url and '/songs/' in response.url and response.request.method=='GET') as retry:
            r.click_actual(p,'ギブアップ')
        assert retry.value.status==500
        r._wait_state(socket_client,step='reveal')
        expect(p.locator('p').filter(has_text='MusicKit:').first).to_be_visible(timeout=10000)
        assert len(lookups)>before,'reveal did not retry the failed album lookup'
        r._assert_stopped(p)
        assert not p.evaluate('window.__introProbe.samples.some(s=>s.playing && s.volume>0)')
    else:
        r.click_actual(p,'ギブアップ');r._wait_state(socket_client,step='reveal')
        r.expected_reveal(p,socket_client)
    if case=='prepared-album-reuse':
        assert not lookups,'prepared reveal unexpectedly fetched album metadata again'
    if case=='single-album-track':
        mark=p.evaluate('window.__introProbe.mark()');p.wait_for_timeout(4300)
        samples=p.evaluate('mark=>window.__introProbe.samples.filter(s=>s.at>=mark&&s.playing)',mark)
        assert len({s['id'] for s in samples})==1
        assert any(b['position']+1<a['position'] for a,b in zip(samples,samples[1:])), 'single-track album did not loop'
    if case=='next':
        r.click_actual(p,'次のラウンドへ');r._wait_state(socket_client,step='beforePlayback',roundAlbumIndex=1,jacketHintPercent=1);r._assert_album_prepared(p,socket_client.state)
        p.wait_for_timeout(2300);r._assert_stopped(p)
    else:r.click_actual(p,'結果発表へ');r.no_results_media(p,socket_client)

@pytest.mark.parametrize('metadata',['same-title','no-artwork','no-album','same-album','different-album-artists'])
def test_metadata_edges_still_use_the_selected_media_ids(frontend_page,socket_client,playback_probe,metadata):
    p=frontend_page;set_musickit_library_data(p,{'playlist-a':['track-1','track-2']})
    mock=getattr(p,'music_kit_api_mock')
    for key in ['track-1','track-2']:
        song=mock.data.songs[key];lib=mock.data.library_songs[key]
        if metadata=='same-title':song.title='Same title';mock.data.library_songs[key]=replace(lib,name='Same title')
        if metadata=='no-artwork':song.artwork=replace(song.artwork,url='');mock.data.library_songs[key]=replace(lib,artwork=replace(lib.artwork,url=''))
        if metadata=='no-album':song.album='';mock.data.library_songs[key]=replace(lib,album_name='')
        if metadata in ['same-album','different-album-artists']:
            song.album='Shared';song.artist='Shared artist' if metadata=='same-album' else song.artist
            mock.data.library_songs[key]=replace(lib,album_name='Shared',artist_name=song.artist)
    p.goto('/console');r.click_actual(p,'ログイン');r.click_actual(p,'Spec Playlist A')
    expect(p.get_by_text('1件のプレイリスト、2曲を選択中',exact=True)).to_be_visible()
    p.evaluate(Path(r.__file__).with_name('playback_observer.js').read_text())
    r.start_mode(p,socket_client,playback_probe,'intro')
    for index in range(2):
        update_round(socket_client,playback_probe);r.replay_sequence(p,socket_client,playback_probe,'0.5')
        r.click_actual(p,'ギブアップ');r.expected_reveal(p,socket_client)
        if index==0:r.click_actual(p,'次のラウンドへ');r._wait_state(socket_client,roundIndex=1,step='beforePlayback');expect(p.get_by_role('button',name='再生',exact=True)).to_be_enabled(timeout=5000)
    assert socket_client.state['roundIndex']==1

@pytest.mark.parametrize('late',['old-image','new-image'])
def test_late_artwork_cannot_paint_a_different_jacket(frontend_page,socket_client,playback_probe,late):
    import struct,zlib
    def png(red,green,blue):
        def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
        raw=b''.join(b'\0'+bytes([red,green,blue,255])*4 for _ in range(4))
        return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',4,4,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
    p=frontend_page;r.selected_track_count(p,socket_client,playback_probe,3);r.start_mode(p,socket_client,playback_probe,'jacket')
    state=socket_client.state;first=next(a for a in state['albums'] if a['id']==state['shuffledAlbumIds'][0]);old_url=first['artworkRevealUrl']
    board=p.context.new_page();held=[]
    def image_response(route):
        old=route.request.url==old_url
        if old==(late=='old-image'):held.append((route,old))
        else:route.fulfill(content_type='image/png',body=png(255,0,0) if old else png(0,0,255),headers={'Access-Control-Allow-Origin':'*'})
    board.route('**/example.test/artwork/**',image_response)
    board.goto('/gameboard',wait_until='domcontentloaded');board.wait_for_timeout(200)
    r.click_actual(p,'ギブアップ');r.expected_reveal(p,socket_client);r.click_actual(p,'次のラウンドへ');r._wait_state(socket_client,roundAlbumIndex=1)
    # Full reveal strength makes pixel identity independent of the obscuring mode.
    socket_client.emit('console:set-jacket-grayscale',{'jacketGrayscale':False})
    socket_client.emit('console:set-jacket-hint-percent',{'jacketHintPercent':100})
    board.wait_for_timeout(200)
    canvas=board.get_by_role('img',name='ジャケットヒント')
    pixel="c=>Array.from(c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data)"
    if late=='new-image':assert canvas.evaluate(pixel)!=[255,0,0,255]
    assert held,'delay gate did not intercept an artwork response'
    for route,old in held:route.fulfill(content_type='image/png',body=png(255,0,0) if old else png(0,0,255),headers={'Access-Control-Allow-Origin':'*'})
    board.wait_for_function("() => {const c=document.querySelector('canvas'); if(!c)return false;const p=c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data;return p[0]===0&&p[2]===255}",timeout=3000)
    assert canvas.evaluate(pixel)==[0,0,255,255]
    board.close()

@pytest.mark.parametrize('first',['phone','physical'])
def test_phone_and_http_buzzer_share_the_same_acceptance_rule(frontend_page,socket_client,http,playback_probe,first):
    p=frontend_page;r.selected_track_count(p,socket_client,playback_probe,3)
    phone=p.context.new_page();phone.add_init_script("sessionStorage.setItem('intro-buzz-action-actor-id','P')");phone.goto('/action')
    phone.get_by_role('button',name='早押しボタン').click();r._wait_state(socket_client,players=[{'id':'P','score':0}])
    assert http.post('/api/act/Q').status_code==200
    board=p.context.new_page();board.goto('/gameboard')
    r.start_mode(p,socket_client,playback_probe,'intro');r.start_intro(p,socket_client,playback_probe,1.5)
    if first=='physical':
        assert http.post('/api/act/Q').status_code==200
        with phone.expect_response('**/api/act/P') as response:phone.get_by_role('button',name='早押しボタン').click()
        assert response.value.status==204;winner='Q'
    else:
        with phone.expect_response('**/api/act/P') as response:phone.get_by_role('button',name='早押しボタン').click()
        assert response.value.status==200
        assert http.post('/api/act/Q').status_code==204;winner='P'
    r._wait_state(socket_client,answererId=winner)
    expect(board.get_by_role('heading',name='解答をどうぞ！')).to_be_visible()
    expect(board.get_by_label(winner,exact=True).last).to_have_class(re.compile(r'.*scale-125.*'))
    r._assert_stopped(p)
    assert all(player['score']==0 for player in socket_client.state['players'])
    r.click_actual(p,'不正解');r.playable_again(p,socket_client,playback_probe)
    phone.close();board.close()

@pytest.mark.parametrize('flow',['reported','minimum','all-wrong','recovered'])
def test_complete_user_flow_through_results_and_a_new_game(frontend_page,socket_client,http,playback_probe,flow):
    p=frontend_page;r.selected_track_count(p,socket_client,playback_probe,6)
    for actor in ['P','Q','R']:assert http.post('/api/act/'+actor).status_code==200
    if flow=='recovered':
        r.arm_sdk(p,'setQueue','reject');r.click_actual(p,'イントロで開始');r.sdk_error(p,'setQueue')
        r.click_actual(p,'リセット');r._wait_state(socket_client,phase='ready')
        r.click_actual(p,'Spec Playlist A');expect(p.get_by_text('1件のプレイリスト、6曲を選択中',exact=True)).to_be_visible()
        for actor in ['P','Q','R']:assert http.post('/api/act/'+actor).status_code==200
    r.start_mode(p,socket_client,playback_probe,'intro')
    order=list(socket_client.state['shuffledTrackIds']);scores={'P':0,'Q':0,'R':0}
    board=p.context.new_page();board.goto('/gameboard')
    for index,track in enumerate(order):
        update_round(socket_client,playback_probe)
        assert playback_probe['round_id']==track and socket_client.state['roundIndex']==index
        sequence='0.1' if flow=='minimum' else '0.5,1,2' if index<2 else '0.5'
        r.replay_sequence(p,socket_client,playback_probe,sequence)
        if flow=='all-wrong':
            for actor in ['P','Q','R']:
                assert http.post('/api/act/'+actor).status_code==200;r._wait_state(socket_client,answererId=actor);r._assert_stopped(p)
                r.click_actual(p,'不正解');r._wait_state(socket_client,step='beforePlayback')
            r.click_actual(p,'ギブアップ')
        else:
            if flow!='minimum':
                r.start_intro(p,socket_client,playback_probe,3);r.buzz(p,socket_client,http,'P');r.stopped_answering(p,socket_client,'P')
                r.click_actual(p,'不正解');r._wait_state(socket_client,step='beforePlayback')
                r.replay_sequence(p,socket_client,playback_probe,'0.1' if flow=='recovered' else '0.5')
            assert http.post('/api/act/Q').status_code==200;r._wait_state(socket_client,answererId='Q');r._assert_stopped(p)
            r.click_actual(p,'正解');scores['Q']+=1
        r._wait_state(socket_client,step='reveal');r.expected_reveal(p,socket_client)
        assert {v['id']:v['score'] for v in socket_client.state['players']}==scores
        title=next(t['title'] for t in socket_client.state['tracks'] if t['id']==track)
        expect(board.get_by_text(title,exact=True)).to_be_visible()
        if index<len(order)-1:
            r.click_actual(p,'次のラウンドへ');r._wait_state(socket_client,roundIndex=index+1,step='beforePlayback');expect(p.get_by_role('button',name='再生',exact=True)).to_be_enabled(timeout=5000)
    r.click_actual(p,'結果発表へ');r.no_results_media(p,socket_client)
    r.click_actual(p,'次のゲームへ');r._wait_state(socket_client,phase='ready');assert socket_client.state['players']==[]
    assert http.post('/api/act/Q').status_code==200
    r.start_mode(p,socket_client,playback_probe,'intro');r.replay_sequence(p,socket_client,playback_probe,'0.5')
    assert socket_client.state['players']==[{'id':'Q','score':0}]
    board.close()

@pytest.mark.parametrize('kind',['playlists','tracks'])
@pytest.mark.parametrize('failure',['500','401','cycle','invalid-json','missing-data'])
def test_second_page_fault_does_not_claim_complete_selection_and_can_retry(frontend_page,socket_client,playback_probe,kind,failure):
    p=frontend_page;broken={'value':True};calls=[];held=[]
    path='/v1/me/library/playlists' if kind=='playlists' else '/v1/me/library/playlists/playlist-a/tracks'
    items=([{'id':'playlist-a','type':'library-playlists','attributes':{'name':'Spec Playlist A'}},{'id':'playlist-b','type':'library-playlists','attributes':{'name':'Spec Playlist B'}}] if kind=='playlists' else [{'id':f'track-{i}','type':'library-songs','attributes':{'name':f'Track {i}','artistName':'Artist','albumName':'Album'}} for i in [1,2]])
    from urllib.parse import urlsplit,parse_qs
    def response(route):
        url=urlsplit(route.request.url)
        if url.path!=path:route.fallback();return
        cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'}
        if route.request.method=='OPTIONS':route.fulfill(status=204,headers=cors);return
        calls.append(route.request.url)
        if len(calls)>10 and broken['value']:held.append(route);return
        if not broken['value']:route.fulfill(json={'data':items},headers=cors);return
        offset=parse_qs(url.query).get('offset')
        if not offset:route.fulfill(json={'data':items[:1],'next':path+'?offset=1'},headers=cors);return
        if failure in ['500','401']:route.fulfill(status=int(failure),json={'errors':[{'detail':'Injected second page failure'}]},headers=cors)
        elif failure=='cycle':route.fulfill(json={'data':[],'next':path+'?offset=1'},headers=cors)
        elif failure=='invalid-json':route.fulfill(body='{broken json',content_type='application/json',headers=cors)
        else:route.fulfill(json={},headers=cors)
    p.route('**/api.music.apple.com'+path+'*',response)
    p.goto('/console');r.click_actual(p,'ログイン')
    if kind=='tracks':r.click_actual(p,'Spec Playlist A')
    # A bounded polling period keeps cyclic pagination testable without an
    # artificial SDK rejection that could make the application's UI pass.
    for _ in range(100):
        p.wait_for_timeout(100)
        if held or p.locator('li span.text-rose, p.text-rose').count() or p.get_by_role('button',name='再読み込み',exact=True).is_enabled():break
    assert not held,'the same next link was requested more than ten times'
    expect(p.get_by_role('button',name='再読み込み',exact=True)).to_be_enabled(timeout=10000)
    assert socket_client.state['tracks']==[],socket_client.state
    error = (p.locator('li span.text-rose') if kind=='playlists' else p.locator('main > section').first.locator('p.text-muted'))
    expect(error.first).to_be_visible(timeout=3000)
    broken['value']=False
    if kind=='playlists':r.click_actual(p,'再読み込み');expect(p.get_by_role('button',name='Spec Playlist A',exact=True)).to_be_visible(timeout=10000)
    else:
        r.click_actual(p,'Spec Playlist A');expect(p.get_by_text('1件のプレイリスト、2曲を選択中',exact=True)).to_be_visible(timeout=10000)
        assert {t['id'] for t in socket_client.state['tracks']}=={'track-1','track-2'}

@pytest.mark.parametrize('count',[1,49,50,51,100,101])
def test_last_paged_track_is_reachable_and_really_playable(frontend_page,socket_client,playback_probe,count):
    p=frontend_page;r.fifty_item_pages(p);r.selected_track_count(p,socket_client,playback_probe,count)
    r.start_mode(p,socket_client,playback_probe,'intro')
    order=list(socket_client.state['shuffledTrackIds']);last=f'track-{count}'
    assert set(order)=={f'track-{i}' for i in range(1,count+1)} and len(order)==count
    for index in range(order.index(last)):
        assert socket_client.state['shuffledTrackIds'][socket_client.state['roundIndex']]==order[index]
        r.click_actual(p,'ギブアップ');r._wait_state(socket_client,step='reveal')
        r.click_actual(p,'次のラウンドへ');r._wait_state(socket_client,step='beforePlayback',roundIndex=index+1)
        expect(p.get_by_role('button',name='再生',exact=True)).to_be_enabled(timeout=5000)
    update_round(socket_client,playback_probe);assert playback_probe['round_id']==last
    r.replay_sequence(p,socket_client,playback_probe,'0.5')

@pytest.mark.parametrize('count',[30])
def test_thirty_wrong_answers_still_allow_the_final_correct_answer(intro,socket_client,http,playback_probe,count):
    p=intro;r.repeated_wrong_ui(p,socket_client,http,playback_probe,count)
    assert http.post('/api/act/player-1').status_code==200;r._wait_state(socket_client,answererId='player-1')
    r.click_actual(p,'正解');r._wait_state(socket_client,step='reveal')
    assert socket_client.state['players']==[{'id':'player-1','score':1}]
    r.expected_reveal(p,socket_client)

@pytest.mark.parametrize('failure',['abort','http-404'])
def test_failed_jacket_artwork_is_explained_to_the_audience(frontend_page,socket_client,playback_probe,failure):
    import re
    p=frontend_page;r.selected_track_count(p,socket_client,playback_probe,3);r.start_mode(p,socket_client,playback_probe,'jacket')
    board=p.context.new_page()
    board.route('**/example.test/**',lambda route:route.abort() if failure=='abort' else route.fulfill(status=404,body=''))
    board.goto('/gameboard');board.wait_for_timeout(300)
    expect(board.get_by_text(re.compile('(画像|ジャケット).*(失敗|読み込め|取得でき)'))).to_be_visible(timeout=1500)
    r.click_actual(p,'リセット');r._wait_state(socket_client,phase='ready');board.close()

@pytest.mark.parametrize('reload',['reload','reopen'])
def test_phone_reconnection_preserves_answer_rights_without_another_press(intro,socket_client,http,playback_probe,reload):
    p=intro;phone=p.context.new_page();script="sessionStorage.setItem('intro-buzz-action-actor-id','player-1')";phone.add_init_script(script);phone.goto('/action')
    r.start_intro(p,socket_client,playback_probe,1.5);r.buzz(p,socket_client,http,'player-1');r.stopped_answering(p,socket_client,'player-1')
    before=deepcopy(socket_client.state)
    if reload=='reload':phone.reload()
    else:phone.close();phone=p.context.new_page();phone.add_init_script(script);phone.goto('/action')
    phone.wait_for_timeout(300)
    assert socket_client.state==before;r._assert_stopped(p)
    r.click_actual(p,'正解');r._wait_state(socket_client,step='reveal');r.expected_reveal(p,socket_client);phone.close()

@pytest.mark.parametrize('offline_ms',[100,1000])
def test_board_reconnection_catches_up_with_the_latest_reveal(intro,socket_client,playback_probe,browser,server_url,offline_ms):
    p=intro;ctx=browser.new_context(base_url=server_url);board=ctx.new_page();board.goto('/gameboard')
    try:
        ctx.set_offline(True);board.wait_for_timeout(offline_ms)
        r.click_actual(p,'ギブアップ');r.expected_reveal(p,socket_client);r.click_actual(p,'次のラウンドへ');r._wait_state(socket_client,roundIndex=1,step='beforePlayback')
        expect(p.get_by_role('button',name='再生',exact=True)).to_be_enabled(timeout=5000)
        ctx.set_offline(False)
        r.click_actual(p,'ギブアップ');r.expected_reveal(p,socket_client)
        state=socket_client.state;track=next(t for t in state['tracks'] if t['id']==state['shuffledTrackIds'][1])
        expect(board.get_by_text(track['title'],exact=True)).to_be_visible(timeout=8000)
        expect(board.get_by_role('status')).to_have_count(0)
    finally:ctx.close()

@pytest.mark.parametrize('width',[320,390])
def test_long_japanese_answer_is_selectable_in_the_real_mobile_layout(frontend_page,socket_client,http,playback_probe,width):
    p=frontend_page;p.set_viewport_size({'width':width,'height':844});set_musickit_library_data(p,{'playlist-a':['track-1']})
    mock=getattr(p,'music_kit_api_mock');title='とても長い日本語の楽曲タイトル'*20;artist='長いアーティスト名'*20
    mock.data.songs['track-1'].title=title;mock.data.songs['track-1'].artist=artist
    mock.data.library_songs['track-1']=replace(mock.data.library_songs['track-1'],name=title,artist_name=artist)
    p.goto('/console');r.click_actual(p,'ログイン');r.click_actual(p,'Spec Playlist A');expect(p.get_by_text('1件のプレイリスト、1曲を選択中',exact=True)).to_be_visible()
    assert http.post('/api/act/P').status_code==200;p.evaluate(Path(r.__file__).with_name('playback_observer.js').read_text());r.start_mode(p,socket_client,playback_probe,'intro')
    r.replay_sequence(p,socket_client,playback_probe,'0.5');assert http.post('/api/act/P').status_code==200;r._wait_state(socket_client,answererId='P')
    answer=p.get_by_role('combobox',name='回答');answer.fill('とても長い日本語')
    candidate=p.get_by_role('option').filter(has_text=title);expect(candidate).to_contain_text(artist);candidate.click()
    r._wait_state(socket_client,step='correct');assert socket_client.state['players']==[{'id':'P','score':1}]
    assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    r._wait_state(socket_client,step='reveal');r.click_actual(p,'結果発表へ');r.no_results_media(p,socket_client)

@pytest.mark.parametrize('judgments',[['不正解','正解']])
def test_host_board_and_two_phone_buttons_follow_both_answerers(frontend_page,socket_client,playback_probe,judgments):
    p=frontend_page;r.selected_track_count(p,socket_client,playback_probe,3)
    phones=[]
    for actor in ['P','Q']:
        phone=p.context.new_page();phone.add_init_script(f"sessionStorage.setItem('intro-buzz-action-actor-id','{actor}')");phone.goto('/action');phone.get_by_role('button',name='早押しボタン').click();phones.append(phone)
    r._wait_state(socket_client,players=[{'id':'P','score':0},{'id':'Q','score':0}])
    board=p.context.new_page();board.goto('/gameboard');r.start_mode(p,socket_client,playback_probe,'intro')
    def scores_match():
        for player in socket_client.state['players']:
            expect(board.get_by_label(player['id'],exact=True).last).to_have_text(str(player['score']))
    scores_match()
    for actor,phone,judgment in zip(['P','Q'],phones,judgments):
        r.start_intro(p,socket_client,playback_probe,1.5);expect(board.locator('main')).to_have_attribute('data-board-tone','playing')
        with phone.expect_response('**/api/act/'+actor) as response:phone.get_by_role('button',name='早押しボタン').click()
        assert response.value.status==200;r._wait_state(socket_client,answererId=actor);r._assert_stopped(p)
        expect(board.get_by_role('heading',name='解答をどうぞ！')).to_be_visible();expect(board.get_by_label(actor,exact=True).first).to_be_visible()
        scores_match()
        r.click_actual(p,judgment);expect(board.locator('main')).to_have_attribute('data-board-tone','wrong' if judgment=='不正解' else 'correct')
        r._wait_state(socket_client,step='beforePlayback' if judgment=='不正解' else 'reveal')
        if judgment=='不正解':scores_match()
    assert socket_client.state['players']==[{'id':'P','score':0},{'id':'Q','score':1}]
    r.expected_reveal(p,socket_client);r.click_actual(p,'結果発表へ');r.no_results_media(p,socket_client)
    expect(board.get_by_role('heading',name='結果発表！')).to_be_visible()
    for player in socket_client.state['players']:
        card=board.get_by_label(player['id'],exact=True).locator('../..')
        expect(card.locator('strong')).to_have_text(str(player['score']))
    for phone in phones:phone.close()
    board.close()

@pytest.mark.parametrize('step',['beforePlayback','playing','answering','correct','wrong','reveal','results'])
def test_real_console_reload_restores_progress(intro,socket_client,http,playback_probe,step):
    p=intro
    if step in ['playing','answering','correct','wrong']:
        r.start_intro(p,socket_client,playback_probe,10)
    if step in ['answering','correct','wrong']:
        r.buzz(p,socket_client,http,'player-1');r.stopped_answering(p,socket_client,'player-1')
    if step in ['correct','wrong']:
        r.click_actual(p,'正解' if step=='correct' else '不正解');r._wait_state(socket_client,step=step)
    if step in ['reveal','results']:
        r.click_actual(p,'ギブアップ');r.expected_reveal(p,socket_client)
    if step=='results':r.click_actual(p,'結果発表へ');r.no_results_media(p,socket_client)
    before=deepcopy(socket_client.state)
    p.reload()
    p.wait_for_function('() => window.MusicKit?.getInstance()',timeout=10000)
    p.evaluate(Path(r.__file__).with_name('playback_observer.js').read_text())
    expected={'playing':'beforePlayback','correct':'reveal','wrong':'beforePlayback'}.get(step,step)
    r._wait_state(socket_client,step=expected)
    if expected=='beforePlayback':
        expect(p.get_by_role('button',name='再生',exact=True)).to_be_enabled(timeout=10000)
        r._assert_stopped(p)
    elif expected=='answering':
        expect(p.get_by_role('button',name='正解',exact=True)).to_be_enabled(timeout=10000)
        r._assert_stopped(p)
    elif expected=='reveal':r.expected_reveal(p,socket_client)
    else:r._assert_stopped(p)
    assert socket_client.state['players']==before['players']
    assert socket_client.state['shuffledTrackIds']==before['shuffledTrackIds']
    assert socket_client.state['answererId']==(None if step=='wrong' else before['answererId'])

@pytest.mark.parametrize('late_ms',[100,1200])
def test_late_preload_cannot_play_next_song_at_short_track_end(intro,socket_client,playback_probe,late_ms):
    p=intro;current=playback_probe['round_id']
    next_id=socket_client.state['shuffledTrackIds'][1]
    r.start_intro(p,socket_client,playback_probe,5)
    p.wait_for_timeout(late_ms)
    p.evaluate('id=>MusicKit.getInstance().playNext({song:id})',next_id)
    r._wait_state(socket_client,step='beforePlayback')
    r._assert_stopped(p)
    samples=p.evaluate('mark=>window.__introProbe.samples.filter(s=>s.at>=mark&&s.playing&&s.volume>0)',playback_probe['active']['mark'])
    assert samples and {s['id'] for s in samples}=={current}
    assert max(s['at'] for s in samples)-min(s['at'] for s in samples)<2300
