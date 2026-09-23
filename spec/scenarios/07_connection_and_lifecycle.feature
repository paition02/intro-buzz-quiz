@planned
Feature: 接続切断・認証・画面の再生成
  以下はテストの設計。実行可能なテストとの対応は IMPLEMENTATION.md を参照。

  @SESSION_001 @p0
  Scenario: 再生開始をサーバーが拒否した場合は音を出さない
    Given 曲Aの準備が完了している
    And 再生開始要求をサーバーが拒否する
    When 再生ボタンを押す
    Then 曲Aの音声は出ない
    And 拒否理由が表示されボタンが操作不能のまま残らない

  @SESSION_002 @p0
  Scenario: 再生中に状態通信が切れても期限で音を止める
    Given 曲Aを3秒設定で再生中である
    When ホストとサーバーのWebSocket接続を切断する
    Then 曲Aの音声は音声開始から3秒で停止する
    And 通信切断を表示する
    And 再接続後はサーバー状態と照合して再操作できる

  @SESSION_003 @p1
  Scenario: 解答中にプレイヤーが再接続しても権利を失わない
    Given Pが解答権を取得し楽曲は停止している
    When Pの早押し画面を切断し同じ識別子で再接続する
    Then Pの解答権と得点は保持される
    And 再接続を新たな早押しや参加トグルとして扱わない

  @SESSION_004 @p1
  Scenario: 未接続の間に進んだ最新ラウンドを表示する
    Given ゲームボードが曲Aの出題中に切断された
    When ホストが曲Bまで進めてからゲームボードを再接続する
    Then 曲Bの最新状態と得点を表示する
    And 曲Aの古い表示に戻らない

  @SESSION_005 @p0
  Scenario: ログアウト後に保留中の音声を開始しない
    Given 曲Aの準備処理が保留中である
    When ログアウトする
    And 保留した曲Aの処理を完了させる
    Then 音声を開始しない
    And 未ログイン表示となり再ログイン操作が可能である

  @SESSION_006 @p1
  Scenario: ログインをキャンセルした後に再試行する
    Given 未ログインでログイン操作を開始した
    When 認証画面をキャンセルしてから再びログインする
    Then キャンセルを成功として扱わず操作待ちが解除される
    And 2回目の認証成功後はプレイリストを取得できる

  @SESSION_007 @p1
  Scenario: トークン取得失敗から復旧する
    Given developer tokenの取得が失敗している
    When ホスト画面を開きエラーを確認する
    And 取得先を復旧して画面を再読み込みする
    Then エラーが解消されMusicKitの認証と曲選択ができる
    And 古い初期化処理が新しいインスタンスを上書きしない

  @SESSION_008 @p1
  Scenario: ログイン状態の再通知でプレイリスト選択を壊さない
    Given 認証済みで曲Aと曲Bを選択している
    When 同じ認証済み通知を複数受信する
    Then 選択曲は維持される
    And ライブラリ取得の競合で未選択状態に戻らない

  @SESSION_009 @p0 @decision_resolved
  Scenario: 再生要求の応答を失った場合の扱い
    Given サーバーは再生開始を受理したがホストへの応答が届かない
    When 応答待ち期限を超過する
    Then 音声を停止し、サーバーの再生中状態を待機へ戻して再操作できる
    And 応答のない要求を無条件再送して二重再生しない
    And 無期限の再生中表示を残さない

  @SESSION_010 @p0 @decision_resolved
  Scenario: ホスト画面を閉じた場合の進行の復旧
    Given イントロを再生中でPが参加している
    When ホスト画面を閉じて再度開く
    Then 中断した再生を停止して待機へ戻し、再生ボタンから頭出し再生できる
    And 再同期後にPの早押しとホストの判定を操作できる
    And 無期限の再生状態を残さない

  @SESSION_011 @p1 @out_of_scope
  Scenario: 二つのホスト画面からの再生操作
    Given 異なる端末で二つのホスト画面を開いている
    When 一方が再生している間にもう一方も操作する
    Then 音声を担当するホストと操作権限の方針を決める
    And 同じゲームの音を二重に流さない
    And 両方の画面に担当と操作可否を示す

  @SESSION_012 @p1 @out_of_scope
  Scenario: サーバー再起動後のホスト復帰
    Given 曲Aの再生中にサーバーを再起動する
    When ホストが新しいサーバー状態へ再接続する
    Then ゲームを初期化するか永続状態から復元するかを決める
    And 停止済みの旧ゲームの音声を再開しない
    And 新しい状態で開始操作が可能になる

  @SESSION_013 @p0 @decision_resolved
  Scenario Outline: 状態 <state> でのホスト再読み込み方針
    Given ホストが <state> にあり他の画面は接続したままである
    When ホスト画面を再読み込みする
    Then 再生中は停止して待機へ戻り、解答者・得点・出題を保持して操作を続けられる
    And 準備中は準備をやり直し、正誤演出は終了まで進み、正解発表と結果表示は復元する
    And 旧画面のタイマーに依存して進行不能にならない

    Examples:
      | state |
      | 初回ロード中 |
      | 再生待機中 |
      | 再生中 |
      | 解答中 |
      | 正解演出中 |
      | 不正解演出中 |
      | 正解発表中 |
      | 結果発表中 |

  @SESSION_014 @p1 @out_of_scope @device
  Scenario Outline: 端末割り込み <interruption> から復帰する
    Given ホストが曲Aを3秒設定で再生中である
    When <interruption> を発生させて復帰する
    Then OSの制約に応じた中断と復帰時の再開方針を決める
    And 復帰後に期限切れの音声を無期限再生しない
    And 再操作が必要なら画面に表示する

    Examples:
      | interruption |
      | 画面ロック |
      | 別タブへの切替 |
      | アプリのバックグラウンド化 |
      | 着信によるオーディオ割り込み |
      | Bluetooth出力の切断 |
      | 端末スリープ |

  @SESSION_015 @p0 @device
  Scenario Outline: 再生環境 <environment> で基本の一連操作を行う
    Given <environment> の実環境または対応するブラウザでMusicKitに認証済みである
    When 秒数を変えた3回再生、早押し、不正解、再再生、正解、次の曲と進める
    Then 各回の音声・停止・出題曲・解答者が一致する
    And 先読み可否を問わず最後まで操作できる
    And 自動再生が禁止された場合は解除操作を案内し無限待機にしない

    Examples:
      | environment |
      | macOS Safari |
      | macOS Chrome |
      | Windows Chrome |
      | Windows Edge |
      | iPhone Safari |
      | iPad Safari |
      | Android Chrome |
