# 内輪向けライブ配信アプリ 仕様書（Cloudflare Realtime SFU版 / 修正版）

## 1. 目的
- 内輪（限定メンバー）で使える「低遅延の配信＆視聴」を最小構成で実現する。
- WebRTCはP2Pではなく Cloudflare Realtime SFU（旧 Calls）を中継に用い、視聴者が増えても配信者端末の上り負荷が爆発しない構成とする。:contentReference[oaicite:3]{index=3}
- 無料枠（Realtimeの月1,000GB egress）内での運用を第一優先とする。:contentReference[oaicite:4]{index=4}

## 2. 前提・制約（無料枠運用）
### 2.1 課金対象
- Cloudflare edge → クライアントへのデータ送信量（egress）が課金対象。
- Realtime SFU/TURNは合算で「月 1,000GB まで無料」、超過は $0.05/GB。:contentReference[oaicite:5]{index=5}

### 2.2 無料枠を守るための設計制約（仕様として固定）
- 既定の配信品質は「低〜中」に固定し、初期状態で高ビットレートにしない。
- 同時視聴者数に上限を設ける（例：デフォルト 10、最大 20 など）。
- 視聴ページは「自動再接続の無限ループ」を避け、リトライ回数/間隔を制限する（egress増加抑制）。

## 3. 全体アーキテクチャ
### 3.1 コンポーネント
- Client（配信者）：ブラウザ（スマホ/PC）でカメラ・マイクを取得しWebRTCでSFUへPublish。
- Client（視聴者）：ブラウザでWebRTCでSFUからSubscribeして再生。
- Backend（Cloudflare Workers）：認証/ルーム制御/シグナリングの代理（App Secretを保持し、Realtime HTTPS APIへアクセス）。
- State（推奨：Durable Objects）：roomId→配信トラック一覧、視聴者数、配信状態などの状態管理（Workers単体はステートレスになりやすいため）。

※ Cloudflare Realtime SFU は「HTTPS APIによるシグナリング」を提供し、バックエンドがクライアントとトラック購読関係を管理する想定。:contentReference[oaicite:6]{index=6}

### 3.2 Realtime API（HTTPS）の利用（設計上の前提）
- セッション作成: POST /apps/{appId}/sessions/new
- トラック追加（publish / subscribe）: POST /apps/{appId}/sessions/{sessionId}/tracks/new
- 再交渉: PUT /apps/{appId}/sessions/{sessionId}/renegotiate :contentReference[oaicite:7]{index=7}

## 4. 機能要件
## 4.1 配信（Publisher）
### UI/操作
- 配信開始/停止
- 解像度（または品質）段階切替（Low / Mid / High の3段階）
- インカメ/アウトカメ切替
- マイクON/OFF
- 接続強度表示（簡易：良/並/悪）

### メディア品質（初期値と上限）
- Low: 360p / 300–500kbps（映像）+ 32–48kbps（音声）
- Mid: 540p / 600–900kbps（映像）+ 48–64kbps（音声）
- High: 720p / 1200–1800kbps（映像）+ 64kbps（音声）
※ 無料枠運用の観点から、デフォルトは Low または Mid とする。

### 挙動
- 配信開始時に roomId を発行し、視聴URL（または視聴コード）を生成する。
- 配信者はSFUへ「video track」「audio track」をPublishする。
- カメラ切替は（可能な限り）トラック差し替えで行う。差し替え時は renegotiate を実行し、視聴側が映像を継続受信できること。:contentReference[oaicite:8]{index=8}

## 4.2 視聴（Viewer）
### UI/操作
- 視聴開始/停止
- 音量調整（ミュート含む）
- 接続強度表示（簡易：良/並/悪）
- 遅延の目安表示（任意：推定値）

### 挙動
- 視聴開始時、Backendから「現在配信中のtrackId一覧」を取得し、該当トラックをSubscribeする。
- 視聴者はSFUへ直接「どのトラックを見るか」を決められないため、Backendが購読対象のtrackIdを制御する。:contentReference[oaicite:9]{index=9}

## 4.3 ルーム（配信単位）
- roomId: 配信の識別子（URLまたは短いコード）
- ルーム状態: idle / live / ended
- 視聴者数カウント（無料枠運用の安全弁）
- 視聴者上限: exceed時は「満員」表示（購読させない）

## 4.4 認証（最小）
- 内輪用途の最小として「視聴コード（短いPIN）」「ワンタイムURL」いずれかを採用。
- App Secret / API Token はクライアントへ渡さない（Workersの環境変数で保持）。

## 5. 非機能要件
## 5.1 安定性
- 再接続：接続断時、指数バックオフ（例：1s→2s→4s→8s、最大5回）で自動復帰を試みる。
- 失敗時：ユーザーに「回線不安定」「再試行」導線を提示。

## 5.2 低遅延
- 目的は「通話に近い遅延」（HLSのような十数秒遅延ではない）。

## 5.3 セキュリティ（最低限）
- 視聴URLは推測困難にする（十分な長さのID）。
- ルームのtrackId一覧は認証済みクライアントにのみ返す。

## 6. 画面・導線（最小）
- トップ：配信開始ボタン / 視聴コード入力
- 配信画面：プレビュー、開始/停止、品質、カメラ切替、マイク、接続強度
- 視聴画面：動画プレイヤ（video要素）、音量、接続強度、退出

## 7. 接続強度（実装指針：簡易）
- WebRTC Stats（RTCPeerConnection.getStats）から以下のいずれかで段階評価：
  - packetLoss / jitter / roundTripTime
- 表示は「良/並/悪」に丸める（数値を露出しない）。

## 8. API設計（Backend / Workers）
### 8.1 ルーム
- POST /api/room/create
  - 戻り：roomId, watchCode, watchUrl
- GET /api/room/{roomId}/status
  - 戻り：state, viewerCount, limits

### 8.2 Publish（配信）
- POST /api/room/{roomId}/publish/offer
  - 入力：publisherOfferSdp
  - 処理：Realtime sessions/new → tracks/new（publish）→ answer返却
  - 戻り：publisherAnswerSdp, publishedTrackIds
  - ※ trackIdをDOに保存

### 8.3 Subscribe（視聴）
- POST /api/room/{roomId}/subscribe/offer
  - 入力：viewerOfferSdp, watchCode
  - 処理：ルームのpublishedTrackIdsを参照→ Realtime tracks/new（subscribe）→ 必要に応じ renegotiate → answer返却
  - 戻り：viewerAnswerSdp

※ Realtime側のセッション/トラック操作は Connection API に準拠。:contentReference[oaicite:10]{index=10}

## 9. 運用
- 配信終了時にルーム状態を ended にし、視聴者の新規参加を停止する。
- 無料枠監視：月間の視聴時間や推定egressをログとして保存（簡易でよい）。

## 10. 将来拡張（後回し）
- コメント/チャット（別系統：WebSocket + DO）
- 録画（ヘッドレスクライアント等）
- 複数配信者、共同配信
- RealtimeKit等のUIコンポーネント採用（要検討）


