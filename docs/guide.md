# はじめる

このページは **v0.2.0** 用です。v0.1とはAPIが異なるため、更新時は[移行手順](/migration)を確認してください。Node.js 22.13以降に対応し、ランタイムの依存パッケージはありません。

```sh
npm install atom-memory@0.2.0
```

リポジトリのサンプルを実行する場合は、checkoutで`npm ci && npm run build`を実行してください。

## ホストを一度設定する

認証主体・保存・書込先の権限・呼出し主体はホストが設定します。通常の操作では分類名や ID を指定しません。

<<< ../examples/basic.mjs

上の実コードは `npm run example` で実行できます。`npm run docs:examples` はドキュメントが参照する主要サンプルを抽出し、型検査して実行します。

`LocalAuthority` の `issue` は認証済み主体に対するホスト操作です。モデルに公開しません。人間の入力は発言として `source` に記録します。外界の真実であると保証する区分ではありません。生成エージェントはホストが `actor: { type: 'agent' }` へ束縛します。

## SQLite

```ts runnable
import { MemoryHost, LocalAuthority } from 'atom-memory';
import { SqliteStorage } from 'atom-memory/sqlite';
const storage = new SqliteStorage(':memory:'); // 永続化時はホストがファイルパスを選ぶ
const authority = new LocalAuthority();
const auth = authority.issue({
  subject: 'example',
  readPolicies: ['private'],
  writePolicies: ['private'],
  canIngestSource: true,
});
const memory = new MemoryHost({ storage, authority }).connect({
  auth,
  writePolicy: 'private',
  actor: { type: 'human' },
});
const saved = await memory.write('分類名と手動IDがなくても保存できる');
console.log((await memory.inspect(saved.ref)).atom.text);
storage.close();
```

SQLite は不変版、出典、ref、cursor、入力manifest、後継記録を保存します。`LocalAuthority` はプロセス内の認証です。再起動をまたぐアプリでは安定した認証ハンドルを解決する `Authorizer` が必要です。保存済みrefも、その時点の閲覧許可を検証します。

次は [API](/api)、[自動readとWriter](/runtime)、[v0.1からの移行](/migration)を参照してください。
