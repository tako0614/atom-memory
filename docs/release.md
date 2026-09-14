# リリース

0.10候補の活性に基づく関係探索は、[比較試験](/acquisition)まで実装しました。今回の方式は採用条件を満たさず、安定版は0.9.0を維持しています。研究コードの追加をnpm 0.10公開と扱いません。

v0.9.0では、公開書き込みAPIを宣言的な `write({ changes })` batchへ統一しました。`create`、`revise`、`retire` を同じatomic planへまとめ、batch-local link、host-issued InputToken、idempotency replay、retireのraw body保持を扱います。`inspect` は一-hopの隣接を `direction`、`roles`、`limit`、cursorで取得し、`read` / `search` のdepthとは分離しています。

現在の意味の正本は[規範仕様](/specification)、v0.8からの置換手順は[移行](/migration)、型の対応は[TypeScript](/contracts)です。npmのversion、integrity、対応commit、公開状態は生成される[公開manifest](/release.json)と検証記録で確認し、このページから公開済みやデプロイ済みとは推測しません。

## 0.9.0の契約変更

- `MemoryAPI` は `read` / `search` / `inspect` / `write` の四つ。v0.8の `edit`、`Draft`、`EditOutcome` は公開APIに残しません。
- `MemoryContent` は `{ text, links }` で、create/reviseの `sources` とともに完全置換です。省略や文字列contentは受け付けません。
- 各changeは `id` と `op` を持ち、revise/retireの `target` は観測refです。local linkはchange idだけを指し、循環・多重所属を許可します。
- agent changeにはhost-issued `InputToken` を要求し、human / input-adapterのsource writeはtokenを省略できます。初回の期限切れtokenは拒否しますが、commit済みplanの一致replayはtoken期限切れ後も結果を回収できます。
- `WriteOutcome` は `operationId`、`repeated`、`indexing`、change idごとの `changes` を返します。planを変えた同一idempotencyKeyはconflictです。
- `retire` は本文、links、sources、originsを保存したままstateだけをretiredへ変えます。inspectはrootと一-hop neighborを返します。

## 検証の読み方

`npm run check`、`npm run docs:examples`、`npm run docs:build`、`test/v09.test.mjs` などの決定的な検証は、保存・認可・atomicity・cursor・依存・索引境界を対象にします。ランキング出力は `validation/ranking-v0.9.0.json` と `validation/selection-v0.9.0.json` へ分け、`validation/v0.8.0.md` と旧JSONはその版の履歴として残します。

固定fixture、proxy utility、研究用embedding、隣接アプリのcheckは、意味品質、実LLMの回答品質、全コーパスの網羅、一般的最適性、performance、課金額を証明しません。新しい実LLM評価や本番Sakana反映を行ったとは記載しません。

```sh
npm ci
npm run check
npm run docs:examples
npm run docs:build
npm pack
```

これらはソースリポジトリで実行する検証手順です。npm公開、サイトデプロイ、利用者DBの消去は別の明示的な操作と読戻しが必要です。過去v0.7の公開記録は履歴として[検証記録](https://github.com/tako0614/atom-memory/blob/main/validation/release-v0.7.0.json)に保持します。
