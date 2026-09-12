import { defineConfig } from 'vitepress';
export default defineConfig({
  lang: 'ja-JP',
  title: 'Atom Memory',
  description: 'メモと関係を保存し、今の問いに必要な記憶をモデルへ渡す TypeScript ライブラリ。',
  cleanUrls: true,
  head: [
    ['link', { rel: 'icon', href: 'data:,' }],
    ['meta', { name: 'theme-color', content: '#ffffff' }],
  ],
  sitemap: { hostname: 'https://atom-memory.takos.jp' },
  themeConfig: {
    nav: [
      { text: 'ドキュメント', link: '/guide' },
      { text: 'コード例', link: '/examples' },
      { text: 'API', link: '/api' },
    ],
    sidebar: [
      {
        text: 'はじめる',
        items: [
          { text: 'Hello, Memory', link: '/guide' },
          { text: '短いコードで試す', link: '/examples' },
          { text: 'エージェントにつなぐ', link: '/runtime' },
          { text: '長期履歴を整理する', link: '/history' },
        ],
      },
      {
        text: '使い方を広げる',
        items: [
          { text: 'Atom と関係', link: '/concepts' },
          { text: 'ホストの設定', link: '/setup' },
          { text: '保存と検索の設定', link: '/adapters' },
        ],
      },
      {
        text: 'API',
        items: [
          { text: '操作一覧', link: '/api' },
          { text: 'write · 保存', link: '/api#write' },
          { text: 'search · 検索', link: '/api#search' },
          { text: 'inspect · 参照', link: '/api#inspect' },
          { text: 'read · 記憶の取得', link: '/api#read' },
          { text: 'edit · 編集', link: '/api#edit' },
          { text: 'TypeScript', link: '/contracts' },
        ],
      },
      {
        text: '実装と検証',
        collapsed: true,
        items: [
          { text: 'アーキテクチャ', link: '/specification' },
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
