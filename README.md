# Live Streaming Pages App

Cloudflare Pages Functions とシンプルなフロントエンドで構成したミニマルなライブ配信アプリです。`functions/ws.js` が配信者と視聴者の WebSocket 中継を行い、`public/broadcaster.html` と `public/viewer.html` が送受信 UI を提供します。仕様書で求められる映像/音声送出、A/V 同期、ABR 風品質調整、ping/pong 監視、Origin 制限・配信キーによる保護をすべて実装済みです。

## ディレクトリ概要

```
public/            # 配信者・視聴者 UI
  broadcaster.html
  viewer.html
functions/
  ws.js            # WebSocket 中継 (Pages Functions)
wrangler.toml      # ローカル開発・Pages Functions 設定
```

## 動作要件 (仕様対応の確認ポイント)

- **メディア取得**: `broadcaster.html` で `getUserMedia` によりカメラ/マイクを取得し、解像度プリセット (Low/Medium/High) とカメラ向き (Front/Back) を選択可能。マイクはトグルで `track.enabled` を切り替え。
- **送信**: 映像は `<canvas>` で JPEG へエンコードし、音声は `MediaRecorder` の 500ms chunk (audio/webm/Opus) を base64 化して WebSocket 送信。品質は JPEG 品質/FPS/解像度の 3 段階を ABR 風に自動降格・復帰。
- **同期/再生**: 視聴側は音声をマスタークロックにし、映像はキューから過去で最新のフレームを選択。A/V ズレが ±400ms を超えるとリセット、150–400ms で軽度補正。初期 500ms バッファ、溢れた音声チャンクは破棄。
- **安定化**: 5 秒ごとに ping/pong で RTT 測定。`bufferedAmount` と実効 FPS を監視し、WARN/DROP 閾値で品質を段階的にダウン。30 秒安定時は 1 段階アップ。pong 欠落 30 秒で送信側を切断し再接続を促す。
- **セキュリティ**: Origin を `ALLOWED_ORIGINS`（環境変数）とローカル用ホワイトリストで検査し、配信者には `?key=` が必須。ペイロードは JSON/型/JPEG dataURL/base64 長を検証し、不正メッセージや send 失敗視聴者は即破棄。
- **自動再接続**: 視聴側は指数バックオフ (1→2→4…最大 30s) で再接続し、接続状態や再接続回数を UI 表示。

## ローカル実行

Pages Functions を含む挙動確認を行う場合は Cloudflare CLI (Wrangler) を利用します。

```bash
# Pages Functions を含めて起動 (推奨)
wrangler pages dev public --functions=functions

# 静的ファイルだけ確認する場合
python -m http.server 8000
# http://localhost:8000/public/broadcaster.html などを開く
```

環境変数 `BROADCAST_KEY`（未指定時は `SECRET`）で配信キーを設定し、配信者は `/ws?role=broadcaster&key=<BROADCAST_KEY>`、視聴者は `/ws?role=viewer` で接続します。Origin 制限を有効にする場合は `ALLOWED_ORIGINS` にカンマ区切りで許可ドメインを指定します。

## 本番デプロイ (Cloudflare Pages)

1. Cloudflare Pages プロジェクトを作成し、このリポジトリを接続。
2. Pages Functions を有効化し、**環境変数** を設定:
   - `BROADCAST_KEY`: 配信者用の共有キー
   - `ALLOWED_ORIGINS`: `https://<your-project>.pages.dev,https://<custom-domain>` 形式
3. ビルド設定は不要（静的配信のため Build command/Output dir は空欄 or `public`）。
4. デプロイ後、`https://<your-project>.pages.dev/public/broadcaster.html` で配信開始、`viewer.html` で視聴を確認。
5. 独自ドメインを利用する場合は SSL/TLS を有効化し、`ALLOWED_ORIGINS` に追記して再デプロイ。

### Wrangler 経由でのデプロイ

Cloudflare アカウントにログイン済みであれば、次のコマンドで Pages へ直接アップロードできます。

```bash
wrangler pages deploy public --project-name <PROJECT_NAME> --functions=functions
```

## 運用チェックリスト

- **RTT/品質監視**: 配信者 UI の RTT/FPS/Quality/buffered を確認し、品質ダウン・アップが発生するかをログで確認。
- **再接続**: 視聴者側をネットワーク遮断→復帰させ、指数バックオフ再接続と A/V リセットが動作するかを確認。
- **セキュリティ**: `ALLOWED_ORIGINS` 未許可の Origin や誤った `BROADCAST_KEY` で接続し、403/1008 で拒否されることを確認。

## スクリーンショット取得の例

UI 確認用のスクリーンショットが必要な場合は、ローカルでサーバーを起動し、Playwright などでページを開いて撮影できます。

```bash
python -m http.server 8000 &
# 例: Playwright (Python) で撮影
# await page.goto('http://localhost:8000/public/broadcaster.html'); await page.screenshot(path='broadcaster.png')
```

撮影後の画像を PR に添付すると、閲覧環境によらず表示の有無を確認できます。
