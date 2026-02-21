<template>
  <div class="h-full flex flex-col">
    <nav class="bg-gray-800 text-white p-4 flex justify-between items-center">
      <div class="font-bold text-xl">Midou Multi-Agent System</div>
      <div class="flex gap-4">
        <router-link to="/" class="hover:text-gray-300" active-class="text-blue-400">Graph Editor</router-link>
        <router-link to="/chat" class="hover:text-gray-300" active-class="text-blue-400">Chat</router-link>
      </div>
    </nav>
    <main class="flex-1 overflow-hidden">
      <router-view></router-view>
    </main>
  </div>
</template>

<script setup>
</script>
