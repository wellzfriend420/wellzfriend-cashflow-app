# WellzFriend Cashflow App

日々の入出金予定と実績、売掛・買掛、口座残高を確認し、短期の資金繰りを把握するためのブラウザアプリです。

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
