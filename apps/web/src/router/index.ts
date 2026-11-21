import { createRouter, createWebHashHistory } from "vue-router";
import { useHelloStore } from "@/stores/hello";
import { useWorkspaceStore } from "@/stores/workspace";
import { publicWeb } from "@/stores/multiTenant";
import { adminRoute } from "@/pages/multiTenant/router";
const studioPage = () => import("@/pages/studio/index.vue");
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: () => publicWeb.value ? "/studio" : "/hello",
    },
    {
      path: "/hello",
      beforeEnter: async () => publicWeb.value || await useHelloStore().load() ? { path: "/studio", replace: true } : true,
      component: () => import("@/pages/hello/index.vue"),
    },
    {
      path: "/home",
      beforeEnter: () => publicWeb.value ? "/studio/projects" : true,
      component: () => import("@/pages/home/index.vue"),
    },
    { path: "/studio", name: "studio", component: studioPage },
    { path: "/studio/create", name: "studioCreate", component: studioPage },
    { path: "/studio/works", name: "studioWorks", component: studioPage },
    { path: "/studio/projects", name: "studioProjects", component: studioPage },
    { path: "/studio/settings", name: "studioSettings", component: studioPage },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      path: "/workspace",
      beforeEnter: () => publicWeb.value && !useWorkspaceStore().project ? { path: "/home", replace: true } : true,
      component: () => import("@/pages/workspace/index.vue"),
    },
    adminRoute,
  ],
});
export default router;
