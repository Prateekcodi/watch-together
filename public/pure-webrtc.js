/**
 * PureWebRTC - Reliable WebRTC implementation
 * Fetches TURN credentials from backend for cross-network support
 */
class PureWebRTC {
  constructor() {
    this.socket = null;
    this.videoElement = null;
    this.roomId = null;
    this.isHost = false;

    this.localStream = null;
    this.peerConnections = new Map();

    this.peerConnection = null;
    this.hostId = null;

    this.onConnected = null;
    this.onDisconnected = null;
    this.onStreamReceived = null;
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.onError = null;

    // Will be fetched from backend
    this.iceConfig = null;
  }

  // ─── ICE Config (fetched from backend) ────────────────────

  async getICEConfig() {
    if (this.iceConfig) return this.iceConfig;

    try {
      const res = await fetch('/api/ice-config');
      if (res.ok) {
        this.iceConfig = await res.json();
        console.log('[WebRTC] ICE config loaded,', this.iceConfig.iceServers.length, 'servers');
        return this.iceConfig;
      }
    } catch (err) {
      console.warn('[WebRTC] Could not fetch ICE config from backend:', err.message);
    }

    // Hard fallback (STUN only)
    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ]
    };
    return this.iceConfig;
  }

  // ─── Setup ────────────────────────────────────────────────

  init(videoElement, socket) {
    this.videoElement = videoElement;
    this.socket = socket;
    // Pre-fetch ICE config early so it is ready when needed
    this.getICEConfig();
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

    this._setVideoStream(this.videoElement, this.localStream, true);

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
    this._closeViewerPc(viewerId);

    const iceConfig = await this.getICEConfig();
    const pc = new RTCPeerConnection(iceConfig);
    this.peerConnections.set(viewerId, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

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
      console.log('[WebRTC] Viewer ' + viewerId + ': ' + pc.connectionState);
      if (pc.connectionState === 'connected') {
        if (this.onPeerConnected) this.onPeerConnected(viewerId);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this._closeViewerPc(viewerId);
        if (this.onPeerDisconnected) this.onPeerDisconnected(viewerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] Viewer ' + viewerId + ' ICE: ' + pc.iceConnectionState);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.socket.emit('webrtc:host-offer', {
      roomId: this.roomId,
      viewerId,
      offer
    });

    console.log('[WebRTC] Offer sent to viewer ' + viewerId);
  }

  async handleViewerAnswer(viewerId, answer) {
    const pc = this.peerConnections.get(viewerId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
      console.error('[WebRTC] handleViewerAnswer error:', e.message);
    }
  }

  async addViewerIceCandidate(viewerId, candidate) {
    const pc = this.peerConnections.get(viewerId);
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
  }

  _closeViewerPc(viewerId) {
    const pc = this.peerConnections.get(viewerId);
    if (pc) { pc.close(); this.peerConnections.delete(viewerId); }
  }

  // ─── VIEWER: Connect to host ──────────────────────────────

  async handleHostOffer(offer, hostId) {
    this.hostId = hostId;
    this._cleanViewerPc();

    const iceConfig = await this.getICEConfig();
    const pc = new RTCPeerConnection(iceConfig);
    this.peerConnection = pc;

    console.log('[WebRTC] Viewer peer connection created, ICE servers:', iceConfig.iceServers.length);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socket.emit('webrtc:viewer-ice-candidate', {
          roomId: this.roomId,
          candidate
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] Viewer ICE state:', pc.iceConnectionState);
      this._updateConnectionStatus(pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[WebRTC] Viewer connection state:', state);
      if (state === 'connected') {
        if (this.onConnected) this.onConnected();
        if (this.onPeerConnected) this.onPeerConnected();
        this._updateConnectionStatus('connected');
      } else if (state === 'disconnected' || state === 'failed') {
        if (this.onDisconnected) this.onDisconnected();
        this._updateConnectionStatus(state);
      }
    };

    pc.ontrack = (event) => {
      console.log('[WebRTC] Received track:', event.track.kind);
      const stream = event.streams[0] || new MediaStream([event.track]);
      this._setVideoStream(this.videoElement, stream, false);
      if (this.onStreamReceived) this.onStreamReceived(stream);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.socket.emit('webrtc:viewer-answer', {
      roomId: this.roomId,
      hostId,
      answer
    });

    console.log('[WebRTC] Answer sent to host');
  }

  async addHostIceCandidate(candidate) {
    if (this.peerConnection && candidate) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {}
    }
  }

  _cleanViewerPc() {
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }

  _updateConnectionStatus(state) {
    const noticeText = document.getElementById('viewer-notice-text');
    if (!noticeText) return;
    const map = {
      checking: '🔄 Connecting… finding a path',
      connected: '✅ Watching live broadcast',
      completed: '✅ Watching live broadcast',
      disconnected: '⚠️ Connection lost…',
      failed: '❌ Connection failed — leave and rejoin',
      new: '⏳ Connecting…'
    };
    if (map[state]) noticeText.textContent = map[state];
  }

  // ─── Video playback ───────────────────────────────────────

  _setVideoStream(videoEl, stream, muted) {
    if (!videoEl) return;

    videoEl.srcObject = stream;
    videoEl.muted = muted;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
    videoEl.removeAttribute('controls');

    const customControls = document.getElementById('custom-controls');
    if (customControls) customControls.style.display = 'none';

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
    overlay.style.cssText = [
      'position:absolute', 'inset:0', 'background:rgba(0,0,0,0.65)',
      'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
      'cursor:pointer', 'z-index:100', 'touch-action:manipulation', 'gap:12px'
    ].join(';');
    overlay.innerHTML = [
      '<div style="background:rgba(255,255,255,0.15);border:2px solid rgba(255,255,255,0.5);',
      'border-radius:50%;width:72px;height:72px;',
      'display:flex;align-items:center;justify-content:center;font-size:28px;">▶</div>',
      '<span style="color:white;font-size:14px;opacity:0.8;">Tap to watch</span>'
    ].join('');

    container.style.position = 'relative';
    container.appendChild(overlay);

    const play = (e) => {
      e.preventDefault();
      e.stopPropagation();
      overlay.removeEventListener('pointerdown', play);
      overlay.removeEventListener('click', play);
      videoEl.play().then(() => {
        this._removeTapOverlay();
      }).catch(() => {
        // Let user try again
        overlay.addEventListener('pointerdown', play);
        overlay.addEventListener('click', play);
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
    if (preview) preview.srcObject = null;

    this.isHost = false;
  }

  _restoreVideoElement() {
    this._removeTapOverlay();
    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement.muted = false;
    }
    const customControls = document.getElementById('custom-controls');
    if (customControls) customControls.style.display = '';
  }

  async cleanup() {
    await this.stopBroadcast();
    this._cleanViewerPc();
    this._restoreVideoElement();
    this.iceConfig = null;
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
