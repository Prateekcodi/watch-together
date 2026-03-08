/**
 * PureWebRTC - Simple, reliable WebRTC implementation
 * Host broadcasts → Viewers connect → Video plays
 */
class PureWebRTC {
  constructor() {
    this.socket = null;
    this.videoElement = null;
    this.roomId = null;
    this.isHost = false;

    // Host state
    this.localStream = null;
    this.peerConnections = new Map(); // viewerId -> RTCPeerConnection

    // Viewer state
    this.peerConnection = null;
    this.hostId = null;

    // Callbacks
    this.onConnected = null;
    this.onDisconnected = null;
    this.onStreamReceived = null;
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onError = null;

    // ICE config — public STUN + free TURN fallbacks
    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelay',
          credential: 'openrelay'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelay',
          credential: 'openrelay'
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelay',
          credential: 'openrelay'
        }
      ]
    };
  }

  // ─── Setup ────────────────────────────────────────────────

  init(videoElement, socket) {
    this.videoElement = videoElement;
    this.socket = socket;
    console.log('[WebRTC] Initialized');
  }

  // ─── HOST: Start broadcasting ─────────────────────────────

  async startBroadcast(options = {}) {
    this.isHost = true;
    this.roomId = options.roomId || this.roomId;

    try {
      if (options.screen) {
        this.localStream = await this._getScreenStream();
      } else {
        this.localStream = await this._getCameraStream();
      }
    } catch (err) {
      this._emitError('Could not access media: ' + err.message);
      return false;
    }

    // Show local stream in video element
    this._setVideoStream(this.videoElement, this.localStream, true);

    // Show local preview
    const preview = document.getElementById('local-preview');
    if (preview) {
      preview.srcObject = this.localStream;
      preview.play().catch(() => {});
    }

    console.log('[WebRTC] Broadcasting started');
    return true;
  }

  async _getCameraStream() {
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);
    return navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: isMobile ? 1280 : 1920 },
        height: { ideal: isMobile ? 720 : 1080 },
        frameRate: { ideal: 30 }
      },
      audio: true
    });
  }

  async _getScreenStream() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen share not supported on this device');
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', frameRate: { ideal: 30 } },
      audio: true
    });
  }

  // ─── HOST: Handle new viewer ──────────────────────────────

  async createOfferForViewer(viewerId) {
    // Clean up any existing connection for this viewer
    this._closeViewerPc(viewerId);

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(viewerId, pc);

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Send ICE candidates
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socket.emit('webrtc:host-ice-candidate', {
          roomId: this.roomId,
          viewerId,
          candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Viewer ${viewerId} state: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this._closeViewerPc(viewerId);
        if (this.onPeerDisconnected) this.onPeerDisconnected(viewerId);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.socket.emit('webrtc:host-offer', {
      roomId: this.roomId,
      viewerId,
      offer
    });
  }

  async handleViewerAnswer(viewerId, answer) {
    const pc = this.peerConnections.get(viewerId);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addViewerIceCandidate(viewerId, candidate) {
    const pc = this.peerConnections.get(viewerId);
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
  }

  _closeViewerPc(viewerId) {
    const pc = this.peerConnections.get(viewerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(viewerId);
    }
  }

  // ─── VIEWER: Connect to host ──────────────────────────────

  connectToHost() {
    // Clean up any old connection
    this._cleanViewerPc();

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnection = pc;

    // Send ICE candidates to host
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socket.emit('webrtc:viewer-ice-candidate', {
          roomId: this.roomId,
          candidate
        });
      }
    };

    // Receive remote stream
    pc.ontrack = (event) => {
      console.log('[WebRTC] Received track:', event.track.kind);
      const stream = event.streams[0] || new MediaStream([event.track]);
      this._setVideoStream(this.videoElement, stream, false);
      if (this.onStreamReceived) this.onStreamReceived(stream);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[WebRTC] Viewer connection state:', state);
      if (state === 'connected') {
        if (this.onConnected) this.onConnected();
        if (this.onPeerConnected) this.onPeerConnected();
      } else if (state === 'disconnected' || state === 'failed') {
        if (this.onDisconnected) this.onDisconnected();
      }
    };

    return pc;
  }

  async handleHostOffer(offer, hostId) {
    this.hostId = hostId;

    // Always create a fresh peer connection for each offer
    const pc = this.connectToHost();

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.socket.emit('webrtc:viewer-answer', {
      roomId: this.roomId,
      hostId,
      answer
    });
  }

  async addHostIceCandidate(candidate) {
    if (this.peerConnection && candidate) {
      try { await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
  }

  _cleanViewerPc() {
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }

  // ─── Video playback helper ────────────────────────────────

  _setVideoStream(videoEl, stream, muted) {
    if (!videoEl) return;

    videoEl.srcObject = stream;
    videoEl.muted = muted;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');

    // Hide native controls during WebRTC
    videoEl.removeAttribute('controls');

    // Hide custom seek controls (no seeking in live stream)
    const customControls = document.getElementById('custom-controls');
    if (customControls) {
      customControls.style.display = 'none';
    }

    // Try autoplay; if blocked, show tap overlay
    videoEl.play().then(() => {
      console.log('[WebRTC] Video playing');
      this._removeTapOverlay();
    }).catch(() => {
      console.log('[WebRTC] Autoplay blocked — showing tap overlay');
      this._showTapOverlay(videoEl);
    });
  }

  _showTapOverlay(videoEl) {
    this._removeTapOverlay();

    const container = videoEl.parentElement;
    if (!container) return;

    const overlay = document.createElement('div');
    overlay.id = 'webrtc-tap-overlay';
    overlay.style.cssText = `
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 100;
      touch-action: manipulation;
    `;
    overlay.innerHTML = `
      <div style="
        background: rgba(255,255,255,0.15);
        border: 2px solid rgba(255,255,255,0.4);
        border-radius: 50%;
        width: 80px;
        height: 80px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 32px;
      ">▶</div>
    `;

    container.style.position = 'relative';
    container.appendChild(overlay);

    const play = (e) => {
      e.preventDefault();
      e.stopPropagation();
      videoEl.play().then(() => {
        this._removeTapOverlay();
      }).catch(err => {
        console.log('[WebRTC] Play after tap failed:', err.message);
      });
    };

    overlay.addEventListener('pointerdown', play);
    overlay.addEventListener('click', play);
  }

  _removeTapOverlay() {
    document.getElementById('webrtc-tap-overlay')?.remove();
  }

  // ─── Stop / Cleanup ───────────────────────────────────────

  async stopBroadcast() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    this.peerConnections.forEach(pc => pc.close());
    this.peerConnections.clear();

    this._restoreVideoElement();

    const preview = document.getElementById('local-preview');
    if (preview) {
      preview.srcObject = null;
    }

    this.isHost = false;
    console.log('[WebRTC] Broadcast stopped');
  }

  _restoreVideoElement() {
    this._removeTapOverlay();

    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement.muted = false;
    }

    // Restore custom controls
    const customControls = document.getElementById('custom-controls');
    if (customControls) {
      customControls.style.display = '';
    }
  }

  async cleanup() {
    await this.stopBroadcast();
    this._cleanViewerPc();
    this._restoreVideoElement();
  }

  handleViewerLeft(viewerId) {
    this._closeViewerPc(viewerId);
    if (this.onPeerDisconnected) this.onPeerDisconnected(viewerId);
  }

  _emitError(msg) {
    console.error('[WebRTC]', msg);
    if (this.onError) this.onError(new Error(msg));
  }

  isAvailable() {
    return !!(navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);
  }
}

window.PureWebRTC = PureWebRTC;
