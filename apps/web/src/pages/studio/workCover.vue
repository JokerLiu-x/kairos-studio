<template>
  <span ref="cover" class="workCover" :class="{ portrait, wide }">
    <img v-if="url && work.mediaType === 'image' && !failed" :src="url" alt="" decoding="async" @load="imageReady" @error="failed = true" />
    <video v-else-if="url && !failed" :src="url" muted playsinline preload="metadata" aria-hidden="true" @loadedmetadata="videoReady" @error="failed = true" />
    <span v-if="!url || failed" class="coverPlaceholder"><component :is="work.mediaType === 'video' ? IconMovie : IconPhoto" :size="27" /><small v-if="failed">预览不可用</small></span>
    <span class="mediaBadge">
      <component :is="work.mediaType === 'video' ? IconPlayerPlay : IconPhoto" :size="13" aria-hidden="true" />
      {{ work.mediaType === "video" ? duration || "视频" : "图片" }}
    </span>
    <span v-if="dimensions" class="dimensions">{{ dimensions }}</span>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { IconMovie, IconPhoto, IconPlayerPlay } from "@tabler/icons-vue";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import type { QuickWork } from "./useQuickMedia";

const props = defineProps<{ work: QuickWork; directory: string }>();
const cover = ref<HTMLElement>();
const url = ref("");
const failed = ref(false);
const duration = ref("");
const dimensions = ref("");
const portrait = ref(false);
const wide = ref(false);
let observer: IntersectionObserver | undefined;
onMounted(() => {
  if (!cover.value) return;
  observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting) return;
    observer?.disconnect();
    const source = useWorkspaceFiles(props.directory).readUrl(props.work.path);
    url.value = props.work.mediaType === "video" ? `${source}#t=0.1` : source;
  }, { rootMargin: "160px" });
  observer.observe(cover.value);
});
onBeforeUnmount(() => observer?.disconnect());

function setDimensions(width: number, height: number) {
  if (!width || !height) return;
  dimensions.value = `${width} × ${height}`;
  portrait.value = height > width;
  wide.value = width / height > 1.3;
}

function imageReady(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  setDimensions(image.naturalWidth, image.naturalHeight);
}

function videoReady(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  setDimensions(video.videoWidth, video.videoHeight);
  if (Number.isFinite(video.duration)) {
    const seconds = Math.round(video.duration);
    duration.value = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
}
</script>

<style scoped>
.workCover {
  position: relative;
  display: grid;
  place-items: center;
  height: clamp(145px, 21vw, 270px);
  overflow: hidden;
  background: radial-gradient(ellipse at 48% 48%, #f5ebe0, #e6d7c9);
  color: #65584d;
}
.workCover img, .workCover video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.workCover.wide img, .workCover.wide video { object-fit: cover; }
.workCover.portrait { background: #e7ded4; }
.coverPlaceholder { display: grid; gap: 8px; justify-items: center; }
.mediaBadge, .dimensions {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 7px;
  border-radius: 999px;
  background: #211a15c9;
  color: #fffaf4;
  font-size: 11px;
}
.mediaBadge { top: 9px; left: 9px; }
.dimensions { right: 9px; bottom: 9px; }
</style>
