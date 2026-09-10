---
layout: home
hero:
  name: Atom Memory
  text: 記憶を小さく。<br>関係を失わずに。
  tagline: 情報も、まとまりも、所属も Atom。出典と不変の版を保ちながら、自動のreadと内容・関係の編集 で扱う TypeScript ライブラリです。
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

## 分類名と手動IDを要求しない

`write(content)`で保存し、`search(query)`で探し、`inspect(ref)`で観測した版を確認します。`read(state)`はモデルへ渡す記憶を組み立て、`edit(callback)`は非公開の差分を一度だけ確定します。同じ内容・関係・ベクトルを共通の取得処理で利用します。

**v0.2.0はローカルのMemory/SQLite実装に対応しています。** v0.1からは[移行](/migration)が必要です。[はじめる](/guide)で実行コード、[runtime](/runtime)で自動取得と記憶領域の置換を確認できます。
