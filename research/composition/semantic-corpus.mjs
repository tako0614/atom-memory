// Synthetic community records. Structure is defined from these policies before
// evaluation prompts are supplied; this is not a benchmark of an AI Writer.
export const policies = [
  {
    title: '写真の共有',
    claim: 'イベントの写真は共有チャンネルに投稿できます。',
    condition: '顔が写る本人全員から公開の同意を得てください。',
  },
  {
    title: '会議の録音',
    claim: 'オンライン会議を録音して議事録を作れます。',
    condition: '録音前に参加者全員へ知らせて了承を得てください。',
  },
  {
    title: '外部リンク',
    claim: '役立つ外部サイトのリンクを紹介できます。',
    condition: '紹介料を受け取る場合は広告であると明示してください。',
  },
  {
    title: '利用者の処分',
    claim: '重大な違反には利用停止の判断を提案します。',
    condition: 'BANとKICKの実行は管理者が承認した後に人間が行います。',
  },
  {
    title: '資料の再利用',
    claim: '勉強会の資料を編集して別の会で使えます。',
    condition: '原作者の名前と出典を記載し、ライセンスの条件を守ってください。',
  },
  {
    title: '予算の支出',
    claim: '共同イベントの会場費をコミュニティの予算から支出できます。',
    condition: '支出前に承認された担当者が金額と領収書の扱いを確認します。',
  },
];
export function records() {
  return policies.map((p, i) => ({
    ...p,
    source: p.claim + p.condition,
    summary: `コミュニティの規則：${p.title}`,
    history: Array.from(
      { length: 12 },
      (_, day) =>
        `第${day + 1}回の活動記録。${p.title}について運営で話し合いました。担当班は${i + 1}班です。`,
    ),
  }));
}
// Gold evidence is the claim plus its condition. Broad relevance is not truth.
export const questions = [
  '参加者が写った写真を投稿したい。何を確認すればよい？',
  '打ち合わせを録音して後で議事録を作りたい。',
  '紹介料がもらえるサービスのURLを貼ってもいい？',
  '違反した利用者をボットが即座にBANできる？',
  '勉強会のスライドを別のイベントで編集して使いたい。',
  '共同イベントの場所代を払うには誰の確認が必要？',
];
export const texts = () => [
  ...new Set([
    'community collection',
    ...questions,
    ...records().flatMap((r) => [r.source, r.claim, r.condition, r.summary, ...r.history]),
  ]),
];
