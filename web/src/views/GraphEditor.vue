<template>
  <div class="h-full w-full flex">
    <div class="flex-1 flex flex-col relative">
      <div class="p-4 bg-white border-b border-gray-200 flex justify-between items-center z-10">
        <h2 class="text-lg font-semibold">Agent Graph Editor</h2>
        <div class="flex gap-2">
          <button @click="addAgent" class="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600">Add Agent</button>
          <button @click="saveSystem" class="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">Save System</button>
        </div>
      </div>
      <div class="flex-1 relative">
        <VueFlow v-model="elements" :default-zoom="1" :min-zoom="0.2" :max-zoom="4" @connect="onConnect" @nodeClick="onNodeClick" @edgeClick="onEdgeClick" @paneClick="onPaneClick">
          <Background pattern-color="#aaa" gap="8" />
          <Controls />
          <MiniMap />
        </VueFlow>
      </div>
    </div>
    
    <!-- Properties Panel -->
    <div v-if="selectedElement" class="w-80 bg-gray-50 border-l border-gray-200 p-4 overflow-y-auto flex flex-col gap-4">
      <h3 class="font-bold text-lg border-b pb-2">{{ isNode(selectedElement) ? 'Agent Properties' : 'Connection Properties' }}</h3>
      
      <template v-if="isNode(selectedElement)">
        <div>
          <label class="block text-sm font-medium text-gray-700">Name</label>
          <input v-model="selectedElement.label" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">System Prompt</label>
          <textarea v-model="selectedElement.data.systemPrompt" rows="4" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border"></textarea>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">Cron Expression</label>
          <input v-model="selectedElement.data.cron" placeholder="e.g. 0 9 * * *" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">Model</label>
          <input v-model="selectedElement.data.model" placeholder="e.g. gpt-4o" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border" />
        </div>
      </template>
      
      <template v-else>
        <div>
          <label class="block text-sm font-medium text-gray-700">Label</label>
          <input v-model="selectedElement.label" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">Trigger Condition</label>
          <input v-model="selectedElement.data.condition" placeholder="e.g. code" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border" />
          <p class="text-xs text-gray-500 mt-1">If message contains this string, it will be routed.</p>
        </div>
      </template>
      
      <button @click="deleteSelected" class="mt-auto bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600">Delete</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

const elements = ref([])
const selectedElement = ref(null)
const { onConnect: onConnectFlow, addEdges } = useVueFlow()

onMounted(async () => {
  await loadSystem()
})

const isNode = (el) => !el.source

const onNodeClick = (event) => {
  selectedElement.value = event.node
}

const onEdgeClick = (event) => {
  selectedElement.value = event.edge
}

const onPaneClick = () => {
  selectedElement.value = null
}

const deleteSelected = () => {
  if (selectedElement.value) {
    elements.value = elements.value.filter(el => el.id !== selectedElement.value.id)
    selectedElement.value = null
  }
}

const loadSystem = async () => {
  try {
    const res = await fetch('http://localhost:3000/api/system')
    const data = await res.json()
    
    const nodes = (data.agents || []).map(agent => ({
      id: agent.id,
      label: agent.name,
      position: agent.position || { x: Math.random() * 400, y: Math.random() * 400 },
      data: { ...agent.data }
    }))
    
    const edges = (data.connections || []).map(conn => ({
      id: conn.id || `e-${conn.source}-${conn.target}`,
      source: conn.source,
      target: conn.target,
      animated: true,
      label: conn.type || 'communicates',
      data: { ...conn.data }
    }))
    
    elements.value = [...nodes, ...edges]
  } catch (error) {
    console.error('Failed to load system:', error)
  }
}

const saveSystem = async () => {
  const nodes = elements.value.filter(el => !el.source)
  const edges = elements.value.filter(el => el.source)
  
  const systemData = {
    agents: nodes.map(n => ({
      id: n.id,
      name: n.label,
      position: n.position,
      data: n.data || {}
    })),
    connections: edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.label,
      data: e.data || {}
    }))
  }
  
  try {
    await fetch('http://localhost:3000/api/system', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(systemData)
    })
    alert('System saved successfully!')
  } catch (error) {
    console.error('Failed to save system:', error)
    alert('Failed to save system')
  }
}

const addAgent = () => {
  const id = `agent-${Date.now()}`
  elements.value.push({
    id,
    label: `New Agent`,
    position: { x: 100, y: 100 },
    data: { systemPrompt: 'You are a helpful assistant.', cron: '', model: '' }
  })
}

const onConnect = (params) => {
  params.id = `e-${params.source}-${params.target}-${Date.now()}`
  params.animated = true
  params.data = { condition: '' }
  addEdges([params])
}
</script>

<style>
.vue-flow__node {
  @apply bg-white border-2 border-blue-500 rounded-lg p-4 shadow-md font-semibold text-center min-w-[120px];
}
</style>
