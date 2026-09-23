@planned
Feature: 選曲・ページング・曲とアルバムの識別
  以下はテストの設計。実行可能なテストとの対応は IMPLEMENTATION.md を参照。

  @LIBRARY_001 @p1
  Scenario: 空プレイリストだけでは開始できない
    Given 曲が0件のプレイリストを取得済みである
    When そのプレイリストを選択する
    Then 選択曲数は0でゲーム開始を無効にする
    And 存在しない曲の準備を始めない

  @LIBRARY_002 @p1
  Scenario: 選択解除中に古い取得結果が返っても追加しない
    Given プレイリストAを選択して曲取得を保留している
    When Aを選択解除する
    And Aの取得結果を返す
    Then Aの曲は選択曲に含まれない
    And 選択件数とサーバーの曲一覧が一致する

  @LIBRARY_003 @p1
  Scenario: 複数プレイリストの取得順が逆でも選択を失わない
    Given プレイリストAとBを選択して両方の取得を保留している
    When Bの結果を先に返してからAの結果を返す
    Then AとBの選択曲を両方保持する
    And 最後に返ったAだけでBを上書きしない

  @LIBRARY_004 @p1
  Scenario: 重複曲を含むプレイリストの一方を解除する
    Given Aに曲Xと曲Y、Bに曲Yと曲Zがあり両方を選択している
    When Aを解除する
    Then 曲Yと曲Zが残り曲Xだけが除かれる
    And 曲Yを重複出題しない

  @LIBRARY_005 @p1
  Scenario: 取得中にリセットしても選曲が復活しない
    Given 選択したプレイリストAの曲取得を保留している
    When リセットする
    And Aの取得結果を返す
    Then 選択プレイリストと曲一覧は空のままである
    And 古い取得結果からゲームを開始しない

  @LIBRARY_006 @p1
  Scenario: プレイリスト再読み込み失敗後に再操作できる
    Given プレイリスト一覧の再読み込みが失敗する
    When 再読み込みを押してエラーを確認し通信を復旧して再試行する
    Then 読み込み中表示が解除される
    And 再試行後に一覧が更新され選曲できる

  @LIBRARY_007 @p1
  Scenario: 曲IDが欠落した項目を再生キューへ渡さない
    Given プレイリストにIDなしの曲と正常な曲Aが含まれる
    When プレイリストを選択してゲームを開始する
    Then 曲Aだけを出題する
    And 空IDのMusicKit要求は発生しない

  @LIBRARY_008 @p1
  Scenario: 曲名が欠落した項目を出題しない
    Given プレイリストに曲名なしの項目と正常な曲Aが含まれる
    When プレイリストを選択してゲームを開始する
    Then 曲Aだけを出題する
    And 回答候補に空の曲名を表示しない

  @LIBRARY_009 @p1
  Scenario: アートワーク欠落でもイントロは進行できる
    Given 曲AにアートワークURLがないが音源と曲名は有効である
    When 曲Aを選び再生し正解発表へ進める
    Then 音声の再生と停止ができる
    And 画像の失敗で画面全体が操作不能にならない

  @LIBRARY_010 @p1
  Scenario: アルバム名がない曲でもイントロを開始できる
    Given 曲Aにアルバム名がなくイントロ用のIDと曲名は有効である
    When 曲Aを選択する
    Then イントロモードを開始できる
    And 有効なアルバムが0件ならジャケットモードの開始を拒否する

  @LIBRARY_011 @p1
  Scenario: 同じアルバムの異なる曲を一度だけ出題する
    Given 同じアルバム名とアルバムアーティストに属する曲Aと曲Bを選択している
    When ジャケットゲームを開始する
    Then アルバムは1問にまとまる
    And 正解発表ではそのアルバム全体を再生する

  @LIBRARY_012 @p1
  Scenario: 同名でアーティストが異なるアルバムを区別する
    Given 同じアルバム名でアルバムアーティストが異なる二つのアルバムを選択している
    When ジャケットゲームを開始する
    Then 二つの別問題として出題する
    And 回答候補でもアーティストによって区別できる

  @LIBRARY_013 @p1 @decision_resolved
  Scenario: 利用不能と判明した曲をその時点で除外する
    Given プレイリストの一部の曲が地域制限または削除で再生できない
    When プレイリストを選択して開始する
    Then 取得時に利用不能と分かった曲を選曲から除外し、準備・再生時に判明した曲も出題と回答候補から除外する
    And 利用不能な曲の存在を表示し無限ロードにしない
    And 有効曲だけならゲームを進められる

  @LIBRARY_014 @p1
  Scenario Outline: ページ境界の曲数 <count> を過不足なく取得する
    Given 選択するプレイリストに <count> 曲がありAPIが50件ごとに返す
    When 全ページを取得して選択する
    Then 有効な曲IDが重複なく <count> 件選択される
    And 最終ページの曲も出題と再生が可能である

    Examples:
      | count |
      | 0 |
      | 1 |
      | 49 |
      | 50 |
      | 51 |
      | 100 |
      | 101 |

  @LIBRARY_015 @p1
  Scenario Outline: 曲ID種別 <kind> の再生と正解発表
    Given <kind> の曲Aを選択している
    When イントロ再生と正解発表、ジャケットの正解発表をそれぞれ行う
    Then 曲Aと対応するアルバムが正しいAPI経路で取得される
    And ライブラリIDをcatalog IDとして要求しない

    Examples:
      | kind |
      | catalog ID |
      | i.で始まるライブラリID |

  @LIBRARY_016 @p1
  Scenario Outline: ページ取得の失敗 <failure> で無限に取得しない
    Given プレイリスト一覧または曲一覧のページ取得に <failure> を設定する
    When 一覧を読み込む
    Then 成功していない全件取得を完了表示しない
    And エラーが表示され読み込み中が解除される
    And 再試行できる

    Examples:
      | failure |
      | 2ページ目でHTTP 500 |
      | 2ページ目でHTTP 401 |
      | 同じnextリンクを繰り返す応答 |
      | 不正なJSON |
      | dataフィールドなし |
