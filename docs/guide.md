---
next:
  text: 短いコードで試す
  link: /examples
---

# Hello, Memory

まずは「コーヒーの好み」を一つ覚えさせてみましょう。文章を保存し、必要な場面で取り出す。それが Atom Memory の基本です。

## 1. インストールする

Node.js 22.13 以降を使います。好きなフォルダーでインストールしてください。

```sh
npm install atom-memory
```

この例はローカルで動きます。モデルや API キーの設定は必要ありません。

## 2. ファイルを用意する

同じフォルダーに、次の二つのファイルを保存します。`hello.mjs` がアプリの処理、`memory.mjs` が一度だけ行う初期化です。

::: code-group

<<< ../examples/hello.mjs

<<< ../examples/memory.mjs

:::

`write` で好みを保存し、`read` に今の文脈を渡しています。保存先や書き手の設定は `memory.mjs` にまとまっています。設定を変えたくなったら [ホストの設定](/setup)へ進めます。

## 3. 動かす

```sh
node hello.mjs
```

すると、保存した記憶が返ります。

```text output:hello.mjs
コーヒーはブラックが好き。
```

これで、文脈に合わせて情報を取り出せました。この例では確認のために本文だけを表示しています。モデルへ渡すときは、参照や出典も含んだ `recalled.text` を参考資料に使います。

## もう少し、使ってみよう

候補を一覧で見たいときは `search`。情報が変わったら `edit`。どちらも同じ `memory` を使えます。

<div class="doc-paths">
<a href="/examples"><strong>短いコードで試す <span aria-hidden="true">→</span></strong><span>検索、訂正、条件付きの記憶。</span></a>
<a href="/runtime"><strong>エージェントにつなぐ <span aria-hidden="true">→</span></strong><span>モデルを呼ぶたび、自動で記憶を選ぶ。</span></a>
</div>

この例の記憶はプロセス内に保存されます。終了後も残すなら [SQLite](/adapters#sqlite-に保存する)を設定してください。
