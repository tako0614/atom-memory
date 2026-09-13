# リリース

**atom-memory 0.7.0をnpmへ公開しました。** 利用の頻度と間隔を扱う `adaptiveUse()` と、状態の更新・評価を差し替える `AvailabilityModel` を追加しました。本文・関係・版・出典を保持し、既存の活性伝播と評価予算をそのまま使います。

npmのバージョン・integrity・対応commitは[公開manifest](/release.json)、サイトのデプロイと読戻しは[0.7.0の公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.7.0.json)で確認できます。設定変更は[移行](/migration)を参照してください。

## 0.7の変更

- 標準モデルは、利用されるたびに現在の想起しやすさを上げ、間隔を空けた再利用で半減期を伸ばします。初期7日・最大365日は工学的な既定値で、脳の再現や最適値という主張ではありません。
- `activation.model` で同期的な `update` / `value` を選べます。状態はJSON 1 KiB以下、値は非負有限です。ライブラリが時刻、主体・policy・revisionの隔離、重複抑止、原子的な保存を扱います。
- モデルは利用による初期活性の増幅だけに関与します。埋め込み80%・語彙20%の本文一致と、一つの活性伝播規則は維持します。古さを理由に本文一致そのものを減衰させません。
- 0.6の利用状態はreadや再送で書き換えず、次の新しい利用イベントで移行します。旧半減期が新しい上限を超えていても短くしません。モデルIDを変える場合は対象scopeの `resetUse` が必要です。

`read` / `search` だけでは利用を加算しません。アプリが実際にモデルへ渡した記憶を、成功応答後にホストへ通知します。モデル実行・Writer・ジョブ・費用管理は引き続きアプリ側です。Schur合成は研究用で、既定の検索経路には含めません。

## 検証

155件のテスト、16件の研究用テスト、16件の実行可能なドキュメント例と7件の出力照合が合格しました。Node 22・24のCIと、梱包したtarballおよび空キャッシュからのnpmインストールで、ESM・TypeScript・SQLite・独自モデル・状態の失効とリセットを確認しています。

公開済み0.6.0からの移行試験では、3件の版と観測ref、3件のv3ベクトルを保持し、切替時の利用スコア差は0でした。リセット済み状態の再送による復活、旧半減期の短縮、readによる状態の書換えはありません。0.5.1・0.4.0からの移行試験も通っています。

```sh
npm ci
npm run check
npm run example
npm run example:writer
npm run example:history
npm run format:check
ATOM_V06_PACKAGE=/path/to/published-0.6.0-package node scripts/check-v06-migration.mjs
npm pack
```

これらはソースリポジトリで実行する検証です。移行スクリプトは一時SQLite fixtureを使い、利用者の既存DBを書き換えません。数値誤差の保証は取得済みの固定グラフを対象とし、全資料の検索完全性や実モデルの回答品質・費用削減を示すものではありません。

## Sakanaと公開範囲

Sakanaのソースは、自動想起を現在の可視文脈へ合わせ、`memory_focus` を次の成功したモデル要求への補助情報として扱う形に更新しました。全体のprecheckと、通信失敗・再開・利用通知の重複抑止を確認しています。**稼働中Botへの本番反映は、このリリースに含めません。**

過去の実測は、[0.6.0](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.6.0.json)・[0.5.1](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.5.1.json)・[0.5.0](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.5.0.json)の記録に保持しています。
