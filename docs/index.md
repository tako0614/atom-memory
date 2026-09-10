---
layout: home
hero:
  name: Atom Memory
  text: 記憶を小さく。<br>関係を失わずに。
  tagline: 情報も、まとまりも、所属も Atom。出典と不変の版を保ちながら、有限の read と小さな write で扱う TypeScript ライブラリです。
  actions:
    - theme: brand
      text: 使いはじめる
      link: /guide
    - theme: alt
      text: 設計を読む
      link: /concepts
features:
  - title: 一つのモデル
    details: 原資料、抽出、集合、所属を同じ Atom で表現。要素の追加で親や全祖先を書き換える必要はありません。
  - title: 出典まで戻れる
    details: 不変の版、UTF-8 の出典座標、ホストが記録する読取履歴。生成要約と原資料を区別します。
  - title: 有限の操作
    details: 候補数、本文 bytes、モデル呼出し、tokens を制限。途中結果と継続、索引遅延を明示して返します。
---

## 二つの操作から始める

```sh
npm install atom-memory
```

<div class="atom-model">
  <div class="box"><small>READ</small><strong>文脈に必要な版を読む</strong><p>既知 ID、役割付き関係、語彙・ベクトルから探し、出典と読取状態を持ち帰る。</p></div>
  <div class="arrow" aria-hidden="true">⇄</div>
  <div class="box"><small>WRITE</small><strong>小さな差分を確定する</strong><p>期待する版、権限、参照、出典を検証して、有限バッチを一度に受理する。</p></div>
</div>

**v0.1.0 は Node.js 向けのローカル参照実装です。** メモリ上と SQLite の保存、共通ハーネス、交換可能なモデル・tokenizer 契約を含みます。分散ストレージや検索品質の実証は、[今後の評価範囲](/release#実装と評価の境界)です。
