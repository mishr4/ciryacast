# Cirya Radio One Discord Bot

A Discord bot for playing Cirya Radio One streams in voice channels.

## Setup

### 1. Create Discord Bot on Developer Portal

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Name it "Cirya Radio One"
4. Go to "Bot" → Click "Add Bot"
5. Copy the **TOKEN** (you'll need this)
6. Under "TOKEN", click "Reset Token" if needed
7. Save the token to Railway as `DISCORD_TOKEN` environment variable

### 2. Enable Intents

In Developer Portal → Bot section:
- ✅ Message Content Intent
- ✅ Server Members Intent (optional)

### 3. Invite Bot to Server

1. Go to OAuth2 → URL Generator
2. Select scopes: `bot` + `applications.commands`
3. Select permissions:
   - ✅ Connect
   - ✅ Speak
   - ✅ Use Voice Activity
4. Copy the generated URL and visit it to invite the bot

### 4. Set Environment Variables on Railway

```
DISCORD_TOKEN=your_bot_token_here
RADIO_ONE_STATION_ID=605617ec-9fa6-4e84-be47-cbdab6550229
API_URL=https://cast.tmc.gg
```

### 5. Deploy

The bot runs automatically alongside the main server on Railway. No separate hosting needed!

## Commands

- `/play` - Join your voice channel and play Radio One
- `/stop` - Stop playback and disconnect
- `/now` - See what's currently playing

## Local Development

```bash
cd bot
npm install
npm run dev
```

Make sure you have the main server running (or set `API_URL` to your local port).
