# OPERATIONS

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
   - `transactions.gs`
   - `setup.gs`
   - `holiday.gs`
   - `fixedExpense.gs`
6. Set `SPREADSHEET_ID` in `main.gs` to the customer spreadsheet ID.
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

