# 自動引落し前日のLINE通知（0.6.3・本番未反映）

- 既存n8nを共用し、送信元LINE公式アカウント・Messaging API資格情報・宛先は会社専用にする。`deployment/n8n-direct-debit.json` は未有効の共通テンプレート。既存ワークフローは変更しない。
- 毎日10:00 JSTに翌日分を1通。対象0件は送信しない。銀行・支店、引落合計、口座別合計を表示。長文時は明細だけを省略し、正しい全体・口座別合計とアプリURLを残す。口座番号は送らない。
- 設定→自動引落しのLINE通知設定で、固定支出・支払予定表単位、通常出金・買掛残予定の個別単位で明示的に指定。既存項目から勝手に推測しない。固定支出／予定表の新しい回も対象。異なる支払方法が混在する予定表は分けて登録する。
- `cashflow_transactions.plannedDate`（固定支出の仮想明細を含む）を使用。休日調整済み日付・個別変更を再調整しない。状態が予定、出金、実績日なし、金額>0のみ。借入の合算／別引落・部分確定は未確定の現行明細だけを合計する。予定日・残高・実績は変更しない。
- 既存settingsへ設定と日別送信記録を保存。schema4のまま、バックアップ・復元対象。1日1バッチを原子的に作成し、送信本文・宛先・再送キーを固定。LINE受付後のackも冪等。同日の追加・変更で2通目を送らない。送信開始後の変更は通知本文へ追記しないため最新状態はアプリで確認する。
- `X-Line-Retry-Key` を初回から指定。タイムアウト等では同日内に同じバッチを再利用。200系または受付済みID付き409だけを受付済みにする。受付は端末への配達・既読を意味しない。翌日へ古いバッチを持ち越さない。

## 承認後のTOOTWO設定

1. TOOTWO専用Composeに共通env3項目を渡す。`DIRECT_DEBIT_NOTIFICATIONS=true`、32〜128文字の専用ランダム `DIRECT_DEBIT_API_TOKEN`、明示確認した `DIRECT_DEBIT_LINE_TARGET`（Uで始まるユーザーIDまたはC/Rのグループ等ID）。秘密値はGitやチャットへ貼らない。他2社はfalse／未設定のまま。
2. n8nへテンプレートを新規インポート。2か所のexample.invalidをTOOTWOの公開HTTPS originへ変更。Prepare/Recordの2つのHTTPノードに同じ新規Header Auth資格情報（Authorization: Bearer 資金繰り専用APIトークン）を指定。LINE pushには別のTOOTWO専用Header Auth資格情報（Authorization: Bearer TOOTWO公式LINEのチャネルアクセストークン）を指定。共有envの `LINE_CHANNEL_ACCESS_TOKEN`、製造管理用 `LINE_MANAGER_USER_ID` およびとらいアンぐるの認証情報・送信元・宛先は使用しない。送信先IDはTOOTWO公式LINEが参加済みのTOOTWO用グループから取得し、チャネルシークレットによる署名検証後に登録する。
3. 画面で通知対象とONを保存し、送信先・対象プレビューを確認してから新規ワークフローだけを有効化する。既存n8nの再作成、PostgreSQL／Caddy変更は不要。
4. n8nの通信障害は最大3回短時間リトライ。LINEのHTTPエラーは受付扱いにせず実行失敗にする。同日内の復旧時はワークフローを先頭から再実行（送信ノード単体の再実行は禁止）。日を越えた古い実行データの再実行は禁止。n8n停止中の10:00実行は現行2.33.3では自動追いつきしないため、その日のうちに手動再実行が必要。通知時刻は通常10:00、障害復旧時のみ遅延。
5. n8n実行データは成功／失敗／手動とも保存OFF（通知本文・送信先を履歴に残さない）。アプリの通知設定には本日の受付状態を表示。復元後は通知ON前に当日の送信状況を確認する。LINE側の再送キー有効期間24時間内は同じ会社origin・日付から同じキーを生成する。

関連テストは合成データ・ローカルHTTP・LINE応答モックのみ。本番LINE実送信／n8nインポートは未実施。

仕様根拠：[LINE再送キー](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/)、[n8n Schedule Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/)。
