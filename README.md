SEE DEMO: https://www.loom.com/share/169da7c76455436a912bec71f52bccbb

# AI Chat Agent

An AI-powered chat application built with Cloudflare Workers AI, featuring text chat, image analysis, conversation analytics, and a clean minimal UI.

## Features

- **Text Chat**: Powered by Llama 3.3 with custom personality
- **Image Analysis**: Upload and analyze images using LLaVA vision model
- **Conversation State**: Persistent sessions using Durable Objects
- **Analytics**: Track message counts, response times, and session duration
- **Export**: Download conversation history as JSON
- **Clean UI**: Minimal design with tab navigation and real-time updates

## Tech Stack

- Cloudflare Workers
- Workers AI (Llama 3.3, LLaVA)
- Durable Objects
- TypeScript

## Local Development

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Cloudflare account

### Setup

1. Clone the repository:
```bash
git clone <your-repo-url>
cd cloudflare
```

2. Install dependencies:
```bash
npm install
```

3. Login to Cloudflare (if not already logged in):
```bash
npx wrangler login
```

4. Run the development server:
```bash
npm run dev
```

The application will be available at `http://localhost:8787`

### Project Structure

```
cloudflare/
├── src/
│   └── index.ts          # Main Worker with Durable Object and frontend
├── wrangler.toml         # Cloudflare Workers configuration
├── package.json          # Dependencies and scripts
└── tsconfig.json         # TypeScript configuration
```

## Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## Configuration

The application uses:
- **Workers AI binding**: `AI` (configured in wrangler.toml)
- **Durable Objects binding**: `AGENT_STATE` (configured in wrangler.toml)
- **Compatibility date**: 2024-12-01 with nodejs_compat flag

## Usage

1. **Chat**: Type a message and press Enter or click the arrow button
2. **Image Analysis**: Click the image icon, upload an image, and optionally add a prompt
3. **Analytics**: Switch to the Analytics tab to view conversation statistics
4. **Export**: Click Export to download conversation history
5. **Clear**: Click Clear to reset the conversation
