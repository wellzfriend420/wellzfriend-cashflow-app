# WellzFriend Cashflow App

2026-09-25：口座管理を銀行名・支店名・種別・文字列の口座番号へ変更し、VPSへ反映済み。[変更・検証記録](docs/accounts-verification-20260925.md)を参照。

## VPS版（2026-09-24）

Node.js 24 / 専用SQLiteへの移植版です。最新の構成・初期設定・バックアップ・復元手順は [VPS実装・運用計画](docs/vps-implementation.md) を参照してください。以下のGAS向け記述は旧版の資料です。既存サービスや共有Caddyは変更せず、独立配置から検証します。

日々の入出金予定と実績、売掛・買掛、口座残高を確認し、短期の資金繰りを把握するためのブラウザアプリです。

## 修正候補の状況

2026-09-18時点で本番未反映です。[Google/VPS移行調査](docs/migration-assessment.md)と[検証記録](docs/verification.md)を確認してください。

## 正本

- ソースコード、設計、変更履歴: このGitHubリポジトリ
- Googleスプレッドシートの実体: Google Drive
- 業務データ: 利用会社の承認済みデータ保存先
- ローカル: 開発・テスト・検証用の一時作業環境

Googleスプレッドシート本体、顧客・業務データ、GAS URL、スプレッドシートID、認証情報、秘密値はコミットしません。

## 文書

- [詳細設計・現行仕様](PROJECT.md)
- [導入手順](SETUP.md)
- [WFS運用手順](OPERATIONS.md)
- [データ契約](SCHEMA.md)
- [変更履歴](CHANGELOG.md)
- [改善候補](TODO.md)
- [将来構想](IDEAS.md)
- [AI向け作業指示](README_AI.md)

## 構成

- `index.html`: 画面構造
- `assets/`: UIスタイルとクライアント処理
- `*.gs`: Google Apps Scriptバックエンド

詳細な機能、データ構造、既知の制約は `PROJECT.md` を正本とします。
WFS上の運用、顧客展開、将来のNode.js移行に備えるルールは `OPERATIONS.md` と `SCHEMA.md` を正本とします。
