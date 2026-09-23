# 状態・操作とシナリオの照合

2026-09-22。README、サーバーの状態遷移、ConsolePage のボタン条件、既存 feature / step 定義と照合。
「仕様上必要な挙動」「現行実装の挙動」「実行して確認した範囲」を区別する。
シナリオの本数だけで網羅済みとは判定しない。

## 状態とホストの操作

○はその状態で可能、—は不可。選曲済み・認証済みなど通常の前提を満たすものとする。
リセットは全行で可能。「音源準備中」はサーバーの loading と同義ではない。
サーバーは同じ処理内で loading → beforePlayback へ進み、ブラウザの音源準備はその後も続く。

| 状態 | 選曲/開始 | 再生 | 早押し | 正誤判定 | ギブアップ | 次ラウンド | 結果へ | 次ゲーム | 主な照合先 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 未認証・initialization | — | — | 参加切替 | — | — | — | — | — | SESSION_006–008、既存 action_api |
| ready・選曲なし | 選曲○/開始— | — | 参加切替 | — | — | — | — | — | LIBRARY_001、CONTROL_013 |
| ready・選曲あり | ○ | — | 参加切替 | — | — | — | — | — | CONTROL_005、既存 console |
| イントロ・初回音源準備中 | — | — | — | — | — | — | — | — | INTRO_003、GAP_011/013 |
| イントロ・初回準備完了 | — | ○ | — | — | ○ | — | — | — | INTRO_001/006、ROUND_001/012 |
| イントロ・再生開始待ち | — | — | ○※1 | — | — | — | — | — | INTRO_010、BUZZ_012/013 |
| イントロ・再生中 | — | — | ○ | — | — | — | — | — | BUZZ_001/014、CONTROL_001 |
| イントロ・時間切れ停止中 | — | — | ○ | — | — | — | — | — | BUZZ_014、ASYNC_004、GAP_003 |
| イントロ・再生済みで再準備中 | — | — | ○ | — | — | — | — | — | BUZZ_003/014、GAP_009 |
| イントロ・再生済みで準備完了 | — | ○ | ○ | — | ○ | — | — | — | INTRO_004/015、BUZZ_003/004 |
| ジャケット出題 | — | — | ○ | — | ○ | — | — | — | JACKET_001/002/014/015 |
| 解答中・停止処理中 | — | — | 無反応 | ○※2 | — | — | — | — | BUZZ_006/013、GAP_006 |
| 解答中・停止完了 | — | — | 無反応 | ○ | — | — | — | — | BUZZ_005/007、CONTROL_002/003 |
| 正解演出中 | — | — | 無反応 | — | — | — | — | — | BUZZ_008/015、RESET_005 |
| 不正解演出中 | — | — | 無反応 | — | — | — | — | — | BUZZ_010/015、RESET_006 |
| 正解発表・非最終問題 | — | — | 無反応 | — | — | ○ | ○ | — | ROUND_004/009/015/016、JACKET_005/006 |
| 正解発表・最終問題 | — | — | 無反応 | — | — | — | ○ | — | ROUND_007/014、CONTROL_013 |
| results | — | — | — | — | — | — | — | ○ | ROUND_010/011、JACKET_016 |

※1 サーバーが console:play を受理した後は、音声が始まる前でも早押し可能。
※2 修正前はbusyが未完了のplayに拘束され、判定ボタンが無効のままになる場合があった。現在は判定をSDKの待機から独立させ、同じ判定の重複要求は別に抑止する。
ジャケットの設定変更は beforePlayback のみ。イントロ秒数はローカル設定であり、サーバーへ送る操作ではない。再生中の値変更の適用時期は INTRO_014 の判断事項。

### 自動通知と応答も操作として扱う

| 通知 | 受理する現在状態 | 他状態・古い操作への期待 | シナリオ |
| --- | --- | --- | --- |
| console:ready | initialization | 他状態では拒否しゲームを初期化しない | SESSION_008、既存 console |
| console:play-ended | intro / playing | 古い再生・ラウンド・ゲームの期限は現在を止めない | ROUND_005、RESET_004/010、GAP_015 |
| console:correct-feedback-ended | correct | 旧判定通知で新しい演出を終わらせない | RESET_005/010 |
| console:wrong-feedback-ended | wrong | 旧判定通知で新しい解答を消さない | RESET_006/010 |
| 同一内容の state | 全状態 | 音源を再開・巻き戻しせず期限も変えない | CONTROL_006、GAP_008 |
| SDK の成功・失敗・状態イベント | 対応する現行操作 | 古い結果を現在の成功/失敗と混同しない | ASYNC_006/007/008/013/017/018 |

修正前は終了通知に操作IDがなく、同名ステップへ戻ると古い通知を区別できなかった。現在は開始時の `operationId` を通知に含め、古いID・ID欠落を拒否する。本体変更とテスト変更の理由は [FIXES.md](FIXES.md) に記録した。

## 非同期処理の途中で何が起こるか

| 進行中の処理 | 通常完了 | 遅延・未解決 | 失敗 | 割り込み・遅れた完了 |
| --- | --- | --- | --- | --- |
| 曲ロード / setQueue / skip | INTRO_003、ROUND_014 | ASYNC_015、GAP_011 | ASYNC_002/009 | RESET_002/009、ROUND_015 |
| 頭出し / seek | INTRO_005 | ASYNC_015 | ASYNC_003 | RESET_009、ROUND_015 |
| 再生開始 / play | INTRO_001/015 | INTRO_010、BUZZ_013、ASYNC_018 | ASYNC_001/007 | BUZZ_012/013、GAP_004/009 |
| 音源配信・バッファ待ち | INTRO_001 | GAP_001/002 | GAP_005 | SESSION_002、GAP_001 |
| 停止 / pause | BUZZ_001 | ASYNC_015、GAP_003 | ASYNC_004/008 | BUZZ_006、RESET_009、GAP_015 |
| 先読み / playNext | 既存 apple_music の先読みケース | INTRO_011、ASYNC_015 | ASYNC_005 | ASYNC_006、ROUND_015 |
| アルバムID取得と再生 | JACKET_003/004 | ASYNC_015 | JACKET_012 | JACKET_006、RESET_009 |
| サーバー要求とack | CONTROL_010 | SESSION_009 | SESSION_001、GAP_012 | BUZZ_012、RESET_010 |
| 正誤の効果音と演出期限 | BUZZ_005/008 | RESET_005/006 | GAP_010 | RESET_007/010 |
| 認証・ライブラリ取得 | SESSION_006/008、LIBRARY_014 | LIBRARY_002/003/005 | SESSION_007、LIBRARY_016 | SESSION_005、GAP_005 |

この表は対応する仕様が存在することを示す。全マスのテスト実装や実機確認が完了したという表示ではない。

## 点検で訂正した期待結果

- BUZZ_010/015: 不正解・正解の演出中にも answererId は残る。クールダウン終了後なら204となるため、「常に409」という誤った期待値を訂正した。正解後の発表とギブアップ後の発表も分けた。
- ASYNC_015: 旧Promiseを解放してから停止するだけでは未解決時のリセットを検証できない。**解放前の停止**と解放後の無害性を別々の Then にした。
- ASYNC_018: 「再生開始の確認を遅らせる」を、音声開始は遅らせずPromiseの解決だけを遅らせる、と具体化した。
- INTRO_012/013: 曲末で停止する仕様に確定した。指定秒数より短ければ曲末で待機へ戻し、ループも次曲への自動送りもしない。
- INTRO_002: 自然発生する報告の完全再現と、障害注入による復帰能力の検証を区別する。故障を作って失敗しただけで報告の原因が確定したとは言わない。
- ブラウザ統合の停止判定: isPlaying のみでなく再生位置が進まないこと、出題IDが一致することも確認する。ただしサンプル音源は無音のため、実際のスピーカー出力を確認したとは言わない。

## 既存テストとの重複整理

以下は新しい独立テストを増やす前に既存ケースを強化する。
ファイル名は `spec/features` を基準とする。本文の期待値に未検証部分があれば同義とは扱わない。

| 設計ID | 既存の照合先 | 追加・強化する点 |
| --- | --- | --- |
| INTRO_003 | frontend/apple_music: Starting a selected game prepares the first round without playback | 無音区間・曲IDまで観測 |
| INTRO_004/005/007/015 | integration/game_session: Intro can be replayed after nobody buzzes | 3回以上、秒数の増減、開始位置、実際の停止を新 playback ケースで補完 |
| BUZZ_002/003 | integration/game_session: Wrong answer returns to the same round and accepts another buzz | 再生し直した音声と期限は新 playback ケース、再生なしの再早押しは既存へ統合 |
| BUZZ_009 | integration/game_session: Only the first player to buzz gets answer rights | 既存は逐次送信。並列受信と両方の到着順は別途必要 |
| ROUND_003 | frontend/apple_music: The intro reveal loops the round track without advancing the queue | 3周と次曲非再生を強化 |
| ROUND_004 | frontend/apple_music: Advancing right after the reveal does not start the revealed track later | Promiseを保留して割り込み順を固定 |
| ROUND_008/014 | frontend/apple_music: Intro rounds keep preparing when the host advances quickly | 既存は4曲選択で途中まで。最終曲と結果まで拡充 |
| ROUND_009 | backend/game_flow: Show results clears current track | バックエンド状態だけでは停止を検証できない。ブラウザの音源停止を補完 |
| ROUND_010/011 | integration/game_session: Next game keeps selected tracks but clears participants and scores | 次ゲームを実際に再生して旧キュー混入を確認 |
| JACKET_003/005 | frontend/apple_music: Jacket reveal uses a complete MusicKit album queue | 全曲順と無音区間、遅延完了を補完 |
| JACKET_009 | backend/game_flow: New jacket round resets the hint level but keeps display settings | 画面の画像と音声停止を補完 |
| LIBRARY_011/012 | backend/console: Jacket album candidates are grouped by album name and album artist | 同名別アーティストの非統合も確認 |
| CONTROL_008、UI_007/008/009 | frontend/console_page の回答カード各ケース | 同名別ID、IME確定、遅延クリックだけを追加 |
| UI_001 | frontend/console_page の slider ring 内側・スクロール各ケース | 同義部分は再実装不要 |

シナリオ本文は設計IDによる参照用に維持する。実行対象を二重登録しない。
新しい実行対象は `features/playback` と `features/contracts` をそれぞれ専用モジュールから収集する。
既存 frontend / integration の収集範囲を広げて未実装案を誤って実行しない。

## 確定した仕様と今回の範囲

従来の12項目は [DECISIONS.md](DECISIONS.md) の通り整理した。8定義の期待結果を確定し、複数ホスト・サーバー再起動の永続復元・OS割り込み専用対応・判定訂正機能の4定義は今回の対象外とした。ユーザーへの判断依頼は残さない。

## 実行可能なテストと残る確認

前回は既存126件を含む574ケースを検証した。確定仕様に対応する追加テストと再検証の件数・合否は検証記録を参照する。
実行結果は [検証記録](RESULTS.md)、設計IDごとの実装先と判断待ちは [実装対応表](IMPLEMENTATION.md) を参照する。
未実装だった73定義へ実行例を追加し、部分対応だった92定義にも境界・複合操作・観測を補った。設計IDとの紐付けだけを、文章の全条件や実機の網羅性の証明とはしない。

ブラウザの再生時間許容差は指定秒数の半分と250msの小さい方、開始位置は指定秒数の半分と150msの小さい方。0.1秒では50msとする。
早押し・リセットの停止待ち上限は1秒で、製品仕様としての遅延許容を決めたものではない。
1ms境界・30分待機は仮想時計、200操作の生成列は4シード×2モード、購読・タイマー・効果音は10ゲームの反復で確認した。ブラウザのヒープ全体のリーク検査や実端末の30分連続稼働を代替するものではない。

既存テストの固定2秒待機と、UI操作のタイムアウト時にsocket命令へ置き換える処理は削除した。既存126件は通常のUI操作で再検証した（資格情報なしの1ケースだけ別サーバーで実行）。共通SocketClientは同名conftestのimport衝突を避けるため quiz_transport.py へ移動し、抽出時にクラスのASTが移動前と一致することを確認した。その後、終了通知の新しいoperationId形式に対応した。サーバー・ブラウザの同時収集・実行も検証した。

CONTROL_010/012の文面はREADMEの画面の役割に合わせて訂正した。早押し画面は押下の受付結果を示すボタンであり、他者の解答者名や得点を表示する画面ではない。解答者・得点は観戦画面、受付規則はスマホと物理ボタン相当のHTTP要求、進行と音源はホストで検証する。新しい画面機能を暗黙の必須仕様として追加しない。

仕様判断待ちは解消した。対象外4定義と実機確認待ち1定義を区別する。検出した失敗の修正内容は [FIXES.md](FIXES.md)、修正前の結果は [execution-before-fix.json](execution-before-fix.json) に保存している。
