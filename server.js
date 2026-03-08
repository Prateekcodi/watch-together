/**
 * Watch-Together Server with WebRTC Support
 * 
 * Architecture:
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                        Client Browser                           │
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
 │           │                     │                   │             │
 │  ┌────────▼────────┐  ┌────────▼────────┐  ┌───────▼────────┐   │
 │  │  LiveKit Cloud  │  │  Broadcast      │  │  Event Queue   │   │
 │  │  (WebRTC SFU)   │  │  (optimization) │  │  (reliability) │   │
 │  └─────────────────┘  └─────────────────┘  └────────────────┘   │
 └─────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │ Media CDN   │   │ LiveKit     │   │ Your Video  │
   │ (HLS/DASH)  │   │ Cloud       │   │ Files       │
   └─────────────┘   └─────────────┘   └─────────────┘
 * 
 * Why LiveKit for WebRTC?
 * - Open-source WebRTC SFU (Selective Forwarding Unit)
 * - Ultra-low latency (<100ms)
 * - Scalable to thousands of viewers
 * - Free tier: livekit.io (20GB/mo traffic free)
 * 
 * Alternative self-hosted: mediasoup, janus-gateway
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const streamifier = require('streamifier');

// MSE Streaming module (Progressive upload + MSE playback)
const { initMSEUpload } = require('./server-mse');

// ICE Config route (for WebRTC TURN credentials)
const iceConfig = require('./ice-config');

// ============================================
// CLOUDINARY CONFIGURATION (Free Cloud Storage)
// ============================================
// Sign up at cloudinary.com (free tier: 25GB storage, 300K monthly transformations)
// Get your credentials from: https://cloudinary.com/console

let cloudinary = null;
let cloudinaryConfigured = false;

if (process.env.CLOUDINARY_CLOUD_NAME && 
    process.env.CLOUDINARY_API_KEY && 
    process.env.CLOUDINARY_API_SECRET) {
  
  const { v2: cloudinaryV2 } = require('cloudinary');
  cloudinary = cloudinaryV2;
  
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  
  cloudinaryConfigured = true;
  console.log('✅ Cloudinary configured - uploads will persist in cloud!');
} else {
  console.log('⚠️  Cloudinary not configured - using local storage only');
  console.log('   Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET for cloud storage');
  console.log('   Sign up free at: https://cloudinary.com');
}

const app = express();
const httpServer = createServer(app);

// Increase timeout for large file uploads (10 minutes)
httpServer.timeout = 10 * 60 * 1000;
httpServer.keepAliveTimeout = 60 * 1000;
httpServer.headersTimeout = 65 * 1000;

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Initialize MSE Streaming endpoints
initMSEUpload(app);

// ICE Config endpoint for WebRTC TURN credentials
app.use('/api/ice-config', iceConfig);

// ============================================
// FILE UPLOAD CONFIGURATION
// ============================================

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for video uploads
let storage;
if (cloudinaryConfigured) {
  // Use memory storage when Cloudinary is configured
  storage = multer.memoryStorage();
} else {
  // Use disk storage for local uploads
  storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      cb(null, `${Date.now()}_${safeName}`);
    }
  });
}

// Only accept video files
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['video/mp4', 'video/webm', 'video/ogg', 'video/mkv', 'video/quicktime', 'video/x-msvideo', 'application/octet-stream'];
  const allowedExtensions = /\.(mp4|webm|ogg|mkv|avi|mov|flv|wmv)$/i;
  
  // Check MIME type OR file extension
  const extMatch = allowedExtensions.test(file.originalname);
  const mimeMatch = allowedTypes.includes(file.mimetype);
  
  if (mimeMatch || extMatch) {
    cb(null, true);
  } else {
    cb(new Error('Only video files are allowed (mp4, webm, ogg, mkv, avi, mov)'), false);
  }
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB limit
});

// Upload endpoint - accepts video file and returns URL
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file provided' });
  }
  
  try {
    let fileUrl;
    let publicId;
    
    if (cloudinaryConfigured && cloudinary) {
      // Upload to Cloudinary for persistent cloud storage
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'video',
            folder: 'watch-together',
            public_id: `video_${Date.now()}`,
            eager: [
              { streaming_profile: 'hd', format: 'm3u8' }
            ],
            eager_async: true
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
      });
      
      fileUrl = result.secure_url;
      publicId = result.public_id;
      console.log(`☁️ Video uploaded to Cloudinary: ${result.public_id}`);
    } else {
      // Fallback to local storage
      fileUrl = `/uploads/${req.file.filename}`;
      publicId = req.file.filename;
      console.log(`📁 Video saved locally: ${req.file.filename}`);
    }
    
    res.json({
      success: true,
      url: fileUrl,
      filename: publicId,
      originalName: req.file.originalname,
      size: req.file.size,
      isCloud: cloudinaryConfigured
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ============================================
// CHUNKED UPLOAD ENDPOINTS
// ============================================

// In-memory storage for chunked uploads (use Redis for production)
const chunkedUploads = new Map();
const uploadJobs = new Map(); // Track async upload assembly jobs
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

// Initialize chunked upload
app.post('/api/upload/init', express.json(), (req, res) => {
  const { filename, totalSize, totalChunks } = req.body;
  
  const uploadId = uuidv4();
  const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  const tempDir = path.join(uploadsDir, 'chunks', uploadId);
  
  // Create temp directory for chunks
  fs.mkdirSync(tempDir, { recursive: true });
  
  chunkedUploads.set(uploadId, {
    filename: safeName,
    totalSize,
    totalChunks,
    receivedChunks: new Set(),
    tempDir,
    createdAt: Date.now()
  });
  
  res.json({ uploadId, chunkSize: CHUNK_SIZE });
});

// Upload a single chunk
app.post('/api/upload/chunk', upload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex } = req.body;
  
  const upload = chunkedUploads.get(uploadId);
  if (!upload) {
    return res.status(400).json({ error: 'Upload session not found' });
  }
  
  if (!req.file) {
    return res.status(400).json({ error: 'No chunk data provided' });
  }
  
  const chunkNum = parseInt(chunkIndex);
  if (upload.receivedChunks.has(chunkNum)) {
    // Chunk already received, skip
    return res.json({ success: true, chunkIndex: chunkNum, alreadyReceived: true });
  }
  
  // Save chunk to temp file
  const chunkPath = path.join(upload.tempDir, `chunk_${chunkNum}`);
  fs.writeFileSync(chunkPath, req.file.buffer);
  upload.receivedChunks.add(chunkNum);
  
  const progress = (upload.receivedChunks.size / upload.totalChunks) * 100;
  console.log(`Chunked upload ${uploadId}: ${upload.receivedChunks.size}/${upload.totalChunks} chunks (${progress.toFixed(1)}%)`);
  
  res.json({ 
    success: true, 
    chunkIndex: chunkNum,
    received: upload.receivedChunks.size,
    total: upload.totalChunks,
    progress
  });
});

// Complete chunked upload (async - returns immediately, client polls for status)
app.post('/api/upload/complete', express.json(), (req, res) => {
  const { uploadId } = req.body;
  
  const upload = chunkedUploads.get(uploadId);
  if (!upload) {
    return res.status(400).json({ error: 'Upload session not found' });
  }
  
  if (upload.receivedChunks.size !== upload.totalChunks) {
    return res.status(400).json({ 
      error: 'Incomplete upload', 
      received: upload.receivedChunks.size,
      expected: upload.totalChunks 
    });
  }
  
  // Generate job ID
  const jobId = uuidv4();
  
  // Store job status
  uploadJobs.set(jobId, {
    uploadId,
    status: 'processing',
    progress: 0,
    createdAt: Date.now()
  });
  
  // Start assembly in background (don't await)
  assembleChunksAsync(uploadId, jobId);
  
  // Return immediately with job ID
  res.json({ 
    success: true, 
    jobId,
    message: 'Assembly started'
  });
});

// Async chunk assembly function
async function assembleChunksAsync(uploadId, jobId) {
  const upload = chunkedUploads.get(uploadId);
  if (!upload) {
    uploadJobs.set(jobId, { status: 'error', error: 'Upload session not found' });
    return;
  }
  
  try {
    const finalFilename = `${Date.now()}_${upload.filename}`;
    const finalPath = path.join(uploadsDir, finalFilename);
    
    const writeStream = fs.createWriteStream(finalPath);
    
    for (let i = 0; i < upload.totalChunks; i++) {
      const chunkPath = path.join(upload.tempDir, `chunk_${i}`);
      const chunkBuffer = fs.readFileSync(chunkPath);
      writeStream.write(chunkBuffer);
      fs.unlinkSync(chunkPath); // Delete chunk after reading
      
      // Update progress every 10 chunks
      if (i % 10 === 0) {
        const progress = ((i + 1) / upload.totalChunks) * 100;
        uploadJobs.set(jobId, { 
          uploadId, 
          status: 'processing', 
          progress: Math.round(progress) 
        });
      }
    }
    
    writeStream.end();
    
    // Wait for file to be written
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    // Clean up temp directory
    if (fs.existsSync(upload.tempDir)) {
      fs.rmSync(upload.tempDir, { recursive: true, force: true });
    }
    
    // Remove from memory
    chunkedUploads.delete(uploadId);
    
    const fileUrl = `/uploads/${finalFilename}`;
    console.log(`✅ Chunked upload complete: ${finalFilename} (${upload.totalSize} bytes)`);
    
    // Store success result
    uploadJobs.set(jobId, {
      status: 'complete',
      progress: 100,
      result: {
        success: true,
        url: fileUrl,
        filename: finalFilename,
        originalName: upload.filename,
        size: upload.totalSize,
        isCloud: false
      }
    });
    
  } catch (error) {
    console.error('Chunked upload assembly error:', error);
    uploadJobs.set(jobId, { status: 'error', error: error.message });
  }
}

// Get job status endpoint
app.get('/api/upload/status/:jobId', (req, res) => {
  const job = uploadJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
  
  // Clean up completed/error jobs after 5 minutes
  if (job.status === 'complete' || job.status === 'error') {
    setTimeout(() => {
      uploadJobs.delete(req.params.jobId);
    }, 5 * 60 * 1000);
  }
});

// Cancel chunked upload
app.post('/api/upload/cancel', express.json(), (req, res) => {
  const { uploadId } = req.body;
  
  const upload = chunkedUploads.get(uploadId);
  if (upload) {
    // Clean up temp directory
    if (fs.existsSync(upload.tempDir)) {
      fs.rmSync(upload.tempDir, { recursive: true, force: true });
    }
    chunkedUploads.delete(uploadId);
  }
  
  res.json({ success: true });
});

// Clean up stale chunked uploads (run every 30 minutes)
setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour
  
  for (const [uploadId, upload] of chunkedUploads) {
    if (now - upload.createdAt > maxAge) {
      console.log(`Cleaning up stale chunked upload: ${uploadId}`);
      if (fs.existsSync(upload.tempDir)) {
        fs.rmSync(upload.tempDir, { recursive: true, force: true });
      }
      chunkedUploads.delete(uploadId);
    }
  }
}, 30 * 60 * 1000);

// Serve uploaded videos
app.use('/uploads', express.static(uploadsDir));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// List all uploaded videos
app.get('/api/videos', (req, res) => {
  fs.readdir(uploadsDir, (err, files) => {
    if (err) {
      return res.json([]);
    }
    const videos = files
      .filter(f => f.match(/\.(mp4|webm|ogg|mkv|avi|mov)$/i))
      .map(filename => ({
        url: `/uploads/${filename}`,
        filename,
        name: filename.replace(/^\d+_/, ''), // Remove timestamp prefix
        size: fs.statSync(path.join(uploadsDir, filename)).size
      }));
    res.json(videos);
  });
});

// Delete video endpoint
app.delete('/api/videos/:filename', (req, res) => {
  const filepath = path.join(uploadsDir, req.params.filename);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// LiveKit configuration (optional - only needed for WebRTC streaming)
let livekitClient = null;
let livekitApiKey = process.env.LIVEKIT_API_KEY;
let livekitApiSecret = process.env.LIVEKIT_API_SECRET;
let livekitUrl = process.env.LIVEKIT_URL;

if (livekitApiKey && livekitApiSecret) {
  const livekit = require('livekit-server-sdk');
  const AccessToken = livekit.AccessToken;
  const VideoGrant = livekit.VideoGrant || livekit.RoomGrant;
  livekitClient = { AccessToken, VideoGrant };
  console.log('✅ LiveKit configured - WebRTC streaming available');
} else {
  console.log('⚠️  LiveKit not configured - using URL-based streaming only');
  console.log('   Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and LIVEKIT_URL to enable WebRTC');
}

// In-memory room storage (use Redis for production)
const rooms = new Map();

// Room structure
// rooms = {
//   'room-id': {
//     id: 'room-id',
//     host: socket-id,
//     participants: Map<socket-id, { name, role, joinedAt, isPublishing }>,
//     streamingMode: 'url' | 'webrtc',
//     videoState: {
//       url: null,
//       currentTime: 0,
//       isPlaying: false,
//       playbackRate: 1,
//       lastUpdate: Date.now(),
//       livekitRoom: null
//     },
//     chat: [],
//     createdAt: Date.now()
//   }
// }

const PORT = process.env.PORT || 3000;

// ============================================
// ROOM MANAGEMENT
// ============================================

function createRoom(hostSocket, roomId = null, streamingMode = 'url') {
  const id = roomId || uuidv4().substring(0, 8);
  
  if (rooms.has(id)) {
    throw new Error('Room already exists');
  }

  // Validate streaming mode
  const mode = (streamingMode === 'mse') ? 'mse' : 
               (streamingMode === 'webrtc') ? 'webrtc' : 'url';

  const room = {
    id,
    host: hostSocket.id,
    participants: new Map(),
    streamingMode: mode, // 'url', 'mse', or 'webrtc'
    videoState: {
      url: null,
      uploadId: null, // For MSE mode
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1,
      lastUpdate: null,
      lastUpdatedBy: null,
      livekitRoomName: null
    },
    chat: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    markedForDeletion: false
  };

  rooms.set(id, room);
  return room;
}

function joinRoom(socket, roomId, userName) {
  const room = rooms.get(roomId);
  
  if (!room) {
    throw new Error('Room not found');
  }

  // Cancel deletion if room was marked for deletion
  if (room.markedForDeletion) {
    room.markedForDeletion = false;
    console.log(`Room ${roomId} activity resumed, cancellation deletion`);
  }

  // Update last activity timestamp
  room.lastActivity = Date.now();

  // Add participant
  room.participants.set(socket.id, {
    name: userName || `User${room.participants.size + 1}`,
    role: room.participants.size === 0 ? 'host' : 'viewer',
    joinedAt: Date.now(),
    isPublishing: false // For WebRTC
  });

  // If first participant, make them host
  if (room.participants.size === 1) {
    room.host = socket.id;
    room.participants.get(socket.id).role = 'host';
  }

  return room;
}

function leaveRoom(socket) {
  for (const [roomId, room] of rooms) {
    if (room.participants.has(socket.id)) {
      const wasHost = room.host === socket.id;
      const participant = room.participants.get(socket.id);
      
      // If publishing WebRTC, cleanup
      if (participant?.isPublishing && room.videoState.livekitRoomName) {
        socket.to(roomId).emit('webrtc:participantUnpublished', {
          socketId: socket.id
        });
      }
      
      room.participants.delete(socket.id);

      // Update last activity timestamp
      room.lastActivity = Date.now();

      // If host left, assign new host or mark room for deletion
      if (wasHost) {
        if (room.participants.size > 0) {
          const newHost = room.participants.keys().next().value;
          room.host = newHost;
          room.participants.get(newHost).role = 'host';
          
          // Notify new host
          io.to(newHost).emit('room:newHost');
        } else {
          // Room empty, mark for deletion instead of immediate delete
          // This gives users time to reconnect with the same room code
          room.markedForDeletion = true;
          console.log(`Room ${roomId} marked for deletion in 5 minutes (grace period)`);
        }
      }

      // Broadcast user left
      socket.to(roomId).emit('room:userLeft', {
        socketId: socket.id,
        userName: participant?.name
      });

      return roomId;
    }
  }
  return null;
}

function getRoomInfo(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return null;

  return {
    id: room.id,
    participantCount: room.participants.size,
    streamingMode: room.streamingMode,
    isHost: room.host === socketId,
    participants: Array.from(room.participants.entries()).map(([id, p]) => ({
      socketId: id,
      name: p.name,
      role: p.role,
      isPublishing: p.isPublishing
    })),
    videoState: room.videoState,
    createdAt: room.createdAt,
    livekitEnabled: !!livekitClient
  };
}

// ============================================
// LIVEKIT HELPER FUNCTIONS
// ============================================

async function cleanupLivekitRoom(roomName) {
  if (!roomName) return;
  
  // Note: In production, you'd use LiveKit client to delete rooms
  console.log(`LiveKit room ${roomName} cleanup would happen here`);
}

function generateLivekitToken(roomName, participantName, isHost) {
  if (!livekitClient) return null;
  
  const { AccessToken } = livekitClient;
  
  const token = new AccessToken(
    livekitApiKey,
    livekitApiSecret,
    {
      identity: participantName,
      name: participantName,
      ttl: 3600 // 1 hour expiration
    }
  );

  // In LiveKit SDK v1.x, addGrant accepts a plain object
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: isHost, // Only host can publish video
    canSubscribe: true,
    canPublishData: true
  });

  return token.toJwt();
}

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // ----------------------------------------
  // Room Events
  // ----------------------------------------
  
  socket.on('room:create', ({ roomId, userName, streamingMode }, callback) => {
    try {
      const room = createRoom(socket, roomId, streamingMode);
      joinRoom(socket, room.id, userName);
      
      socket.join(room.id);
      
      // Send response via callback
      if (typeof callback === 'function') {
        callback({
          roomId: room.id,
          ...getRoomInfo(room.id, socket.id)
        });
      }
      
      console.log(`Room created: ${room.id} by ${socket.id} (mode: ${room.streamingMode})`);
    } catch (error) {
      if (typeof callback === 'function') {
        callback({ error: error.message });
      }
    }
  });

  socket.on('room:join', ({ roomId, userName }, callback) => {
    try {
      const room = joinRoom(socket, roomId, userName);
      socket.join(roomId);
      
      // Calculate current video time if video is playing
      let currentTime = room.videoState.currentTime;
      if (room.videoState.isPlaying && room.videoState.lastUpdate) {
        const timeSinceUpdate = (Date.now() - room.videoState.lastUpdate) / 1000;
        currentTime += timeSinceUpdate;
      }
      
      // Send response via callback
      if (typeof callback === 'function') {
        callback({
          roomId: room.id,
          ...getRoomInfo(room.id, socket.id),
          chat: room.chat.slice(-50),
          videoState: {
            url: room.videoState.url,
            currentTime: currentTime,
            isPlaying: room.videoState.isPlaying
          }
        });
      }

      // Notify others
      socket.to(roomId).emit('room:userJoined', {
        socketId: socket.id,
        userName: room.participants.get(socket.id).name,
        participantCount: room.participants.size
      });

      console.log(`User ${userName} joined room: ${roomId}`);
    } catch (error) {
      if (typeof callback === 'function') {
        callback({ error: error.message });
      }
    }
  });

  socket.on('room:leave', () => {
    const roomId = leaveRoom(socket);
    if (roomId) {
      socket.leave(roomId);
      socket.emit('room:left', { roomId });
    }
  });

  socket.on('room:getInfo', ({ roomId }, callback) => {
    const info = getRoomInfo(roomId);
    if (info) {
      callback(info);
    } else {
      callback(null);
    }
  });

  // ----------------------------------------
  // Video URL Mode Events
  // ----------------------------------------

  socket.on('video:setSource', ({ roomId, url }) => {
    console.log('Video source request:', { roomId, url, socketId: socket.id });
    const room = rooms.get(roomId);
    if (!room) return;
    
    // Only host can change video source
    if (room.host !== socket.id) {
      socket.emit('video:error', { message: 'Only host can change video source' });
      return;
    }

    // Switch to URL mode
    room.streamingMode = 'url';
    room.videoState = {
      url,
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1,
      lastUpdate: Date.now(),
      lastUpdatedBy: socket.id,
      livekitRoomName: null
    };

    io.to(roomId).emit('video:sourceChanged', {
      url,
      mode: 'url',
      setBy: room.participants.get(socket.id).name
    });
  });

  socket.on('video:play', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) {
      socket.emit('video:error', { message: 'Only host can control playback' });
      return;
    }

    room.videoState.isPlaying = true;
    room.videoState.currentTime = currentTime;
    room.videoState.lastUpdate = Date.now();
    room.videoState.lastUpdatedBy = socket.id;

    socket.to(roomId).emit('video:play', {
      currentTime,
      timestamp: Date.now()
    });
  });

  socket.on('video:pause', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) {
      socket.emit('video:error', { message: 'Only host can control playback' });
      return;
    }

    room.videoState.isPlaying = false;
    room.videoState.currentTime = currentTime;
    room.videoState.lastUpdate = Date.now();
    room.videoState.lastUpdatedBy = socket.id;

    socket.to(roomId).emit('video:pause', {
      currentTime,
      timestamp: Date.now()
    });
  });

  socket.on('video:seek', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) {
      socket.emit('video:error', { message: 'Only host can control playback' });
      return;
    }

    room.videoState.currentTime = currentTime;
    room.videoState.lastUpdate = Date.now();
    room.videoState.lastUpdatedBy = socket.id;

    socket.to(roomId).emit('video:seek', {
      currentTime,
      timestamp: Date.now()
    });
  });

  // ----------------------------------------
  // MSE Streaming Events (Progressive Upload)
  // ----------------------------------------

  socket.on('mse:uploadComplete', ({ roomId, uploadId, filename, size }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    // Only host can set MSE upload
    if (room.host !== socket.id) {
      socket.emit('mse:error', { message: 'Only host can start MSE streaming' });
      return;
    }

    // Switch to MSE mode
    room.streamingMode = 'mse';
    room.videoState = {
      url: null,
      uploadId: uploadId,
      filename: filename,
      size: size,
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1,
      lastUpdate: Date.now(),
      lastUpdatedBy: socket.id,
      livekitRoomName: null
    };

    // Notify viewers that MSE stream is ready
    socket.to(roomId).emit('mse:streamReady', {
      uploadId,
      filename,
      size,
      hostName: room.participants.get(socket.id).name
    });

    console.log(`[MSE] Upload complete for room ${roomId}: ${uploadId}`);
  });

  socket.on('mse:play', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) return;

    room.videoState.isPlaying = true;
    room.videoState.currentTime = currentTime;
    room.videoState.lastUpdate = Date.now();

    socket.to(roomId).emit('mse:play', {
      currentTime,
      timestamp: Date.now()
    });
  });

  socket.on('mse:pause', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) return;

    room.videoState.isPlaying = false;
    room.videoState.currentTime = currentTime;
    room.videoState.lastUpdate = Date.now();

    socket.to(roomId).emit('mse:pause', {
      currentTime,
      timestamp: Date.now()
    });
  });

  socket.on('mse:seek', ({ roomId, currentTime }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) return;

    room.videoState.currentTime = currentTime;
    room.videoState.lastUpdate = Date.now();

    socket.to(roomId).emit('mse:seek', {
      currentTime,
      timestamp: Date.now()
    });
  });

  // ----------------------------------------
  // WebRTC Streaming Events (LiveKit)
  // ----------------------------------------

  socket.on('webrtc:startStreaming', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) {
      socket.emit('webrtc:error', { message: 'Only host can start streaming' });
      return;
    }

    if (!livekitClient) {
      socket.emit('webrtc:error', { message: 'WebRTC streaming not configured on server' });
      return;
    }

    // Create LiveKit room name
    const livekitRoomName = `watch-together-${roomId}`;
    room.videoState.livekitRoomName = livekitRoomName;
    room.streamingMode = 'webrtc';
    
    console.log(`[WebRTC] Starting streaming for room ${roomId}`);
    console.log(`[WebRTC] LiveKit room name: ${livekitRoomName}`);
    console.log(`[WebRTC] LiveKit URL: ${livekitUrl}`);
    
    // Generate host token
    const hostToken = generateLivekitToken(livekitRoomName, room.participants.get(socket.id).name, true);
    
    console.log(`[WebRTC] Token generated: ${hostToken ? 'present' : 'missing'}`);

    // Update participant as publishing
    room.participants.get(socket.id).isPublishing = true;

    socket.emit('webrtc:streamingStarted', {
      roomName: livekitRoomName,
      token: hostToken,
      url: livekitUrl
    });

    // Notify viewers
    socket.to(roomId).emit('webrtc:hostStartedStreaming', {
      hostName: room.participants.get(socket.id).name
    });
  });

  socket.on('webrtc:joinAsViewer', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (!livekitClient) {
      socket.emit('webrtc:error', { message: 'WebRTC streaming not configured on server' });
      return;
    }

    if (!room.videoState.livekitRoomName) {
      socket.emit('webrtc:error', { message: 'Host is not streaming' });
      return;
    }

    // Generate viewer token
    const userName = room.participants.get(socket.id)?.name || 'Viewer';
    const viewerToken = generateLivekitToken(room.videoState.livekitRoomName, userName, false);

    socket.emit('webrtc:viewerJoined', {
      roomName: room.videoState.livekitRoomName,
      token: viewerToken,
      url: livekitUrl
    });
  });

  socket.on('webrtc:stopStreaming', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) return;

    const roomName = room.videoState.livekitRoomName;
    room.streamingMode = 'url';
    room.videoState.livekitRoomName = null;
    room.participants.get(socket.id).isPublishing = false;

    cleanupLivekitRoom(roomName);

    io.to(roomId).emit('webrtc:streamingStopped', {
      by: room.participants.get(socket.id).name
    });
  });

  // ----------------------------------------
  // PURE WEBRTC SIGNALING (No LiveKit required!)
  // ----------------------------------------

  // Host starts broadcasting
  socket.on('webrtc:host-started', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) {
      socket.emit('webrtc:error', { message: 'Only host can start broadcasting' });
      return;
    }

    // Switch to WebRTC mode
    room.streamingMode = 'webrtc';
    room.videoState.livekitRoomName = null; // Using pure WebRTC, not LiveKit
    room.participants.get(socket.id).isPublishing = true;

    console.log(`[PureWebRTC] Host started broadcasting in room ${roomId}`);

    // Notify all viewers that host is streaming
    socket.to(roomId).emit('webrtc:host-started', {
      hostId: socket.id,
      hostName: room.participants.get(socket.id).name
    });
  });

  // Viewer requests to receive host's stream
  socket.on('webrtc:join-viewer', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Check if host is publishing
    const hostParticipant = room.participants.get(room.host);
    if (!hostParticipant?.isPublishing) {
      socket.emit('webrtc:error', { message: 'Host is not broadcasting' });
      return;
    }

    console.log(`[PureWebRTC] Viewer ${socket.id} joining room ${roomId}`);

    // Tell the host about this viewer (host will create offer)
    socket.to(room.host).emit('webrtc:new-viewer', {
      viewerId: socket.id,
      viewerName: room.participants.get(socket.id)?.name || 'Viewer'
    });
  });

  // Host creates offer for viewer
  socket.on('webrtc:host-offer', ({ roomId, viewerId, offer }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    // Only host can send offers
    if (room.host !== socket.id) return;

    // Send offer to specific viewer
    io.to(viewerId).emit('webrtc:viewer-offer', {
      hostId: socket.id,
      offer
    });

    console.log(`[PureWebRTC] Host sent offer to viewer ${viewerId}`);
  });

  // Viewer sends answer to host
  socket.on('webrtc:viewer-answer', ({ roomId, hostId, answer }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Send answer back to host
    io.to(hostId).emit('webrtc:host-answer', {
      viewerId: socket.id,
      answer
    });

    console.log(`[PureWebRTC] Viewer sent answer to host ${hostId}`);
  });

  // ICE candidate exchange - viewer to host
  socket.on('webrtc:viewer-ice-candidate', ({ roomId, candidate }) => {
    const room = rooms.get(roomId);
    if (!room) {
      console.log(`[PureWebRTC] ICE: Room ${roomId} not found for viewer candidate`);
      return;
    }
    
    console.log(`[PureWebRTC] Viewer ${socket.id} sending ICE candidate to host ${room.host}`);
    
    // Send ICE candidate to host
    io.to(room.host).emit('webrtc:host-ice-candidate', {
      viewerId: socket.id,
      candidate
    });
  });

  // ICE candidate exchange - host to viewer
  socket.on('webrtc:host-ice-candidate', ({ roomId, viewerId, candidate }) => {
    console.log(`[PureWebRTC] Host sending ICE candidate to viewer ${viewerId} in room ${roomId}`);
    
    // Send ICE candidate to specific viewer
    io.to(viewerId).emit('webrtc:viewer-ice-candidate', {
      hostId: socket.id,
      candidate
    });
    
    console.log(`[PureWebRTC] ICE candidate sent to viewer ${viewerId}`);
  });

  // Host stops broadcasting
  socket.on('webrtc:host-stopped', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    if (room.host !== socket.id) return;

    room.streamingMode = 'url';
    room.videoState.livekitRoomName = null;
    room.participants.get(socket.id).isPublishing = false;

    // Notify all viewers
    io.to(roomId).emit('webrtc:host-stopped', {
      hostId: socket.id
    });

    console.log(`[PureWebRTC] Host stopped broadcasting in room ${roomId}`);
  });

  // Viewer requests a new offer (for connection retry)
  socket.on('webrtc:request-offer', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      console.log(`[PureWebRTC] Room ${roomId} not found for offer request`);
      return;
    }
    
    // Check if host is publishing
    const hostParticipant = room.participants.get(room.host);
    if (!hostParticipant?.isPublishing) {
      socket.emit('webrtc:error', { message: 'Host is not broadcasting' });
      return;
    }
    
    console.log(`[PureWebRTC] Viewer ${socket.id} requesting new offer in room ${roomId}`);
    
    // Tell the host to create a new offer for this viewer
    socket.to(room.host).emit('webrtc:new-viewer', {
      viewerId: socket.id,
      viewerName: room.participants.get(socket.id)?.name || 'Viewer',
      isRetry: true
    });
  });

  // Viewer sends ICE restart offer (for ICE timeout recovery)
  socket.on('webrtc:ice-restart-offer', ({ roomId, hostId, offer }) => {
    const room = rooms.get(roomId);
    if (!room) {
      console.log(`[PureWebRTC] Room ${roomId} not found for ICE restart`);
      return;
    }
    
    // Send ICE restart offer to host
    console.log(`[PureWebRTC] Viewer sending ICE restart offer to host ${hostId}`);
    io.to(hostId).emit('webrtc:ice-restart-offer', {
      roomId,
      viewerId: socket.id,
      offer
    });
  });

  // Viewer leaves
  socket.on('webrtc:viewer-left', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Notify host that viewer left
    io.to(room.host).emit('webrtc:viewer-left', {
      viewerId: socket.id
    });
  });

  socket.on('video:getState', ({ roomId }, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback(null);
      return;
    }

    let adjustedTime = room.videoState.currentTime;
    if (room.videoState.isPlaying && room.videoState.lastUpdate) {
      const elapsed = (Date.now() - room.videoState.lastUpdate) / 1000;
      adjustedTime += elapsed * room.videoState.playbackRate;
    }

    callback({
      ...room.videoState,
      adjustedTime,
      streamingMode: room.streamingMode
    });
  });

  // ----------------------------------------
  // Chat Events
  // ----------------------------------------

  socket.on('chat:send', ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const chatMessage = {
      id: uuidv4(),
      socketId: socket.id,
      userName: room.participants.get(socket.id)?.name || 'Anonymous',
      message: message.substring(0, 500),
      timestamp: Date.now(),
      videoTime: room.videoState.currentTime
    };

    room.chat.push(chatMessage);
    
    if (room.chat.length > 1000) {
      room.chat = room.chat.slice(-1000);
    }

    io.to(roomId).emit('chat:message', chatMessage);
  });

  // ----------------------------------------
  // Connection Events
  // ----------------------------------------

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    leaveRoom(socket);
  });
});

// ============================================
// API ROUTES
// ============================================

app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  res.json({
    id: room.id,
    participantCount: room.participants.size,
    streamingMode: room.streamingMode,
    hasVideo: !!room.videoState.url,
    livekitEnabled: !!livekitClient,
    createdAt: room.createdAt
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    livekitConfigured: !!livekitClient
  });
});

// ============================================
// ROOM CLEANUP TASK
// ============================================
// Periodically clean up rooms that have been empty for too long
const ROOM_GRACE_PERIOD = 5 * 60 * 1000; // 5 minutes in milliseconds
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.markedForDeletion && (now - room.lastActivity > ROOM_GRACE_PERIOD)) {
      console.log(`Cleaning up empty room: ${roomId}`);
      cleanupLivekitRoom(room.videoState.livekitRoomName);
      rooms.delete(roomId);
    }
  }
}, 60 * 1000); // Run every minute

// Start server
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║          Watch-Together Server Started                     ║
║                                                            ║
║  Local:   http://localhost:${PORT}                            ║
║  API:     http://localhost:${PORT}/api/room/:roomId          ║
║                                                            ║
║  Active Rooms: ${rooms.size}                                       ║
║  WebRTC Mode: ${livekitClient ? '✅ Enabled' : '❌ Not configured'}    ║
╚════════════════════════════════════════════════════════════╝
  `);
});

module.exports = { app, io };
