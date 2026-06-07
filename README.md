# 早押しイントロクイズ

Apple Music の楽曲を使った、リアルタイム同期型の早押しイントロクイズアプリです。
1 台の PC でゲームサーバーを起動し、ホストはスマホの**ホストコンソール**で進行、観客は**ゲームボード**を大画面で観戦、プレイヤーはスマホや物理ボタンを**早押しボタン**として使います。すべての画面・ボタンは WebSocket でサーバーの 1 つのゲーム状態を共有します。

## 特徴

- **サーバーが唯一の真実 (single source of truth)** — ゲーム状態はサーバーが保持し、Socket.IO で全クライアントへ broadcast します。各画面は状態を表示し、操作は「意図」をサーバーへ送るだけです。
- **実音源での再生** — ホストが Apple Music にログインし、自分のライブラリのプレイリストから曲を選んで MusicKit JS で実際に再生します。
- **物理ボタン対応** — スマホの `/action` ページだけでなく、`POST /api/act/:actorId` を直接叩く自作の物理早押しボタンも使えます。
- **Bun ネイティブ** — ランタイム・HTTP サーバー・WebSocket をすべて Bun（`Bun.serve` + `@socket.io/bun-engine`）で動かします。SPA、API、Socket.IO を 1 つの Bun サーバーで配信します。

## 構成

| 画面 / API | パス | 役割 |
| --- | --- | --- |
| ホーム | `GET /` | 各画面へのリンク集 |
| ホストコンソール | `GET /console` | Apple Music ログイン・曲選択・ゲーム進行（ホスト操作） |
| ゲームボード | `GET /gameboard` | 大画面向けの観戦表示 |
| 早押しボタン | `GET /action` | スマホを早押しボタンとして使うプレイヤー向けページ |
| トークン発行 | `GET /api/token` | MusicKit 用 developer token (JWT) |
| アクション信号 | `POST /api/act/:actorId` | プレイヤー / 物理ボタンからの早押し・参加トグル |
| WebSocket | `/socket.io/` | 状態同期とホスト操作イベント |

## 必要なもの

- [Bun](https://bun.sh/)
- Apple Developer Program のメンバーシップ（MusicKit 用の developer token を発行するため）
  - Team ID
  - MusicKit 対応の Key ID と、その秘密鍵 (`.p8`)
- Apple Music のサブスクリプション（ホストがライブラリのプレイリストを再生するため）

## セットアップ

### 1. 依存をインストール

```bash
bun install
```

### 2. 環境変数を設定

`.env.example` をコピーして `.env` を作成し、各値を記入します（必要な変数とその説明は `.env.example` を参照してください）。Bun は cwd の `.env` を自動で読み込みます。

```bash
cp .env.example .env
```

`APPLE_*` が未設定の場合、`GET /api/token` は `401` を返し、MusicKit でのログイン・再生はできません（ゲームの状態遷移自体は動きます）。

### 3. 起動

```bash
bun dev
```

`bun --hot` で Bun サーバーをホットリロード付きで起動します。HTTP と HTTPS を同時に `0.0.0.0` で待ち受けるため LAN 内の端末からアクセスできます。実際の URL は起動時のログに表示されます。

| 用途 | URL |
| --- | --- |
| ホスト操作（PC / スマホ） | `http://localhost:<HTTP_PORT>/console` / `https://localhost:<HTTPS_PORT>/console` |
| 大画面表示 | `http://localhost:<HTTP_PORT>/gameboard` / `https://localhost:<HTTPS_PORT>/gameboard` |
| 早押しボタン（各プレイヤーのスマホ） | `http://localhost:<HTTP_PORT>/action` / `https://localhost:<HTTPS_PORT>/action` |

`.env` の例では `HTTP_PORT=1199`、`HTTPS_PORT=2199` です。LAN 内の別端末から使う場合は `localhost` を PC の IP アドレスに置き換えます（例: `http://192.168.x.x:<HTTP_PORT>/action` または `https://192.168.x.x:<HTTPS_PORT>/action`）。物理ボタンは `POST http://<PCのIP>:<HTTP_PORT>/api/act/<任意のID>` または `POST https://<PCのIP>:<HTTPS_PORT>/api/act/<任意のID>` を叩きます。

## 遊び方

1. **ホストがログイン** — `/console` を開き「Apple Musicにログイン」。ログインするとライブラリのプレイリスト一覧が自動取得されます。
2. **曲を選ぶ** — プレイリストを複数選択すると、その曲がまとめて MusicKit のキューへ読み込まれます。
3. **プレイヤー参加** — 各プレイヤーは `/action` を開く（または物理ボタンを用意する）。準備フェーズ中にボタンを押すと参加 / 退出がトグルします。参加者はゲームボードに表示されます。
4. **ゲーム開始** — ホストが「ゲーム開始」。曲順はシャッフルされ、全員のスコアが 0 にリセットされます。
5. **イントロ再生** — ホストが再生秒数（0.1〜30 秒）を指定して「再生」。指定秒数だけイントロが流れます。
6. **早押し** — 再生中、または一度でも再生した後（再生前ステップ）に、参加プレイヤーが最初にボタンを押すと解答権を獲得します。
7. **正誤判定** — ホストが「正解」/「不正解」を判定。正解なら +1 点で正解発表へ、不正解なら再び早押し受付に戻ります。
8. **正解発表 → 次へ** — 正解発表中は曲をフル再生（ループ）。ホストは「次のラウンドへ」で次の曲、「結果発表へ」でスコアボードを表示します。
9. **次のゲーム / リセット** — 「次のゲームへ」で参加者をクリアして準備フェーズへ。「リセット」で初期状態まで戻します。

## ゲーム状態モデル

サーバーは 1 つの `GameState` を保持し、変化のたびに全クライアントへ `state` イベントを emit します。

### フェーズ (`phase`)

| フェーズ | 説明 |
| --- | --- |
| `initialization` | 起動直後。ホストの Apple Music ログイン待ち |
| `ready` | 準備フェーズ。プレイリスト選択とプレイヤー参加の受付 |
| `game` | ゲーム進行中 |

### ステップ (`step`、`game` フェーズ内)

| ステップ | 説明 |
| --- | --- |
| `loading` | 次の曲を準備中 |
| `beforePlayback` | 再生前。ホストの再生待ち |
| `playing` | イントロ再生中。早押し受付中 |
| `answering` | 解答権が確定。ホストの正誤判定待ち |
| `correct` / `wrong` | 正解 / 不正解の演出（約 1.8 秒） |
| `reveal` | 正解発表（曲のフル再生・ループ） |
| `results` | スコア結果発表 |

> 補足: 不正解の演出後は `beforePlayback` に戻り、同じ曲で再度早押しできます。正解の演出後は `reveal` へ進みます。

## API リファレンス

### `GET /api/token`

MusicKit JS 用の Apple Music developer token を返します。`jose` で ES256 署名した JWT（有効期限 24 時間）です。

- `200` — `{ "token": "...", "expiresAt": "ISO8601" }`
- `401` — Apple Music の認証情報が未設定
- `500` — トークン生成失敗

### `POST /api/act/:actorId`

プレイヤー / 物理ボタンからのアクション信号です。`:actorId` がプレイヤーを識別します（`/action` ページは `sessionStorage` に保存した UUID、物理ボタンは任意の固定 ID を使えます）。**レスポンスボディは常に空で、反応の有無は HTTP ステータスコードで示します。**

| ステータス | 意味 |
| --- | --- |
| `200 OK` | 反応あり（参加トグル成功、または解答権の獲得） |
| `204 No Content` | 正常だが反応なし（すでに他の人が解答権を取得済み 等） |
| `400 Bad Request` | `actorId` が空 |
| `409 Conflict` | 今は受け付けられない状態（未参加での早押し、受付時間外 等） |
| `429 Too Many Requests` | クールダウン中（同一プレイヤーの受理済み action は最短 250ms 間隔） |

挙動の要点:

- **準備フェーズ中** (`initialization` / `ready`): 押すたびに参加 / 退出をトグル（`200`）。
- **ゲーム中**: `playing` ステップ、または 1 回以上再生済みの `beforePlayback` ステップでのみ早押しを受付。
  - 未参加プレイヤー → `409`
  - すでに誰かが解答権を持っている → `204`
  - 最初に押した参加プレイヤー → 解答権を獲得して `answering` へ（`200`）

### WebSocket (`/socket.io/`)

接続時にサーバーは現在の状態を `state` イベントで送信します。ホストコンソールの操作は以下のイベントで送られ、各操作は ack で成否を返します。状態の同期は `state` イベントで行います。

| イベント | 操作 |
| --- | --- |
| `console:ready` | ホストコンソールが再生準備完了したことを通知（→ `ready`） |
| `console:select-playlists` | 選択プレイリストID群と曲リストを設定 |
| `console:start` | ゲーム開始（曲順シャッフル・スコアリセット） |
| `console:play` | イントロ再生開始 |
| `console:play-ended` | イントロ再生終了 |
| `console:correct` | 正解判定 |
| `console:wrong` | 不正解判定 |
| `console:correct-feedback-ended` | 正解フィードバック終了（正解発表へ） |
| `console:wrong-feedback-ended` | 不正解フィードバック終了（再生前へ） |
| `console:give-up` | ギブアップ（正解発表へ） |
| `console:next-round` | 次の曲へ |
| `console:show-results` | 結果発表へ |
| `console:next-game` | 次のゲームへ（参加者クリア） |
| `console:reset` | 初期状態へリセット |

## 音源再生 (MusicKit)

- `index.html` で MusicKit JS v3 を CDN から読み込みます。
- 再生を行うのは**ホストコンソール (`/console`) のみ**です。ゲームボードは正解 / 不正解の効果音（Web Audio で合成）のみ鳴らします。
- ホストコンソールはゲーム状態を駆動源として再生を制御します（`playing` ステップで指定秒数だけイントロ再生、`reveal` ステップで曲をフルループ再生）。再生の開始 / 停止 / MusicKit キュー準備はすべて状態の変化に追従して行われます。
- プレイリストの曲はライブラリ版からカタログ版へ解決し、MusicKit キューには 50 曲単位のロットで投入します。再生対象の曲が別ロットにある場合は、そのロットへキューを張り替えてリピートモードを「1 曲」に設定します。

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `bun dev` | 開発サーバー（`bun --hot`） |
| `bun run typecheck` | 型チェック（`tsc -b`） |
| `bun start` | 本番起動（`NODE_ENV=production`） |
| `bun run lint` | ESLint |
| `bun run test:spec` | backend + frontend の feature / step defs 回帰テスト |

## 技術スタック

- ランタイム / サーバー: **Bun** (`Bun.serve`)
- WebSocket: **Socket.IO** + **@socket.io/bun-engine**
- フロントエンド: **React 19**（Bun サーバーが配信する SPA）
- 音源: **Apple MusicKit JS v3**
- トークン署名: **jose**（ES256 JWT）
