import { createRouter, createWebHistory } from 'vue-router'
import GraphEditor from '../views/GraphEditor.vue'
import ChatView from '../views/ChatView.vue'

const routes = [
  {
    path: '/',
    name: 'GraphEditor',
    component: GraphEditor
  },
  {
    path: '/chat',
    name: 'Chat',
    component: ChatView
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
