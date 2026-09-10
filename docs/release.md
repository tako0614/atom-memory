# v0.2.0 の実装と公開

v0.2.0は、基準commit`0c5a5aeb29b1a11195cb74d562f00c5dd6edec15`からのAPI再設計です。新規利用は`npm install atom-memory@0.2.0`、v0.1からの更新は[移行手順](/migration)を使ってください。旧版を上書きせず、新しい版として提供します。

新しい公開クライアント、自動readによる記憶置換、任意の関係探索、自動参照とCAS、private edit、出典パッキング、失効時の原資料への復帰・明示生成器、旧構成manifestと後継採用をローカルで実装しています。実装・検証範囲は[受入試験](/acceptance)と[検証記録](https://github.com/tako0614/atom-memory/blob/main/validation/README.md)に記録しています。

決定的mock、ローカル検索・隣接数・競合の測定、実LLMによる合成資料の試験は別々に報告します。分散保存、分散検索、ANN品質、一般的なタスク成功率や研究上の新規性をこの版の達成事項に含みません。

## 検証と公開手順

```sh
npm ci
npm run check
npm run example
npm run example:writer
npm run evaluate
npm pack
```

生成したtarballを空のプロジェクトへインストールし、rootとSQLiteの公開export・型・自動readを確認します。検証した同じtarballをnpmへ公開し、registryから再インストールして検証します。サイトはリポジトリの`wrangler.jsonc`を使い、`wrangler deploy --dry-run`の後に`npm run docs:deploy`で公開します。独自のCloudflareアップロード経路は使いません。

npmの版・integrity、GitHub commit/tag、Wrangler deploymentと公開URLの読戻し結果は[公開記録](https://github.com/tako0614/atom-memory/blob/main/validation/release.json)に残します。公開は通常のcheckには含めません。既存データの消去も行いません。

歴史上のv0.1.0は元の最終設計v1.0に基づく版です。原仕様を保存した`spec/`のうち、二操作APIとschema依存の探索はv0.2要求に置き換わります。
