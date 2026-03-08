/**
 * MSE Streaming Server Module
 * 
 * Architecture for Progressive Upload + MSE Playback:
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                        Client Browser                           │
 * │  ┌─────────────┐  ┌─────────────────┐  ┌────────────────────┐   │
 * │  │   MSE       │  │   Chat Panel    │  │   Sync Controls    │   │
 * │  │   Player    │  │   (Messages)    │  │   (Play/Pause/Seek)│   │
 * │  └─────────────┘  └─────────────────┘  └────────────────────┘   │
 * └────────────────────────────┬────────────────────────────────────┘
 *                              │ Socket.IO (events + chunk metadata)
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                        Node.js Server                            │
 * │  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐   │
 * │  │   Chunk Upload  │  │   MSE Chunks    │  │   Sync Manager │   │
 * │  │   (POST /chunk) │  │   (GET /chunk)  │  │   (events)     │   │
 * │  └────────┬────────┘  └────────┬────────┘  └───────┬────────┘   │
 * │           │                     │                   │             │
 * │  ┌────────▼────────┐  ┌────────▼────────┐  ┌───────▼────────┐   │
 * │  │   File System   │  │   Room State    │  │   Broadcast    │   │
 * │  │   (temp chunks) │  │   (memory)      │  │   (events)     │   │
 * │  └─────────────────┘  └─────────────────┘  └────────────────┘   │
 * └─────────────────────────────────────────────────────────────────┘
 * 
 * Why This Approach is More Reliable Than WebRTC:
 * - Uses standard HTTP (port 80/443) - no UDP blocking
 * - Works through proxies, firewalls, corporate networks
 * - No TURN/STUN servers needed
 * - CDN-friendly for scaling
 * - Progressive playback - viewers can start before upload finishes
 * 
 * Trade-offs vs HLS:
 * HLS: + Better CDN support, + Adaptive bitrate
 * MSE: + Lower latency, + Real-time sync, + No transcoding needed
 * 
 * For watch-together, MSE is better because:
 * - We need real-time sync (HLS has 10-30s latency)
 * - Host controls playback for all viewers
 * - Same video quality for everyone
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// MSE Streaming configuration
const MSE_CHUNK_SIZE = 1 * 1024 * 1024; // 1MB chunks (optimal for MSE)
const MSE_UPLOADS_DIR = path.join(__dirname, 'uploads', 'mse');
const MSE_ROOMS = new Map(); // In-memory room state

// Create MSE uploads directory
if (!fs.existsSync(MSE_UPLOADS_DIR)) {
  fs.mkdirSync(MSE_UPLOADS_DIR, { recursive: true });
}

// ============================================
// MSE UPLOAD ENDPOINTS
// ============================================

// Initialize MSE upload session
function initMSEUpload(app) {
  app.post('/api/mse/init', express.json(), (req, res) => {
    const { filename, totalSize, totalChunks } = req.body;
    
    const uploadId = uuidv4();
    const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const tempDir = path.join(MSE_UPLOADS_DIR, uploadId);
    
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      
      const uploadSession = {
        id: uploadId,
        filename: safeName,
        originalName: filename,
        totalSize,
        totalChunks,
        receivedChunks: new Set(),
        tempDir,
        createdAt: Date.now(),
        isComplete: false,
        duration: 0, // Will be extracted from video
        mimeType: 'video/mp4'
      };
      
      MSE_ROOMS.set(`upload_${uploadId}`, uploadSession);
      
      console.log(`📤 MSE upload initialized: ${uploadId} (${totalChunks} chunks)`);
      
      res.json({ 
        uploadId, 
        chunkSize: MSE_CHUNK_SIZE,
        message: 'Upload session created - start sending chunks'
      });
    } catch (error) {
      console.error('MSE init error:', error);
      res.status(500).json({ error: 'Failed to initialize upload' });
    }
  });

  // Upload a single MSE chunk
  app.post('/api/mse/chunk', express.json({ limit: '50mb' }), (req, res) => {
    const { uploadId, chunkIndex, chunkData, isLastChunk } = req.body;
    
    const sessionKey = `upload_${uploadId}`;
    const session = MSE_ROOMS.get(sessionKey);
    
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }
    
    try {
      // Skip if chunk already received
      if (session.receivedChunks.has(chunkIndex)) {
        return res.json({ 
          success: true, 
          chunkIndex,
          alreadyReceived: true,
          progress: (session.receivedChunks.size / session.totalChunks) * 100
        });
      }
      
      // Decode base64 chunk data
      const chunkBuffer = Buffer.from(chunkData, 'base64');
      const chunkPath = path.join(session.tempDir, `chunk_${chunkIndex}`);
      fs.writeFileSync(chunkPath, chunkBuffer);
      session.receivedChunks.add(chunkIndex);
      
      const progress = (session.receivedChunks.size / session.totalChunks) * 100;
      
      // If this is the last chunk, calculate duration and finalize
      if (isLastChunk) {
        session.isComplete = true;
        session.completedAt = Date.now();
        console.log(`✅ MSE upload complete: ${uploadId} (${session.receivedChunks.size}/${session.totalChunks} chunks)`);
      }
      
      res.json({ 
        success: true, 
        chunkIndex,
        isComplete: session.isComplete,
        received: session.receivedChunks.size,
        total: session.totalChunks,
        progress: Math.round(progress * 100) / 100
      });
    } catch (error) {
      console.error('MSE chunk upload error:', error);
      res.status(500).json({ error: 'Failed to save chunk' });
    }
  });

  // Get MSE chunk for streaming
  app.get('/api/mse/chunk/:uploadId/:chunkIndex', (req, res) => {
    const { uploadId, chunkIndex } = req.params;
    
    const sessionKey = `upload_${uploadId}`;
    const session = MSE_ROOMS.get(sessionKey);
    
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }
    
    const chunkNum = parseInt(chunkIndex);
    
    // If chunk doesn't exist yet, wait for it
    if (!session.receivedChunks.has(chunkNum)) {
      return res.status(206).json({ 
        error: 'Chunk not available yet',
        received: session.receivedChunks.size,
        requested: chunkNum
      });
    }
    
    const chunkPath = path.join(session.tempDir, `chunk_${chunkNum}`);
    
    if (!fs.existsSync(chunkPath)) {
      return res.status(404).json({ error: 'Chunk file not found' });
    }
    
    const chunkBuffer = fs.readFileSync(chunkPath);
    
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': chunkBuffer.length,
      'Content-Range': `bytes ${chunkNum * MSE_CHUNK_SIZE}-${(chunkNum + 1) * MSE_CHUNK_SIZE - 1}/${session.totalSize}`,
      'Accept-Ranges': 'bytes'
    });
    
    res.send(chunkBuffer);
  });

  // Get complete video (all chunks concatenated) - for fallback playback
  app.get('/api/mse/video/:uploadId', async (req, res) => {
    const { uploadId } = req.params;
    
    const sessionKey = `upload_${uploadId}`;
    const session = MSE_ROOMS.get(sessionKey);
    
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }
    
    if (!session.isComplete) {
      return res.status(400).json({ error: 'Upload not complete yet' });
    }
    
    try {
      // Concatenate all chunks into a buffer
      const chunks = [];
      let totalSize = 0;
      
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(session.tempDir, `chunk_${i}`);
        if (fs.existsSync(chunkPath)) {
          const chunkBuffer = fs.readFileSync(chunkPath);
          chunks.push(chunkBuffer);
          totalSize += chunkBuffer.length;
        }
      }
      
      // Concatenate all buffers
      const videoBuffer = Buffer.concat(chunks);
      
      res.set({
        'Content-Type': 'video/mp4',
        'Content-Length': videoBuffer.length,
        'Content-Disposition': `inline; filename="${session.filename}"`
      });
      
      res.send(videoBuffer);
      
      console.log(`Served complete video: ${uploadId} (${totalSize} bytes)`);
      
    } catch (error) {
      console.error('Error serving complete video:', error);
      res.status(500).json({ error: 'Failed to serve video' });
    }
  });

  // Get MSE upload session status
  app.get('/api/mse/status/:uploadId', (req, res) => {
    const sessionKey = `upload_${req.params.uploadId}`;
    const session = MSE_ROOMS.get(sessionKey);
    
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }
    
    res.json({
      uploadId: session.id,
      filename: session.originalName,
      totalSize: session.totalSize,
      totalChunks: session.totalChunks,
      receivedChunks: session.receivedChunks.size,
      progress: (session.receivedChunks.size / session.totalChunks) * 100,
      isComplete: session.isComplete,
      createdAt: session.createdAt
    });
  });

  // Get list of available chunks for streaming
  app.get('/api/mse/available/:uploadId', (req, res) => {
    const sessionKey = `upload_${req.params.uploadId}`;
    const session = MSE_ROOMS.get(sessionKey);
    
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }
    
    res.json({
      uploadId: session.id,
      filename: session.originalName,
      totalChunks: session.totalChunks,
      availableChunks: Array.from(session.receivedChunks).sort((a, b) => a - b),
      totalSize: session.totalSize,
      chunkSize: MSE_CHUNK_SIZE,
      isComplete: session.isComplete
    });
  });

  // Cancel MSE upload
  app.delete('/api/mse/upload/:uploadId', (req, res) => {
    const sessionKey = `upload_${req.params.uploadId}`;
    const session = MSE_ROOMS.get(sessionKey);
    
    if (session) {
      // Clean up temp directory
      if (fs.existsSync(session.tempDir)) {
        fs.rmSync(session.tempDir, { recursive: true, force: true });
      }
      MSE_ROOMS.delete(sessionKey);
    }
    
    res.json({ success: true });
  });

  // Clean up stale uploads (run every 30 minutes)
  setInterval(() => {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour
    
    for (const [key, session] of MSE_ROOMS) {
      if (key.startsWith('upload_') && now - session.createdAt > maxAge) {
        console.log(`Cleaning up stale MSE upload: ${session.id}`);
        if (fs.existsSync(session.tempDir)) {
          fs.rmSync(session.tempDir, { recursive: true, force: true });
        }
        MSE_ROOMS.delete(key);
      }
    }
  }, 30 * 60 * 1000);

  console.log('✅ MSE Streaming endpoints initialized');
}

// Export for use in main server
module.exports = { initMSEUpload, MSE_ROOMS, MSE_CHUNK_SIZE, MSE_UPLOADS_DIR };
