# OPERATIONS

## 0.6.3 通知（本番未反映）

既存n8nに新規ワークフローだけを追加する。停止は画面の通知OFFまたは当該ワークフロー無効化。送信失敗・日跨ぎ・バックアップ復元時の手順は [通知設定](docs/direct-debit-notifications.md) を参照。

## 0.6.1 配備

期限超過修正はcashflow-webと専用backupだけを更新。既存予定日・状態・金額の一括補正は行わない。反映前後に整合バックアップ、業務テーブルの内容一致、起動・元予定日表示を確認する。schema4のままだが、新しい個別例外を旧版は理解しないため、運用後のコードだけの切戻しは不可。以下の旧版移行手順は各版の履歴。

## Node.js 0.5.0 配備・復旧

仕様と制約は [予定表仕様](docs/payment-schedules-050.md)。本番反映には資金繰り `cashflow-web` と専用 `backup` の2サービスの入替が必要。停止・再作成前の報告が指定されているため、実行前にこの2サービスと短時間の利用中断を説明し承認を得る。他サービス・Caddy・ネットワーク・ボリュームを再作成しない。`compose down` は使用しない。

更新直前に旧版の整合バックアップを取得し、保持整理の対象外へ複製する。固定NODE_IMAGEで作成した新版を使い、ネットワークなし・本番DBマウントなしの一時コンテナで復元・schema3更新・旧行維持を検証する。

承認後は入力を止めて最終バックアップを再取得。専用backupを停止し、cashflow-webを新版で入替。health/認証/既存データ維持を確認してbackupも新版へ入替、新版バックアップを確認。他サービスのID・状態を前後比較する。

旧0.4.0はschema3を読めない。戻す場合は更新後DBを退避し、更新前バックアップを旧版restoreで空の復元先へ復元。停止中に資金繰りDBのみ切り替え、旧イメージで2サービスを戻す。更新後入力は自動破棄せず差分を確認する。稼働中DBの置換やバックアップ原本の上書きは禁止。

Excel265件移行、テスト残高消去、新口座追加はこの配備に含めない。

> 2026-09-24: VPS版では `docs/vps-implementation.md` の専用コンテナ・認証・毎時Backup API・世代管理・復元手順を優先する。共通Google Driveバックアップは後続作業。下記のGAS運用とは区別する。

> 2026-09-18：修正候補はローカル検証中。本番未反映。導入時は更新済みSETUP.mdとdocs/migration-assessment.mdを優先する。

## Purpose

This document defines the standard WFS operation for the cashflow app while it still runs on Google Apps Script and Google Sheets.

The current goal is to deploy quickly for multiple companies without making a later migration to a Node.js API and database difficult.

## WFS Roles

| Place | Role |
|---|---|
| SSD | Development, fixes, review, and test work only. |
| GitHub | Source of truth for code, design, README_AI, setup, operations, and history. |
| Google Drive Templates | Master operational template for customer copies. Templates are not used directly. |
| Google Drive Customers | Customer-specific operational spreadsheets and delivery files. |
| Apps Script | Runtime for the GitHub-managed GAS backend. It is not the source of truth. |
| Google Sheets | Customer-specific data store during the GAS phase. |

## Current Standard Flow

```text
GitHub
↓ clone to SSD
Review / fix / test
↓ push
Reflect GAS files to Apps Script
↓ deploy Web App
Update Google Drive template if needed
↓ copy template
Create customer environment
```

## Source of Truth

GitHub is the source of truth for:

- HTML, CSS, and browser JavaScript
- Apps Script backend files
- data schema and behavior rules
- setup and operations documents
- change history

Apps Script must be treated as a deployment target. If a production fix is made directly in Apps Script, the same change must be brought back to GitHub before the next release.

## Customer Folder Standard

```text
WellzFriend
├── Templates
│   └── Cashflow App
│       └── TPL_資金繰り_v0.1
└── Customers
    ├── CompanyA
    │   └── CompanyA_資金繰り
    └── CompanyB
        └── CompanyB_資金繰り
```

Use the real company name in Google Drive. Do not commit real customer names, Spreadsheet IDs, GAS URLs, account names, balances, or transaction data to GitHub.

## New Customer Setup

1. Copy the approved template from `WellzFriend/Templates/Cashflow App`.
2. Move the copied spreadsheet to `WellzFriend/Customers/<company>/`.
3. Rename it to `<company>_資金繰り`.
4. Create or open the customer Apps Script project.
5. Reflect the repository `.gs` files into Apps Script:
   - `main.gs`
   - `spreadsheet.gs`
   - `ledger.gs`
   - `transactions.gs`
   - `setup.gs`
   - `holiday.gs`
   - `fixedExpense.gs`
6. Reflect `appsscript.json`, enable the advanced Sheets service, and set the `SPREADSHEET_ID` script property.
7. Run `setupSpreadsheet` once.
8. Deploy Apps Script as a Web App.
9. Open the frontend and set:
   - GAS Web App URL
   - company display name
10. Confirm connection and core screens:
    - accounts
    - partners
    - cashflow transactions
    - receivables
    - payables
    - fixed expenses
    - Excel export

## Customer Setup Rules

- One customer spreadsheet per customer environment.
- One Apps Script deployment per customer environment unless a shared multi-tenant backend is explicitly designed later.
- Spreadsheet IDs and deployment URLs are operational settings, not repository content.
- Initial balances must be entered by the operator or customer approver.
- Customer-specific permissions must be reviewed before operation starts.

## Node.js Migration Guardrails

During the GAS phase, keep future Node.js migration easy by following these rules:

- Treat each sheet as a future database table.
- Keep stable IDs in every record.
- Keep `createdAt` and `updatedAt` as ISO-like strings.
- Keep API actions storage-neutral; do not expose spreadsheet row numbers to the browser.
- Avoid adding business logic directly to spreadsheet formulas.
- Document every new sheet, column, enum, and generated ID rule in `PROJECT.md`.
- When a workflow updates multiple records, document the consistency rule even if GAS cannot make it fully transactional yet.
- Do not make customer-specific branches or customer-specific code files.

## Future Node.js Mapping

| GAS phase | Node.js phase |
|---|---|
| Apps Script Web App | Node.js API |
| `doGet` / `doPost` actions | HTTP routes or RPC handlers |
| Google Sheets | SQLite or PostgreSQL |
| sheet names | database tables |
| `spreadsheet.gs` | repository/data-access layer |
| `setupSpreadsheet` | migration and seed scripts |
| Google Drive customer copies | customer environment provisioning |

## Release Checklist

Before a release:

- GitHub has the latest code and docs.
- `README_AI.md`, `PROJECT.md`, `SETUP.md`, and `CHANGELOG.md` are updated when behavior changes.
- Apps Script has the same `.gs` content as GitHub.
- Template spreadsheet changes are intentional and documented.
- No customer data or secrets are committed.
- A test customer copy has passed setup and core screen checks.


## Prelaunch correction operations

Use an empty customer environment; do not treat old paid records as automatically migrated. Every real account needs an operator-confirmed closing balance and balanceDate. Do not insert fictional accounts into operation.

Choose authentication, access scope and hosting before production. The current API is not a standalone access-control system. Google updates rely on a single Sheets batch and one GAS project's lock; other scripts and manual sheet edits are outside that lock.

Backup, retention, monitoring and restore proposals are in docs/migration-assessment.md. None are installed by this clone. Monthly Excel export is not a full backup. Test a complete restore before operation.
