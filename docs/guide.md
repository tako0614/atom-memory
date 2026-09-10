# はじめる

Atom Memory は Node.js 22.13 以降の ESM ライブラリです。ランタイム依存パッケージはありません。

```sh
npm install atom-memory
```

## 最初の read / write

この例はリポジトリの `npm run example` で実行できます。

<<< ../examples/basic.mjs

`LocalAuthority` はホストが持つ権限管理です。認証済みの利用者を確認した後にハンドルを発行してください。モデルや HTTP リクエストから `issue()` を自由に呼べるようにしないでください。

`canIngestSource` は原資料として記録する権限です。Writer が生成した内容には `organization`、`extraction`、`derived` などの区分を使います。ハーネスは入力を読んだ receipt を差分へ付け、生成物を `source` と申告する操作を拒否します。

## SQLite に保存する

```ts
import { AtomKernel, LocalAuthority } from 'atom-memory';
import { SqliteStorage } from 'atom-memory/sqlite';

const storage = new SqliteStorage('./memory.sqlite');
const authority = new LocalAuthority();
const memory = new AtomKernel({ storage, authority });

// read / write は同じ API
// 終了時:
storage.close();
```

SQLite は版、読取 receipt、cursor、冪等キー、blob、埋め込みを永続化します。`LocalAuthority` のハンドルはプロセス内の権限です。再起動をまたぐ認証は、アプリ側の `Authorizer` を実装してください。永続化した DB に、権限自体が自動的に付与されることはありません。

## 次に読む

- [Atom と関係](/concepts)：所属・固定構成・改訂の違い
- [read / write](/api)：ページ、予算、競合、出典
- [Writer と共通ハーネス](/runtime)：一時差分からホストの承認を経て確定
