import { defineConfig } from 'vitepress';
export default defineConfig({
  lang: 'ja-JP',
  title: 'Atom Memory',
  description: 'メモと関係を保存し、今の問いに必要な記憶をモデルへ渡す TypeScript ライブラリ。',
  cleanUrls: true,
  head: [
    ['link', { rel: 'icon', href: '/mark.svg' }],
    ['meta', { name: 'theme-color', content: '#faf8f3' }],
  ],
  sitemap: { hostname: 'https://atom-memory.takos.jp' },
  themeConfig: {
    logo: '/mark.svg',
    nav: [
      { text: 'はじめる', link: '/guide' },
      { text: 'API', link: '/api' },
      { text: 'エージェント', link: '/runtime' },
      { text: 'v0.2.0', link: '/release' },
    ],
    sidebar: [
      {
        text: '使い方',
        items: [
          { text: 'はじめる', link: '/guide' },
          { text: 'Atom と関係', link: '/concepts' },
          { text: 'API リファレンス', link: '/api' },
          { text: 'エージェントと Writer', link: '/runtime' },
          { text: 'ホストの設定', link: '/setup' },
          { text: '保存と検索の設定', link: '/adapters' },
        ],
      },
      {
        text: '実装と検証',
        items: [
          { text: 'アーキテクチャ', link: '/specification' },
          { text: 'TypeScript', link: '/contracts' },
          { text: '受入条件と検証', link: '/acceptance' },
          { text: 'リリース', link: '/release' },
        ],
      },
      {
        text: '移行',
        collapsed: true,
        items: [
          { text: 'v0.1 からの移行', link: '/migration' },
          { text: '歴史資料：設計 v1.0', link: '/migration-architecture' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/tako0614/atom-memory' }],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: 'このページ' },
    docFooter: { prev: '前のページ', next: '次のページ' },
    footer: { message: 'MIT License · TypeScript / Node.js', copyright: 'Atom Memory · tako0614' },
    editLink: {
      pattern: 'https://github.com/tako0614/atom-memory/edit/main/docs/:path',
      text: 'GitHub で編集',
    },
  },
});
