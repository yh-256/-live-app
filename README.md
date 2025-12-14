# Live Streaming Pages App (Realtime SFU + Durable Object)

Cloudflare Pages の静的 UI と Workers + Durable Object を組み合わせ、Room ベースの REST シグナリングで Realtime SFU（旧 Calls）を使って低遅延ライブ配信を実現するアプリです。配信者・視聴者はそれぞれ `public/broadcaster.html`/`public/viewer.html` をブラウザで開き、Workers の `/api/room/*` エンドポイントを介して Publish/Subscribe を行います。

## 構成ハイライト

- `public/`：
  - `broadcaster.html`：Room 作成 → `/api/room/{roomId}/publish/offer` を呼び出して SDP を交換しながら WebRTC 送信。room/watch-code/状態/接続強度を UI で表示し、viewer limit を監視。
  - `viewer.html`：Room ID + Watch Code を入力 → `/status` → `/subscribe/offer` で視聴。最大 5 回の指数バックオフ再接続と `full` フラグ・視聴コードの検証で、egress 増加を抑える設計。
- `functions/room-state.js`：Durable Object に `roomId`/`state`/`publishedTracks`/`viewerCount`/`viewerLimit` を保持し、Realtime API を呼ぶ `create`/`status`/`publish`/`subscribe`/`end`/`viewer/leave` を実装。
- `functions/realtime.js`：Realtime Sessions/Tracks API の共通 wrapper。
- `functions/_worker.js`：`/api/room/*` のルーティング処理と `/ws` （従来の WebSocket relay）を共存させる entrypoint。
- `wrangler.toml`：Durable Object バインディング（`RELAY` と `ROOM_STATE`）、Realtime API 用の環境変数を定義。

## API/ルームの流れ

1. 配信者が `/api/room/create` を叩くと RoomState が初期化され `roomId/watchCode/watchUrl` を返す。
2. `/api/room/{roomId}/publish/offer` に SDP と track metadata（Bitrate など）を送ると DO が `sessions/new` + `tracks/new` を呼び出し `publisherAnswer` を返却、状態を `live` に。
3. 視聴者は `/api/room/{roomId}/status` で `state/viewerCount/limits/watchCodeHint` を取得し、`watchCode` を付けて `/subscribe/offer` を呼ぶと `viewerAnswer` を得て再生開始。
4. DO は `viewerCount` を+1/-1 し、viewer limit（デフォルト10、最大20）を超えたら `limits.full` を返す。不正 watchCode や `room.state !== live` の場合は 403/409。
5. `/api/room/{roomId}/end` で `state` を `ended` にして新規接続を停止。`/viewer/leave` で viewer count を調整。

## 環境変数

- `BROADCAST_KEY`：4 桁以上の配信キー（未設定時は `SECRET`）。`broadcaster` から `key` クエリで送られ、Workers が検証。
- `ALLOWED_ORIGINS`：`https://<project>.pages.dev,https://<custom>` 形式で Origin チェック。
- `REALTIME_APP_ID`：Realtime アプリ ID（必須）。
- `REALTIME_API_TOKEN`：Realtime HTTPS API 呼び出し用トークン（必須）。
- `REALTIME_BASE_URL`（任意）：Cloudflare が提供する Realtime API のベース URL（省略時は `https://rtc.live.cloudflare.com/v1`）。

## ローカル開発

1. `wrangler pages dev public` を実行して Pages + Functions を起動。`REALTIME_APP_ID`/`REALTIME_API_TOKEN` は `wrangler` の `--var` または `dev.vars` で渡す（本番と同値）。
2. `public/broadcaster.html` を開いて `BROADCAST_KEY` などをセットし、配信を開始。
3. `public/viewer.html` で Room ID + Watch Code を入力して接続。必要ならローカルで `https://localhost:8788/public/viewer.html?room=<roomId>&code=<watchCode>` のように直 URL を使ってテスト。
4. `npm test` は `package.json` 非存在のため `ENOENT` で失敗する（現時点でテストスクリプトなし）。JavaScript を変更したらブラウザ操作で目視確認してください。

## 本番デプロイ（Cloudflare Pages）

1. Pages プロジェクトにこのリポジトリを接続し、`main` ブランチなどをデプロイ対象に。
2. Pages Functions を有効化し `functions/_worker.js` を entrypoint に設定。
3. Durable Object バインディングを 2 件追加（`RELAY`：`Relay`, `ROOM_STATE`：`RoomState`）。
4. 環境変数を設定：`BROADCAST_KEY`, `ALLOWED_ORIGINS`, `REALTIME_APP_ID`, `REALTIME_API_TOKEN`, 必要なら `REALTIME_BASE_URL`。
5. `wrangler pages deploy public --project-name <PROJECT_NAME> --functions=functions` でデプロイ。または UI から publish。
6. 配信者は `https://<project>.pages.dev/public/broadcaster.html` を開き、room/watch code を取得して視聴者に共有。視聴者側は `viewer.html` で Room ID + Watch Code を入力。
7. Cloudflare Pages の Observability で Workers 処理や DO 状態を監視し、`state`/`viewerCount`/`limits.full` をチェック。

## 運用チェックリスト

- 配信者 UI の RTT/FPS/Quality/buffered を確認し、品質アップ/ダウンが発生するかをログで観察。
- `room/{roomId}/status` で `viewerCount`/`limits`/`state` を確認し、`viewers` が `full` になったら通知を表示。
- 視聴者 UI の再接続は指数バックオフ（1→2→4→8→16秒、最大 5 回）で止め、`state=ended` または `limits.full` 時に手動再接続へ誘導。
- 失敗やエラーは `banner` でユーザーに「回線不安定」や「再試行」状態を告知。

