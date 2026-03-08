/**
 * Watch-Together WebRTC Client Module
 * 
 * Handles LiveKit integration for ultra-low latency video streaming
 * 
 * Architecture:
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                     Host (Publisher)                            │
 │  ┌──────────────────────────────────────────────────────────┐   │
 │  │  getUserMedia() → LocalVideoTrack → Room.publish()       │   │
 │  └──────────────────────────────────────────────────────────┘   │
 │                              │                                   │
 │                              ▼ LiveKit SFU                       │
 │  ┌──────────────────────────────────────────────────────────┐   │
 │  │  SFU (Selective Forwarding Unit)                         │   │
 │  │  - Receives 1 stream from host                           │   │
 │  │  - Forwards to all viewers (optimized)                   │   │
 │  └──────────────────────────────────────────────────────────┘   │
 │                              │                                   │
 │              ┌───────────────┼───────────────┐                  │
 │              ▼               ▼               ▼                  │
 │  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐        │
 │  │ Viewer 1     │   │ Viewer 2     │   │ Viewer 3     │        │
 │  │ Room.sub()   │   │ Room.sub()   │   │ Room.sub()   │        │
 │  │ → RemoteTrack│   │ → RemoteTrack│   │ → RemoteTrack│        │
 │  └──────────────┘   └──────────────┘   └──────────────┘        │
 │                                                              │
 │  Latency: < 100ms (vs 2-5s for HLS)                          │
 │  Bandwidth: SFU optimizes quality per viewer                 │
 └──────────────────────────────────────────────────────────────┘
 */

class WebRTCManager {
  constructor() {
    // LiveKit client
    this.room = null;
    this.localTracks = [];
    this.remoteTracks = new Map();
    
    // UI state
    this.isHost = false;
    this.currentRoomId = null;
    this.socket = null;
    
    // DOM elements (set by init)
    this.videoElement = null;
    
    // Callbacks
    this.onConnected = null;
    this.onDisconnected = null;
    this.onParticipantJoined = null;
    this.onParticipantLeft = null;
    this.onError = null;
  }

  /**
   * Initialize WebRTC manager with required dependencies
   * @param {HTMLVideoElement} videoElement - Video element for playback
   * @param {Object} socket - Socket.IO socket instance
   */
  init(videoElement, socket) {
    this.videoElement = videoElement;
    this.socket = socket;
    
    // Listen for WebRTC events from server
    this.bindSocketEvents();
  }

  /**
   * Bind Socket.IO events for WebRTC signaling
   */
  bindSocketEvents() {
    if (!this.socket) return;

    this.socket.on('webrtc:streamingStarted', async (data) => {
      console.log('Host started streaming:', data);
      // Host should publish their stream
      await this.publishToRoom(data);
    });

    this.socket.on('webrtc:hostStartedStreaming', async (data) => {
      console.log('Host started streaming:', data.hostName);
      this.showToast(`${data.hostName} is now streaming via WebRTC`);
    });

    this.socket.on('webrtc:streamingStopped', (data) => {
      console.log('Host stopped streaming');
      this.showToast(`${data.by} stopped streaming`);
      this.cleanup();
    });

    this.socket.on('webrtc:viewerJoined', async (data) => {
      await this.joinRoomAsViewer(data);
    });

    this.socket.on('webrtc:participantUnpublished', (data) => {
      console.log('Participant unpublished:', data.socketId);
      this.handleParticipantUnpublished(data.socketId);
    });
  }

  /**
   * Host starts streaming their camera/screen
   * Requires LiveKit to be configured on server
   */
  async startStreaming() {
    if (!this.socket) {
      this.showError('Not connected to server');
      return;
    }

    try {
      // Request to start streaming
      this.socket.emit('webrtc:startStreaming', {
        roomId: this.currentRoomId
      });

      // Wait for server response with token
      this.socket.once('webrtc:streamingStarted', async (data) => {
        await this.publishToRoom(data);
      });

      this.socket.once('webrtc:error', (error) => {
        this.showError(error.message);
      });

    } catch (error) {
      console.error('Failed to start streaming:', error);
      this.showError('Failed to start streaming');
    }
  }

  /**
   * Stop streaming and cleanup
   */
  async stopStreaming() {
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }

    // Stop local tracks
    for (const track of this.localTracks) {
      track.stop();
    }
    this.localTracks = [];

    // Notify server
    if (this.socket && this.currentRoomId) {
      this.socket.emit('webrtc:stopStreaming', {
        roomId: this.currentRoomId
      });
    }
  }

  /**
   * Viewer joins room to receive host's stream
   */
  async joinAsViewer() {
    if (!this.socket) {
      this.showError('Not connected to server');
      return;
    }

    // Request viewer token
    this.socket.emit('webrtc:joinAsViewer', {
      roomId: this.currentRoomId
    });
  }

  /**
   * Publish local tracks to LiveKit room
   */
  async publishToRoom(data) {
    try {
      // Check if LiveKit SDK is available
      const LivekitClient = window.LivekitClient;
      if (!LivekitClient || !LivekitClient.Room) {
        // Fallback: show message that WebRTC requires LiveKit SDK
        this.showError('LiveKit SDK not loaded. Using URL mode instead.');
        return;
      }

      const LiveKitRoom = LivekitClient.Room;

      // Debug: Log URL and token
      console.log('LiveKit URL:', data.url);
      console.log('LiveKit token present:', !!data.token);
      
      // Validate URL before passing to SDK
      if (!data.url || typeof data.url !== 'string') {
        throw new Error('Invalid LiveKit URL: ' + JSON.stringify(data.url));
      }
      
      // Test URL parsing
      try {
        new URL(data.url);
        console.log('URL validation passed');
      } catch (e) {
        throw new Error('URL validation failed: ' + e.message);
      }
      
      // Test WebSocket connectivity (helps diagnose network issues like ISP blocking)
      console.log('Testing WebSocket connectivity to', data.url);
      const wsTest = new WebSocket(data.url);
      wsTest.onopen = () => {
        console.log('✅ WebSocket test: OPEN - Network is OK');
        wsTest.close();
      };
      wsTest.onerror = () => {
        console.error('❌ WebSocket test: FAILED - Check ISP/CORS settings');
      };
      setTimeout(() => wsTest.close(), 2000);

      // Connect to LiveKit room (v1.2.7 uses options object with url/token)
      console.log('Creating LiveKitRoom instance...');
      this.room = new LiveKitRoom({
        url: data.url,
        token: data.token,
        regionUrlProvider: undefined, // Disable region URL resolution (fixes SDK bug)
        adaptiveStream: true,
        dynacast: true
      });
      console.log('LiveKitRoom instance created, connecting...');
      
      // Handle connection events
      this.room
        .on('connected', () => {
          console.log('Connected to LiveKit room');
          if (this.onConnected) this.onConnected();
        })
        .on('disconnected', () => {
          console.log('Disconnected from LiveKit room');
          if (this.onDisconnected) this.onDisconnected();
        })
        .on('trackSubscribed', (track, publication, participant) => {
          console.log('Track subscribed:', participant.identity);
          this.handleRemoteTrack(track, this.videoElement);
        })
        .on('trackUnsubscribed', (track, publication, participant) => {
          console.log('Track unsubscribed:', participant.identity);
          this.handleRemoteTrackUnsubscribed(track);
        })
        .on('participantConnected', (participant) => {
          console.log('Participant connected:', participant.identity);
          if (this.onParticipantJoined) this.onParticipantJoined(participant);
        })
        .on('participantDisconnected', (participant) => {
          console.log('Participant disconnected:', participant.identity);
          if (this.onParticipantLeft) this.onParticipantLeft(participant);
        })
        .on('error', (error) => {
          console.error('LiveKit error:', error);
          if (this.onError) this.onError(error);
        });

      // STEP 1: Request camera/microphone access FIRST (shows permission prompt)
      console.log('Requesting camera access...');
      const localTracks = await LivekitClient.createLocalTracks({
        audio: true,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      });
      console.log('Camera access granted, got', localTracks.length, 'tracks');
      
      // Store tracks locally
      for (const track of localTracks) {
        this.localTracks.push(track);
      }
      
      // Attach to video element if available
      if (this.videoElement) {
        const videoTrack = localTracks.find(t => t.kind === 'video');
        if (videoTrack) {
          videoTrack.attach(this.videoElement);
        }
      }
      
      // STEP 2: Connect to LiveKit
      console.log('Connecting to LiveKit room...');
      try {
        await this.room.connect();
        console.log('Connected to LiveKit room');
      } catch (e) {
        console.error('LiveKit connect error:', e.message);
        // Keep the local tracks even if LiveKit fails
        this.showError('Camera OK but LiveKit connection failed');
        return;
      }
      
      // STEP 3: Publish local tracks to LiveKit
      console.log('Publishing', this.localTracks.length, 'tracks to LiveKit...');
      for (const track of this.localTracks) {
        this.room.publish(track);
      }
      console.log('Published tracks successfully');

    } catch (error) {
      console.error('Failed to publish to room:', error);
      this.showError('Failed to start WebRTC streaming');
    }
  }

  /**
   * Join room as viewer to receive remote streams
   */
  async joinRoomAsViewer(data) {
    try {
      const LivekitClient = window.LivekitClient;
      if (!LivekitClient || !LivekitClient.Room) {
        this.showError('LiveKit SDK not loaded');
        return;
      }

      const LiveKitRoom = LivekitClient.Room;
      
      // Debug: Log URL and token
      console.log('Viewer LiveKit URL:', data.url);
      console.log('Viewer LiveKit token present:', !!data.token);
      
      // Validate URL before passing to SDK
      if (!data.url || typeof data.url !== 'string') {
        throw new Error('Invalid LiveKit URL: ' + JSON.stringify(data.url));
      }
      
      // Test URL parsing
      try {
        new URL(data.url);
        console.log('URL validation passed');
      } catch (e) {
        throw new Error('URL validation failed: ' + e.message);
      }

      // Connect to LiveKit room (v1.2.7 uses options object with url/token)
      this.room = new LiveKitRoom({
        url: data.url,
        token: data.token,
        regionUrlProvider: undefined, // Disable region URL resolution (fixes SDK bug)
        adaptiveStream: true,
        dynacast: true
      });

      this.room
        .on('connected', () => {
          console.log('Viewer connected to LiveKit room');
          if (this.onConnected) this.onConnected();
        })
        .on('disconnected', () => {
          console.log('Viewer disconnected from LiveKit room');
          if (this.onDisconnected) this.onDisconnected();
        })
        .on('trackSubscribed', (track, publication, participant) => {
          console.log('Viewer received track from:', participant.identity);
          this.handleRemoteTrack(track, this.videoElement);
        })
        .on('trackUnsubscribed', (track, publication, participant) => {
          this.handleRemoteTrackUnsubscribed(track);
        })
        .on('error', (error) => {
          console.error('LiveKit error:', error);
          if (this.onError) this.onError(error);
        });

      await this.room.connect();

    } catch (error) {
      console.error('Failed to join as viewer:', error);
      this.showError('Failed to join WebRTC room');
    }
  }

  /**
   * Handle incoming remote track
   */
  handleRemoteTrack(track, element) {
    if (track.kind === 'video' || track.kind === 'audio') {
      // Attach track to element
      track.attach(element);
      
      // Store reference
      this.remoteTracks.set(track.sid, {
        track,
        element
      });
    }
  }

  /**
   * Handle remote track being unsubscribed
   */
  handleRemoteTrackUnsubscribed(track) {
    const ref = this.remoteTracks.get(track.sid);
    if (ref) {
      track.detach();
      this.remoteTracks.delete(track.sid);
    }
  }

  /**
   * Handle participant unpublished event
   */
  handleParticipantUnpublished(socketId) {
    // Find and cleanup any tracks from this participant
    for (const [sid, ref] of this.remoteTracks) {
      // In production, track participant identity
      ref.track.detach();
    }
  }

  /**
   * Cleanup all resources
   */
  async cleanup() {
    // Disconnect from LiveKit
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }

    // Stop local tracks
    for (const track of this.localTracks) {
      track.stop();
    }
    this.localTracks = [];

    // Clear remote tracks
    for (const [sid, ref] of this.remoteTracks) {
      ref.track.detach();
    }
    this.remoteTracks.clear();
  }

  /**
   * Check if WebRTC is available
   */
  isAvailable() {
    return window.LivekitClient && 
           window.LivekitClient.Room &&
           navigator.mediaDevices && 
           navigator.mediaDevices.getUserMedia;
  }

  /**
   * Show toast notification
   */
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  /**
   * Show error
   */
  showError(message) {
    this.showToast(message, 'error');
    if (this.onError) this.onError(new Error(message));
  }
}

// Export for use in app.js
window.WebRTCManager = WebRTCManager;
