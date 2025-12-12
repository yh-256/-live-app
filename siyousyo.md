# Minimal Live Stream WS+CF — 完全仕様書（最終版）

内輪向けの「無料で開発できる配信アプリ」を Cloudflare Pages + Workers のみで構築するための最終仕様書。  
映像・音声の同期、接続安定化、自動品質調整、セキュリティ対策などをすべて含む。

---

# 1. システム概要

## 1.1 目的
スマホブラウザから映像＋音声をライブ配信し、Webブラウザで視聴できるミニマルかつ安定した配信システムを、無料の Cloudflare Pages + Workers の範囲内で構築する。

## 1.2 特徴
- Cloudflare Pages（静的UI）＋ Workers（WebSocket 中継）
- 映像 + 音声ストリーム対応（WebSocket）
- 自動品質調整（JPEG品質/FPS/解像度の段階的制御）
- 音声を基準にした簡易A/V同期モデル
- 接続強度表示（RTT / FPS / bufferedAmount ）
- 安定化アルゴリズム搭載
- カメラ切り替え（前/後）・マイクON/OFF
- 解像度プリセット（Low/Medium/High）
- 最低限のセキュリティ（Origin制限・配信キー・ペイロード検証）

---

# 2. 主要ユースケース

1. 配信者が `broadcaster.html` をスマホで開く  
2. カメラ・マイク使用を許可  
3. 解像度 / カメラ方向 / マイク設定を選択  
4. 「配信開始」 → WebSocket 接続  
5. 視聴者は `viewer.html` を開けば即視聴  
6. 音声優先で同期し、ネットワーク劣化時は自動で品質調整  
7. 接続強度が UI 上に表示される  

---

# 3. 全体構成

```
root/
  public/
    broadcaster.html
    viewer.html
  functions/
    ws.js
  wrangler.toml（任意）
```

- Pages：静的ファイル配信
- Workers（Pages Functions）：WebSocketサーバ

---

# 4. 機能仕様

# 4.1 配信者画面（broadcaster）

## 映像取得
- getUserMedia(video)
- カメラ方向選択：
  - front: `facingMode: "user"`
  - back: `facingMode: { exact: "environment" }`

## 解像度プリセット
| モード | 解像度 |
|--------|---------|
| Low    | 320×240 |
| Medium | 640×480 |
| High   | 1280×720 |

配信開始後の変更は再接続が必要。

## 音声取得
- getUserMedia(audio)
- MediaRecorder で 500ms ごとの audio/webm（Opus）チャンクを生成
- マイクON/OFFは `track.enabled` を切り替え

## 映像エンコード
- `<canvas>` に描画 → JPEG 生成  
- `canvas.toDataURL("image/jpeg", quality)`  
- quality は 0.4〜0.8 の範囲で自動調整可能

## 音声送信
- MediaRecorder のチャンクを base64 で JSON に詰めて送信

## 接続強度表示
- RTT（ping/pong）
- 実効FPS
- ws.bufferedAmount
- Strong / Normal / Weak / Bad の4段階表示

## 自動品質調整（ABR風）
- JPEG品質：0.8 → 0.6 → 0.4
- FPS：10fps → 7fps → 5fps
- 解像度：High → Medium → Low
- トリガー条件：RTT増大 / bufferedAmount増加 / FPS低下  
- 復帰条件：安定状態30秒継続 → 1段階アップ

---

# 4.2 視聴者画面（viewer）

## 映像再生
- WebSocket で video パケットを受信し、A/V同期モデルに従って表示

## 音声再生
- AudioContext  
- 500ms の初期バッファ後再生開始  
- 音声キューが溢れた場合、古いチャンクを捨てて追いつく

## 自動再接続
- エクスポネンシャルバックオフ（1 → 2 → 4 → 最大30秒）

## A/V 同期
- 音声をマスタークロックとし、映像は必要に応じてスキップ/待機  
- ズレ > ±400ms で A/V リセット

---

# 5. メッセージプロトコル

## 5.1 WebSocket接続URL

```
wss(s)://<domain>/ws?role=<broadcaster|viewer>&key=<optional>
```

## 5.2 JSONメッセージ形式

### 映像（video）
```json
{
  "type": "video",
  "seq": 1234,
  "ts": 123456,
  "data": "data:image/jpeg;base64,....."
}
```

### 音声（audio）
```json
{
  "type": "audio",
  "seq": 5678,
  "ts": 123450,
  "duration": 500,
  "mime": "audio/webm;codecs=opus",
  "data": "<base64>"
}
```

### 制御（ping/pong）
```json
{ "type": "ping", "ts": 1234567890 }
{ "type": "pong", "ts": 1234567890 }
```

---

# 6. A/V同期モデル

## 6.1 ts の定義
配信者側で
```
baseTs = performance.now()
ts = performance.now() - baseTs
```

## 6.2 視聴者側の再生クロック
```
currentMediaTime = (now - firstPacketReceivedAt) + playbackOffsetMs
```
playbackOffsetMs の初期値：500ms

## 6.3 映像同期
- video キューに溜める
- currentMediaTime より過去で最大の ts のフレームを表示
- 過去に遅れすぎたフレームは破棄

## 6.4 音声同期
- 音声は500ms のバッファ保持後再生
- バッファ >1500ms → 古いチャンク破棄

## 6.5 A/V ズレ補正
```
delta = videoDisplayedTs - audioCurrentTs
```

- |delta| ≤150ms：正常
- 150–400ms：軽度補正
- >400ms：A/Vリセット（最新に同期し直す）

---

# 7. 接続安定化仕様

## 7.1 ping/pong
- 5秒ごとに ping
- RTT = now - ts
- 30秒 pongなし → 再接続

## 7.2 ws.bufferedAmount 監視
- WARN：200KB  
- DROP：500KB  
- DROP 超 → フレームスキップ  
- WARN 継続 → 自動品質ダウン  

## 7.3 自動再接続
- バックオフ：1s → 2s → 4s … → 最大30s

## 7.4 サーバ側で遅い視聴者排除
- send() 例外 or readyState != OPEN → 即削除

---

# 8. セキュリティ仕様

## 8.1 Origin制限
- `ALLOWED_ORIGINS = ["https://<project>.pages.dev"]`
- 不一致なら 403

## 8.2 配信キー
- broadcaster は `?key=SECRET` 必須
- 一致しない場合は `1008 Policy Violation` で切断

## 8.3 ペイロード検証
- JSON parse 失敗 → 破棄
- type mismatch → 破棄
- JPEG dataURL 形式チェック
- base64長 / サイズ上限チェック
- 不正クライアントは強制切断

---

# 9. Workers（/ws）仕様

## 9.1 グローバル状態（単一インスタンス内）
```
let broadcaster = null
let viewers = new Set()
```

## 9.2 接続処理
- role=broadcaster:
  - key確認
  - broadcaster に登録
- role=viewer:
  - viewers に追加

## 9.3 メッセージ処理
- type に応じて video/audio を全 viewer に中継
- 不正 or oversized → 無視
- send 失敗 viewer は削除

---

# 10. 配信UI仕様

## 10.1 broadcaster.html

### UI要素
- プレビュー（video）
- Canvas（非表示）
- Resolution select：Low / Medium / High
- Camera toggle：Front / Back
- Mic toggle：ON / OFF
- Start / Stop ボタン
- Status 表示（FPS / RTT / Quality）

---

# 11. 制約と拡張可能性

## 制約
- Workers はインスタンス間で状態共有しないため、大規模利用には向かない
- JPEG over WebSocket のため低帯域時は劣化しやすい
- 厳密なA/V同期や放送品質は非対象

## 拡張
- WebRTC ingest
- Durable Objects でルーム管理
- チャット機能
- レコーディング（Cloudflare R2）

---

# 12. 本仕様の目的

- 完全無料・容易にホストできるライブ配信基盤を構築しつつ、  
  既存の大規模配信サービス（IVS / Stream / WebRTC SFU 等）が採用している  
  「高品質化テクニック」を実現可能な範囲で取り込むこと。
