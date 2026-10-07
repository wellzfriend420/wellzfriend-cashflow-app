# セットアップ（本番未反映の修正候補）

## 現行版 0.6.1

正本のNode/VPS実装を使用。新規の依存追加・既存schema4の構造移行なし。旧GASセットアップは履歴であり現行VPSへ実行しない。

## Node.js 0.5.0

既存VPS・認証・公開URL・DBパスを引き継ぐ。追加依存や外部サービスは不要。`node --test tests/*.test.cjs` 後、既存の固定Node24イメージで配備する。schema2→3は起動時更新なのでバックアップと隔離復元検証を先に実施。配備・旧版復帰は [OPERATIONS](OPERATIONS.md)、入力方法は [予定表仕様](docs/payment-schedules-050.md)。

> 2026-09-24: VPS版の新規セットアップは `docs/vps-implementation.md` に従う。下記は旧GAS版の記録。VPS版でGAS公開やスプレッドシート設定を実施しない。

運用先を決定してから実施する。この文書の更新は本番配備の完了を意味しない。

## ローカル検証

- Node.jsで node --test tests/ledger.test.cjs tests/cashflow.test.cjs。
- 画面は node tools/preview.cjs で127.0.0.1:8769に開く。
- 画面の接続先を同じサーバーの /api に設定すると合成データを操作できる。データはメモリー内のみで、終了時に失われる。本番利用は禁止。

## Google構成を選択する場合

1. 運用先専用の空ブックを準備する。親テンプレートをコピーする場合は、コピー側のサンプル口座等を確認して整理する。実データを一括削除しない。
2. GASへmain.gs、spreadsheet.gs、ledger.gs、transactions.gs、setup.gs、holiday.gs、fixedExpense.gsの7ファイルとappsscript.jsonを反映する。
3. スクリプトプロパティSPREADSHEET_IDに運用先を設定。ソースにはIDを埋め込まない。
4. 高度なGoogle Sheetsサービスを有効化。標準Cloudプロジェクトの場合はSheets APIの有効化も確認する。manifestは日本時間と必要スコープを指定している。
5. setupSpreadsheetを明示実行する。7シートの列と日本時間を設定する。架空口座は作らない。列が異なる既存データがあれば停止するので、個別の移行確認を行う。
6. 利用者・認証・画面配信方式を決める。匿名で全員に公開しない。Google認証付きGASと別オリジンの画面の組合せでは、単にURLを設定するだけでは動作しないことがある。GASからの画面配信などを検証する。
7. 合成データの専用テスト環境で保存・更新・削除・再送・一括更新失敗・Excelを検証する。実Google APIの原子性・認証・エラー応答を含む確認はまだ未実施。
8. 実口座を登録し、利用者確認済みの基準日終了残高を入力。初期売掛・買掛残と固定支出も確認する。
9. バックアップと復元を検証した後に運用開始する。

ブラウザー設定はURLと会社名。日繰りExcelは表示月・選択口座の帳票であり、全データのバックアップではない。

## VPS構成を選択する場合

移行対象・SQLite/PostgreSQL・残工数・バックアップ案は [移行調査](docs/migration-assessment.md) を参照。Node.jsバックエンド、DB、認証、本番用配備定義は今回まだ作成していない。
