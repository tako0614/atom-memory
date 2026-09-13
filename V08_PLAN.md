# v0.8 実装順序

基準commit: a2f3c59098ba7f6a46ffd3903d2fc14fa43335f5 (0.7.0)。開始時HEADは基準と一致、対象worktreeはclean。

1. 規範仕様と型、公開APIの赤テストを固定。
2. manifest v2、acquisition/presentation/generation/watch/ack、host.observe/InputToken。
3. 生成単位別atomic edit、欠損参照、required、保守的な新旧purge。
4. 閉包/render/costを共通化し、基準解と比較する有界集合選択。
5. V08-01〜40、既存回帰、旧0.7 SQLite移行、docs、tarball consumer検証。

意味の正本: docs/specification.md。試験結果: validation/v0.8.0.md。
新規LLM評価、npm公開、サイト再デプロイ、利用者データ消去はこの作業に含めない。
