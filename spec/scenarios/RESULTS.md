# 再生シナリオの検証記録

2026-09-22。ベースコミット `47f7172` からの未コミット変更を検証した。

## 仕様確定後の結果

**612ケース成功、失敗0、未実行0。**

[確定した仕様](DECISIONS.md) に合わせ、曲末停止、秒数変更の次回適用、バッファ待ちの除外、画面再生成からの復帰、再生不能曲の除外を実装した。以前の574ケースから38ケースを追加した。
仕様判断待ちは0。設計178定義は、自動テスト実装あり173、今回の対象外4、実機確認待ち1に分類した。

結果は全モジュールの実行と、修正後の対象再実行を合わせたケースごとの最新結果。単一の一括実行で全件成功したという意味ではない。資格情報なしのケースは別サーバーで検証した。
実SDKの広範囲回帰は専用サーバー18081、最終調整後の復帰・選曲・曲末・短時間再生は別サーバー18082、制御コンポーネントは実行時に本体から作成したbundleで検証した。

| モジュール | ケース数 | 成功 | その他 |
| --- | ---: | ---: | ---: |
| [backend/test_backend_specs.py](../step_defs/backend/test_backend_specs.py) | 50 | 50 | 0 |
| [backend/test_contract_scenarios.py](../step_defs/backend/test_contract_scenarios.py) | 122 | 122 | 0 |
| [backend/test_ordering_and_generated.py](../step_defs/backend/test_ordering_and_generated.py) | 40 | 40 | 0 |
| [frontend/test_controller_ordering.py](../step_defs/frontend/test_controller_ordering.py) | 164 | 164 | 0 |
| [frontend/test_extended_scenarios.py](../step_defs/frontend/test_extended_scenarios.py) | 68 | 68 | 0 |
| [frontend/test_frontend_specs.py](../step_defs/frontend/test_frontend_specs.py) | 76 | 76 | 0 |
| [frontend/test_playback_regressions.py](../step_defs/frontend/test_playback_regressions.py) | 92 | 92 | 0 |

[機械可読結果](execution-results.json)・[失敗一覧](FAILURES.md)・[実装対応表](IMPLEMENTATION.md)に各ケースの結果と参照先を記録した。[仕様確定前の574件](execution-before-decisions.json)と[不具合修正前の結果](execution-before-fix.json)も保存している。

## 今回の観測とテストの訂正

- 2秒の音源を5秒指定しても曲末で停止。正解発表の単曲・アルバムのループは維持。先読み完了が遅れても次の答えを流さない。
- 再生中に秒数を増減しても今回の停止時刻と表示は変わらず、次回から反映。
- 2秒／10秒の読み込み待ちを再生時間に加算しない。早押しで停止した後の配信復旧でも音が復活しない。
- 再読み込み時の待機・再生・解答・正解演出・不正解演出・正解発表・結果を検証。得点の再加算をせず、演出を完了して操作できる。
- 再生操作の応答喪失を、状態通知の到着前後で検証。未所有の再生状態は音を出さず待機に戻す。
- 選曲時の既知の再生不能曲、準備時の404／410、Promise未完了中のSDKエラー通知で除外。401／500は除外しない。全曲除外・混在・古い通知も検証。
- 旧仕様のバッファ待ち中の実時間期限を期待した2件、2秒音源が2.5秒流れると期待した5件を新仕様に訂正。後者は入力操作そのものの検証を維持し、停止時刻だけを曲末までに変更。
- 再生失敗のテストはSDK名の接頭辞ではなく「再生を開始できません」の表示を検証し、待機に戻った後に再生をやり直せることも確認した。
- 再読み込みテストでは観測器を新しい画面に設置し直す。不正解演出完了後は通常どおり解答権が解除されることを期待する。

lint、アプリとテスト環境の型検査、Python／Gherkin構文、対応表と収集ケースの整合を確認した。

## 再現方法

Bun 1.4.2、Python 3.14.7、pytest 9.0.3、Chromium系ブラウザで検証した。
実際のゲーム用サーバーを指定しない。未使用ポートで専用サーバーを起動し、自動再読み込みが観測を消さない本番設定を使う。

```sh
NODE_ENV=production PORT=18081 bun server/index.ts
```

別ターミナルで全テストを順番に実行する。同じゲームサーバーへの並列実行はしない。

```sh
cd spec/step_defs
TEST_BACKEND_URL=http://localhost:18081 .venv/bin/python -m pytest --tb=short --junitxml=/private/tmp/quiz-results.xml
```

資格情報あり／なしのAPI試験はサーバー環境によって片方がskipする。残ったケースは別の専用サーバーで実行する。資格情報なしの環境は `APPLE_TEAM_ID`・`APPLE_KEY_ID`・`APPLE_PRIVATE_KEY` を空にして起動する。
制御コンポーネントとサーバー時計の2モジュールだけなら既存サーバーは不要。終了後は自分で起動したサーバーを停止する。

終了通知の形式を変更したため、利用中の環境へ反映するときはサーバーを再起動し、開いているホストコンソールも再読み込みする。通知には開始時の `state.operationId` を保持して付ける。

リポジトリルートから `spec/step_defs/.venv/bin/python spec/scripts/scenario_results.py` にJUnitファイルを実行順に渡すと結果を更新できる。`spec/scripts/scenario_inventory.py` は設計と実装の対応を検証・再生成する。

## 観測範囲と残る確認

実MusicKit SDKの試験は実UIを操作し、Apple MusicのHTTP応答と2秒の無音音源に既存モックを使う。明示した障害ケースだけSDK呼び出し等の失敗・保留・無動作を注入する。
制御コンポーネント試験は本番ReactとSDK・通信の代替実装を使う。両者の範囲は [テスト環境](../harness/README.md) に記載した。

曲ID・再生位置・メディア状態・音量を観測した。実ブラウザの時間許容差は原則 `min(250ms, 指定秒数/2)`、開始位置は `min(150ms, 指定秒数/2)`、0.1秒では50ms、サンプル間隔は10ms。1ms境界は仮想時計であり実機精度の保証ではない。
試験で使う停止待ちの上限や障害注入の待機期限は失敗判定用で、製品の遅延許容を決めたものではない。

JUnitと各ケースの観測JSONは実行環境の一時ディレクトリにある。認証トークン・ヘッダーは保存しない。画面再読み込み前のメディア観測は引き継がない。

**仕様判断待ちは [DECISIONS.md](DECISIONS.md) で解消。対象外4定義と実機確認1定義を区別する。** 物理スピーカー、実アカウントでの楽曲、OS割り込み、実端末の長時間稼働、ヒープ全体のリークは確認済みとしない。設計173定義への自動テスト実装や件数だけで、あらゆる操作の網羅性を保証しない。
