# 非同期順序を制御するテスト環境

アプリの本体にはテスト用フラグ・API・状態変更口を追加しません。`entry.tsx` は本番の `ConsolePage`、`GameboardPage`、`usePlaybackTarget`、MusicKitストア、ライブラリ取得処理をそのままimportします。

- `build.ts`: Bunでテスト専用bundleを一時ディレクトリへ生成します。差し替えるimportはSocket.IOのtransport境界だけです。
- `socket.ts`: テストが入力する状態通知、要求の記録、成功／拒否ackの完了順を制御します。サーバーの正しさをこの代替transportで証明しません。
- `media.js`: 再生開始／停止／音量／曲IDを持つSDK境界の代替実装です。呼び出し前後の保留・拒否とイベント順を制御します。実SDKや実際の音声出力の代わりとは扱いません。
- `clock-server.ts`: 別プロセスで本番サーバーをimportし、サーバーが利用する `Date.now` を制御します。249／250／251ms等の受付境界を、実HTTP・Socket.IOで検証します。制御APIはloopbackの一時ポートにのみ置きます。

テストはPlaywrightの時計で1ms前・期限・期限後、30秒、30分待機を進めます。実際のSDKの内部debounce、codec、通信、media要素の振る舞いは `test_playback_regressions.py` と `test_extended_scenarios.py` の実MusicKit SDKテストで別に確認します。

`network-500` 等の制御コンポーネントテストは、SDK呼び出しの応答を遅らせて制御側の待機を検証します。実ネットワーク帯域や端末負荷に対する性能保証ではありません。CPU条件のみCDPのCPU throttlingも設定します。
曲末境界の制御テストはSDKイベントと次ラウンド操作の順序を検証し、自然な曲末・ループそのものは実SDKの2秒のテスト音源で確認します。

固定シード1・7・42・20260922の200操作を、イントロ／ジャケットそれぞれで実行します。サーバー側とコンポーネント側は独立した期待状態・得点・音源条件と比較し、シード・操作列・要求・SDK呼び出しと結果をpytestの一時ディレクトリへ保存します。認証情報は保存しません。

実行例（リポジトリルート）:

```sh
spec/step_defs/.venv/bin/python -m pytest spec/step_defs/frontend/test_controller_ordering.py spec/step_defs/backend/test_ordering_and_generated.py --tb=short
```

この2モジュールには既存サーバーの指定は不要です。サーバーの時計テストは自身の一時サーバーを起動・終了します。実SDKのテストには従来通り `TEST_BACKEND_URL` が必要です。同じゲームサーバーに対するテストは並列実行しません。
