import { defineConfig } from 'vitepress';
export default defineConfig({
  lang: 'ja-JP',
  title: 'Atom Memory',
  description: '一つの Atom モデルで、出典・履歴・関係を保つエージェントメモリ。',
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
      { text: '設計仕様', link: '/specification' },
      { text: 'v0.1.0', link: '/release' },
    ],
    sidebar: [
      {
        text: 'Atom Memory',
        items: [
          { text: 'はじめに', link: '/guide' },
          { text: 'Atom と関係', link: '/concepts' },
          { text: 'read / write', link: '/api' },
          { text: 'Writer と共通ハーネス', link: '/runtime' },
          { text: '保存・検索アダプター', link: '/adapters' },
        ],
      },
      {
        text: '仕様と検証',
        items: [
          { text: '受入条件 F01–F20', link: '/acceptance' },
          { text: '最終設計 v1.0', link: '/specification' },
          { text: 'TypeScript 契約', link: '/contracts' },
          { text: 'リリースと公開手順', link: '/release' },
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
