## 目的
- `siyousyo.md`に記載されたRealtime SFU構成・配信/視聴/ルーム管理要件を満たすライブ配信アプリを、既存のWebSocket relay＋broadcaster/viewer UIを最大限活かしながらWorkers＋Durable ObjectによるRESTシグナリングへ移行して整備する。

## 現状の流用方針
1. `public/broadcaster.html`と`public/viewer.html`はカメラ/マイク制御、品質調整、接続強度表示、再接続/同期ロジックをすでに持つため、UI構造と性能監視の実装は維持し、シグナリング周り（room作成・offer/answer交換）のみを新APIへ差し替える。RTCPeerConnection本体と品質監視のロジックはそのまま使い、`fetch`する先だけWorkers APIに変更することで工数を削減する。
2. `functions/ws.js`のOriginチェックやペイロード検証、接続管理ヘルパーは共通モジュール化してRESTエンドポイントでも再利用する。現行WebSocket relayはデバッグ目的で残しつつ、主力はRealtime HTTPS APIで、Durable Object中心で`roomId`/`watchCode`/`trackId`/`viewerCount`を管理する構造に転換し、egress監視用ログやstate遷移もDOに保持する。

## 実装計画
1. **ルーム状態のDurable Object設計**
   - `RoomState` DOに`roomId`（十分な長さのランダム文字列）、`state`（idle/live/ended）、`watchCode`（短いPIN型）、`publishedTrackIds`（video/audio）、`viewerCount`、`limits`（デフォルト10/最大20）、`createdAt`/`endedAt`を保持。
   - `state`遷移は`room/create`でidle、`publish`成功でlive、`broadcaster`が切断または明示的終了でendedとし、`/api/room/{roomId}/status`が最新値を返す。viewer上限を超えると`limits.full`を立てて視聴APIを拒否する。
   - 視聴時間・推定egress（publishesTrack bitrate×再生時間）をDO内部で簡易カウントし、無料枠運用の安全弁としてログ/メトリクス化。必要に応じて環境変数でしきい値を調整。
   - DOはwatchCode検証、publishedTrackIdsの返却、viewerCountのインクリメント/デクリメントを担当し、視聴者がtrackを直接選べないように制御する。
2. **配信API（publish）**
   - `/api/room/create`：room生成→Realtime `sessions/new`でpublisher sessionを確保→`roomId/watchCode/watchUrl`を返す。デフォルト品質はLowまたはMidで、解像度プリセット（360p/540p/720p）を案内。
   - `/api/room/{roomId}/publish/offer`：publisherOfferSDP受信→Realtime `tracks/new`（video/audio）呼び出し→publisherAnswerSDP＋`publishedTrackIds`返却。trackIdはDOに保存し、renegotiateが必要ならPUT呼び出し。APIは`state=live`、`viewerCount`初期値0を返す。
   - カメラ切替時はtrack差し替え（旧track停止＋新track publish）と`renegotiate`を実装し、DOに最新trackId集合を保持。
3. **視聴API（subscribe）**
   - `/api/room/{roomId}/status`で`state`/`viewerCount`/`limits`/`watchCodeRequired`を返し、準備完了なら視聴者が入力するwatchCodeまたはURLパラメータを`/api/room/{roomId}/subscribe/offer`へ送る。watchCode不一致や`state`がidle/ended、viewerLimit到達時はHTTP 403/409＋`full`フラグと案内テキストで拒否。
   - DOから`publishedTrackIds`を取得し、Realtime `tracks/new`（subscribe）を呼び出してviewerAnswerSDPを生成。成功時にviewerCountをインクリメントし、disconnect/closeイベントで必ずデクリメントする。視聴者はtrackIdを選べないため、DOが最適なトラックID集合を返す。
   - UI側の再接続は指数バックオフ（1→2→4→8→16秒、最大5回）とし、回数を上限まで数えて`reconnect`ステータスに表示。`full`が返ってきたら「満員」バナーと明示的な再試行ボタンを出す。
4. **フロントエンド改修**
   - BroadcasterはRTCPeerConnectionを維持しつつ、`room/create`→`/publish/offer`という`fetch`ベースのシグナリングに置き換える。`room/create`で得た`roomId/watchUrl/watchCode`をUIに表示し、publish成功で`state`を`live`にし、`viewerCount`/`limits`の更新をステータス表示に反映させる。既存の品質制御（画像base64送信）、ping/pong、buffered監視もそのまま使いつつ、新APIのレスポンスを加えて接続強度を更新。
   - Viewerは`roomId`（URLクエリor入力）、`watchCode`を使って`/api/room/{roomId}/status`を呼び、視聴可否を判断してから`/subscribe/offer`で`viewerAnswerSDP`を取得。現在のaudio/videoキュー、A/V同期、Decode fallback、ping/pong、再接続ロジックをそのまま利用し、`full`/`state=ended`時はバナー表示で再接続を停止。
   - 接続強度バッジは`良/並/悪`に丸め、RTCPeerConnectionの`getStats`（packetLoss/jitter/RTT）や`ping/pong`/`buffered`の状態を組み合わせて更新。再接続回数、満員、再試行のステータスをUIに表示し、無限ループを防ぐ。
5. **運用/非機能要件対応**
   - Durable Object側で`state`遷移（`idle`→`live`→`ended`）、`viewerCount`/`viewerLimit`のチェック、再接続回数制御を行い、egress量（track bitrate×視聴人数×時間）を軽量ログとして記録。`/status`で`limits.full`や`remaining`を返してUIが「満員」「あと何人」表示できるようにする。
   - BackendはApp Secret/API Tokenを環境変数で保持し、クライアントには`watchCode/watchUrl`のみを渡す。watchCodeは短いPIN形式で、`watchCodeRequired`フラグを`/status`に含めて視聴者の入力を促す。
   - 視聴者/配信者双方で指数バックオフ（1→2→4→8→16秒、最大5回）を実装し、`state=ended`もしくは`limits.full`で自動接続を止める。UIには「回線不安定」「再試行」を明示し、必要な場合は手動再試行ボタンを用意する。

## 工数削減の工夫
- カメラ/音声の品質調整や接続強度表示は既存実装（`public/`内）をそのまま流用し、新API接続箇所だけを`fetch`へ差し替えで済ませる。
- `functions/ws.js`のバリデーションヘルパーを分離して、新RESTエンドポイントでも同じチェックを共有させる。
- Durable Objectでは現行`Relay`の`viewers`/`broadcaster`の概念を`room`単位に整理し、状態遷移や接続数カウントを記録することで過剰な新実装を避ける。
