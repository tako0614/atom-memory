# v0.1 から v0.2 への移行

基準commitは`0c5a5aeb29b1a11195cb74d562f00c5dd6edec15`です。v0.1のreadの意味を、同じKernelメソッドのまま変更しません。

| v0.1                                  | v0.2の通常経路                                                |
| ------------------------------------- | ------------------------------------------------------------- |
| Kernelの`read({selector: search})`    | bound clientの`search(query)`                                 |
| Kernelの`read({selector: refs})`      | bound clientの`inspect(ref)`                                  |
| アプリが手作業で文脈へread結果を追加  | `MemoryHarness`の自動`read(state)`と記憶置換                  |
| 手動ID・版・expectedHeadのwriteバッチ | `write(content)`と`edit(draft => ...)`                        |
| `AgentHarness`のrecords追記           | 旧版は`LegacyAgentHarness`、新`AgentHarness`は`MemoryHarness` |
| membership専用の関係探索              | 任意schema・任意roleの正引きと逆引き                          |

既存SQLiteに対して`new MemoryHost({ kernel: existingKernel })`で接続できます。既存Atomをコピー・再採番・再分類しません。保存済みmembershipのslotsをそのまま一般の役割付きリンクとして読み、元のID、版、originsを保持します。明示的な固定includeは低水準Kernelで引き続き使えます。

既知の旧版`PinnedRef`を高水準refへ移す場合は、信頼されたホストが`host.reference(pinnedRef, binding)`を呼びます。モデルがraw IDを送って認可を得る経路にはしません。ホストの認証設定・同じ保存先を各APIで共有してください。

通常のlinksは論理関係です。旧includeの意味を期待する移行では、低水準の固定構成を明示的に維持してください。版を固定した`{ref, at:'observed'}`自体は全文の自動構成ではありません。

旧Kernelと旧ハーネスのF01–F20は回帰試験として維持しています。新しい取得、パッキング、自動readと編集はA01–A36で別に検証します。A35は既存SQLiteのID・不変版・出典・membershipを変えず、再オープン後にも高水準refと履歴を解決できることを検査します。

原仕様の「公開APIはread/writeだけ」「schemaで探索を分岐」はv0.2の要求で置き換えます。元の仕様ファイルは歴史資料として残します。npm/siteの再公開と既存データの消去は、この移行の自動操作に含みません。
