import { DurableObject } from "cloudflare:workers";

interface Env {
  AI: Ai;
  AGENT_STATE: DurableObjectNamespace<AgentState>;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
}

interface Analytics {
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  averageResponseTime: number;
  firstMessageTime?: number;
  lastMessageTime?: number;
}

// Durable Object for managing conversation state
export class AgentState extends DurableObject {
  async getMessages(): Promise<Message[]> {
    return (await this.ctx.storage.get<Message[]>("messages")) || [];
  }

  async addMessage(message: Message): Promise<void> {
    const messages = await this.getMessages();
    message.timestamp = Date.now();
    messages.push(message);
    await this.ctx.storage.put("messages", messages);
    await this.updateAnalytics(message);
  }

  async clearMessages(): Promise<void> {
    await this.ctx.storage.put("messages", []);
    await this.ctx.storage.put("analytics", {
      totalMessages: 0,
      userMessages: 0,
      assistantMessages: 0,
      averageResponseTime: 0,
    });
  }

  async getAnalytics(): Promise<Analytics> {
    return (await this.ctx.storage.get<Analytics>("analytics")) || {
      totalMessages: 0,
      userMessages: 0,
      assistantMessages: 0,
      averageResponseTime: 0,
    };
  }

  private async updateAnalytics(message: Message): Promise<void> {
    const analytics = await this.getAnalytics();
    analytics.totalMessages++;

    if (message.role === "user") {
      analytics.userMessages++;
      analytics.lastMessageTime = message.timestamp;
      if (!analytics.firstMessageTime) {
        analytics.firstMessageTime = message.timestamp;
      }
    } else if (message.role === "assistant") {
      analytics.assistantMessages++;

      // Calculate response time
      const messages = await this.getMessages();
      if (messages.length >= 2) {
        const lastUserMessage = [...messages].reverse().find(m => m.role === "user");
        if (lastUserMessage?.timestamp && message.timestamp) {
          const responseTime = message.timestamp - lastUserMessage.timestamp;
          analytics.averageResponseTime =
            (analytics.averageResponseTime * (analytics.assistantMessages - 1) + responseTime) /
            analytics.assistantMessages;
        }
      }
    }

    await this.ctx.storage.put("analytics", analytics);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Serve frontend
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Chat endpoint
    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const { message, sessionId, image } = await request.json() as {
          message: string;
          sessionId: string;
          image?: string;
        };

        // Get Durable Object instance for this session
        const id = env.AGENT_STATE.idFromName(sessionId);
        const stub = env.AGENT_STATE.get(id);

        // Get conversation history
        const messages = await stub.getMessages();

        // Add user message
        await stub.addMessage({ role: "user", content: message });

        // If image is present, use vision model (no streaming for vision)
        if (image) {
          // Convert base64 to array buffer
          const base64Data = image.split(',')[1];
          const binaryString = atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          // Call vision model
          const visionResponse = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
            image: Array.from(bytes),
            prompt: message,
            max_tokens: 512,
          });

          const assistantMessage = visionResponse.description || "I couldn't analyze the image.";

          // Save assistant response
          await stub.addMessage({
            role: "assistant",
            content: assistantMessage,
          });

          return new Response(
            JSON.stringify({ response: assistantMessage }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        // Prepare messages for text AI
        const aiMessages = [
          {
            role: "system",
            content: "You are a helpful chatbot.",
          },
          ...messages,
          { role: "user", content: message },
        ];

        // Call text model
        const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: aiMessages,
        });

        const assistantMessage = response.response;

        // Save assistant response
        await stub.addMessage({
          role: "assistant",
          content: assistantMessage,
        });

        return new Response(
          JSON.stringify({ response: assistantMessage }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    // Clear chat endpoint
    if (url.pathname === "/api/clear" && request.method === "POST") {
      try {
        const { sessionId } = await request.json() as { sessionId: string };
        const id = env.AGENT_STATE.idFromName(sessionId);
        const stub = env.AGENT_STATE.get(id);
        await stub.clearMessages();

        return new Response(
          JSON.stringify({ success: true }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    // Analytics endpoint
    if (url.pathname === "/api/analytics" && request.method === "POST") {
      try {
        const { sessionId } = await request.json() as { sessionId: string };
        const id = env.AGENT_STATE.idFromName(sessionId);
        const stub = env.AGENT_STATE.get(id);
        const analytics = await stub.getAnalytics();

        return new Response(
          JSON.stringify(analytics),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    // Export conversation endpoint
    if (url.pathname === "/api/export" && request.method === "POST") {
      try {
        const { sessionId } = await request.json() as { sessionId: string };
        const id = env.AGENT_STATE.idFromName(sessionId);
        const stub = env.AGENT_STATE.get(id);
        const messages = await stub.getMessages();

        return new Response(
          JSON.stringify({ messages }, null, 2),
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
              "Content-Disposition": "attachment; filename=conversation.json"
            },
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// Simple HTML frontend
const HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Chat</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: Arial, sans-serif;
      background: #fff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .header {
      padding: 20px;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 40px;
    }

    .mode-tabs {
      display: flex;
      gap: 40px;
    }

    .mode-tab {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 10px 0;
      cursor: pointer;
      font-size: 16px;
      color: #5f6368;
      transition: color 0.2s, border-color 0.2s;
    }

    .mode-tab.active {
      color: #202124;
      border-bottom-color: #000;
    }

    .mode-tab:hover {
      color: #202124;
    }

    .header-actions {
      position: absolute;
      right: 20px;
      display: flex;
      gap: 15px;
    }

    .clear-btn {
      background: #000;
      border: 1px solid #000;
      border-radius: 20px;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 14px;
      color: #fff;
      transition: background 0.2s, color 0.2s;
    }

    .clear-btn:hover {
      background: #333;
      border-color: #333;
    }

    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      max-width: 768px;
      width: 100%;
      margin: 0 auto;
      padding: 0 20px;
      padding-bottom: 120px;
    }

    .main-content.chat-active {
      max-width: 768px;
    }

    .logo-area {
      text-align: center;
      margin-top: 100px;
      margin-bottom: 30px;
      transition: opacity 0.3s, transform 0.3s;
    }

    .logo-area.hidden {
      display: none;
    }

    .logo {
      font-size: 90px;
      font-weight: 400;
      color: #000;
      letter-spacing: 2px;
      font-family: 'Brush Script MT', 'Lucida Handwriting', cursive;
      font-style: italic;
    }

    .search-container {
      margin: 27px auto 0;
      width: 100%;
      max-width: 584px;
      transition: all 0.3s;
    }

    .search-container.fixed {
      position: fixed;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      margin: 0;
      padding: 20px;
      background: #fff;
      border-top: 1px solid #e0e0e0;
      max-width: 768px;
      z-index: 100;
    }

    .search-wrapper {
      display: flex;
      align-items: center;
      border: 1px solid #dfe1e5;
      border-radius: 24px;
      min-height: 44px;
      padding: 5px 8px 5px 14px;
      width: 100%;
      flex-wrap: wrap;
      gap: 8px;
    }

    .search-wrapper:hover {
      border-color: #202124;
    }

    .search-wrapper.focused {
      border-color: #202124;
    }

    input[type="text"] {
      flex: 1;
      border: none;
      outline: none;
      font-size: 16px;
      color: #202124;
      background: transparent;
      min-width: 200px;
    }

    .image-upload-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 8px;
      display: flex;
      align-items: center;
      color: #5f6368;
      transition: color 0.2s;
      margin: 0;
      height: auto;
      min-width: auto;
    }

    .image-upload-btn:hover {
      color: #202124;
      transform: none;
      box-shadow: none;
      background: none;
    }

    input[type="file"] {
      display: none;
    }

    .image-preview {
      display: none;
      width: 100%;
      margin-top: 8px;
      padding: 8px;
      background: #f8f9fa;
      border-radius: 8px;
      align-items: center;
      gap: 8px;
    }

    .image-preview.active {
      display: flex;
    }

    .image-preview img {
      max-width: 80px;
      max-height: 80px;
      border-radius: 4px;
      object-fit: cover;
    }

    .image-preview-info {
      flex: 1;
      font-size: 13px;
      color: #5f6368;
    }

    .remove-image-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: #5f6368;
      font-size: 20px;
      padding: 4px 8px;
      transition: color 0.2s;
      margin: 0;
      height: auto;
      min-width: auto;
    }

    .remove-image-btn:hover {
      color: #d93025;
      transform: none;
      box-shadow: none;
      background: none;
    }

    .send-arrow {
      background: none;
      border: none;
      cursor: pointer;
      padding: 8px;
      display: flex;
      align-items: center;
      color: #5f6368;
      transition: color 0.2s;
    }

    .send-arrow:hover {
      color: #202124;
    }

    .send-arrow:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .messages {
      margin-top: 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding-bottom: 20px;
      width: 100%;
    }

    .messages.empty {
      display: none;
    }

    .message {
      padding: 8px 0;
      line-height: 1.6;
      font-size: 15px;
      max-width: 100%;
      display: flex;
    }

    .user {
      justify-content: flex-end;
    }

    .user-bubble {
      background: #000;
      color: #fff;
      padding: 12px 20px;
      border-radius: 20px;
      max-width: 70%;
      word-wrap: break-word;
    }

    .assistant {
      color: #202124;
      justify-content: flex-start;
    }

    .message img {
      max-width: 300px;
      max-height: 300px;
      border-radius: 8px;
      margin-top: 12px;
      display: inline-block;
    }

    .user img {
      float: right;
      margin-left: 10px;
    }

    .assistant img {
      float: left;
      margin-right: 10px;
    }

    .streaming-cursor {
      display: inline-block;
      width: 8px;
      height: 20px;
      background: #202124;
      margin-left: 2px;
      animation: blink 1s infinite;
      vertical-align: text-bottom;
    }

    @keyframes blink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }

    .loading {
      padding: 16px;
      background: #f8f9fa;
      border-radius: 8px;
      color: #5f6368;
      font-size: 14px;
      max-width: 80%;
      border: 1px solid #dadce0;
    }

    .loading::after {
      content: '...';
      animation: dots 1.5s steps(4, end) infinite;
    }

    @keyframes dots {
      0%, 20% { content: '.'; }
      40% { content: '..'; }
      60%, 100% { content: '...'; }
    }

    .analytics-view {
      display: none;
      padding: 40px 20px;
      max-width: 600px;
      margin: 0 auto;
    }

    .analytics-view.active {
      display: block;
    }

    .chat-view {
      display: block;
    }

    .chat-view.hidden {
      display: none;
    }

    .analytics-view h2 {
      margin: 0 0 30px 0;
      font-size: 32px;
      color: #202124;
    }

    .analytics-stats {
      margin-bottom: 20px;
    }

    .stat-item {
      padding: 12px 0;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      justify-content: space-between;
    }

    .stat-item:last-child {
      border-bottom: none;
    }

    .stat-label {
      color: #5f6368;
      font-size: 14px;
    }

    .stat-value {
      color: #202124;
      font-weight: bold;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="mode-tabs">
      <button class="mode-tab active" id="chatTab" onclick="switchMode('chat')">Chat</button>
      <button class="mode-tab" id="analyticsTab" onclick="switchMode('analytics')">Analytics</button>
    </div>
    <div class="header-actions">
      <button class="clear-btn" onclick="exportConversation()">Export</button>
      <button class="clear-btn" onclick="clearChat()">Clear</button>
    </div>
  </div>

  <div class="analytics-view" id="analyticsView">
    <h2>Analytics</h2>
    <div class="analytics-stats" id="analyticsStats"></div>
  </div>

  <div class="chat-view" id="chatView">
  <div class="main-content">
    <div class="logo-area" id="logoArea">
      <div class="logo">AI Chat</div>
    </div>

    <div class="search-container" id="searchContainer">
      <div class="search-wrapper" id="searchWrapper">
        <button class="image-upload-btn" onclick="document.getElementById('imageInput').click()" type="button">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
          </svg>
        </button>
        <input type="file" id="imageInput" accept="image/*" onchange="handleImageSelect(event)" />
        <input
          type="text"
          id="messageInput"
          placeholder="Ask me anything..."
          onkeypress="handleKeyPress(event)"
          onfocus="handleFocus()"
          onblur="handleBlur()"
        />
        <button class="send-arrow" onclick="sendMessage()" id="sendBtn" type="button">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </button>
      </div>
      <div class="image-preview" id="imagePreview">
        <img id="previewImg" src="" alt="Preview" />
        <div class="image-preview-info" id="imageInfo"></div>
        <button class="remove-image-btn" onclick="removeImage()" type="button">×</button>
      </div>
    </div>

    <div class="messages empty" id="messages"></div>
  </div>
  </div>

  <script>
    const sessionId = Math.random().toString(36).substring(7);
    let selectedImage = null;

    function handleImageSelect(event) {
      const file = event.target.files[0];
      if (!file) return;

      if (file.size > 5 * 1024 * 1024) {
        alert('Image size must be less than 5MB');
        return;
      }

      const reader = new FileReader();
      reader.onload = function(e) {
        selectedImage = e.target.result;
        document.getElementById('previewImg').src = selectedImage;
        document.getElementById('imageInfo').textContent = file.name;
        document.getElementById('imagePreview').classList.add('active');
      };
      reader.readAsDataURL(file);
    }

    function removeImage() {
      selectedImage = null;
      document.getElementById('imageInput').value = '';
      document.getElementById('imagePreview').classList.remove('active');
    }

    async function sendMessage() {
      const input = document.getElementById('messageInput');
      const message = input.value.trim();

      if (!message && !selectedImage) return;

      // Disable input
      input.disabled = true;
      document.getElementById('sendBtn').disabled = true;

      // Display user message with image if present
      if (selectedImage) {
        addMessageWithImage(message || 'Analyze this image', 'user', selectedImage);
      } else {
        addMessage(message, 'user');
      }

      input.value = '';

      try {
        const payload = {
          message: message || 'What is in this image?',
          sessionId
        };

        if (selectedImage) {
          payload.image = selectedImage;
        }

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.error) {
          addMessage('Error: ' + data.error, 'assistant');
        } else {
          addMessage(data.response, 'assistant');
        }
      } catch (error) {
        addMessage('Error: Failed to get response', 'assistant');
      }

      // Clear image after sending
      removeImage();

      // Re-enable input
      input.disabled = false;
      document.getElementById('sendBtn').disabled = false;
      input.focus();
    }

    function activateChatMode() {
      document.getElementById('logoArea').classList.add('hidden');
      document.getElementById('searchContainer').classList.add('fixed');
      document.querySelector('.main-content').classList.add('chat-active');
    }

    function addMessage(text, role) {
      const messagesDiv = document.getElementById('messages');
      const wasEmpty = messagesDiv.classList.contains('empty');
      messagesDiv.classList.remove('empty');

      const messageDiv = document.createElement('div');
      messageDiv.className = 'message ' + role;

      if (role === 'user') {
        const bubble = document.createElement('div');
        bubble.className = 'user-bubble';
        bubble.textContent = text;
        messageDiv.appendChild(bubble);
      } else {
        messageDiv.textContent = text;
      }

      messagesDiv.appendChild(messageDiv);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;

      if (wasEmpty && role === 'user') {
        activateChatMode();
      }
    }

    function addMessageWithImage(text, role, imageSrc) {
      const messagesDiv = document.getElementById('messages');
      const wasEmpty = messagesDiv.classList.contains('empty');
      messagesDiv.classList.remove('empty');

      const messageDiv = document.createElement('div');
      messageDiv.className = 'message ' + role;

      if (role === 'user') {
        const bubble = document.createElement('div');
        bubble.className = 'user-bubble';
        bubble.textContent = text;

        const img = document.createElement('img');
        img.src = imageSrc;
        bubble.appendChild(document.createElement('br'));
        bubble.appendChild(img);

        messageDiv.appendChild(bubble);
      } else {
        const textNode = document.createTextNode(text);
        messageDiv.appendChild(textNode);

        const img = document.createElement('img');
        img.src = imageSrc;
        messageDiv.appendChild(img);
      }

      messagesDiv.appendChild(messageDiv);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;

      if (wasEmpty && role === 'user') {
        activateChatMode();
      }
    }

    async function clearChat() {
      if (!confirm('Clear all messages?')) return;

      try {
        await fetch('/api/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });

        const messagesDiv = document.getElementById('messages');
        messagesDiv.innerHTML = '';
        messagesDiv.classList.add('empty');

        // Reset to initial state
        document.getElementById('logoArea').classList.remove('hidden');
        document.getElementById('searchContainer').classList.remove('fixed');
        document.querySelector('.main-content').classList.remove('chat-active');
      } catch (error) {
        alert('Failed to clear chat');
      }
    }

    async function switchMode(mode) {
      const chatTab = document.getElementById('chatTab');
      const analyticsTab = document.getElementById('analyticsTab');
      const chatView = document.getElementById('chatView');
      const analyticsView = document.getElementById('analyticsView');

      if (mode === 'chat') {
        chatTab.classList.add('active');
        analyticsTab.classList.remove('active');
        chatView.classList.remove('hidden');
        analyticsView.classList.remove('active');
      } else if (mode === 'analytics') {
        chatTab.classList.remove('active');
        analyticsTab.classList.add('active');
        chatView.classList.add('hidden');
        analyticsView.classList.add('active');

        // Load analytics data
        try {
          const response = await fetch('/api/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
          });

          const analytics = await response.json();

          const statsDiv = document.getElementById('analyticsStats');
          const avgResponseTime = analytics.averageResponseTime
            ? (analytics.averageResponseTime / 1000).toFixed(2) + 's'
            : 'N/A';

          const sessionDuration = analytics.firstMessageTime && analytics.lastMessageTime
            ? Math.round((analytics.lastMessageTime - analytics.firstMessageTime) / 1000 / 60) + ' minutes'
            : 'N/A';

          statsDiv.innerHTML =
            '<div class="stat-item">' +
              '<span class="stat-label">Total Messages</span>' +
              '<span class="stat-value">' + analytics.totalMessages + '</span>' +
            '</div>' +
            '<div class="stat-item">' +
              '<span class="stat-label">Your Messages</span>' +
              '<span class="stat-value">' + analytics.userMessages + '</span>' +
            '</div>' +
            '<div class="stat-item">' +
              '<span class="stat-label">AI Responses</span>' +
              '<span class="stat-value">' + analytics.assistantMessages + '</span>' +
            '</div>' +
            '<div class="stat-item">' +
              '<span class="stat-label">Avg Response Time</span>' +
              '<span class="stat-value">' + avgResponseTime + '</span>' +
            '</div>' +
            '<div class="stat-item">' +
              '<span class="stat-label">Session Duration</span>' +
              '<span class="stat-value">' + sessionDuration + '</span>' +
            '</div>';
        } catch (error) {
          alert('Failed to load analytics');
        }
      }
    }

    async function exportConversation() {
      try {
        const response = await fetch('/api/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'conversation-' + Date.now() + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      } catch (error) {
        alert('Failed to export conversation');
      }
    }

    function handleKeyPress(event) {
      if (event.key === 'Enter') {
        sendMessage();
      }
    }

    function handleFocus() {
      document.getElementById('searchWrapper').classList.add('focused');
    }

    function handleBlur() {
      document.getElementById('searchWrapper').classList.remove('focused');
    }

    // Focus input on load
    document.getElementById('messageInput').focus();
  </script>
</body>
</html>
`;
