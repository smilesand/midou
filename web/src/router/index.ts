import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import GraphEditor from '../views/GraphEditor.vue'
import ChatView from '../views/ChatView.vue'
import PipelineView from '../views/PipelineView.vue'
import PipelineHelpView from '../views/PipelineHelpView.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'GraphEditor',
    component: GraphEditor,
  },
  {
    path: '/chat',
    name: 'Chat',
    component: ChatView,
  },
  {
    path: '/pipeline',
    name: 'Pipeline',
    component: PipelineView,
  },
  {
    path: '/pipeline/help',
    name: 'PipelineHelp',
    component: PipelineHelpView,
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
