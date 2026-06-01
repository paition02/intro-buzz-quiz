# 早押しイントロクイズ

PCでゲームサーバーを起動し、スマホのホストコンソール、スクリーンのゲームボード、物理早押しボタンから同じゲーム状態を操作するイントロクイズアプリです。

## 起動

```bash
bun install
bun dev
```

- ホスト操作: <http://localhost:5173/console>
- スクリーン表示: <http://localhost:5173/gameboard>
- スマホ早押しボタン: <http://localhost:5173/action>

LAN内のスマホやボタンから使う場合は、PCのIPアドレスで `http://<PCのIP>:5173/console`、`http://<PCのIP>:5173/action`、または `POST http://<PCのIP>:5173/api/act/<actor_id>` にアクセスします。

## 実装済みエンドポイント

- `GET /gameboard` — プレイヤー共通表示
- `GET /console` — ホスト進行画面
- `GET /action` — スマホを早押しボタンとして使うプレイヤー向けページ
- `POST /api/act/:actor_id` — プレイヤー/物理ボタンのアクション信号
- `GET /api/token` — MusicKit developer token

## 現在のMVP仕様

- 準備フェーズでは、アクションでプレイヤー参加をトグルします。
- ゲーム中は、イントロ再生中、またはその曲が1回以上再生済みの再生前ステップで、最初に押した参加プレイヤーだけが解答権を得ます。
- アクションAPIはレスポンスボディではなくステータスコードで反応有無を示します。
  - `200 OK`: 反応あり
  - `204 No Content`: 正常だが反応なし
  - `400 Bad Request`: リクエスト不正
  - `409 Conflict`: 状態的に今は受け付けられない
  - `429 Too Many Requests`: 連打・クールダウン
- Apple Music/MusicKitでログインし、ライブラリプレイリストから曲を選択して実音源を再生します。
