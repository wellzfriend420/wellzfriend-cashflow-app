# SCHEMA

## SQLite schema4 / Node.js 0.6.1

構造移行なし。既存settings内のpending_history_（変更前後・操作者・時刻）、pending_cancel_（売掛買掛残予定取消）、pending_leg_override_（予定表の個別例外）、pending_request_（再送防止）を保存。固定支出の個別変更・取消は再生成で戻さない。残予定取消は既払額を保持し、実績として扱わない。

## SQLite schema3 / Node.js 0.5.0

`payment_schedules`, `payment_schedule_occurrences`, `payment_schedule_legs` を追加。取引sourceに `payment_schedule` を追加。借入基準5項目、元本／利息、各回の方式スナップショットと例外、銀行明細リンクと実績内訳を保持。各列・制約・ID生成・状態計算は [仕様](docs/payment-schedules-050.md)、DDLは `src/schedule-schema.cjs`。schema2の既存行は維持。旧コードへは更新前DBの復元が必要。以下は旧GAS設計を含む。

## VPS SQLite v2（2026-09-25）

accountsの`name`を廃止。`bank`（銀行名・必須）、`branch`（支店名・任意）、`type`（種別）、`accountNumber`（口座番号・任意）を独立して保存する。口座番号はTEXTで、APIでも数値型を拒否する。画面はテキスト入力＋数字キーボード、半角数字32桁以内。先頭0を保持する。表示名はbankとbranchを空白で連結し、口座番号は編集画面で確認する。

ID・残高・残高基準日・取引からの口座ID参照は維持。user_version=1から2への一度だけの移行では、bankを優先し、空なら旧nameを銀行名欄に引き継ぐ。branch/accountNumberは未設定で追加し、name列を削除する。API／画面に旧name互換処理は残さない。既存認証テーブルを初期化しない。

新規バックアップはv2。v1バックアップも検査後、空の復元先だけをv2へ移行して復元できる。元バックアップは変更しない。v2 DBを旧アプリで開くことは禁止（旧版のスキーマ版チェックで拒否）。

## VPS SQLite v1（2026-09-24）

業務7テーブルの列名とIDを維持し、`src/contract.cjs` に契約を固定。`src/storage.cjs` がSTRICTテーブル、整数円、口座外部キー、売掛／買掛cfIdの遅延外部キー、日付検索インデックスを作成する。空文字の未設定値はSQL NULLへ統一。createdAt/updatedAtはサーバー生成。

追加テーブル: `users`（管理者・scryptハッシュ）、`sessions`（トークンハッシュ・CSRF・期限）、`login_attempts`（試行数・期間）、`audit_events`（操作者ID・操作名・対象ID・日時。業務本文なし）。`PRAGMA user_version=1`。未来版のDBを旧アプリで開くことは拒否する。会社名はsettingsに保存し、端末ローカルには保存しない。旧スプレッドシートからの自動移行は行わない。

> 2026-09-18：準備用cloneの修正契約。本番未反映。旧版の実データは自動移行しない。

## Purpose

This file defines the storage-neutral data contract for the cashflow app.

During the GAS phase these contracts are implemented as Google Sheets. In a future Node.js phase, each sheet should become a database table with the same logical fields.

## General Rules

- Every business record must have a stable `id`.
- `createdAt` and `updatedAt` are required for records created by the app.
- Dates use `YYYY-MM-DD`.
- Months use `YYYY-MM`.
- Amounts are numeric yen values.
- Empty optional values may be stored as blank cells in Sheets, but API responses should expose them as `null` where possible.
- Browser code must not depend on spreadsheet row numbers.
- Generated IDs must be deterministic when duplicate prevention is required.

## Tables

### cashflow_transactions

Primary cashflow movement table.

Fields:

`id, source, sourceId, status, type, partner, description, account, plannedDate, plannedAmount, actualDate, actualAmount, memo, createdAt, updatedAt`

Rules:

- `source`: `manual`, `receivable`, `payable`, `fixed_expense`, `receivable_payment`, `payable_payment`
- `status`: `予定`, `確定`, `取消`, `完了` (旧 `一部確定` は移行確認が必要)
- `type`: `入金`, `出金`
- `sourceId` links to the originating record when applicable.
- Fixed expense generated IDs use `fx_<fixedExpenseId>_<YYYYMM>`.

### receivables

Accounts receivable table.

Fields:

`id, partner, invoiceDate, amount, dueDate, paidAmount, status, cfId, memo, createdAt, updatedAt, account`

Rules:

- `cfId` links to the generated cashflow transaction.
- Saving a receivable should create or update the linked `cashflow_transactions` record.
- Payment confirmation should update both receivable status and the linked cashflow transaction.

### payables

Accounts payable table.

Fields:

`id, partner, occDate, amount, dueDate, paidAmount, status, cfId, memo, createdAt, updatedAt, account`

Rules:

- `cfId` links to the generated cashflow transaction.
- Saving a payable should create or update the linked `cashflow_transactions` record.
- Payment confirmation should update both payable status and the linked cashflow transaction.

### accounts

Bank account and cash account master.

Fields:

`id, name, bank, type, balance, sort, createdAt, updatedAt, balanceDate`

Rules:

- `balance` is the closing actual balance at `balanceDate` (YYYY-MM-DD, JST).
- Reconstruct other dates using confirmed movements after/before that snapshot; do not mutate the snapshot on each payment.
- A missing balanceDate requires operator input; never guess it.

### partners

Partner master.

Fields:

`id, name, type, createdAt, updatedAt`

Rules:

- `type` describes receivable/payable usage.
- Partner names may be customer data and must not be committed as sample data unless synthetic.

### settings

Future server-side settings table.

Fields:

`key, value, updatedAt`

Rules:

- Current browser settings such as GAS URL and company name are stored in `localStorage`.
- Secrets must not be stored here.

### fixed_expenses

Fixed expense master.

Fields:

`id, name, payee, amount, day, startMonth, endMonth, account, holidayRule, memo, active, createdAt, updatedAt`

Rules:

- `holidayRule`: `next`, `previous`, `none`
- Generated cashflow transactions must not overwrite confirmed actual records.
- Generated transaction IDs must stay deterministic.

## Migration Notes

When moving to Node.js:

- Preserve existing IDs.
- Import each sheet as a table.
- Add database constraints after data cleanup, not before.
- Replace spreadsheet upsert with transactional service methods.
- Keep API response shapes compatible with the browser until the frontend is intentionally revised.


## 2026-09 correction contracts

- receivables/payables.account is the scheduled account. Actual installments can use different accounts.
- cfId points to the remaining scheduled movement (amount minus paidAmount). At zero remaining it has status 完了 and is excluded from projections.
- Each installment is a separate cashflow row with source receivable_payment/payable_payment, sourceId equal to its debt ID and ID pay_<paymentId>.
- A retried paymentId with the same payload is a no-op. Reuse with different payload fails.
- Confirmation updates debt total, payment history and remaining schedule in one transaction.
- Existing rows require expectedUpdatedAt to match. Omitted fields are preserved; createdAt remains stable.
- Confirmed movements cannot be edited or deleted through the generic endpoint. Refund/correction workflows are not implemented.
- Amounts are safe integer yen. Actual dates cannot be future dates. Manual zero actuals are supported.
- VPS implementations must preserve these contracts and enforce the payment ID uniqueness in the database.
