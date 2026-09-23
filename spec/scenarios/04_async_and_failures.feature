@planned
Feature: MusicKitの遅延・失敗・処理順の逆転
  以下はテストの設計。実行可能なテストとの対応は IMPLEMENTATION.md を参照。

  @ASYNC_001 @p0
  Scenario: 再生開始失敗後に再操作できる
    Given 曲Aの準備が完了し次の再生要求だけが失敗する
    When 再生ボタンを押す
    Then 失敗を表示し再生中として放置しない
    And 復旧後に再試行すれば曲Aを指定秒数だけ再生できる

  @ASYNC_002 @p0
  Scenario: ロード失敗をロード中のままにしない
    Given 曲Aの音源取得が失敗する
    When ゲームを開始する
    Then エラーが表示され失敗した曲を準備済みとは扱わない
    And リセットが操作できる
    And 復旧後にゲームを開始し直せる

  @ASYNC_003 @p0
  Scenario: 頭出し失敗を成功扱いしない
    Given 曲Aを5秒再生して停止済みで次の頭出し要求が失敗する
    When 曲Aを再び再生する
    Then 5秒地点から誤って再生しない
    And エラーを表示し復旧後は先頭から再生できる

  @ASYNC_004 @p0
  Scenario: 停止要求の失敗を画面だけで隠さない
    Given 曲Aが再生中でMusicKitの停止要求が失敗する
    When 再生期限に到達する
    Then 停止失敗がホストに表示される
    And 停止を確認するまで通常の再生待機として成功表示しない
    And 復旧後に停止して再生操作へ戻れる

  @ASYNC_005 @p0
  Scenario: 先読み失敗でも現在の曲を再生停止できる
    Given 曲Aの準備は完了し次の曲Bの先読みだけが失敗する
    When 曲Aを1秒で再生し自然停止後にもう一度再生する
    Then 曲Aは両方の回で1秒で停止する
    And 曲Bの失敗を理由に曲Aの再生ボタンを無期限に無効化しない

  @ASYNC_006 @p0
  Scenario: 古い処理の失敗を次の曲のエラーにしない
    Given 曲Aの先読み要求を保留したまま曲Bへ進み準備が完了している
    When 保留していた曲Aの要求を失敗させる
    Then 曲Bの準備完了状態を取り消さない
    And 曲Bを再生できる
    And 未処理のPromise例外が発生しない

  @ASYNC_007 @p0
  Scenario: 再生要求が成功を返しても音声が始まらない
    Given MusicKitが再生Promiseを解決するが再生状態も再生位置も進めない
    When 曲Aの再生を要求する
    Then 成功応答だけで再生成功と判定しない
    And 開始を確認できない場合は期限付きで失敗として表示する
    And ホストが再操作できる

  @ASYNC_008 @p0
  Scenario: 停止要求が成功を返しても音声が止まらない
    Given MusicKitが停止Promiseを解決するが音声と再生位置が進み続ける
    When 再生期限に到達する
    Then 音声が止まったことを確認するまで停止成功と判定しない
    And 停止を確認できない場合は失敗として表示し再操作を可能にする

  @ASYNC_009 @p0
  Scenario: 曲切替が成功しても違う曲なら準備済みにしない
    Given 曲Bへの切替要求に対してMusicKitが曲Aを現在曲として返す
    When 次のラウンドの曲Bを準備する
    Then 曲Bの再生ボタンを有効にしない
    And 曲IDの不一致を表示し曲Aを出題曲として鳴らさない

  @ASYNC_010 @p1
  Scenario: 先読み非対応でも通常ロードで次の曲を再生する
    Given 次の曲の先読みが利用できない再生環境で曲Aを終了した
    When 曲Bへ進んで準備完了後に再生する
    Then 曲Bを通常のロードで準備できる
    And 曲Bを先頭から指定秒数だけ再生し停止できる

  @ASYNC_011 @p1
  Scenario: 一時消音中の失敗後に音量を戻す
    Given ホストの音量が0.4で曲準備中の一時消音を使用する
    And 消音区間内のロード処理が失敗する
    When エラー後に復旧して曲Aを再生する
    Then 音量が0.4へ戻り曲Aが聞こえる
    And 準備失敗によって消音が残らない

  @ASYNC_012 @p1
  Scenario: ホストが元から消音している場合は勝手に解除しない
    Given ホストの音量が0である
    When 曲の準備、再生、停止、次の曲の準備を行う
    Then 音量は0のままである
    And 内部の準備処理が音量を上げない

  @ASYNC_013 @p0
  Scenario: 古い再生完了が新しい再生の期限を上書きしない
    Given 曲Aの1回目の再生完了通知を保留している
    And 早押しと不正解を経て2回目を5秒設定で再生中である
    When 1回目の完了通知を返す
    Then 2回目は自身の音声開始から5秒で停止する
    And 古い通知による頭出しや追加再生が起きない

  @ASYNC_014 @p1
  Scenario: 曲メタデータの遅延で音声の停止期限を延ばさない
    Given 曲Aの音源は準備済みだがアートワークや曲情報の取得を保留している
    When 曲Aを0.5秒で再生する
    Then 音声開始から0.5秒で停止する
    And 情報表示の遅延は再生期限に影響しない

  @ASYNC_015 @p0 @fault_injection
  Scenario Outline: 処理 <operation> が応答しなくてもリセットを完了する
    Given 曲Aの <operation> が完了も失敗も返さず保留中である
    When ホストがリセットする
    Then 選択曲と解答者が解除され楽曲が停止する
    When その後に旧処理を完了させる
    Then 楽曲は停止したままである
    And 旧処理がゲームを復元したり音を鳴らしたりしない
    And 新しい曲を選んで開始できる

    Examples:
      | operation |
      | setQueue |
      | play |
      | pause |
      | seekToTime |
      | skipToNextItem |
      | playNext |
      | アルバムID取得 |

  @ASYNC_016 @p0
  Scenario Outline: 開始や停止が抑制される間隔 <interval> でも操作を失わない
    Given 同種のMusicKit操作が250ms以内だと成功応答だけ返す環境である
    When 曲の準備後 <interval> msで再生する
    And 早押しと不正解後に再生する
    Then 曲を実際に再生でき早押しで実際に止まる
    And 最終状態だけでなく各操作の音声と停止を確認する

    Examples:
      | interval |
      | 0 |
      | 1 |
      | 249 |
      | 250 |
      | 251 |

  @ASYNC_017 @p1
  Scenario Outline: イベントとPromiseの順序 <order> に依存しない
    Given 曲Aの準備が完了している
    And MusicKitの通知順を <order> にする
    When 曲Aを1秒で再生して自然停止を待つ
    Then 曲Aは1秒だけ再生され再生可能な待機状態へ戻る
    And 同じ通知を二度受けても追加再生しない

    Examples:
      | order |
      | 音声開始イベントが先でPromise解決が後 |
      | Promise解決が先で音声開始イベントが後 |
      | 停止イベントが先で停止Promise解決が後 |
      | 停止Promise解決が先で停止イベントが後 |
      | 同一状態イベントが重複 |

  @ASYNC_018 @p0
  Scenario Outline: 途中の待機時間 <delay> によって再生秒数が変わらない
    Given 曲Aの準備が完了し実際の音声開始は遅らせず再生Promiseの解決だけを <delay> ms遅らせる
    When 曲Aを0.5秒設定で再生する
    Then 音声開始を基準に0.5秒で止まる
    And Promise解決までの待機が音声長へ上乗せされない

    Examples:
      | delay |
      | 0 |
      | 250 |
      | 1000 |
      | 5000 |
