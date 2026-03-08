# Watch Together - Self-Hosted Video Sync Platform

A free, self-hosted platform for watching videos together in real-time with ultra-low latency synchronization.

## 🎯 Features

- **Real-time Video Sync** - Play, pause, and seek synchronized across all viewers
- **Live Chat** - Real-time chat with timestamps synced to video position
- **Room Management** - Create rooms, invite friends, track viewer count
- **Low Latency** - Near real-time sync using WebSocket events
- **Mobile Compatible** - Works on desktop and mobile browsers
- **No App Required** - Pure web-based, no installation needed
- **Direct File Upload** - Drag & drop video files directly to the server (up to 5GB)

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Browser                           │
│  ┌─────────────┐  ┌─────────────────┐  ┌────────────────────┐   │
│  │   Video     │  │   Chat Panel    │  │   Room Controls    │   │
│  │   Player    │  │   (Messages)    │  │   (Sync Status)    │   │
│  └─────────────┘  └─────────────────┘  └────────────────────┘   │
└────────────────────────────┬────────────────────────────────────┘
                              │ WebSocket (Socket.IO)
                              ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │                        Node.js Server                            │
 │  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐   │
 │  │   Room Manager  │  │   Chat Handler  │  │  Sync Manager  │   │
 │  └────────┬────────┘  └────────┬────────┘  └───────┬────────┘   │
 └───────────┼────────────────────┼───────────────────┼─────────────┘
             │                    │                   │
             ▼                    ▼                   ▼
        In-Memory           Socket.IO           Broadcast
        Storage             Events              Events
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Local Development

```bash
# Clone the repository
git clone <your-repo-url>
cd watch-together

# Install dependencies
npm install

# Start the server
npm start

# Open http://localhost:3000
```

### Testing with Sample Videos

Use these public domain video URLs for testing:

```
https://www.w3schools.com/html/mov_bbb.mp4
https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4
```

## 📦 Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Backend | Node.js + Express | HTTP server, API endpoints |
| Real-time | Socket.IO | WebSocket communication |
| Video | HTML5 Video | Video playback |
| Styling | CSS3 | Responsive design |
| Deployment | Free options | See below |

## 🔧 Configuration

### Environment Variables

```bash
PORT=3000                    # Server port (default: 3000)
NODE_ENV=development         # Environment

# Pure WebRTC (Built-in, no config needed!)
# Uses native browser WebRTC APIs with Socket.IO signaling
# Works out of the box - no credentials required

# Optional: Add your own TURN server for better NAT traversal
# Edit public/pure-webrtc.js and add to iceServers array

# LiveKit WebRTC (Optional - for production scale)
# Only needed if you want LiveKit SFU features
LIVEKIT_API_KEY=your_api_key         # From livekit.io
LIVEKIT_API_SECRET=your_api_secret  # From livekit.io
LIVEKIT_URL=wss://your-project.livekit.cloud  # LiveKit WebSocket URL

# Cloudinary Configuration (for persistent video storage)
# Get free credentials at: https://cloudinary.com/console
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

### Quick Start (Pure WebRTC - No Config Needed!)

```bash
# Install dependencies
npm install

# Start the server - Pure WebRTC works immediately!
npm start

# Open http://localhost:3000
# Select "WebRTC Live" mode on the landing page
```

## ☁️ Cloud Storage (Free Persistent Uploads)

### Why Cloudinary?

When deploying online (Railway, Render, etc.), the local filesystem is **ephemeral** - uploads are lost on restart!

**Cloudinary Free Tier:**
- 25GB storage
- 300K monthly transformations
- Videos persist forever

### Setup Cloudinary (Free)

1. **Create Account**
   - Go to [cloudinary.com](https://cloudinary.com)
   - Sign up for free (no credit card)

2. **Get Credentials**
   - Go to Console → Settings → API Credentials
   - Copy: Cloud Name, API Key, API Secret

3. **Configure Server**
   ```bash
   # Local development
   export CLOUDINARY_CLOUD_NAME=your_cloud_name
   export CLOUDINARY_API_KEY=your_api_key
   export CLOUDINARY_API_SECRET=your_api_secret
   npm start
   ```

4. **For Deployment (Railway/Render)**
   - Add environment variables in your deployment dashboard
   - Uploads will persist in Cloudinary forever!

### How It Works

| Scenario | Storage Location |
|----------|-----------------|
| Localhost (no Cloudinary) | `uploads/` folder (lost on server restart) |
| Localhost (with Cloudinary) | Cloudinary cloud storage |
| Deployed (no Cloudinary) | Container filesystem (lost on restart) |
| Deployed (with Cloudinary) | Cloudinary cloud storage (persistent!) |

## 📡 WebRTC Streaming Mode

### Two Options Available

The platform supports two WebRTC streaming modes:

| Mode | Latency | Setup Required | Best For |
|------|---------|----------------|----------|
| **Pure WebRTC** | <100ms | None! Works out of box | Quick setup, no external services |
| **LiveKit** | <100ms | API credentials | Production, scalability |
| **URL Mode** | ~100-500ms | None | Watching stored videos |

---

### ✅ Pure WebRTC (Default - No Setup Required!)

**New!** The platform now includes a pure WebRTC implementation using native browser APIs. No external services needed!

**How it works:**
1. Host clicks "📡 Start WebRTC Stream"
2. Browser prompts for camera/microphone access
3. Host's stream is broadcast to all viewers via WebRTC peer-to-peer
4. Viewers click "Join WebRTC Stream" to watch

**Features:**
- Native WebRTC using `RTCPeerConnection`
- Socket.IO for signaling (SDP exchange, ICE candidates)
- Uses Google's public STUN servers for NAT traversal
- Works in most home/office networks

**For better NAT traversal (corporate networks, strict firewalls):**
Add your own TURN server in `public/pure-webrtc.js`:
```javascript
this.iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:your-turn-server.com:3478',
      username: 'user',
      credential: 'password'
    }
  ]
};
```

---

### LiveKit WebRTC (Optional - For Production)

For production deployments with many viewers, LiveKit provides better scalability:

1. **Create LiveKit Account**
   - Go to [livekit.io](https://livekit.io)
   - Sign up (free tier: 20GB traffic/month)
   - Create a new project

2. **Get Credentials**
   - API Key
   - API Secret
   - Project URL (e.g., `wss://your-project.livekit.cloud`)

3. **Configure Server**
   ```bash
   export LIVEKIT_API_KEY=your_key
   export LIVEKIT_API_SECRET=your_secret
   export LIVEKIT_URL=wss://your-project.livekit.cloud
   npm start
   ```

4. **Usage**
   - Host clicks "📡 Start WebRTC Stream"
   - Allows camera/microphone access
   - Viewers automatically join the stream

### Self-Hosted LiveKit (Advanced)

For full control, self-host LiveKit:

```bash
# Using Docker Compose
git clone https://github.com/livekit/livekit
cd livekit
docker-compose up -d
```

Then configure:
```bash
LIVEKIT_URL=wss://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

### Production Considerations

For production, consider:

```bash
# Use process manager
npm install -g pm2
pm2 start server.js --name watch-together

# Or use Docker (see below)
```

## 🐳 Docker Deployment (Free)

### Option 1: Docker Run

```bash
# Build image
docker build -t watch-together .

# Run container
docker run -d \
  --name watch-together \
  -p 3000:3000 \
  -v watch-together-data:/app/data \
  watch-together
```

### Option 2: Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  watch-together:
    build: .
    container_name: watch-together
    ports:
      - "3000:3000"
    restart: unless-stopped
    environment:
      - NODE_ENV=production
    volumes:
      - watch-together-data:/app/data

volumes:
  watch-together-data:
```

Deploy:

```bash
docker-compose up -d
docker-compose logs -f watch-together
```

### Option 3: Railway (Free Tier)

1. Push code to GitHub
2. Go to [railway.app](https://railway.app)
3. "New Project" → "Deploy from GitHub"
4. Select your repo
5. Railway auto-detects Node.js
6. Deploy! (Free tier includes $5 credit/month)

### Option 4: Render (Free Tier)

1. Go to [render.com](https://render.com)
2. "New Web Service"
3. Connect GitHub repo
4. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Create (free tier includes 750 hours/month)

### Option 5: Fly.io (Free Tier)

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login
flyctl auth login

# Launch
flyctl launch

# Set port
flyctl secrets set PORT=8080

# Scale (free tier allows 3 VMs)
flyctl scale count 1
```

## 🔒 Security Considerations

### Current Security (MVP)

- Basic room ID generation (8-character UUID)
- In-memory storage (data lost on restart)
- No authentication required

### Production Security Checklist

```javascript
// server.js - Add these security measures

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

app.use(helmet());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Input validation
const { z } = require('zod');

const messageSchema = z.object({
  message: z.string().min(1).max(500),
  roomId: z.string().min(4).max(8)
});
```

### Recommended Security Improvements

1. **Authentication**
   - Add user login (OAuth, JWT)
   - Room password protection
   - Rate limiting by user

2. **Data Validation**
   - Sanitize all inputs
   - Limit message length
   - Validate video URLs

3. **CORS Configuration**
   ```javascript
   const io = new Server(httpServer, {
     cors: {
       origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
       methods: ["GET", "POST"]
     }
   });
   ```

4. **Room Security**
   ```javascript
   // Generate secure room IDs
   function createSecureRoom() {
     return crypto.randomBytes(4).toString('hex'); // 8 chars
   }
   ```

## 📈 Scalability

### Current Limits (Single Server)

- ~500 concurrent users per room
- ~50 rooms per server
- In-memory storage (not persistent)

### Scaling Options

#### 1. Horizontal Scaling with Redis

```bash
npm install redis socket.io-redis
```

```javascript
// server.js
const redisAdapter = require('socket.io-redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();

io.adapter(createAdapter(pubClient, subClient));
```

#### 2. Multiple Server Instances

```bash
# Start multiple instances behind a load balancer
pm2 start server.js -i 4 --name watch-together-cluster
```

#### 3. Media Streaming (for large audiences)

For >50 viewers, consider:

- **LiveKit** (livekit.io) - Open-source WebRTC SFU
- **mediasoup** - Node.js WebRTC SFU
- **Mux** (mux.com) - Video infrastructure

```javascript
// LiveKit integration example
const { LiveKitClient } = require('livekit-server-sdk');

const livekit = new LiveKitClient({
  apiKey: process.env.LIVEKIT_API_KEY,
  apiSecret: process.env.LIVEKIT_API_SECRET,
});

// For large rooms, offload video streaming to LiveKit
```

### Performance Optimization

```javascript
// Enable compression
const compression = require('compression');
app.use(compression());

// Cache static files
app.use(express.static('public', {
  maxAge: '1d',
  etag: false
}));
```

## 🎨 Customization

### Styling

Edit `public/styles.css` to customize:
- Colors (CSS variables)
- Layout (flexbox/grid)
- Responsive breakpoints

### Features to Add

1. **Video Quality Selection**
   ```javascript
   // In video sync event
   socket.emit('video:play', {
     roomId,
     currentTime,
     quality: '720p' // Add quality param
   });
   ```

2. **Emoji Reactions**
   ```javascript
   socket.on('reaction:send', ({ roomId, emoji }) => {
     socket.to(roomId).emit('reaction:receive', { emoji });
   });
   ```

3. **Polls**
   ```javascript
   socket.on('poll:create', ({ roomId, question, options }) => {
     // Store and broadcast poll
   });
   ```

4. **Video Sources**
   - YouTube embed support
   - Vimeo support  
   - HLS/DASH streaming
   - Local file upload

## 📝 API Reference

### Socket Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `room:create` | Client → Server | `{ userName }` |
| `room:join` | Client → Server | `{ roomId, userName }` |
| `video:play` | Host → Server | `{ roomId, currentTime }` |
| `video:pause` | Host → Server | `{ roomId, currentTime }` |
| `video:seek` | Host → Server | `{ roomId, currentTime }` |
| `video:setSource` | Host → Server | `{ roomId, url }` |
| `chat:send` | Client → Server | `{ roomId, message }` |
| `chat:message` | Server → Client | `{ id, userName, message, timestamp, videoTime }` |

### REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/room/:roomId` | GET | Get room info |
| `/api/upload` | POST | Upload video file |
| `/api/videos` | GET | List uploaded videos |
| `/api/videos/:filename` | DELETE | Delete a video |
| `/uploads/:filename` | GET | Stream uploaded video |
| `/health` | GET | Health check |

### File Upload

The platform now supports **direct file upload**! 

**Supported formats:** MP4, WebM, OGG, MKV, AVI, MOV

**Maximum file size:when ei
**Usage:**
1. As host, drag & drop a video file onto the upload zone
2. Or click the zone to browse files
3. Video uploads automatically and starts playing for everyone!

**Note:** Uploaded files are stored in the `uploads/` directory on the server. For production, consider using cloud storage (S3, GCS, etc.).

## 🐛 Troubleshooting

### Common Issues

1. **Video not loading**
   - Check CORS headers on video server
   - Use direct MP4 links (not streaming protocols)
   - Ensure video server allows cross-origin

2. **Sync drift over time**
   - Host should periodically resync (every 30 seconds)
   - Add drift compensation algorithm

3. **Mobile browser issues**
   - Enable hardware acceleration
   - Handle play() promise rejection (requires user gesture)

### Debug Mode

```bash
DEBUG=* npm start
```

## 📄 License

MIT License - Free for personal and commercial use.

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
5. Open Pull Request

---

Built with ❤️ for the community
