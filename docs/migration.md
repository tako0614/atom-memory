# v0.8への移行

v0.7.0の基準は `a2f3c59098ba7f6a46ffd3903d2fc14fa43335f5`。意味の正本は[規範仕様](/specification)です。移行に利用者DBの消去は不要です。v0.7とv0.8を同一SQLiteへ同時に書き込まないでください。v0.8導入後の旧writer再開はサポートしません。

| 対象                            | 扱い                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Atom ID・revision・出典・links  | 再採番・本文rewriteなし                                                                       |
| v3 own-body embedding           | encoder/前処理/本文が適合すれば保持                                                           |
| AvailabilityModel.idと利用状態  | 同じIDなら保持。意味変更時だけ明示reset                                                       |
| 旧manifestと意味が未確認のlinks | legacyとして全リンクを消去依存に残す                                                          |
| 新InputToken                    | ホスト発行。モデルtool schemaへ追加しない                                                     |
| 旧cursor                        | CURSOR_EXPIRED。新しい取得から開始                                                            |
| read.text                       | formatVersion=2。memory/evidenceを一つの表示として渡す                                        |
| AtomView.links                  | 利用可能形 / unavailable形のunion                                                             |
| StorageAdapter                  | bounded purgeDependents / purgeRevisions / metaPageが必要。旧custom adapterの消去は明示エラー |

旧manifestをrole名や引用から小さい生成単位へ変換しません。新しい版を正しくobserveして生成しても、過去版のlegacy消去依存は残ります。「読めた」と「古い消去依存を解除した」は異なります。

信頼済み原資料の通常関連は、原資料内容の独立性をホストが保証する新契約です。認可済みの別policyへの通常関連も記録でき、読取scopeから外れた先はunavailableになります。出典・生成内容のpolicy越境は引き続き拒否します。既知のコピー/抽出を原資料として取り込む場合もsourcesを付けてください。

## 型と表示の移行例

```ts runnable
import type { AtomView, RecallResult } from 'atom-memory';
export function availableTargets(atom: AtomView) {
  return atom.links.flatMap((link) => (link.unavailable ? [] : [link.ref]));
}
export function modelMemory(result: RecallResult) {
  if (result.formatVersion !== 2) throw new Error('Unsupported memory display');
  return result.text;
}
```

sourceのcitationは原資料への追跡情報です。本文提示はpresentation.unitsで判定します。共有evidenceは保存Atomの改変ではなく、一回の表示での費用共有です。inspect.readEligibilityはuncheckedまたはblockedであり、通常readで単独採用できる保証には使いません。

## 消去と停止の契約

dry-runは新旧混在の全履歴から影響数とlegacy依存を確認します。`maxWork`は依存page、履歴とmetadataのbyte量を含む有限操作上限で、既定16,000,000です。DB内部の索引探索やストレージcallbackのCPU時間の上限ではありません。

実消去は先に永続的な停止マーカーを保存します。未完了・I/O失敗中は、この保存先全体の公開read/writeを止めます。ホストは同じatomIdでpurgeを再呼出し、complete=trueを確認してください。1 Atomの全履歴が一回の予算を超える場合はminimumWorkを参考に予算を増やします。自動ジョブはありません。

本文、blob、FTS相当のbody索引、vector、利用状態、cache、対象を含むpresentation/生成記録を処理します。SQLiteの空きページ・WAL回収はcompact、外部バックアップと送信済みpayloadはホスト所有です。

## 再現する移行検証

```sh
npm pack atom-memory@0.7.0 --pack-destination /tmp/atom-v07
# 展開先のpackageを指定する (利用者DBは開かない)
ATOM_V07_PACKAGE=/tmp/atom-v07/package node scripts/check-v08-migration.mjs
npm run check:v08
```

旧npm packageが実際に作った一時SQLiteとMemory recordsで、ID・版・出典・利用状態・適合索引、cursor失効、legacy消去と新規独立原資料の残存を確認します。SQLiteでは停止した消去を再接続して再開します。配布tarballの空consumer試験も検証記録に分けます。

0.6以前からの利用状態の変更は[旧v0.7移行資料](/migration-v07)を参照してください。ここに記載した手順はnpm公開やサイト再デプロイの承認ではありません。
