# ホストの設定

アプリで使う `memory` は、ホストが保存先と権限を設定して作ります。ローカルで試す場合は、次の初期化を `memory.mjs` として保存してください。

<<< ../examples/memory.mjs

アプリ側ではこのファイルからクライアントを読み込みます。

```ts
import { memory } from './memory.mjs';

await memory.write('招待リンクの有効期限は24時間です。');
```

設定するのは次の三つです。

| 設定                       | この例での意味                                                   |
| -------------------------- | ---------------------------------------------------------------- |
| `LocalAuthority` と `auth` | `support-app` に `notes` への読み書きを許可する                  |
| `MemoryHost`               | プロセス内の保存先を用意する                                     |
| `connect`                  | この許可と、人間の入力という書き手の情報をクライアントに束縛する |

`notes` はアクセス権の名前です。内容を分類するラベルではなく、検索時に指定する必要はありません。認証と書き手はアプリのホストで設定し、モデルには選ばせません。

## 保存先と書き手を変える

ファイルに残すなら [SQLite](/adapters#sqlite-に保存する)を設定します。入力アダプターから投入する資料は `actor: { type: 'input-adapter' }`、モデルが作る説明は `actor: { type: 'agent', generatedOrigin: 'organization' }` を使います。

同じホストから複数のクライアントを発行できるので、入力アダプターと Writer は同じ記憶を扱えます。[Writer の例](/runtime#小さなwriter例)を参照してください。

候補providerは `PinnedRef[]` だけを返し、保存本文の再読、スコア、構造伝播はCoreが担当します。embeddingの有無に応じて語彙または語彙＋ベクトルの候補入口を選びます。`ExactCandidateProvider` は小規模な有限走査の基準として必要な箇所で明示します。取得の上限は `retrieval`、利用状態モデル・増幅・関係重みは `activation` に設定します。既定モデルは `adaptiveUse()` です。

## アプリの認証につなぐ

`LocalAuthority` はプロセス内の認証を試す実装です。継続運用するアプリでは、ログイン済みユーザーと権限をホスト側の `Authorizer` へ接続します。再起動をまたいで参照や cursor を使う場合は、安定した認証ハンドルを解決できるようにします。

この初期化を一度済ませたら、アプリは [保存・検索・読取](/guide)を内容だけで呼べます。

## 検索評価と保存上限

`MemoryHost` の `activation` で `adaptiveUse()` または独自の `AvailabilityModel`、最大増幅、関係ごとの方向重みを、`retrieval` で候補・グラフ探索の上限を設定します。[構造ランキング](/ranking)を参照してください。保存処理の上限は `limits` で指定します。低水準Kernelを注入する設定はありません。

モデルへ返した結果をアプリが成功として受理したら、ホストは `host.recordUse(recalled.refs, binding, { eventId })` を自動で呼びます。read・searchの実行やモデルのツール、人の承認だけでは利用を記録しません。モデルIDやパラメータを変えて保存状態が `STATE_INVALIDATED` になった場合は、対象のscopeで `host.resetUse(binding)` を明示します。集計を現在の主体・policyから消すときにも同じAPIを使います。

embeddingを使う本番hostは、`prepareIndex` / `updateIndex` を提供する全policy scopeでdrainし、各scopeのcheckpointを確認してから意味検索をreadyと扱います。一つのchannelや一回の呼出しの `pending: false` は全体の準備完了ではありません。
