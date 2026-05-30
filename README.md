# 早押しイントロクイズ

PCでゲームサーバーを起動し、スマホのホストコンソール、スクリーンのゲームボード、物理早押しボタンから同じゲーム状態を操作するイントロクイズアプリです。

## 起動

```bash
npm install
npm run dev
```

- ホスト操作: <http://localhost:5173/console>
- スクリーン表示: <http://localhost:5173/gameboard>
- 早押しボタンデバッグ: <http://localhost:5173/debug/action>

LAN内のスマホやボタンから使う場合は、PCのIPアドレスで `http://<PCのIP>:5173/console` や `POST http://<PCのIP>:5173/api/act/<actor_id>` にアクセスします。

## 実装済みエンドポイント

- `GET /gameboard` — プレイヤー共通表示
- `GET /console` — ホスト進行画面
- `POST /api/act/:actor_id` — プレイヤー/物理ボタンのアクション信号
- `GET /debug/action` — アクション送信シミュレーター
- `GET /api/state` — 現在状態
- `GET /api/events` — Server-Sent Eventsによる状態配信

## 現在のMVP仕様

- 準備フェーズでは、アクションでプレイヤー参加をトグルし、常に `{ "shouldReact": true }` を返します。
- 再生中ステップでは、最初に押した参加プレイヤーだけが解答権を得て `{ "shouldReact": true }`、それ以外は `{ "shouldReact": false }` です。
- Apple Music/MusicKit連携は未接続で、ログイン・プレイリスト選択・曲ロードの差し込み口だけ用意しています。
- 曲データはサンプルトラックで進行します。

## 次にやること

- MusicKit JSの認証とプレイリスト取得
- 実音源の指定秒数再生・停止
- 物理ボタンのHTTPクライアント例
- ゲーム設定（効果音、表示時間、同一曲の再出題制御など）
