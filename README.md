# Discord Music Bot (Node.js)

簡易的な音楽再生ボットの雛形です。主な特徴:
- スラッシュコマンドで再生・停止・スキップ
- メンションまたは指定テキストでローカル音源を再生
- アーティストループ機能（このプロジェクトでは**湘南乃風**に固定）

---

## セットアップ
1. Node.js (18+) をインストール
2. ffmpeg と yt-dlp をインストール（音声抽出に必要）
   - Debian/Ubuntu: `sudo apt install ffmpeg` / `pip install -U yt-dlp` など
3. リポジトリで依存をインストール
   ```bash
   npm install
   ```
4. `.env` を作成して `BOT_TOKEN` などを設定（`.env.example` を参照）
5. 開発中は `GUILD_ID` を設定するとコマンド登録が高速です
6. ボットを実行
   ```bash
   npm start
   ```

## 使い方
- /join: ボイスチャンネルに参加
- /leave: 退出
- /play <query or URL>: YouTubeから曲を検索して再生
- /artist: 湘南乃風のみを無限ループで再生
- メンションまたは `TRIGGER_TEXT` を含むメッセージで `LOCAL_AUDIO` を再生

### 注意
- Spotifyの音声直接再生は行っていません。YouTube検索経由で再生します。
- 著作権や配信規約に注意してください。

---

## Proxmox CT上での運用メモ
- CTにNodeとFFmpegを入れ、PM2やsystemdで常駐させるのが運用しやすいです。
- Lavalinkを使う場合はJava（Lavalinkサーバ）を別CTで動かす運用が良いです。

