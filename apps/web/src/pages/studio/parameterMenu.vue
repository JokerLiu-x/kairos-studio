<template>
  <el-dropdown ref="dropdown" class="parameterDropdown" trigger="click" placement="top-start" :showArrow="false" :offset="8" popperClass="studioParameterPopover" @command="choose" @visibleChange="expanded = $event">
    <button ref="triggerButton" class="parameterControl" type="button" :class="{ expanded }" :aria-label="`${label}：${format(value)}`">
      <component :is="icon" :size="18" aria-hidden="true" />
      <span>{{ format(value) }}</span>
      <icon-chevron-down :size="12" class="parameterChevron" aria-hidden="true" />
    </button>
    <template #dropdown>
      <div class="parameterTitle">{{ label }}</div>
      <el-dropdown-menu :aria-label="label">
        <el-dropdown-item v-for="option in options" :key="option" :command="option" :class="{ selected: option === value }" role="menuitemradio" :aria-checked="option === value">
          <span>{{ format(option) }}</span>
          <icon-check v-if="option === value" :size="18" stroke="2" aria-hidden="true" />
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts" generic="Value extends string | number">
import { onBeforeUnmount, ref, watch, type Component } from "vue";
import { IconCheck, IconChevronDown } from "@tabler/icons-vue";
import type { DropdownInstance } from "element-plus";

const props = defineProps<{ label: string; options: readonly Value[]; icon: Component; unit?: string }>();
const value = defineModel<Value>({ required: true });
const expanded = ref(false);
const dropdown = ref<DropdownInstance>();
const triggerButton = ref<HTMLButtonElement>();

function format(option: Value) {
  return props.unit ? `${option} ${props.unit}` : String(option);
}

function choose(option: Value) { value.value = option; }
function closeOnEscape(event: KeyboardEvent) {
  if (event.key !== "Escape" || !expanded.value) return;
  event.preventDefault();
  event.stopPropagation();
  dropdown.value?.handleClose();
  triggerButton.value?.focus({ preventScroll: true });
}
watch(expanded, open => {
  if (open) document.addEventListener("keydown", closeOnEscape, true);
  else document.removeEventListener("keydown", closeOnEscape, true);
});
onBeforeUnmount(() => document.removeEventListener("keydown", closeOnEscape, true));
</script>

<style lang="scss" scoped>
.parameterControl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 35px;
  padding: 6px 9px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--kairos-muted);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition: background .16s ease;
  &:hover, &.expanded { background: var(--kairos-hover); }
  &:focus-visible { outline: 2px solid var(--kairos-focus); outline-offset: 2px; }
  .parameterChevron { opacity: .65; }
}
.parameterDropdown { color: var(--kairos-muted); }
@media (prefers-reduced-motion: reduce) {
  .parameterControl { transition: none; }
}
</style>

<style lang="scss">
.el-popper.studioParameterPopover {
  --el-dropdown-menu-box-shadow: none;
  width: 174px;
  max-width: calc(100vw - 24px);
  padding: 6px;
  border: 1px solid var(--kairos-edge);
  border-radius: 18px;
  background: var(--kairos-solid);
  box-shadow: var(--kairos-shadow);
  color: var(--kairos-text);

  .parameterTitle { padding: 9px 10px 6px; color: var(--kairos-muted); font-size: 13px; }
  .el-dropdown-menu { padding: 2px 0; background: transparent; }
  .el-dropdown-menu__item {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    min-height: 41px;
    padding: 6px 10px;
    border-radius: 12px;
    color: var(--kairos-text);
    font-size: 15px;
    font-variant-numeric: tabular-nums;
    &.selected { background: var(--kairos-raised); }
    &:hover, &:focus { background: var(--kairos-hover); color: var(--kairos-text); }
  }
}
</style>
