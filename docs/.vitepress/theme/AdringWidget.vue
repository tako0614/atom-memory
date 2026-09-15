<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';

const container = ref<HTMLDivElement>();
let dispose: (() => void) | undefined;

onMounted(() => {
  const element = container.value;
  if (!element) return;
  const script = document.createElement('script');
  script.src = 'https://ar-cdn.net/widget/v1.js';
  script.async = true;
  script.referrerPolicy = 'origin';
  script.dataset.siteId = '1b549a36-fcce-4d36-ab16-907e75734792';
  script.dataset.variant = 'card';
  element.append(script);
  dispose = () => {
    (script as HTMLScriptElement & { __adringCleanup?: () => void }).__adringCleanup?.();
    element.replaceChildren();
  };
});

onBeforeUnmount(() => dispose?.());
</script>

<template>
  <aside aria-label="広告" class="adring-placement">
    <div ref="container" />
  </aside>
</template>

<style scoped>
.adring-placement {
  box-sizing: border-box;
  width: 100%;
  max-width: 488px;
  min-height: 196px;
  margin: 0 auto;
  padding: 24px;
}
</style>
