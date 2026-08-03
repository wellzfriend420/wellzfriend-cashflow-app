# PROJECT

## アプリの目的

日々の入出金予定と実績、売掛・買掛、口座残高を一か所で確認し、短期の資金繰りを把握するためのブラウザアプリです。GASをAPIとしてGoogleスプレッドシートへ保存し、GAS URL未設定時はデモモードで画面を確認できます。

## 使用技術

- HTML / CSS / JavaScript
- Tailwind CSS CDN（ユーティリティクラス）
- SheetJS 0.18.5 CDN（Excel出力）
- Google Apps Script
- Googleスプレッドシート
- ブラウザ `localStorage`（GAS URL、会社名）

ビルド工程やパッケージ管理はありません。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 6画面のHTML構造、ナビゲーション、外部ライブラリ読込 |
| `assets/styles.css` | レスポンシブUI、テーブル、フォーム、モーダル等のスタイル |
| `assets/app.js` | 状態管理、API通信、描画、入力、残高計算、Excel出力 |
| `main.gs` | スプレッドシートID、シート・列定義、GET/POSTルーティング |
| `spreadsheet.gs` | シートの自動作成、全件取得、upsert、削除 |
| `transactions.gs` | 月指定の資金繰り取引取得 |
| `setup.gs` | 初回シート作成、初期口座、デバッグ関数 |
| `holiday.gs` | 日本の祝日・営業日判定、休日調整 |
| `fixedExpense.gs` | 固定支出マスタ、月別予定生成、重複防止 |
| `SETUP.md` | 導入と更新手順 |
| `OPERATIONS.md` | WFS運用、顧客展開、リリース手順 |
| `SCHEMA.md` | 保存先に依存しないデータ契約 |
| `CHANGELOG.md` | 変更履歴 |
| `TODO.md` | 優先順位付きの改修計画 |
| `IDEAS.md` | 中長期の構想 |
| `work/original/` | 今回受領した未変更ファイル（比較・退避用） |

## 画面一覧

| 画面 | 主な表示・操作 |
|---|---|
| ホーム | 現預金合計、口座別残高、月末・30日予測、未回収売掛、未払買掛、警告、直近取引 |
| 日繰り | 月切替、予測／実績／差異、口座フィルター、口座別取引額・残高、Excel出力 |
| 売掛 | 未回収／回収済／遅延の一覧、登録・編集・入金確定・削除 |
| 買掛 | 未払／支払済／遅延の一覧、登録・編集・支払確定・削除 |
| 口座 | 口座名、銀行、種別、現在残高の登録・編集・削除 |
| 設定 | GAS Web App URL、会社名、取引先マスタ、固定支出マスタ |

## 入力項目

- 手動取引: 区分、口座、取引先、摘要、予定日、予定金額、メモ
- 取引確定: 実績日、実績金額、確定状態
- 売掛: 取引先、請求日、請求額、入金予定日、入金口座、メモ
- 売掛入金確定: 実績入金日、入金額、入金口座
- 買掛: 取引先、発生日、支払予定額、支払予定日、支払口座、メモ
- 買掛支払確定: 実績支払日、支払額、支払口座
- 口座: 口座名、銀行名、種別、現在残高
- 取引先: 取引先名、売掛／買掛／両方
- 設定: GAS Web App URL、会社名

## 主要機能

- 資金繰り取引の予定・実績・差異表示
- 売掛登録と入金確定
- 買掛登録と支払確定
- 口座・取引先マスタ
- ホームの短期予測と遅延／資金不足警告
- 月別・口座別Excel出力
- 固定支出マスタからの月別予定自動生成と休日調整
- GAS未設定時のデモ表示

## データの流れ

1. 画面操作を `assets/app.js` が受け取ります。
2. 参照はGASの `doGet`、保存・削除は `doPost` を呼びます。
3. `main.gs` がアクション名で処理を振り分けます。
4. `spreadsheet.gs` がシート行とJavaScriptオブジェクトを相互変換します。
5. 取得結果をブラウザ内の `APP` にキャッシュし、各画面を再描画します。
6. GAS URL未設定時は同じ形のデモデータを返し、永続化は行いません。

## WFS運用と将来移行方針

現行版はGASとGoogleスプレッドシートで運用します。ただし、二社以上の顧客展開と将来のNode.js移行を前提に、GitHubを正本、Apps Scriptを実行環境、Google Driveをテンプレートと顧客運用実体の保管場所として分離します。

Node.js移行時に困らないよう、ブラウザ側はスプレッドシート行番号へ依存させず、GASの `doGet` / `doPost` は保存先に依存しないAPI境界として扱います。各シートは将来のDBテーブル候補であり、列、ID、状態、生成IDルールは `SCHEMA.md` を正本として管理します。

顧客ごとのコピー、権限、デプロイ、リリース確認は `OPERATIONS.md` を正本とします。

## スプレッドシート構成

### cashflow_transactions

`id, source, sourceId, status, type, partner, description, account, plannedDate, plannedAmount, actualDate, actualAmount, memo, createdAt, updatedAt`

- `source`: `manual` / `receivable` / `payable` / `fixed_expense`
- `status`: 予定 / 一部確定 / 確定 / 取消
- `type`: 入金 / 出金
- 売掛・買掛との対応は `sourceId`、逆方向は各マスタの `cfId`

### receivables

`id, partner, invoiceDate, amount, dueDate, paidAmount, status, cfId, memo, createdAt, updatedAt`

### payables

`id, partner, occDate, amount, dueDate, paidAmount, status, cfId, memo, createdAt, updatedAt`

### accounts

`id, name, bank, type, balance, sort, createdAt, updatedAt`

`balance` は「本日時点の実績残高」として扱われます。取引確定時に自動更新される実装ではありません。

### partners

`id, name, type, createdAt, updatedAt`

### settings

`key, value, updatedAt`。現時点では画面設定の保存には使われておらず、GAS URLと会社名はブラウザの `localStorage` に保存されます。

### fixed_expenses

`id, name, payee, amount, day, startMonth, endMonth, account, holidayRule, memo, active, createdAt, updatedAt`

保存時に開始月〜終了月の資金繰り予定を生成します。生成取引は `source=fixed_expense`、`sourceId=<固定支出ID>`、摘要先頭は `【固定支出】` です。

## 入金予定／支払予定の扱い

売掛を保存すると `receivables` と、`source=receivable` の入金予定取引を並行保存します。買掛も同様に `payables` と `source=payable` の出金予定取引を保存します。入金・支払確定時は累計済額と状態を更新し、対応する資金繰り取引へ実績日・実績金額を設定します。

現状は2シートの更新が単一トランザクションではありません。片方だけ失敗した場合の自動ロールバックはありません。また、売掛・買掛の削除は対応する資金繰り取引を自動削除しないため、孤立データに注意が必要です。

## 固定支出予定の生成

- 生成IDを `fx_<固定支出ID>_<YYYYMM>` に固定してupsertし、再実行時の二重登録を防ぎます。
- 基本日が月末を超える場合は月末日へ丸めます。
- 土日、日本の祝日、振替休日、国民の休日を判定し、翌営業日／前営業日／当日の規則を適用します。
- 編集・削除は今後のみ／全期間を選択できます。確定実績は常に保護します。
- 月表示時は欠けている生成予定だけ補完し、既存の履歴を上書きしません。

## 残高計算の仕組み

### ホーム予測

口座マスタの現在残高合計を起点に、今日より後かつ指定日までの取引を反映します。実績があれば実績、なければ予定を採用し、入金を加算、出金を減算します。

### 日繰り表

口座マスタの現在残高から、表示月の月初〜今日に確定した取引を逆算して月初残高を求めます。その後、表示順に取引を足し引きして口座別残高を表示します。予測モードは実績優先、実績モードは実績のみ、差異モードは予定と実績の差額も表示します。

### 現行ロジックの前提と限界

- 口座残高は別途手動で最新化されている前提です。
- 未来月・過去月の月初残高は、表示月以外の取引を横断取得して補正しません。
- ホームの30日予測は当月取得データのみなので、月をまたぐ将来取引を含まない場合があります。
- `actualAmount` の有無を真偽値で判定する箇所があり、0円実績は「実績なし」扱いです。
- 予定月と実績月が異なる取引は、GASの月抽出条件上、両方の月に返る可能性があります。

## Excel出力の仕組み

`assets/app.js` の `exportCashflowToExcel` が、画面と同じ口座選択・モード・並び順・残高計算を再実行します。月初残高行、取引行、月末予測残高行を作り、SheetJSで `日繰り_YYYY-MM_モード.xlsx` を保存します。SheetJS CDNが読み込めない環境では出力できません。

## 今後改修するときの注意点

- Apps Script内の `.gs` は分割されていても共通名前空間です。関数名・定数名を重複させないでください。
- シート列の追加は `COLUMNS` だけでなく既存シートの移行も必要です。`getOrCreateSheet` は既存シートのヘッダーを自動更新しません。
- `saveRecord` は渡されなかった列を空文字で上書きします。部分更新ではなく、原則として完全なレコードを渡してください。
- 新しいシート、列、状態、生成IDルールを追加するときは `SCHEMA.md` を同時に更新してください。
- Node.js移行前提のため、顧客固有のコード分岐やスプレッドシート行番号に依存する画面処理を追加しないでください。
- 売掛／買掛と資金繰り取引の二重保存には整合性対策が必要です。
- 削除時の関連データ、口座削除時の既存取引参照を確認してください。
- Web公開範囲、GAS URLの共有、スプレッドシート権限を運用前に決めてください。
- HTML内の文字列をそのまま `innerHTML` に入れる箇所が多いため、外部入力を扱う場合はエスケープを追加してください。
- Excel列や残高ロジックを変更するときは、画面表示と出力処理を同時に更新してください。

## 次に固定収入マスタを追加する場合

固定支出と同じ構造を再利用します。主な変更先は新規 `fixedIncome.gs`、`main.gs`、`assets/app.js`、`index.html` です。休日判定は `holiday.gs` をそのまま共用し、生成元は `source=fixed_income`、取引区分は入金とします。
