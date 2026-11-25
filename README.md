# Nestline

ローカルファーストのアウトライナーです。文書はブラウザの IndexedDB に自動保存され、Markdown、OPML、JSON、LaTeX のインポート／エクスポートに対応します。外部サーバーへの保存は行いません。

## 開発

```sh
npm install
npm run dev
```

本番ビルドは `npm run build`、単体テストは `npm test` で実行します。

## 編集

- Enter：兄弟ノードを追加。空ノードでは逆インデント
- Tab / Shift+Tab：インデント／逆インデント
- Shift+Enter：ノード内改行
- 空ノードで Backspace：ノードと子を削除
- ↑↓：可視ノード間の移動
- Ctrl+↑↓：兄弟の並べ替え
- Ctrl+Shift+Space：折りたたみ／展開
- Alt+→ / Alt+←：ズームイン／ズームアウト
- Ctrl+Z / Ctrl+Shift+Z：Undo / Redo

表示中のノードはクリックすると生テキストで編集できます。Markdown と数式はフォーカスが外れたときに描画されます。

## 入出力

上部の「入出力」メニューから形式と出力範囲を選びます。ズーム中は文書全体か、ズームした部分木を出力できます。インポート時は現在の文書を置き換えるか、ルートに新しいノードとして追加するかを選択します。置き換え前には確認を表示します。

LaTeX 出力は `layer` と `itemize` の2形式です。単体コンパイルには LuaLaTeX と HaranoAji フォントが必要です。
