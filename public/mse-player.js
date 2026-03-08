/**
 * MSE Player Module
 * 
 * Progressive Upload + MSE Playback for Watch-Together
 * 
 * Key Features:
 * - Chunked video upload (1MB chunks)
 * - Progressive playback as chunks arrive
 * - Real-time sync via Socket.IO
 * - No WebRTC, no UDP, no ISP blocking
 */

class MSEPlayer {
  constructor(options = {}) {
    this.videoElement = options.videoElement;
    this.socket = options.socket;
    this.roomId = options.roomId;
    this.uploadId = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.availableChunks = new Set();
    this.currentChunk = 0;
    this.isBuffering = false;
    this.isPlaying = false;
    this.chunkSize = 1024 * 1024; // 1MB
    this.isHost = false;
    this.syncEnabled = true;
    this.lastSyncTime = null;
    this.retryCount = 0;
    this.maxRetries = 3;
    
    console.log('MSE Player initialized');
  }
  
  // Define callback methods
  onSourceOpen() {
    console.log('MediaSource opened');
    this.sourceBuffer = this.mediaSource.addSourceBuffer('video/mp4');
    this.sourceBuffer.mode = 'segments';
    this.sourceBuffer.addEventListener('updateend', () => this.onBufferUpdateEnd());
    this.sourceBuffer.addEventListener('error', (e) => console.error('SourceBuffer error:', e));
  }
  
  onSourceEnded() {
    console.log('MediaSource ended');
  }
  
  onSourceError(e) {
    console.error('MediaSource error:', e);
  }
  
  onBufferUpdateEnd() {
    if (this.videoElement.paused && this.availableChunks.size > 0) {
      this.videoElement.play().catch(e => console.log('Auto-play blocked:', e));
    }
  }
  
  /**
   * Initialize MSE upload for a video file
   * @param {File} file - The video file to upload
   * @returns {Promise<string>} uploadId
   */
  async initUpload(file) {
    console.log(`📤 Initializing MSE upload for: ${file.name} (${this.formatBytes(file.size)})`);
    
    // Calculate chunks
    const totalSize = file.size;
    const totalChunks = Math.ceil(totalSize / this.chunkSize);
    
    // Initialize upload session
    const initResponse = await fetch('/api/mse/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        totalSize,
        totalChunks
      })
    });
    
    if (!initResponse.ok) {
      throw new Error('Failed to initialize upload');
    }
    
    const { uploadId } = await initResponse.json();
    this.uploadId = uploadId;
    
    console.log(`Upload session created: ${uploadId}`);
    
    // Upload chunks in parallel (max 3 concurrent)
    await this.uploadChunks(file, uploadId, totalChunks);
    
    return uploadId;
  }
  
  /**
   * Upload video chunks to server
   */
  async uploadChunks(file, uploadId, totalChunks) {
    const progressFill = document.getElementById('mse-progress-fill');
    const progressText = document.getElementById('mse-progress-text');
    const statusEl = document.getElementById('mse-upload-status');
    
    if (progressFill) progressFill.style.width = '0%';
    
    let uploadedChunks = 0;
    const chunkReaders = [];
    
    // Read and upload chunks
    for (let i = 0; i < totalChunks; i++) {
      const start = i * this.chunkSize;
      const end = Math.min(start + this.chunkSize, file.size);
      const chunk = file.slice(start, end);
      
      const reader = new FileReader();
      
      const chunkPromise = new Promise((resolve, reject) => {
        reader.onload = async (e) => {
          try {
            const chunkData = e.target.result.split(',')[1]; // Get base64 data
            const isLastChunk = i === totalChunks - 1;
            
            const response = await fetch('/api/mse/chunk', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                uploadId,
                chunkIndex: i,
                chunkData,
                isLastChunk
              })
            });
            
            if (!response.ok) {
              throw new Error(`Failed to upload chunk ${i}`);
            }
            
            uploadedChunks++;
            const progress = (uploadedChunks / totalChunks) * 100;
            
            if (progressFill) progressFill.style.width = `${progress}%`;
            if (progressText) progressText.textContent = `${Math.round(progress)}%`;
            if (statusEl) statusEl.textContent = `Uploading: ${uploadedChunks}/${totalChunks} chunks`;
            
            resolve({ chunkIndex: i, progress });
          } catch (error) {
            reject(error);
          }
        };
        
        reader.onerror = () => reject(new Error(`Failed to read chunk ${i}`));
        reader.readAsDataURL(chunk);
      });
      
      chunkReaders.push(chunkPromise);
      
      // Limit concurrent uploads
      if (chunkReaders.length >= 3) {
        await Promise.all(chunkReaders);
        chunkReaders.length = 0;
      }
    }
    
    // Wait for remaining chunks
    if (chunkReaders.length > 0) {
      await Promise.all(chunkReaders);
    }
    
    if (statusEl) statusEl.textContent = 'Upload complete! Preparing stream...';
    console.log(`✅ Upload complete: ${totalChunks} chunks`);
    
    return true;
  }
  
  /**
   * Start MSE playback with available chunks
   */
  async startPlayback() {
    if (!this.uploadId) {
      throw new Error('No upload session');
    }
    
    console.log(`🎬 Starting MSE playback for: ${this.uploadId}`);
    
    // Check if MediaSource is supported
    if (!window.MediaSource) {
      console.warn('MediaSource API not available');
      throw new Error('MediaSource not supported in this browser');
    }
    
    // Check for MP4 codec support - try different codec strings
    const codecTests = [
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', // Standard H.264/AAC
      'video/mp4; codecs="avc1.42E01E"', // H.264 only
      'video/mp4', // Basic MP4
      'video/mp4; codecs="avc3.42E01E, mp4a.40.2"', // H.264 high
    ];
    
    let supportedCodec = null;
    for (const codec of codecTests) {
      if (MediaSource.isTypeSupported(codec)) {
        supportedCodec = codec;
        console.log(`Supported codec: ${codec}`);
        break;
      }
    }
    
    if (!supportedCodec) {
      console.warn('No supported MP4 codec found');
      console.log('Checking what codecs are supported...');
      
      // Debug: log what actually is supported
      const testCodecs = ['video/mp4', 'video/webm', 'video/mp4; codecs="avc1.42E01E"'];
      for (const test of testCodecs) {
        console.log(`  ${test}: ${MediaSource.isTypeSupported(test)}`);
      }
      
      throw new Error('No supported MP4 codec in this browser. Try Chrome or Edge.');
    }
    
    // Create MediaSource
    this.mediaSource = new MediaSource();
    
    // Replace video source
    this.videoElement.src = URL.createObjectURL(this.mediaSource);
    
    // Wait for source to open
    await new Promise((resolve, reject) => {
      this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
      this.mediaSource.addEventListener('sourceerror', reject, { once: true });
    });
    
    console.log('MediaSource opened');
    
    // Create source buffer with the supported codec
    this.sourceBuffer = this.mediaSource.addSourceBuffer(supportedCodec);
    this.sourceBuffer.mode = 'segments';
    
    // Listen for buffer events
    this.sourceBuffer.addEventListener('updateend', () => this.onBufferUpdateEnd());
    this.sourceBuffer.addEventListener('error', (e) => {
      console.error('SourceBuffer error:', e);
      this.onSourceBufferError(e);
    });
    
    // Set up polling for new chunks
    this.startChunkPolling();
    
    // Set up video event listeners
    this.videoElement.addEventListener('ended', () => this.onVideoEnded());
    this.videoElement.addEventListener('timeupdate', () => this.onVideoTimeUpdate());
    
    console.log('MSE playback initialized');
  }
  
  /**
   * Poll server for available chunks and append to buffer
   */
  startChunkPolling() {
    const pollInterval = 500; // Poll faster (500ms)
    
    const poll = async () => {
      if (!this.uploadId || this.videoElement.ended) {
        return;
      }
      
      try {
        const response = await fetch(`/api/mse/available/${this.uploadId}`);
        
        if (!response.ok) {
          throw new Error('Failed to get available chunks');
        }
        
        const data = await response.json();
        const available = new Set(data.availableChunks);
        
        // Find chunks we haven't processed yet
        const newChunks = [];
        for (const chunkIndex of available) {
          if (!this.availableChunks.has(chunkIndex)) {
            newChunks.push(chunkIndex);
          }
        }
        
        // Sort and append chunks
        if (newChunks.length > 0) {
          newChunks.sort((a, b) => a - b);
          
          // Process chunks sequentially
          for (const chunkIndex of newChunks) {
            await this.appendChunk(chunkIndex);
            this.availableChunks.add(chunkIndex);
          }
          
          // Update UI
          this.updateBufferStatus(data);
          
          // Try to start playback if we have chunks
          this.tryStartPlayback();
        }
        
      } catch (error) {
        console.error('Chunk polling error:', error);
      }
      
      // Continue polling
      if (!this.videoElement.ended) {
        setTimeout(poll, pollInterval);
      }
    };
    
    poll();
  }
  
  /**
   * Try to start playback if we have buffered data
   */
  tryStartPlayback() {
    if (this.videoElement.paused && this.availableChunks.size > 0) {
      console.log(`Starting playback with ${this.availableChunks.size} chunks buffered`);
      this.videoElement.play().then(() => {
        console.log('Playback started');
        this.isPlaying = true;
      }).catch(e => {
        console.log('Auto-play blocked, waiting for user interaction');
      });
    }
  }
  
  /**
   * Append a single chunk to the source buffer
   */
  async appendChunk(chunkIndex) {
    if (!this.uploadId) return;
    
    const maxRetries = 3;
    let retries = 0;
    
    while (retries < maxRetries) {
      try {
        const response = await fetch(`/api/mse/chunk/${this.uploadId}/${chunkIndex}`);
        
        if (response.status === 206) {
          await new Promise(r => setTimeout(r, 500));
          retries++;
          continue;
        }
        
        if (!response.ok) {
          throw new Error(`Failed to fetch chunk ${chunkIndex}`);
        }
        
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        
        // Wait for source buffer to be ready
        if (this.sourceBuffer && this.sourceBuffer.updating) {
          await new Promise(resolve => {
            const onUpdateEnd = () => {
              this.sourceBuffer.removeEventListener('updateend', onUpdateEnd);
              resolve();
            };
            this.sourceBuffer.addEventListener('updateend', onUpdateEnd);
          });
        }
        
        if (this.sourceBuffer) {
          try {
            this.sourceBuffer.appendBuffer(arrayBuffer);
            console.log(`Appended chunk ${chunkIndex}`);
          } catch (appendError) {
            console.error(`Failed to append chunk ${chunkIndex}:`, appendError);
            throw appendError; // Propagate error for fallback
          }
        }
        return;
        
      } catch (error) {
        console.error(`Error fetching chunk ${chunkIndex}:`, error);
        retries++;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    console.error(`Failed to fetch chunk ${chunkIndex} after ${maxRetries} retries`);
    throw new Error('Chunk append failed');
  }
  
  /**
   * Handle SourceBuffer error - try fallback to regular video
   */
  onSourceBufferError(error) {
    console.error('SourceBuffer error:', error);
    
    // Clean up MSE
    this.cleanup();
    
    // Trigger fallback via callback
    if (this.onError) {
      this.onError(error);
    }
  }
  
  /**
   * Clean up MSE resources
   */
  cleanup() {
    if (this.mediaSource) {
      try {
        if (this.sourceBuffer) {
          try {
            this.mediaSource.removeSourceBuffer(this.sourceBuffer);
          } catch (e) {}
        }
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      } catch (e) {}
    }
    this.mediaSource = null;
    this.sourceBuffer = null;
  }
  
  /**
   * Handle buffer update completion
   */
  onBufferUpdateEnd() {
    // Check if we can start playback
    if (this.videoElement.paused && this.availableChunks.size > 0) {
      this.videoElement.play().catch(e => {
        console.log('Auto-play blocked:', e);
      });
    }
  }
  
  /**
   * Handle video ended
   */
  onVideoEnded() {
    console.log('Video ended');
    this.isPlaying = false;
    
    if (this.isHost && this.syncEnabled) {
      this.socket?.emit('video:ended', { roomId: this.roomId });
    }
  }
  
  /**
   * Handle time update - sync with other viewers
   */
  onVideoTimeUpdate() {
    if (!this.isHost || !this.syncEnabled) return;
    
    const now = Date.now();
    if (this.lastSyncTime && now - this.lastSyncTime < 1000) {
      return; // Only sync every second
    }
    
    this.lastSyncTime = now;
    
    this.socket?.emit('video:time', {
      roomId: this.roomId,
      currentTime: this.videoElement.currentTime,
      duration: this.videoElement.duration,
      paused: this.videoElement.paused
    });
  }
  
  /**
   * Update buffer status UI
   */
  updateBufferStatus(data) {
    const bufferStatus = document.getElementById('mse-buffer-status');
    if (bufferStatus) {
      const percent = Math.round((data.availableChunks.length / data.totalChunks) * 100);
      bufferStatus.textContent = `Buffered: ${percent}% (${data.availableChunks.length}/${data.totalChunks} chunks)`;
    }
  }
  
  /**
   * Set host mode
   */
  setHost(isHost) {
    this.isHost = isHost;
    console.log(`MSE Player host mode: ${isHost}`);
  }
  
  /**
   * Sync playback from host
   */
  syncFromHost(data) {
    if (this.isHost || !this.syncEnabled) return;
    
    const { currentTime, duration, paused } = data;
    
    // Sync time if difference is more than 2 seconds
    if (Math.abs(this.videoElement.currentTime - currentTime) > 2) {
      this.videoElement.currentTime = currentTime;
    }
    
    // Sync play/pause
    if (paused && !this.videoElement.paused) {
      this.videoElement.pause();
    } else if (!paused && this.videoElement.paused && this.availableChunks.size > 0) {
      this.videoElement.play();
    }
  }
  
  /**
   * Play video
   */
  async play() {
    if (this.availableChunks.size === 0) {
      console.warn('No chunks buffered yet');
      return false;
    }
    
    try {
      await this.videoElement.play();
      this.isPlaying = true;
      return true;
    } catch (e) {
      console.error('Play failed:', e);
      return false;
    }
  }
  
  /**
   * Pause video
   */
  pause() {
    this.videoElement.pause();
    this.isPlaying = false;
  }
  
  /**
   * Seek to specific time
   */
  seek(time) {
    this.videoElement.currentTime = time;
  }
  
  /**
   * Get current playback time
   */
  getCurrentTime() {
    return this.videoElement.currentTime;
  }
  
  /**
   * Check if video is playing
   */
  isPaused() {
    return this.videoElement.paused;
  }
  
  /**
   * Get buffered ranges
   */
  getBufferedRanges() {
    return this.videoElement.buffered;
  }
  
  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  /**
   * Clean up resources
   */
  destroy() {
    if (this.mediaSource) {
      if (this.sourceBuffer) {
        try {
          this.mediaSource.removeSourceBuffer(this.sourceBuffer);
        } catch (e) {}
      }
    }
    
    if (this.videoElement) {
      this.videoElement.removeEventListener('ended', this.onVideoEnded);
      this.videoElement.removeEventListener('timeupdate', this.onVideoTimeUpdate);
    }
    
    this.availableChunks.clear();
    this.uploadId = null;
    console.log('MSE Player destroyed');
  }
}

// Export
window.MSEPlayer = MSEPlayer;
