# SCHEMA

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

- `source`: `manual`, `receivable`, `payable`, `fixed_expense`
- `status`: `予定`, `一部確定`, `確定`, `取消`
- `type`: `入金`, `出金`
- `sourceId` links to the originating record when applicable.
- Fixed expense generated IDs use `fx_<fixedExpenseId>_<YYYYMM>`.

### receivables

Accounts receivable table.

Fields:

`id, partner, invoiceDate, amount, dueDate, paidAmount, status, cfId, memo, createdAt, updatedAt`

Rules:

- `cfId` links to the generated cashflow transaction.
- Saving a receivable should create or update the linked `cashflow_transactions` record.
- Payment confirmation should update both receivable status and the linked cashflow transaction.

### payables

Accounts payable table.

Fields:

`id, partner, occDate, amount, dueDate, paidAmount, status, cfId, memo, createdAt, updatedAt`

Rules:

- `cfId` links to the generated cashflow transaction.
- Saving a payable should create or update the linked `cashflow_transactions` record.
- Payment confirmation should update both payable status and the linked cashflow transaction.

### accounts

Bank account and cash account master.

Fields:

`id, name, bank, type, balance, sort, createdAt, updatedAt`

Rules:

- `balance` is treated as the current actual balance maintained by operation.
- Balance update automation must be designed explicitly before implementation.

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

