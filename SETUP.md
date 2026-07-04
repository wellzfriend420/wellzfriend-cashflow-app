# 日繰り資金繰り管理システム セットアップガイド

## ファイル構成

```text
cashflow-app/
├── index.html          # 画面構造
├── assets/
│   ├── styles.css      # 画面スタイル
│   └── app.js          # 画面制御、API通信、残高計算、Excel出力
├── main.gs             # GAS設定、GET/POSTの入口
├── spreadsheet.gs      # シート作成、取得、保存、削除
├── transactions.gs     # 月別の資金繰り取引取得
├── setup.gs            # 初期セットアップ、確認用関数
├── holiday.gs          # 日本の祝日・営業日判定
├── fixedExpense.gs     # 固定支出マスタ、予定生成
├── PROJECT.md          # 現行仕様・構造
├── CHANGELOG.md        # 変更履歴
├── TODO.md             # 優先順位付き改修候補
└── IDEAS.md            # 中長期アイデア
```

## 1. Googleスプレッドシートを作成

1. Googleスプレッドシートで空のブックを作成します。
2. URLの `/d/` と `/edit` の間にあるスプレッドシートIDを控えます。

## 2. Apps Scriptプロジェクトを準備

1. スプレッドシートの「拡張機能」→「Apps Script」を開きます。
2. Apps Script側に次の4ファイルを作成し、同名ファイルの内容を貼り付けます。
   - `main.gs`
   - `spreadsheet.gs`
   - `transactions.gs`
   - `setup.gs`
   - `holiday.gs`
   - `fixedExpense.gs`
3. `main.gs` の `SPREADSHEET_ID` を実際のIDへ変更します。
4. 保存後、関数一覧から `setupSpreadsheet` を一度だけ実行し、権限を許可します。

Apps Scriptではプロジェクト内のすべての `.gs` ファイルが共通の名前空間で読み込まれます。ファイルの並び順には依存していません。

## 3. 作成されるシート

| シート | 用途 |
|---|---|
| `cashflow_transactions` | 入出金予定・実績 |
| `receivables` | 売掛金 |
| `payables` | 買掛金 |
| `accounts` | 口座マスタと現在残高 |
| `partners` | 取引先マスタ |
| `settings` | 将来の設定保存領域 |
| `fixed_expenses` | 固定支出マスタ |

列定義の正本は `main.gs` の `COLUMNS` です。既存シートの列順を変える場合は、移行手順を用意してから変更してください。

## 4. Webアプリとしてデプロイ

1. Apps Scriptで「デプロイ」→「新しいデプロイ」を選びます。
2. 種類を「ウェブアプリ」にします。
3. 実行ユーザーとアクセス範囲を運用方針に合わせて設定します。
4. デプロイ後のWebアプリURLを控えます。
5. コード更新後は、新しいバージョンとしてデプロイを更新します。

## 5. 画面を起動

`index.html` と `assets` フォルダを同じ構成のままWebサーバーへ配置します。ローカル確認では、簡易Webサーバー経由で `index.html` を開くのが確実です。

画面の「設定」で次を入力します。

- GAS Web App URL
- 会社名

GAS URLはブラウザの `localStorage` に保存されます。URL未設定時はデモデータで動作し、スプレッドシートへは保存されません。

## 6. Excel出力

日繰り画面の「Excel出力」から、表示中の月・モード・選択口座を `.xlsx` で保存します。処理は `assets/app.js` の `exportCashflowToExcel` が担当し、SheetJSをCDNから読み込みます。

## 7. 更新時の確認

- `main.gs` の公開アクション名と `assets/app.js` の呼び出し名が一致していること
- `COLUMNS` と既存シートのヘッダー・列順が一致していること
- 売掛／買掛の保存時に対応する資金繰り取引も保存されること
- 予測／実績／差異の各モードで日付と金額が意図どおり選ばれること
- 口座フィルター後の月初・月末残高とExcel出力が画面表示に一致すること
- 固定支出の対象月ごとに生成取引が1件だけ存在すること
- 土日祝日の翌営業日／前営業日調整が意図どおりであること
- 編集・削除時に確定済み実績が保護されること

詳細な現行仕様と既知の注意点は `PROJECT.md` を参照してください。
