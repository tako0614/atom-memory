import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import AdringWidget from './AdringWidget.vue';
import './style.css';
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'layout-bottom': () => h(AdringWidget),
    }),
};
