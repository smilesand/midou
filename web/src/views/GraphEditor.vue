<template>
  <div class="h-full w-full flex flex-col">
    <div class="p-4 bg-white border-b border-gray-200 flex justify-between items-center">
      <h2 class="text-lg font-semibold">Agent Graph Editor</h2>
      <div class="flex gap-2">
        <button @click="addAgent" class="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600">Add Agent</button>
        <button @click="saveSystem" class="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">Save System</button>
      </div>
    </div>
    <div class="flex-1 relative">
      <VueFlow v-model="elements" :default-zoom="1" :min-zoom="0.2" :max-zoom="4" @connect="onConnect">
        <Background pattern-color="#aaa" gap="8" />
        <Controls />
        <MiniMap />
      </VueFlow>
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
const { onConnect: onConnectFlow, addEdges } = useVueFlow()

onMounted(async () => {
  await loadSystem()
})

const loadSystem = async () => {
  try {
    const res = await fetch('http://localhost:3000/api/system')
    const data = await res.json()
    
    const nodes = (data.agents || []).map(agent => ({
      id: agent.id,
      label: agent.name,
      position: agent.position || { x: Math.random() * 400, y: Math.random() * 400 },
      data: { ...agent }
    }))
    
    const edges = (data.connections || []).map(conn => ({
      id: `e-${conn.source}-${conn.target}`,
      source: conn.source,
      target: conn.target,
      animated: true,
      label: conn.type || 'communicates'
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
      ...n.data
    })),
    connections: edges.map(e => ({
      source: e.source,
      target: e.target,
      type: e.label
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
    data: { role: 'assistant' }
  })
}

const onConnect = (params) => {
  addEdges([params])
}
</script>

<style>
.vue-flow__node {
  @apply bg-white border-2 border-blue-500 rounded-lg p-4 shadow-md font-semibold text-center min-w-[120px];
}
</style>
