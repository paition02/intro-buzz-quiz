# ジャケットのアルバム事前準備：変更と検証

## 既存テスト変更の点検

比較対象は作業開始時の HEAD と作業ツリー。アサーションを変更した箇所を以下に整理した。

| 対象 | 変更前の確認 | 最終版の確認と理由 |
| --- | --- | --- |
| `test_controller_ordering.py` の `target` | アルバム再生には `trackId` を渡す | 新しい `albumPrepared` にも `trackId` を渡すヘルパー拡張。既存テストのアサーションは変更していない。 |
| `test_playback_regressions.py` の `start_mode` | ジャケット開始後に停止している | 事前準備中に音声が出ず、対象アルバム全曲が揃い、先頭に巻き戻って停止することを追加確認。その後の従来の停止確認も残す。 |
| 同ファイルの `finish_rounds` / `jacket_wrong_and_next` | ラウンド開始後に停止している | 次ラウンドでは無音の読み込み再生が発生するため、無音化を1秒以内、準備完了を10秒以内に確認したうえで、従来の停止確認を行う。無音化の期限は緩めていない。 |
| `test_extended_scenarios.py` の `next` | 次ラウンド直後と2.3秒後に停止している | 直後は上記の準備確認を経て停止を確認。2.3秒後の停止確認は維持。 |
| 同ファイルの `album-failure` | 正解発表のアルバム取得失敗を表示し、結果へ進んで停止できる | 取得開始が早まったため、障害をゲーム開始前から注入。準備時の失敗表示・停止に加え、正解発表時の再取得がHTTP 500になること、失敗表示・無音・結果への遷移と停止を確認。失敗を成功として扱わない。 |

アルバムの曲順、アルバムループ、単曲アルバムのループ、ヒント・白黒・隠し方の維持、結果画面での停止に関する既存のアサーションは残している。

追加した `prepared-album-reuse` は、準備済みなら正解発表でメタデータを再取得しないことを検証する。失敗ケースから独立している。準備失敗後に通信が復旧したときの再試行成功は別テストで検証する。

## 検証範囲と限界

- 再生制御テスト：本番Reactコンポーネントと制御可能なSDK境界モック。
- ブラウザ統合テスト：実MusicKit JS、Apple Music通信モック、短いテスト音源。契約音源・DRM・実回線・物理スピーカーの検証とは区別する。
- テスト通過を、あらゆる端末・通信条件で不具合がない保証とは扱わない。

## 最終版の全件実行結果

2026-09-23、専用サーバー `http://localhost:3107` に対して、途中で実装・テストを変更せずに全テストを実行した。

- 収集：629件
- 合格：628件
- スキップ：1件
- 失敗・エラー：0件
- 所要時間：2091.11秒（34分51秒）
- 型チェック：合格
- ESLint：合格
- `git diff --check`：合格

スキップの詳細：

- `test_musickit_token_endpoint_rejects_missing_credentials`：Apple Music credentials are configured for this test server

実行コマンド（リポジトリルート）：

```sh
PORT=3107 bun server/index.ts
TEST_BACKEND_URL=http://localhost:3107 UV_CACHE_DIR=/private/tmp/intro-quiz-uv-cache NODENV_VERSION=24.19.0 uv run --project spec/step_defs pytest spec/step_defs -v --tb=short --junitxml=/private/tmp/intro-quiz-full-regression.xml
NODENV_VERSION=24.19.0 bun run typecheck
NODENV_VERSION=24.19.0 bun run lint
git diff --check
```

ログ：`/private/tmp/intro-quiz-full-regression.log`。JUnit結果：`/private/tmp/intro-quiz-full-regression.xml`。
テストサーバーは検証終了後に停止した。

結論：実行した自動テストの範囲では退行を検出していない。契約音源、DRM、実回線での開始遅延、端末の自動再生制約、物理音声出力は未確認。これらまで確認済みとはしない。
