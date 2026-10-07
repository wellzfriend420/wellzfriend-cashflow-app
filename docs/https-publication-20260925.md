# 本番HTTPS公開（2026-09-25）

公開URL：https://cashflow.wellzfriend.com
アプリ0.4.0・SQLiteスキーマv2を維持。アプリコード・認証情報・業務データの変更なし。

## 実施内容

- 利用者がAレコードcashflow → 85.131.245.115、TTL3600を追加。権威DNSと通常の名前解決で反映を確認。
- PUBLIC_ORIGINをhttps://cashflow.wellzfriend.comに設定。
- 既存の受注アプリがedgeネットワーク上でappという名前を使うため、資金繰りComposeのサービス名だけcashflow-webへ変更。edgeを外部ネットワークとして参照し、専用privateネットワークも維持。既存サービスのネットワークやComposeは変更しない。
- 新コンテナ：wfs-cashflow-cashflow-web-1。旧wfs-cashflow-app-1は停止状態で保全。新旧を同時に起動しない。backupコンテナは再作成・停止していない。
- /opt/enchan-n8n/Caddyfileへcashflowサイトだけを追記。既存部分はバイト単位で不変。構文検証後、caddy reloadで反映。Caddyコンテナの再作成・再起動なし。
- ホストの3310番は127.0.0.1に限定したまま。HTTPS経由以外のインターネット公開ポートを追加していない。

追加サイト：

```caddyfile
cashflow.wellzfriend.com {
    encode zstd gzip
    reverse_proxy cashflow-web:3000
    header -Server
    log {
        output stdout
        format json
    }
}
```

## 検証結果

- VPS外から証明書検証付きHTTPS接続に成功。ルート303→ログイン画面200、health 200/status ok、HTTPは308でHTTPSへ転送。
- TLS1.3、Let's Encrypt YE2、SAN cashflow.wellzfriend.com。有効期限2026-12-23 22:37:48 UTC。Caddyの通常の自動証明書管理を使用。更新処理そのものの実行試験ではない。
- 未認証業務APIは401、不一致OriginのログインPOSTは403。
- ローカル自動テスト83件成功。追加HTTPS設定テストで__Host- Cookie、Secure、HttpOnly、SameSite=Strict、Path=/、Domain属性なし、Origin/CSRF拒否、ログイン→ログアウト→再ログイン、旧Cookie名の拒否を一時DB・合成アカウントで確認。TLSの外部接続試験と認証ロジックの隔離試験は別々に実施。
- n8n・PostgreSQL・Caddy・受注／利益管理・資金繰りbackupのコンテナID、起動時刻、稼働状態、healthが変更前後で一致。n8nとwellnotの既存HTTPSサイトは前後とも200。
- 公開後バックアップ成功：cashflow-20260924T233752258Z-23f8e1ef。公開前退避：pre-https-20260925/cashflow-20260924T233341563Z-a980f0a5。

## 実アカウントの確認待ち

管理者パスワードを取得・変更せず、認証を迂回したテスト用セッションも作成していない。利用者に公開URLでログイン→ログアウト→再ログインと、口座・日繰り・売掛／買掛・固定支出・任意年月・Excel出力の確認を依頼済み。本人による確認結果は別途記録する。既存セッションを引き継ぐ前提にしない。

## 保守

今後のCompose操作対象はappではなくcashflow-web。初期管理者作成用PowerShellの対象名も更新（実行はしていない）。127.0.0.1:3310はhealth等の保守確認用として残すが、従来のhttp://127.0.0.1:3310へのブラウザログインはHostチェックとSecure Cookieにより利用できない。公開URLを使う。

変更前Caddyfile、cashflow Compose、env、追加差分、サービス比較、証明書情報はVPSの /opt/wfs/cashflow-releases/https-20260925 に保全。envはVPS内だけ・制限付き権限で保管。戻す場合はcashflow-webを停止し、cashflow専用の旧Compose/envへ戻して旧appを起動する。Caddyは保存した既存部分を復元してvalidate/reload。既存他サービスを停止しない。

## 公開後の実バックアップ復元確認

公開前後の実バックアップを、ネットワークなしの一時コンテナ内へ復元。管理者1名・口座1件と既存業務レコードの維持、元バックアップ無変更、復元DBの整合性・復元アプリhealthを確認。Caddyから既存app名が受注アプリの172.18.0.4だけに解決されることも確認。
