<template>
  <div class="h-full flex flex-col bg-gray-50">
    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <div v-for="(msg, index) in messages" :key="index" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
        <div class="max-w-[70%] rounded-lg p-3 shadow-sm" :class="msg.role === 'user' ? 'bg-blue-500 text-white' : 'bg-white border border-gray-200'">
          <div class="text-xs font-semibold mb-1 opacity-75">{{ msg.role === 'user' ? 'You' : msg.agent }}</div>
          <div class="prose prose-sm max-w-none" :class="msg.role === 'user' ? 'prose-invert' : ''" v-html="renderMarkdown(msg.content)"></div>
        </div>
      </div>
    </div>
    <div class="p-4 bg-white border-t border-gray-200">
      <div class="flex gap-2">
        <input v-model="inputMessage" @keyup.enter="sendMessage" type="text" class="flex-1 border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Type your message..." />
        <button @click="sendMessage" class="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 transition-colors">Send</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { marked } from 'marked'
import { io } from 'socket.io-client'

const messages = ref([
  { role: 'system', agent: 'System', content: 'Welcome to Midou Multi-Agent Chat!' }
])
const inputMessage = ref('')
let socket = null
let currentAssistantMessage = null

onMounted(() => {
  socket = io('http://localhost:3000')
  
  socket.on('message_delta', (data) => {
    if (!currentAssistantMessage) {
      currentAssistantMessage = { role: 'assistant', agent: 'Midou', content: '' }
      messages.value.push(currentAssistantMessage)
    }
    currentAssistantMessage.content = data.text
  })

  socket.on('message_end', (data) => {
    if (currentAssistantMessage) {
      currentAssistantMessage.content = data.fullText
      currentAssistantMessage = null
    }
  })

  socket.on('thinking_start', () => {
    if (!currentAssistantMessage) {
      currentAssistantMessage = { role: 'assistant', agent: 'Midou', content: '💭 Thinking...' }
      messages.value.push(currentAssistantMessage)
    }
  })

  socket.on('thinking_end', () => {
    if (currentAssistantMessage && currentAssistantMessage.content === '💭 Thinking...') {
      currentAssistantMessage.content = ''
    }
  })

  socket.on('error', (data) => {
    messages.value.push({ role: 'system', agent: 'System', content: `Error: ${data.message}` })
  })
})

const renderMarkdown = (text) => {
  return marked(text || '')
}

const sendMessage = () => {
  if (!inputMessage.value.trim()) return
  
  const msg = {
    role: 'user',
    content: inputMessage.value
  }
  
  messages.value.push(msg)
  socket.emit('message', msg)
  inputMessage.value = ''
}
</script>
