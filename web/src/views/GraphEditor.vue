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
    <div v-if="selectedElement" class="w-96 bg-gray-50 border-l border-gray-200 p-4 overflow-y-auto flex flex-col gap-4">
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
        
        <div class="border-t pt-2">
          <h4 class="font-semibold text-sm mb-2">LLM Configuration</h4>
          <div class="space-y-2">
            <div>
              <label class="block text-xs font-medium text-gray-700">Provider</label>
              <select v-model="selectedElement.data.provider" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border">
                <option value="">Default</option>
                <option value="openai">OpenAI Compatible</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-700">Model</label>
              <input v-model="selectedElement.data.model" placeholder="e.g. gpt-4o" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border" />
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-700">API Key</label>
              <input v-model="selectedElement.data.apiKey" type="password" placeholder="Leave empty to use default" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border" />
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-700">Base URL</label>
              <input v-model="selectedElement.data.baseURL" placeholder="Leave empty to use default" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border" />
            </div>
          </div>
        </div>

        <div class="border-t pt-2">
          <div class="flex justify-between items-center mb-2">
            <h4 class="font-semibold text-sm">Cron Jobs</h4>
            <button @click="addCronJob" class="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded hover:bg-blue-200">+ Add</button>
          </div>
          <div v-if="!selectedElement.data.cronJobs || selectedElement.data.cronJobs.length === 0" class="text-xs text-gray-500">No cron jobs configured.</div>
          <div v-for="(job, index) in selectedElement.data.cronJobs" :key="index" class="bg-white p-2 rounded border border-gray-200 mb-2 relative">
            <button @click="removeCronJob(index)" class="absolute top-1 right-1 text-red-500 hover:text-red-700 text-xs">✕</button>
            <div class="mb-1">
              <label class="block text-xs font-medium text-gray-700">Expression</label>
              <input v-model="job.expression" placeholder="* * * * *" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-xs p-1 border" />
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-700">Prompt to Execute</label>
              <textarea v-model="job.prompt" rows="2" placeholder="What should AI do?" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-xs p-1 border"></textarea>
            </div>
          </div>
        </div>
      </template>
      
      <template v-else>
        <div>
          <label class="block text-sm font-medium text-gray-700">Label</label>
          <input v-model="selectedElement.label" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border" />
        </div>
        
        <div class="border-t pt-2">
          <div class="flex justify-between items-center mb-2">
            <h4 class="font-semibold text-sm">Routing Conditions</h4>
            <button @click="addCondition" class="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded hover:bg-blue-200">+ Add</button>
          </div>
          <p class="text-xs text-gray-500 mb-2">Message will be routed if ANY condition matches.</p>
          <div v-if="!selectedElement.data.conditions || selectedElement.data.conditions.length === 0" class="text-xs text-gray-500">No conditions (always routes).</div>
          <div v-for="(cond, index) in selectedElement.data.conditions" :key="index" class="bg-white p-2 rounded border border-gray-200 mb-2 flex gap-2 items-start">
            <div class="flex-1 space-y-1">
              <select v-model="cond.type" class="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-xs p-1 border">
                <option value="contains">Contains</option>
                <option value="regex">Regex</option>
              </select>
              <input v-model="cond.value" placeholder="Value" class="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-xs p-1 border" />
            </div>
            <button @click="removeCondition(index)" class="text-red-500 hover:text-red-700 text-xs mt-1">✕</button>
          </div>
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
  // Ensure arrays exist
  if (!selectedElement.value.data.cronJobs) selectedElement.value.data.cronJobs = []
}

const onEdgeClick = (event) => {
  selectedElement.value = event.edge
  // Ensure arrays exist
  if (!selectedElement.value.data.conditions) selectedElement.value.data.conditions = []
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

const addCronJob = () => {
  if (!selectedElement.value.data.cronJobs) selectedElement.value.data.cronJobs = []
  selectedElement.value.data.cronJobs.push({ expression: '', prompt: '' })
}

const removeCronJob = (index) => {
  selectedElement.value.data.cronJobs.splice(index, 1)
}

const addCondition = () => {
  if (!selectedElement.value.data.conditions) selectedElement.value.data.conditions = []
  selectedElement.value.data.conditions.push({ type: 'contains', value: '' })
}

const removeCondition = (index) => {
  selectedElement.value.data.conditions.splice(index, 1)
}

const loadSystem = async () => {
  try {
    const res = await fetch('http://localhost:3000/api/system')
    const data = await res.json()
    
    const nodes = (data.agents || []).map(agent => {
      // Migrate old cron to new cronJobs array
      const data = { ...agent.data }
      if (data.cron && (!data.cronJobs || data.cronJobs.length === 0)) {
        data.cronJobs = [{ expression: data.cron, prompt: 'System: Scheduled activation triggered.' }]
        delete data.cron
      }
      if (!data.cronJobs) data.cronJobs = []
      
      return {
        id: agent.id,
        label: agent.name,
        position: agent.position || { x: Math.random() * 400, y: Math.random() * 400 },
        data
      }
    })
    
    const edges = (data.connections || []).map(conn => {
      // Migrate old condition to new conditions array
      const data = { ...conn.data }
      if (data.condition && (!data.conditions || data.conditions.length === 0)) {
        data.conditions = [{ type: 'contains', value: data.condition }]
        delete data.condition
      }
      if (!data.conditions) data.conditions = []

      return {
        id: conn.id || `e-${conn.source}-${conn.target}`,
        source: conn.source,
        target: conn.target,
        animated: true,
        label: conn.type || 'communicates',
        data
      }
    })
    
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
    data: { systemPrompt: 'You are a helpful assistant.', cronJobs: [], model: '', provider: '', apiKey: '', baseURL: '' }
  })
}

const onConnect = (params) => {
  params.id = `e-${params.source}-${params.target}-${Date.now()}`
  params.animated = true
  params.data = { conditions: [] }
  addEdges([params])
}
</script>

<style>
.vue-flow__node {
  @apply bg-white border-2 border-blue-500 rounded-lg p-4 shadow-md font-semibold text-center min-w-[120px];
}
</style>
