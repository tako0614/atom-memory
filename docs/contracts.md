# TypeScript 契約

v0.2の通常クライアントの型です。実行時のref検証・認可・版の前提はSDKとホストが担当します。

<<< ../src/client/types.ts

低水準の旧AtomKernel契約は`src/contracts.ts`、新ハーネスは`src/runtime/harness.ts`にあります。旧Kernelと新クライアントのreadは契約が異なります。[移行説明](/migration)を参照してください。
