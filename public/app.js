/**
 * Watch-Together Frontend Application
 */

class WatchTogether {
  constructor() {
    this.socket = null;
    this.socketConnected = false;
    this.roomId = null;
    this.userName = null;
    this.isHost = false;
    this.streamingMode = 'url';
    this.videoPlayer = document.getElementById('video-player');
    this.syncEnabled = true;
    this.lastSyncTime = null;
    this.webrtc = null;
    this.chatMessages = [];
    this.cachedChat = [];
    this.selectedMode = 'url';
    
    this.init();
  }

  init() {
    this.bindEvents();
    this.loadRecentRooms();
    this.checkUrlForRoom();
    this.initMSE();
    this.initWebRTC();
  }

  initMSE() {
    // Initialize MSE player when MSEPlayer class is available
    if (typeof MSEPlayer !== 'undefined') {
      this.msePlayer = new MSEPlayer({
        videoElement: this.videoPlayer,
        socket: null,
        roomId: null
      });
      console.log('MSE Player initialized');
    } else {
      console.warn('MSEPlayer class not loaded yet');
    }
  }

  initWebRTC() {
    // Initialize Pure WebRTC manager (works without LiveKit!)
    if (typeof PureWebRTC !== 'undefined') {
      this.webrtc = new PureWebRTC();
      // Socket will be set when connected in connectSocket()
      
      // Set up WebRTC callbacks
      this.webrtc.onConnected = () => {
        console.log('WebRTC connected');
        this.showToast('Connected to WebRTC stream');
      };
      
      this.webrtc.onDisconnected = () => {
        console.log('WebRTC disconnected');
        this.showToast('Disconnected from WebRTC stream', 'warning');
      };
      
      this.webrtc.onStreamReceived = (stream) => {
        console.log('Received WebRTC stream');
        // Stream is already set by pure-webrtc.js
      };
      
      this.webrtc.onPeerConnected = (peerId) => {
        console.log('Peer connected:', peerId);
      };
      
      this.webrtc.onPeerDisconnected = (peerId) => {
        console.log('Peer disconnected:', peerId);
        this.showToast('Viewer disconnected', 'warning');
      };
      
      this.webrtc.onError = (error) => {
        console.error('WebRTC Error:', error);
        this.showToast('WebRTC Error: ' + error.message, 'error');
      };
      
      console.log('Pure WebRTC Manager initialized');
      
      // Update UI to show WebRTC is available
      const statusEl = document.getElementById('livekit-status');
      if (statusEl) {
        statusEl.innerHTML = '<span class="status-dot" style="background: var(--success-color)"></span><span>Pure WebRTC Ready (No LiveKit required!)</span>';
        statusEl.classList.add('loaded');
      }
    } else {
      console.warn('PureWebRTC class not loaded yet');
    }
  }

  bindEvents() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.selectMode(e.target.dataset.mode));
    });

    document.getElementById('create-room-btn').addEventListener('click', () => this.createRoom());
    document.getElementById('join-room-btn').addEventListener('click', () => this.joinRoom());
    document.getElementById('leave-room-btn').addEventListener('click', () => this.leaveRoom());
    document.getElementById('copy-invite-btn').addEventListener('click', () => this.copyInvite());
    
    document.getElementById('load-video-btn').addEventListener('click', () => this.loadVideo());
    this.videoPlayer.addEventListener('play', () => this.onVideoPlay());
    this.videoPlayer.addEventListener('pause', () => this.onVideoPause());
    this.videoPlayer.addEventListener('seeked', () => this.onVideoSeek());
    
    document.getElementById('send-chat-btn').addEventListener('click', () => this.sendChat());
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.sendChat();
    });
    
    // Quick reaction buttons
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const reaction = btn.dataset.reaction;
        if (this.socketConnected) {
          this.socket.emit('chat:send', {
            roomId: this.roomId,
            message: reaction,
            isReaction: true
          });
        }
      });
    });

    // Quick message buttons
    document.querySelectorAll('.quick-msg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        input.value = btn.textContent;
        input.focus();
        // Auto send
        this.sendChat();
      });
    });
    
    // WebRTC streaming buttons
    document.getElementById('start-webrtc-camera-btn').addEventListener('click', () => {
      this.webrtcMode = 'camera';
      this.startWebRTCStreaming();
    });
    document.getElementById('start-webrtc-screen-btn').addEventListener('click', () => {
      this.webrtcMode = 'screen';
      this.startWebRTCStreaming();
    });
    document.getElementById('stop-webrtc-btn').addEventListener('click', () => this.stopWebRTCStreaming());
    document.getElementById('join-webrtc-btn').addEventListener('click', () => this.joinWebRTCStream());
    
    // Hide screen share button on mobile (not well supported)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
      const screenBtn = document.getElementById('start-webrtc-screen-btn');
      if (screenBtn) {
        screenBtn.style.display = 'none';
      }
    }
    
    document.getElementById('room-code').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.joinRoom();
    });
    
    document.getElementById('video-url').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.loadVideo();
    });
    
    // Chat toggle events
    document.getElementById('chat-toggle').addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleChat();
    }, { passive: false });
    document.getElementById('chat-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleChat();
    });
    
    // Mobile chat button - use both touch and click
    const mobileChatBtn = document.getElementById('mobile-chat-btn');
    if (mobileChatBtn) {
      mobileChatBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleChat();
      }, { passive: false });
      mobileChatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleChat();
      });
    }
    
    // Chat overlay events
    const chatOverlayClose = document.getElementById('chat-overlay-close');
    if (chatOverlayClose) {
      chatOverlayClose.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.closeChatOverlay();
      }, { passive: false });
      chatOverlayClose.addEventListener('click', () => this.closeChatOverlay());
    }
    
    const chatOverlaySend = document.getElementById('chat-overlay-send');
    if (chatOverlaySend) {
      chatOverlaySend.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.sendChatToOverlay();
      }, { passive: false });
      chatOverlaySend.addEventListener('click', () => this.sendChatToOverlay());
    }
    document.getElementById('chat-overlay-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.sendChatToOverlay();
    });
    
    // Custom video controls
    this.initCustomVideoControls();
    
    // Exit theater button
    document.getElementById('exit-theater-btn').addEventListener('click', () => this.exitTheaterMode());
    
    // File upload events
    this.initFileUpload();
  }

  toggleChat() {
    const chatSection = document.getElementById('chat-section');
    const chatToggle = document.getElementById('chat-toggle');
    
    // Check if in theater mode
    if (document.body.classList.contains('theater-mode')) {
      this.openChatOverlay();
      return;
    }
    
    // Check if in browser fullscreen mode
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      this.openChatOverlay();
      return;
    }
    
    // Portrait only - in landscape, chat is always visible
    if (window.innerWidth <= 768 && window.innerHeight > window.innerWidth) {
      chatSection.classList.toggle('open');
      chatToggle.style.display = chatSection.classList.contains('open') ? 'flex' : 'none';
    }
  }

  initCustomVideoControls() {
    const playBtn = document.getElementById('custom-play-btn');
    const fullscreenBtn = document.getElementById('custom-fullscreen-btn');
    const progress = document.getElementById('video-progress');
    const timeDisplay = document.getElementById('time-display');
    const videoContainer = document.getElementById('video-container');
    const customControls = document.getElementById('custom-controls');
    
    if (!playBtn || !this.videoPlayer) return;
    
    // Control hide timer
    this.controlsHideTimer = null;
    this.isControlsVisible = true;
    
    // Check if already in fullscreen
    this.isFullscreen = false;
    
    // Function to show controls
    const showControls = () => {
      if (customControls) {
        customControls.classList.remove('hidden');
        customControls.style.opacity = '1';
        customControls.style.pointerEvents = 'auto';
      }
      clearTimeout(this.controlsHideTimer);
      if (!this.videoPlayer.paused) {
        this.controlsHideTimer = setTimeout(() => {
          customControls?.classList.add('hidden');
        }, 3000);
      }
    };
    
    // Touch/click on video container to toggle controls
    if (videoContainer) {
      // Use touchend for mobile, click for desktop
      const toggle = (e) => {
        e.preventDefault();
        if (customControls?.classList.contains('hidden')) {
          showControls();
        } else {
          customControls?.classList.add('hidden');
        }
      };
      
      videoContainer.addEventListener('touchend', toggle, { passive: false });
      videoContainer.addEventListener('click', toggle);
      
      // Mouse movement on desktop shows controls
      videoContainer.addEventListener('mousemove', () => showControls());
    }
    
    // Play/Pause toggle
    const addControlListener = (element, handler) => {
      element.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
      }, { passive: false });
      element.addEventListener('click', (e) => {
        e.stopPropagation();
        handler();
      });
    };
    
    addControlListener(playBtn, () => {
      if (this.videoPlayer.paused) {
        this.videoPlayer.play();
      } else {
        this.videoPlayer.pause();
      }
    });
    
    // Update play button icon
    this.videoPlayer.addEventListener('play', () => {
      playBtn.textContent = '⏸️';
      showControls();
    });
    
    this.videoPlayer.addEventListener('pause', () => {
      playBtn.textContent = '▶️';
      showControls();
    });
    
    // Update progress bar
    this.videoPlayer.addEventListener('timeupdate', () => {
      if (progress && this.videoPlayer.duration) {
        const value = (this.videoPlayer.currentTime / this.videoPlayer.duration) * 100;
        progress.value = value;
        // Update red fill progress
        progress.style.background = `linear-gradient(to right, var(--red) ${value}%, rgba(255,255,255,0.2) ${value}%)`;
      }
      this.updateTimeDisplay();
    });
    
    // Seek when progress changes
    if (progress) {
      progress.addEventListener('touchend', (e) => {
        e.stopPropagation();
        if (this.videoPlayer.duration) {
          const time = (progress.value / 100) * this.videoPlayer.duration;
          this.videoPlayer.currentTime = time;
        }
      }, { passive: false });
      progress.addEventListener('input', (e) => {
        e.stopPropagation();
        if (this.videoPlayer.duration) {
          const time = (progress.value / 100) * this.videoPlayer.duration;
          this.videoPlayer.currentTime = time;
        }
      });
    }
    
    // Fullscreen button - TOGGLE enter/exit with timestamp guard
    if (fullscreenBtn) {
      let lastFullscreenTime = 0;
      const FULLSCREEN_DEBOUNCE = 500; // 500ms between fullscreen calls
      
      const toggleFullscreen = () => {
        const now = Date.now();
        if (now - lastFullscreenTime < FULLSCREEN_DEBOUNCE) {
          console.log('Fullscreen call debounced');
          return;
        }
        lastFullscreenTime = now;
        
        if (this.isFullscreen) {
          this.exitTrueFullscreen();
        } else {
          this.enterTrueFullscreen();
        }
      };
      
      fullscreenBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFullscreen();
      }, { passive: false });
      
      fullscreenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFullscreen();
      });
    }
    
    // Listen for fullscreen change events with timestamp guard
    let lastFullscreenChange = 0;
    const handleFullscreenChange = () => {
      const now = Date.now();
      if (now - lastFullscreenChange < 100) {
        return; // Debounce rapid changes
      }
      lastFullscreenChange = now;
      
      this.isFullscreen = !!document.fullscreenElement || !!document.webkitFullscreenElement;
      if (fullscreenBtn) {
        fullscreenBtn.textContent = this.isFullscreen ? '⛶' : '⛶';
      }
      
      console.log('Fullscreen changed:', this.isFullscreen);
    };
    
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    
    // Video loaded - show controls
    this.videoPlayer.addEventListener('loadedmetadata', () => {
      this.updateTimeDisplay();
    });
    
    // Update time display
    this.videoPlayer.addEventListener('timeupdate', () => {
      this.updateTimeDisplay();
    });
    
    // Initialize rotate button
    this.initRotateButton();
  }
  
  initRotateButton() {
    const rotateBtn = document.getElementById('rotate-btn');
    const lockIcon = document.getElementById('lock-icon');
    if (!rotateBtn) return;
    
    let isLocked = false;
    
    const updateLockIcon = (locked) => {
      if (lockIcon) {
        lockIcon.textContent = locked ? '🔒' : '🔓';
      }
    };
    
    rotateBtn.addEventListener('click', () => {
      if (!isLocked) {
        // Try to lock to landscape
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').then(() => {
            isLocked = true;
            updateLockIcon(true);
          }).catch((err) => {
            console.log('Could not lock orientation:', err.message);
            this.showToast('Could not lock rotation', 'warning');
          });
        } else {
          this.showToast('Rotation lock not supported', 'warning');
        }
      } else {
        // Unlock
        if (screen.orientation && screen.orientation.unlock) {
          screen.orientation.unlock();
          isLocked = false;
          updateLockIcon(false);
        }
      }
    });
    
    // Listen for orientation changes to update lock state
    if (screen.orientation) {
      screen.orientation.addEventListener('change', () => {
        isLocked = screen.orientation.type.includes('landscape');
        updateLockIcon(isLocked);
      });
    }
    
    // Exit fullscreen button with timestamp guard
    const exitFullscreenBtn = document.getElementById('exit-fullscreen-btn');
    if (exitFullscreenBtn) {
      let lastExitTime = 0;
      exitFullscreenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const now = Date.now();
        if (now - lastExitTime < 500) return;
        lastExitTime = now;
        this.exitTrueFullscreen();
      });
    }
  }
  
  rotateScreen() {
    // CSS-based rotation as fallback
    const roomPage = document.getElementById('room-page');
    if (!roomPage) return;
    
    roomPage.classList.toggle('rotated');
    
    // Add rotation styles if not exists
    if (!document.getElementById('rotation-styles')) {
      const style = document.createElement('style');
      style.id = 'rotation-styles';
      style.textContent = `
        body.rotated {
          transform: rotate(90deg);
          transform-origin: left top;
          width: 100vh;
          height: 100vw;
          position: fixed;
          top: 0;
          left: 0;
          overflow: auto;
        }
      `;
      document.head.appendChild(style);
    }
  }
  
  enterTrueFullscreen() {
    const videoContainer = document.getElementById('video-container');
    if (!videoContainer) return;
    
    // Request fullscreen on the video container itself (Netflix-style)
    if (videoContainer.requestFullscreen) {
      videoContainer.requestFullscreen().catch(err => {
        console.log('Fullscreen error:', err);
        // Fallback to theater mode
        this.enterTheaterMode();
      });
    } else if (videoContainer.webkitRequestFullscreen) {
      videoContainer.webkitRequestFullscreen();
    } else if (videoContainer.msRequestFullscreen) {
      videoContainer.msRequestFullscreen();
    } else {
      // Fallback to theater mode
      this.enterTheaterMode();
    }
  }
  
  exitTrueFullscreen() {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(err => {
        console.log('Exit fullscreen error:', err);
        this.exitTheaterMode();
      });
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    } else {
      this.exitTheaterMode();
    }
    this.isFullscreen = false;
  }

  updateTimeDisplay() {
    const timeDisplay = document.getElementById('time-display');
    const progress = document.getElementById('video-progress');
    
    if (!timeDisplay || !this.videoPlayer) return;
    
    const current = this.formatVideoTime(this.videoPlayer.currentTime || 0);
    const duration = this.formatVideoTime(this.videoPlayer.duration || 0);
    
    timeDisplay.textContent = `${current} / ${duration}`;
    
    if (progress && this.videoPlayer.duration) {
      const value = (this.videoPlayer.currentTime / this.videoPlayer.duration) * 100;
      progress.value = value;
    }
  }

  enterTheaterMode() {
    document.body.classList.add('theater-mode');
    
    // Show controls
    const controls = document.getElementById('custom-controls');
    if (controls) controls.classList.add('visible');
    
    // Show mobile chat button
    const mobileChatBtn = document.getElementById('mobile-chat-btn');
    if (mobileChatBtn) mobileChatBtn.classList.add('visible');
    
    // Show exit button
    const exitBtn = document.getElementById('exit-theater-btn');
    if (exitBtn) exitBtn.style.display = 'block';
  }

  exitTheaterMode() {
    document.body.classList.remove('theater-mode');
    
    // Hide mobile chat button
    const mobileChatBtn = document.getElementById('mobile-chat-btn');
    if (mobileChatBtn) mobileChatBtn.classList.remove('visible');
    
    // Hide exit button
    const exitBtn = document.getElementById('exit-theater-btn');
    if (exitBtn) exitBtn.style.display = 'none';
    
    // Close chat overlay
    this.closeChatOverlay();
  }

  onFullscreenChange() {
    const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    const mobileChatBtn = document.getElementById('mobile-chat-btn');
    
    if (isFullscreen) {
      if (mobileChatBtn) mobileChatBtn.classList.add('visible');
    } else {
      if (mobileChatBtn) mobileChatBtn.classList.remove('visible');
      this.closeChatOverlay();
    }
  }

  openChatOverlay() {
    const overlay = document.getElementById('chat-overlay');
    const overlayMessages = document.getElementById('chat-overlay-messages');
    const chatMessages = document.getElementById('chat-messages');
    
    if (overlay && overlayMessages) {
      // Copy chat messages to overlay
      overlayMessages.innerHTML = chatMessages.innerHTML;
      overlay.classList.add('visible');
      
      // Scroll to bottom
      overlayMessages.scrollTop = overlayMessages.scrollHeight;
    }
  }

  closeChatOverlay() {
    const overlay = document.getElementById('chat-overlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
  }

  sendChatToOverlay() {
    const input = document.getElementById('chat-overlay-input');
    const message = input.value.trim();
    
    if (message && this.socketConnected) {
      const videoTime = this.videoPlayer ? this.videoPlayer.currentTime : 0;
      this.socket.emit('chat:send', {
        roomId: this.roomId,
        message: message,
        videoTime: videoTime
      });
      input.value = '';
      
      // Also sync to main chat
      this.addChatMessage({
        id: Date.now().toString(),
        userName: this.userName,
        message: message,
        timestamp: new Date().toISOString(),
        videoTime: videoTime
      });
    }
  }

  syncChatOverlay() {
    const overlayMessages = document.getElementById('chat-overlay-messages');
    const chatMessages = document.getElementById('chat-messages');
    
    if (overlayMessages && chatMessages && document.getElementById('chat-overlay').classList.contains('visible')) {
      overlayMessages.innerHTML = chatMessages.innerHTML;
      overlayMessages.scrollTop = overlayMessages.scrollHeight;
    }
  }

  selectMode(mode) {
    this.selectedMode = mode;
    
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    
    const descriptions = {
      url: 'Share a video URL - everyone loads the same video. Works with any MP4 link.',
      mse: 'Upload video progressively - viewers can watch while uploading! No WebRTC, works everywhere.',
      webrtc: 'Stream your camera/screen live to viewers. Ultra-low latency, requires camera access.'
    };
    
    document.getElementById('mode-description').textContent = descriptions[mode];
  }

  checkLivekitStatus() {
    const badge = document.getElementById('livekit-status');
    const LiveKitRoom = window.LivekitClient || window.LiveKitRoom;
    if (LiveKitRoom) {
      badge.classList.add('loaded');
      badge.querySelector('span:last-child').textContent = 'WebRTC ready (LiveKit SDK loaded)';
    } else {
      badge.querySelector('span:last-child').textContent = 'WebRTC not available (LiveKit SDK missing)';
    }
  }

  // ============================================
  // ROOM MANAGEMENT
  // ============================================

  async createRoom() {
    const userName = document.getElementById('user-name').value.trim() || 'Host';
    const mode = this.selectedMode || 'url';
    
    try {
      this.connectSocket();
      
      this.socket.emit('room:create', { userName, streamingMode: mode }, (response) => {
        if (response.error) {
          this.showToast(response.error, 'error');
          return;
        }
        
        this.roomId = response.roomId;
        this.userName = userName;
        this.isHost = true;
        this.streamingMode = response.streamingMode || 'url';
        
        this.saveRecentRoom(this.roomId, userName);
        this.showRoom();
        this.showToast('Room created! Share the code with friends', 'success');
      });
    } catch (error) {
      this.showToast('Failed to create room', 'error');
    }
  }

  async joinRoom() {
    const roomCode = document.getElementById('room-code').value.trim().toLowerCase();
    const userName = document.getElementById('join-name').value.trim() || 'Guest';
    
    if (!roomCode) {
      this.showToast('Please enter a room code', 'error');
      return;
    }
    
    try {
      this.connectSocket();
      
      this.socket.emit('room:join', { roomId: roomCode, userName }, (response) => {
        if (response.error) {
          this.showToast(response.error, 'error');
          return;
        }
        
        this.roomId = response.roomId;
        this.userName = userName;
        this.isHost = response.isHost;
        this.streamingMode = response.streamingMode || 'url';
        
        this.saveRecentRoom(this.roomId, userName);
        this.showRoom();
        
        // Sync to current video state if available
        if (response.videoState && response.videoState.url) {
          this.syncToHostVideo(response.videoState);
        }
        
        this.showToast('Joined room ' + this.roomId, 'success');
      });
    } catch (error) {
      this.showToast('Failed to join room', 'error');
    }
  }

  leaveRoom() {
    if (this.webrtc) {
      this.webrtc.cleanup();
      this.webrtc = null;
    }
    
    if (this.socket) {
      this.socket.emit('room:leave');
      this.socket.disconnect();
      this.socket = null;
    }
    
    this.showLanding();
    this.showToast('Left the room', 'success');
  }

  showRoom() {
    document.getElementById('landing-page').classList.remove('active');
    document.getElementById('landing-page').style.display = 'none';
    
    document.getElementById('room-page').classList.add('active');
    document.getElementById('room-page').style.display = 'block';
    
    document.getElementById('room-id-display').textContent = this.roomId;
    document.getElementById('participant-count').textContent = '1 viewer';
    
    const modeDisplay = document.getElementById('streaming-mode');
    if (this.streamingMode === 'mse') {
      modeDisplay.textContent = '📤 MSE Upload';
    } else if (this.streamingMode === 'webrtc') {
      modeDisplay.textContent = '📡 WebRTC Live';
    } else {
      modeDisplay.textContent = '📺 URL Mode';
    }
    
    this.updateControlsForMode();
    
    if (this.cachedChat.length > 0) {
      this.cachedChat.forEach(msg => this.addChatMessage(msg));
    }
    
    // Load uploaded videos for host
    if (this.isHost) {
      this.loadUploadedVideos();
      // Initialize MSE upload if in MSE mode
      if (this.streamingMode === 'mse') {
        this.initMSEUpload();
      }
    }
  }

  showLanding() {
    document.getElementById('room-page').classList.remove('active');
    document.getElementById('room-page').style.display = 'none';
    document.getElementById('landing-page').classList.add('active');
    document.getElementById('landing-page').style.display = 'block';
    
    this.roomId = null;
    this.userName = null;
    this.isHost = false;
    this.streamingMode = 'url';
    this.cachedChat = [];
    
    this.videoPlayer.pause();
    this.videoPlayer.src = '';
    this.videoPlayer.load();
  }

  updateControlsForMode() {
    const hostControls = document.getElementById('host-controls');
    const webrtcControls = document.getElementById('webrtc-controls');
    const viewerNotice = document.getElementById('viewer-notice');
    const viewerNoticeText = document.getElementById('viewer-notice-text');
    const joinWebrtcBtn = document.getElementById('join-webrtc-btn');
    const urlInputSection = document.getElementById('url-input-section');
    const uploadedVideosSection = document.getElementById('uploaded-videos-section');
    const mseUploadSection = document.getElementById('mse-upload-section');
    const dropZone = document.getElementById('drop-zone');
    
    hostControls.style.display = 'none';
    webrtcControls.style.display = 'none';
    viewerNotice.style.display = 'none';
    
    // Hide all sections by default
    if (urlInputSection) urlInputSection.style.display = 'none';
    if (uploadedVideosSection) uploadedVideosSection.style.display = 'none';
    if (mseUploadSection) mseUploadSection.style.display = 'none';
    if (dropZone) dropZone.style.display = 'none';
    
    if (this.isHost) {
      // Host has full control - use custom controls only
      this.videoPlayer.controls = false;
      this.videoPlayer.style.pointerEvents = 'auto';
      
      if (this.streamingMode === 'mse') {
        hostControls.style.display = 'block';
        if (mseUploadSection) mseUploadSection.style.display = 'block';
      } else if (this.streamingMode === 'webrtc') {
        webrtcControls.style.display = 'flex';
        viewerNotice.style.display = 'block';
        viewerNoticeText.textContent = 'You are streaming live to viewers';
      } else {
        hostControls.style.display = 'block';
        if (urlInputSection) urlInputSection.style.display = 'flex';
        if (uploadedVideosSection) uploadedVideosSection.style.display = 'block';
        if (dropZone) dropZone.style.display = 'block';
        viewerNotice.style.display = 'none';
      }
    } else {
      // Viewers - use custom controls only
      this.videoPlayer.controls = false;
      this.videoPlayer.style.pointerEvents = 'auto';
      
      // Disable seek and playback control via JavaScript
      this.videoPlayer.onplay = () => {
        if (!this.isHost && this.streamingMode !== 'webrtc') {
          this.socket.emit('video:requestPlay');
        }
      };
      
      if (this.streamingMode === 'mse') {
        viewerNotice.style.display = 'block';
        viewerNoticeText.textContent = '📤 Host is uploading video progressively';
        document.getElementById('mse-viewer-notice').style.display = 'block';
      } else if (this.streamingMode === 'webrtc') {
        viewerNotice.style.display = 'block';
        viewerNoticeText.textContent = 'Host is streaming live via WebRTC';
        joinWebrtcBtn.style.display = 'inline-block';
      } else {
        viewerNotice.style.display = 'block';
        viewerNoticeText.textContent = 'Host is controlling playback - your video will sync automatically';
      }
    }
  }

  // ============================================
  // FILE UPLOAD FUNCTIONALITY
  // ============================================

  initFileUpload() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    
    if (!dropZone || !fileInput) return;
    
    // Click to browse
    dropZone.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.uploadFile(e.target.files[0]);
      }
    });
    
    // Drag and drop events
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
    
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      
      const files = e.dataTransfer.files;
      if (files.length > 0 && files[0].type.startsWith('video/')) {
        this.uploadFile(files[0]);
      } else {
        this.showToast('Please drop a video file', 'error');
      }
    });
  }

  uploadFile(file) {
    if (!file.type.startsWith('video/')) {
      this.showToast('Only video files are allowed', 'error');
      return;
    }
    
    // Check file size (max 5GB)
    const maxSize = 5 * 1024 * 1024 * 1024;
    if (file.size > maxSize) {
      this.showToast('File too large (max 5GB)', 'error');
      return;
    }
    
    const dropZone = document.getElementById('drop-zone');
    const progressDiv = document.getElementById('upload-progress');
    const progressFill = document.getElementById('progress-fill');
    const uploadStatus = document.getElementById('upload-status');
    const fileInput = document.getElementById('file-input');
    
    // Hide drop zone content, show progress
    dropZone.querySelector('.drop-zone-content').style.display = 'none';
    progressDiv.style.display = 'block';
    
    // Reset function
    const resetDropZone = () => {
      dropZone.querySelector('.drop-zone-content').style.display = 'block';
      progressDiv.style.display = 'none';
      progressFill.style.width = '0%';
      if (fileInput) fileInput.value = '';
    };
    
    // Success handler
    const handleSuccess = (response) => {
      this.showToast('Video uploaded successfully!', 'success');
      this.loadUploadedVideos();
      setTimeout(() => {
        this.loadVideoFromUrl(response.url);
      }, 500);
    };
    
    // Use chunked upload for files > 10MB
    const CHUNK_THRESHOLD = 10 * 1024 * 1024; // 10MB
    
    if (file.size > CHUNK_THRESHOLD) {
      this.uploadFileChunked(file, uploadStatus, progressFill, resetDropZone, handleSuccess);
    } else {
      this.uploadFileRegular(file, uploadStatus, progressFill, resetDropZone, handleSuccess);
    }
  }
  
  uploadFileRegular(file, uploadStatus, progressFill, resetDropZone, onSuccess) {
    uploadStatus.textContent = 'Uploading ' + file.name + '...';
    
    const formData = new FormData();
    formData.append('video', file);
    
    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = (e.loaded / e.total) * 100;
        progressFill.style.width = percent + '%';
        uploadStatus.textContent = `Uploading... ${Math.round(percent)}%`;
      }
    });
    
    xhr.addEventListener('load', () => {
      try {
        const response = JSON.parse(xhr.responseText);
        if (response.success) {
          onSuccess(response);
        } else {
          this.showToast(response.error || 'Upload failed', 'error');
        }
      } catch (e) {
        this.showToast('Upload failed', 'error');
      }
      resetDropZone();
    });
    
    xhr.addEventListener('error', () => {
      this.showToast('Upload failed', 'error');
      resetDropZone();
    });
    
    xhr.open('POST', '/api/upload');
    xhr.send(formData);
  }
  
  uploadFileChunked(file, uploadStatus, progressFill, resetDropZone, onSuccess) {
    const chunkSize = 5 * 1024 * 1024; // 5MB chunks
    const totalChunks = Math.ceil(file.size / chunkSize);
    let currentChunk = 0;
    let uploadId = null;
    
    uploadStatus.textContent = 'Initializing chunked upload...';
    
    // Step 1: Initialize upload session
    fetch('/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        totalSize: file.size,
        totalChunks
      })
    })
    .then(res => res.json())
    .then(data => {
      uploadId = data.uploadId;
      uploadStatus.textContent = `Uploading 0/${totalChunks} chunks...`;
      return this.uploadChunk(uploadId, file, currentChunk, chunkSize, totalChunks, uploadStatus, progressFill);
    })
    .then(() => this.uploadNextChunk(uploadId, file, currentChunk, chunkSize, totalChunks, uploadStatus, progressFill, onSuccess, resetDropZone))
    .catch(error => {
      console.error('Chunked upload error:', error);
      this.showToast('Upload failed: ' + error.message, 'error');
      resetDropZone();
      // Cancel upload session
      if (uploadId) {
        fetch('/api/upload/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId })
        });
      }
    });
  }
  
  uploadChunk(uploadId, file, chunkIndex, chunkSize, totalChunks, uploadStatus, progressFill) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);
    
    const formData = new FormData();
    formData.append('chunk', chunk);
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', chunkIndex);
    
    return fetch('/api/upload/chunk', {
      method: 'POST',
      body: formData
    })
    .then(res => res.json())
    .then(data => {
      if (!data.success) {
        throw new Error(data.error || 'Chunk upload failed');
      }
      
      const percent = (data.progress || 0);
      progressFill.style.width = percent + '%';
      uploadStatus.textContent = `Uploading ${data.received || (chunkIndex + 1)}/${totalChunks} chunks...`;
      
      return data;
    });
  }
  
  uploadNextChunk(uploadId, file, currentChunk, chunkSize, totalChunks, uploadStatus, progressFill, onSuccess, resetDropZone) {
    if (currentChunk >= totalChunks) {
      // All chunks uploaded, complete the upload (poll for status)
      uploadStatus.textContent = 'Assembling file...';
      progressFill.style.width = '100%';
      
      fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success && data.jobId) {
          // Poll for job status
          this.pollUploadStatus(data.jobId, onSuccess, resetDropZone);
        } else {
          this.showToast(data.error || 'Failed to start assembly', 'error');
          resetDropZone();
        }
      })
      .catch(error => {
        console.error('Complete upload error:', error);
        this.showToast('Failed to complete upload: ' + error.message, 'error');
        resetDropZone();
      });
      
      return;
    }
    
    // Upload next chunk
    this.uploadChunk(uploadId, file, currentChunk, chunkSize, totalChunks, uploadStatus, progressFill)
      .then(() => {
        this.uploadNextChunk(uploadId, file, currentChunk + 1, chunkSize, totalChunks, uploadStatus, progressFill, onSuccess, resetDropZone);
      })
      .catch(error => {
        console.error('Chunk upload error:', error);
        this.showToast('Upload failed: ' + error.message, 'error');
        resetDropZone();
      });
  }
  
  pollUploadStatus(jobId, onSuccess, resetDropZone, attempt = 0) {
    const maxAttempts = 300; // Poll for up to 5 minutes (300 * 1 second)
    const pollInterval = 1000; // 1 second
    
    fetch(`/api/upload/status/${jobId}`)
      .then(res => res.json())
      .then(job => {
        if (job.status === 'complete') {
          // Assembly complete
          if (job.result && job.result.success) {
            onSuccess(job.result);
          } else {
            this.showToast(job.result?.error || 'Upload failed during assembly', 'error');
          }
          resetDropZone();
        } else if (job.status === 'error') {
          // Assembly failed
          this.showToast('Assembly failed: ' + job.error, 'error');
          resetDropZone();
        } else if (job.status === 'processing') {
          // Still processing, continue polling
          if (attempt < maxAttempts) {
            setTimeout(() => {
              this.pollUploadStatus(jobId, onSuccess, resetDropZone, attempt + 1);
            }, pollInterval);
          } else {
            this.showToast('Assembly timed out, please try again', 'error');
            resetDropZone();
          }
        }
      })
      .catch(error => {
        console.error('Poll status error:', error);
        // Retry polling on network error
        if (attempt < maxAttempts) {
          setTimeout(() => {
            this.pollUploadStatus(jobId, onSuccess, resetDropZone, attempt + 1);
          }, pollInterval * 2); // Longer delay on error
        } else {
          this.showToast('Failed to check upload status', 'error');
          resetDropZone();
        }
      });
  }

  loadUploadedVideos() {
    const list = document.getElementById('uploaded-videos-list');
    const countEl = document.getElementById('video-count');
    if (!list) return;
    
    list.innerHTML = '<p class="loading-text">Loading videos...</p>';
    
    fetch('/api/videos')
      .then(res => res.json())
      .then(videos => {
        // Update video count
        if (countEl) {
          countEl.textContent = `(${videos.length})`;
        }
        
        if (videos.length === 0) {
          list.innerHTML = '<p class="no-videos">No uploaded videos yet. Drop a video file above!</p>';
          return;
        }
        
        list.innerHTML = videos.map(video => `
          <div class="uploaded-video-item" data-url="${video.url}" data-name="${this.escapeHtml(video.name)}" data-filename="${this.escapeHtml(video.filename)}">
            <span class="video-icon">🎬</span>
            <div class="video-details">
              <div class="video-name">${this.escapeHtml(video.name)}</div>
              <div class="video-size">${this.formatFileSize(video.size)}</div>
            </div>
            <div class="video-actions">
              <button class="delete-video-btn" data-filename="${this.escapeHtml(video.filename)}" title="Delete video">🗑️</button>
              <span class="play-icon">▶️</span>
            </div>
          </div>
        `).join('');
        
        // Add click handlers for play
        list.querySelectorAll('.uploaded-video-item').forEach(item => {
          item.addEventListener('click', (e) => {
            if (e.target.closest('.delete-video-btn')) return; // Don't play if clicking delete
            this.loadVideoFromUrl(item.dataset.url);
          });
        });
        
        // Add delete handlers
        list.querySelectorAll('.delete-video-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteVideo(btn.dataset.filename);
          });
        });
      })
      .catch(err => {
        list.innerHTML = '<p class="no-videos">Failed to load videos</p>';
      });
  }

  deleteVideo(filename) {
    if (!confirm('Are you sure you want to delete this video?')) {
      return;
    }
    
    fetch(`/api/videos/${encodeURIComponent(filename)}`, {
      method: 'DELETE'
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          this.showToast('Video deleted', 'success');
          this.loadUploadedVideos();
        } else {
          this.showToast(data.error || 'Failed to delete video', 'error');
        }
      })
      .catch(err => {
        this.showToast('Failed to delete video', 'error');
      });
  }

  // ============================================
  // MSE UPLOAD FUNCTIONALITY (Progressive Upload)
  // ============================================

  initMSEUpload() {
    const mseDropZone = document.getElementById('mse-drop-zone');
    const mseFileInput = document.getElementById('mse-file-input');
    
    if (!mseDropZone || !mseFileInput) return;
    
    // Click to browse
    mseDropZone.addEventListener('click', () => mseFileInput.click());
    
    mseFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.startMSEUpload(e.target.files[0]);
      }
    });
    
    // Drag and drop events
    mseDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      mseDropZone.classList.add('drag-over');
    });
    
    mseDropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      mseDropZone.classList.remove('drag-over');
    });
    
    mseDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      mseDropZone.classList.remove('drag-over');
      
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const file = files[0];
        // Only accept MP4 for MSE
        if (file.type === 'video/mp4' || file.name.endsWith('.mp4')) {
          this.startMSEUpload(file);
        } else {
          this.showToast('MSE mode requires MP4 format. Please convert your video.', 'error');
        }
      } else {
        this.showToast('Please drop a video file', 'error');
      }
    });
    
    console.log('MSE upload initialized');
  }

  async startMSEUpload(file) {
    // Validate file is MP4
    if (file.type !== 'video/mp4' && !file.name.endsWith('.mp4')) {
      this.showToast('MSE mode requires MP4 format. Please convert your video.', 'error');
      return;
    }
    
    // Check file size
    if (file.size > 2 * 1024 * 1024 * 1024) {
      this.showToast('File too large for MSE (max 2GB)', 'error');
      return;
    }
    
    const mseDropZone = document.getElementById('mse-drop-zone');
    const mseProgress = document.getElementById('mse-upload-progress');
    const mseStatus = document.getElementById('mse-upload-status');
    const mseFileInput = document.getElementById('mse-file-input');
    
    // Hide drop zone content, show progress
    mseDropZone.querySelector('.drop-zone-content').style.display = 'none';
    mseProgress.style.display = 'block';
    mseStatus.textContent = 'Initializing upload...';
    
    try {
      // Create MSE player if not exists
      if (!this.msePlayer) {
        if (typeof MSEPlayer === 'undefined') {
          throw new Error('MSEPlayer not loaded');
        }
        this.msePlayer = new MSEPlayer({
          videoElement: this.videoPlayer,
          socket: this.socket,
          roomId: this.roomId
        });
        
        // Set error handler for fallback
        this.msePlayer.onError = (error) => {
          console.log('MSE error callback triggered:', error);
          this.handleMSEFallback(uploadId, mseStatus);
        };
      }
      
      // Initialize MSE upload
      const uploadId = await this.msePlayer.initUpload(file);
      mseStatus.textContent = 'Upload complete! Starting playback...';
      
      // Notify viewers about MSE upload
      this.socket.emit('mse:uploadComplete', {
        roomId: this.roomId,
        uploadId: uploadId,
        filename: file.name,
        size: file.size
      });
      
      // Start MSE playback
      try {
        await this.msePlayer.startPlayback();
        
        // Set MSE player socket
        this.msePlayer.socket = this.socket;
        this.msePlayer.roomId = this.roomId;
        this.msePlayer.setHost(true);
        
        this.showToast('MSE streaming started! Viewers can now watch.', 'success');
      } catch (playbackError) {
        // MSE failed - fall back to URL mode with complete video
        console.warn('MSE playback failed, using URL mode:', playbackError);
        mseStatus.textContent = 'MSE failed - playing via URL mode...';
        
        // Clean up MSE player
        if (this.msePlayer) {
          this.msePlayer.cleanup();
        }
        
        // Wait for upload to complete and serve complete video
        mseStatus.textContent = 'Preparing video...';
        
        // Wait a bit for upload to complete
        await new Promise(r => setTimeout(r, 1000));
        
        // Get the complete video URL
        const videoUrl = `/api/mse/video/${uploadId}`;
        
        // Load the video via URL mode
        this.loadVideoFromUrl(videoUrl);
        
        mseStatus.textContent = 'Video loaded!';
        this.showToast('Video ready! Playing via URL mode.', 'success');
      }
    } catch (error) {
      console.error('MSE upload error:', error);
      this.showToast('MSE upload failed: ' + error.message, 'error');
      
      // Reset UI
      mseDropZone.querySelector('.drop-zone-content').style.display = 'block';
      mseProgress.style.display = 'none';
      if (mseFileInput) mseFileInput.value = '';
    }
  }

  /**
   * Handle MSE fallback when progressive playback fails
   */
  async handleMSEFallback(uploadId, statusEl) {
    console.log('Handling MSE fallback for:', uploadId);
    
    if (statusEl) statusEl.textContent = 'MSE failed - switching to URL mode...';
    
    // Clean up MSE player
    if (this.msePlayer) {
      this.msePlayer.cleanup();
    }
    
    try {
      // Get the complete video URL
      const videoUrl = `/api/mse/video/${uploadId}`;
      
      // Load the video via URL mode
      this.loadVideoFromUrl(videoUrl);
      
      if (statusEl) statusEl.textContent = 'Video loaded!';
      this.showToast('Video ready! Playing via URL mode.', 'success');
    } catch (error) {
      console.error('MSE fallback error:', error);
      this.showToast('Failed to load video: ' + error.message, 'error');
    }
  }

  async joinMSEStream(uploadId) {
    if (!this.msePlayer) {
      this.msePlayer = new MSEPlayer({
        videoElement: this.videoPlayer,
        socket: this.socket,
        roomId: this.roomId
      });
    }
    
    this.msePlayer.uploadId = uploadId;
    this.msePlayer.socket = this.socket;
    this.msePlayer.roomId = this.roomId;
    this.msePlayer.setHost(false);
    
    // Start MSE playback
    await this.msePlayer.startPlayback();
    
    // Set up sync from host
    this.socket.on('mse:play', (data) => {
      this.msePlayer.syncFromHost(data);
    });
    
    this.socket.on('mse:pause', (data) => {
      this.msePlayer.syncFromHost(data);
    });
    
    this.socket.on('mse:seek', (data) => {
      this.msePlayer.syncFromHost(data);
    });
    
    this.showToast('Connected to MSE stream!', 'success');
  }

  loadVideoFromUrl(url) {
    // Set the URL in the input
    document.getElementById('video-url').value = url;
    
    // Load the video
    this.socket.emit('video:setSource', {
      roomId: this.roomId,
      url: url
    });
    
    this.showToast('Video loaded for everyone', 'success');
    
    // Show video info when loaded
    this.videoPlayer.onloadedmetadata = () => {
      this.showVideoInfo();
    };
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // ============================================
  // SOCKET CONNECTION
  // ============================================

  connectSocket() {
    if (this.socket?.connected) return;
    
    const serverUrl = window.location.origin;
    
    this.socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });
    
    this.socket.on('connect', () => {
      this.socketConnected = true;
      this.updateConnectionStatus('connected');
      
      // Initialize PureWebRTC with socket if not already done
      if (this.webrtc) {
        this.webrtc.socket = this.socket;
      }
    });
    
    this.socket.on('disconnect', () => {
      this.socketConnected = false;
      this.updateConnectionStatus('disconnected');
    });
    
    this.socket.on('connect_error', (error) => {
      this.updateConnectionStatus('disconnected');
      this.showToast('Connection error - please refresh', 'error');
    });
    
    this.socket.on('room:userJoined', (data) => {
      document.getElementById('participant-count').textContent = 
        data.participantCount + ' viewers';
      this.showToast(data.userName + ' joined the room', 'success');
    });
    
    this.socket.on('room:userLeft', (data) => {
      if (data.userName) {
        this.showToast(data.userName + ' left the room', 'success');
      }
    });
    
    this.socket.on('room:newHost', () => {
      this.isHost = true;
      this.updateControlsForMode();
      this.showToast('You are now the host!', 'success');
    });
    
    this.socket.on('video:sourceChanged', (data) => {
      this.streamingMode = data.mode || 'url';
      this.updateControlsForMode();
      
      this.videoPlayer.src = data.url;
      this.videoPlayer.load();
      this.videoPlayer.currentTime = 0;
      this.showToast('Host loaded new video', 'success');
      
      // Show video info when loaded
      this.videoPlayer.onloadedmetadata = () => {
        this.showVideoInfo();
      };
    });
    
    this.socket.on('video:play', (data) => {
      this.syncPlay(data.currentTime, data.timestamp);
    });
    
    this.socket.on('video:pause', (data) => {
      this.syncPause(data.currentTime, data.timestamp);
    });
    
    this.socket.on('video:seek', (data) => {
      this.syncSeek(data.currentTime, data.timestamp);
    });
    
    this.socket.on('webrtc:hostStartedStreaming', (data) => {
      this.streamingMode = 'webrtc';
      this.updateControlsForMode();
      this.showToast(data.hostName + ' started streaming!', 'success');
    });
    
    // Pure WebRTC events (no LiveKit required!)
    this.socket.on('webrtc:host-started', (data) => {
      console.log('Host started broadcasting:', data);
      this.streamingMode = 'webrtc';
      this.updateControlsForMode();
      
      // Show join button for viewers
      const joinBtn = document.getElementById('join-webrtc-btn');
      const noticeText = document.getElementById('viewer-notice-text');
      if (joinBtn && !this.isHost) {
        joinBtn.style.display = 'inline-block';
        noticeText.textContent = data.hostName + ' is live! Click to watch';
      }
      
      this.showToast(data.hostName + ' started broadcasting!', 'success');
    });
    
    this.socket.on('webrtc:host-stopped', (data) => {
      // Only update mode for viewers - host stays in webrtc mode to stream again
      if (!this.isHost) {
        this.streamingMode = 'url';
        this.updateControlsForMode();
      } else {
        // For host: just update controls without changing mode
        this.updateControlsForMode();
      }
      
      // Hide join button (for viewers)
      const joinBtn = document.getElementById('join-webrtc-btn');
      if (joinBtn) {
        joinBtn.style.display = 'none';
      }
      
      // Cleanup WebRTC (for viewers only)
      if (this.webrtc && !this.isHost) {
        this.webrtc.cleanup();
      }
      
      this.showToast('Broadcast ended', 'info');
    });
    
    this.socket.on('webrtc:new-viewer', async (data) => {
      // Host: Create offer for new viewer — delegate to PureWebRTC
      if (this.webrtc && this.isHost) {
        await this.webrtc.createOfferForViewer(data.viewerId);
      }
    });
    
    this.socket.on('webrtc:viewer-offer', async (data) => {
      // Viewer: Handle offer from host — delegate to PureWebRTC
      if (this.webrtc && !this.isHost) {
        this.webrtc.roomId = this.roomId;
        await this.webrtc.handleHostOffer(data.offer, data.hostId);
      }
    });
    
    this.socket.on('webrtc:host-answer', async (data) => {
      // Host: Handle answer from viewer — delegate to PureWebRTC
      if (this.webrtc && this.isHost) {
        await this.webrtc.handleViewerAnswer(data.viewerId, data.answer);
      }
    });
    
    this.socket.on('webrtc:host-ice-candidate', async (data) => {
      // Viewer: Handle ICE candidate from host — delegate to PureWebRTC
      if (this.webrtc && !this.isHost) {
        await this.webrtc.addHostIceCandidate(data.candidate);
      }
    });
    
    this.socket.on('webrtc:viewer-ice-candidate', async (data) => {
      // Handle ICE candidate from other peer — delegate to PureWebRTC
      if (this.webrtc) {
        if (data.viewerId && this.isHost) {
          // HOST: Handle ICE candidate from viewer
          await this.webrtc.addViewerIceCandidate(data.viewerId, data.candidate);
        } else if (data.hostId && !this.isHost) {
          // VIEWER: Handle ICE candidate from host
          await this.webrtc.addHostIceCandidate(data.candidate);
        }
      }
    });
    
    this.socket.on('webrtc:viewer-left', (data) => {
      // Host: Viewer disconnected
      console.log('Viewer left:', data.viewerId);
      if (this.webrtc) {
        this.webrtc.handleViewerLeft(data.viewerId);
      }
    });
    
    this.socket.on('webrtc:streamingStopped', (data) => {
      this.streamingMode = 'url';
      this.updateControlsForMode();
      this.showToast(data.by + ' stopped streaming', 'success');
      
      if (this.webrtc) {
        this.webrtc.cleanup();
        this.webrtc = null;
      }
    });
    
    this.socket.on('webrtc:viewerJoined', async (data) => {
      await this.initWebRTCViewer(data);
    });
    
    this.socket.on('webrtc:error', (error) => {
      this.showToast(error.message, 'error');
    });
    
    this.socket.on('chat:message', (message) => {
      this.addChatMessage(message);
    });
  }

  updateConnectionStatus(status) {
    const statusEl = document.getElementById('connection-status');
    statusEl.className = 'status ' + status;
    statusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  }

  // ============================================
  // VIDEO SYNC LOGIC (URL MODE)
  // ============================================

  syncPlay(hostTime, eventTimestamp) {
    console.log('Received syncPlay event, hostTime: ' + hostTime);
    if (!this.syncEnabled || this.streamingMode === 'webrtc') return;
    
    const timeSinceEvent = (Date.now() - eventTimestamp) / 1000;
    const currentTime = hostTime + timeSinceEvent;
    
    console.log('Syncing to time: ' + currentTime + ', video currentTime: ' + this.videoPlayer.currentTime);
    
    if (Math.abs(this.videoPlayer.currentTime - currentTime) > 2) {
      this.videoPlayer.currentTime = currentTime;
    }
    
    this.videoPlayer.play().catch((e) => console.log('Play failed:', e));
    this.lastSyncTime = currentTime;
  }

  syncPause(hostTime, eventTimestamp) {
    if (!this.syncEnabled || this.streamingMode === 'webrtc') return;
    
    const timeSinceEvent = (Date.now() - eventTimestamp) / 1000;
    const currentTime = hostTime + timeSinceEvent;
    
    this.videoPlayer.pause();
    this.videoPlayer.currentTime = currentTime;
    this.lastSyncTime = currentTime;
  }

  syncSeek(hostTime, eventTimestamp) {
    if (!this.syncEnabled || this.streamingMode === 'webrtc') return;
    
    this.videoPlayer.currentTime = hostTime;
    this.lastSyncTime = hostTime;
  }

  syncToHostVideo(videoState) {
    // Sync viewer to current video position when joining late
    if (!videoState || !videoState.url) return;
    
    this.videoPlayer.src = videoState.url;
    this.videoPlayer.load();
    
    // Set the current time
    setTimeout(() => {
      this.videoPlayer.currentTime = videoState.currentTime || 0;
      
      // Play or pause based on host's state
      if (videoState.isPlaying) {
        this.videoPlayer.play().catch(e => console.log('Auto-play blocked:', e));
      } else {
        this.videoPlayer.pause();
      }
      
      this.showToast('Synced to current video position', 'success');
    }, 500);
  }

  onVideoPlay() {
    console.log('Host clicked play at: ' + this.videoPlayer.currentTime);
    if (!this.isHost || !this.socketConnected || this.streamingMode === 'webrtc') return;
    
    this.socket.emit('video:play', {
      roomId: this.roomId,
      currentTime: this.videoPlayer.currentTime
    });
  }

  onVideoPause() {
    if (!this.isHost || !this.socketConnected || this.streamingMode === 'webrtc') return;
    
    this.socket.emit('video:pause', {
      roomId: this.roomId,
      currentTime: this.videoPlayer.currentTime
    });
  }

  onVideoSeek() {
    if (!this.isHost || !this.socketConnected || this.streamingMode === 'webrtc') return;
    
    this.socket.emit('video:seek', {
      roomId: this.roomId,
      currentTime: this.videoPlayer.currentTime
    });
  }

  loadVideo() {
    const url = document.getElementById('video-url').value.trim();
    
    if (!url) {
      this.showToast('Please enter a video URL', 'error');
      return;
    }
    
    if (!url.startsWith('http')) {
      this.showToast('Please enter a valid URL (http:// or https://)', 'error');
      return;
    }
    
    this.socket.emit('video:setSource', {
      roomId: this.roomId,
      url: url
    });
    
    this.showToast('Video loaded for everyone', 'success');
    
    // Show video info when host loads video
    this.videoPlayer.onloadedmetadata = () => {
      this.showVideoInfo();
    };
  }

  showVideoInfo() {
    const infoDiv = document.getElementById('video-info');
    if (!infoDiv) return;
    
    const duration = this.videoPlayer.duration;
    const width = this.videoPlayer.videoWidth;
    const height = this.videoPlayer.videoHeight;
    
    if (duration && width && height) {
      const mins = Math.floor(duration / 60);
      const secs = Math.floor(duration % 60);
      
      infoDiv.innerHTML = `
        <div class="info-row">
          <span class="info-label">Duration</span>
          <span class="info-value">${mins}:${secs.toString().padStart(2, '0')}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Resolution</span>
          <span class="info-value">${width} × ${height}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Quality</span>
          <span class="info-value">${this.getQualityLabel(width)}</span>
        </div>
      `;
      infoDiv.style.display = 'block';
    }
  }

  getQualityLabel(width) {
    if (width >= 1920) return '1080p Full HD';
    if (width >= 1280) return '720p HD';
    if (width >= 854) return '480p SD';
    if (width >= 640) return '360p';
    return 'Low Quality';
  }

  // ============================================
  // WEBRTC FUNCTIONS (Pure WebRTC - No LiveKit required!)
  // ============================================

  async startWebRTCStreaming() {
    // Check if Pure WebRTC is available
    if (typeof PureWebRTC === 'undefined') {
      this.showToast('WebRTC not available - pure-webrtc.js not loaded', 'error');
      console.error('PureWebRTC not loaded');
      return;
    }
    
    if (!this.isHost) {
      this.showToast('Only the host can start streaming', 'error');
      return;
    }
    
    if (!this.socket) {
      this.showToast('Not connected to server', 'error');
      return;
    }
    
    // Initialize PureWebRTC
    this.webrtc = new PureWebRTC();
    this.webrtc.init(this.videoPlayer, this.socket);
    this.webrtc.roomId = this.roomId;
    
    this.webrtc.onError = (error) => {
      this.showToast('WebRTC Error: ' + error.message, 'error');
    };
    
    // Start broadcasting (camera or screen)
    const success = await this.webrtc.startBroadcast({ 
      screen: this.webrtcMode === 'screen',
      roomId: this.roomId
    });
    
    if (success) {
      // Notify server that host started broadcasting
      this.socket.emit('webrtc:host-started', {
        roomId: this.roomId
      });
      
      // Toggle buttons
      document.getElementById('start-webrtc-camera-btn').style.display = 'none';
      document.getElementById('start-webrtc-screen-btn').style.display = 'none';
      document.getElementById('stop-webrtc-btn').style.display = 'inline-block';
      document.getElementById('webrtc-controls').querySelector('.webrtc-status').innerHTML = 
        '<span class="live-indicator">LIVE</span><span id="viewer-count">0 watching</span>';
      
      // Show local preview for host
      const previewContainer = document.getElementById('local-preview-container');
      if (previewContainer) {
        previewContainer.style.display = 'block';
      }
      
      this.showToast('🔴 Live! Viewers can now join', 'success');
    }
  }

  async stopWebRTCStreaming() {
    if (this.webrtc) {
      await this.webrtc.stopBroadcast();
    }
    
    // Toggle buttons
    document.getElementById('start-webrtc-camera-btn').style.display = 'inline-block';
    document.getElementById('start-webrtc-screen-btn').style.display = 'inline-block';
    document.getElementById('stop-webrtc-btn').style.display = 'none';
    document.getElementById('webrtc-controls').querySelector('.webrtc-status').innerHTML = 
        '<span class="live-indicator"></span><span id="viewer-count">Stream offline</span>';
    
    // Hide local preview
    const previewContainer = document.getElementById('local-preview-container');
    if (previewContainer) {
      previewContainer.style.display = 'none';
    }
    
    // Notify server
    if (this.socket) {
      this.socket.emit('webrtc:host-stopped', {
        roomId: this.roomId
      });
    }
    
    this.showToast('Broadcast stopped', 'info');
  }

  async joinWebRTCStream() {
    // Check if Pure WebRTC is available
    if (typeof PureWebRTC === 'undefined') {
      this.showToast('WebRTC not available - pure-webrtc.js not loaded', 'error');
      return;
    }
    
    if (!this.socket) {
      this.showToast('Not connected', 'error');
      return;
    }
    
    // Initialize PureWebRTC with current video element
    this.webrtc = new PureWebRTC();
    this.webrtc.init(this.videoPlayer, this.socket);
    this.webrtc.roomId = this.roomId;
    
    this.webrtc.onConnected = () => this.showToast('Connected to broadcast!', 'success');
    this.webrtc.onDisconnected = () => this.showToast('Disconnected', 'warning');
    this.webrtc.onError = (error) => this.showToast('WebRTC: ' + error.message, 'error');
    
    // Request to join as viewer
    this.socket.emit('webrtc:join-viewer', {
      roomId: this.roomId
    });
    
    // UI update
    document.getElementById('join-webrtc-btn').style.display = 'none';
    document.getElementById('viewer-notice-text').textContent = 'Connecting to broadcast…';
    this.showToast('Joining broadcast…', 'info');
  }

  async initWebRTCViewer(data) {
    // Not used with Pure WebRTC - kept for compatibility
    console.log('initWebRTCViewer called (LiveKit compatibility)');
  }

  // ============================================
  // CHAT FUNCTIONALITY
  // ============================================

  sendChat() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    
    if (!message || !this.socketConnected) {
      return;
    }
    
    this.socket.emit('chat:send', {
      roomId: this.roomId,
      message: message
    });
    
    input.value = '';
  }

  addChatMessage(message) {
    const container = document.getElementById('chat-messages');
    const messageEl = document.createElement('div');
    const isOwn = message.userName === this.userName;
    const isReaction = message.isReaction || false;
    messageEl.className = 'chat-message' + (isOwn ? ' own-message' : '') + (isReaction ? ' is-reaction' : '');
    messageEl.dataset.messageId = message.id;
    
    const time = new Date(message.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const videoTimeStr = message.videoTime !== undefined 
      ? ' @ ' + this.formatVideoTime(message.videoTime)
      : '';
    
    // Build message DOM elements using DOM methods instead of innerHTML
    const headerEl = document.createElement('div');
    headerEl.className = 'message-header';
    
    const nameEl = document.createElement('span');
    nameEl.className = 'user-name';
    nameEl.textContent = message.userName;
    
    const timeEl = document.createElement('span');
    timeEl.className = 'message-time';
    timeEl.textContent = timeStr;
    
    headerEl.appendChild(nameEl);
    headerEl.appendChild(timeEl);
    
    const textEl = document.createElement('div');
    textEl.className = 'message-text';
    textEl.textContent = message.message;
    
    messageEl.appendChild(headerEl);
    messageEl.appendChild(textEl);
    
    if (videoTimeStr) {
      const videoTimeEl = document.createElement('div');
      videoTimeEl.className = 'video-timestamp';
      videoTimeEl.textContent = videoTimeStr;
      messageEl.appendChild(videoTimeEl);
    }
    
    console.log('Adding message:', message.userName, '|', message.message);
    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
    
    this.cachedChat.push(message);
    if (this.cachedChat.length > 100) {
      this.cachedChat = this.cachedChat.slice(-50);
    }
    
    // Sync to overlay if open
    this.syncChatOverlay();
    
    // Show notification if chat is hidden (mobile or fullscreen)
    const chatSection = document.getElementById('chat-section');
    const chatHidden = (window.innerWidth <= 900 && !chatSection?.classList.contains('open')) || (document.fullscreenElement || document.body.classList.contains('theater-mode'));
    
    if (chatHidden) {
      // Don't show notification for own messages
      if (message.userName !== this.userName) {
        // Remove existing notification first
        document.querySelector('.msg-notification')?.remove();
        
        const notif = document.createElement('div');
        notif.className = 'msg-notification';
        notif.innerHTML = `
          <div class="notif-name">${this.escapeHtml(message.userName)}</div>
          <div class="notif-text">${this.escapeHtml(message.message)}</div>
        `;
        document.body.appendChild(notif);
        
        // Auto remove after animation ends
        setTimeout(() => notif.remove(), 4000);
      }
    }
  }

  formatVideoTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins + ':' + secs.toString().padStart(2, '0');
  }

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  copyInvite() {
    const inviteUrl = window.location.origin + '?room=' + this.roomId;
    
    navigator.clipboard.writeText(inviteUrl).then(() => {
      this.showToast('Invite link copied!', 'success');
    }).catch(() => {
      const textArea = document.createElement('textarea');
      textArea.value = inviteUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      this.showToast('Invite link copied!', 'success');
    });
  }

  checkUrlForRoom() {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    
    if (roomCode) {
      document.getElementById('room-code').value = roomCode;
      document.getElementById('join-name').focus();
    }
  }

  saveRecentRoom(roomId, userName) {
    let recent = JSON.parse(localStorage.getItem('watchTogetherRecent') || '[]');
    
    recent = recent.filter(r => r.roomId !== roomId);
    recent.unshift({ roomId: roomId, userName: userName, joinedAt: Date.now() });
    recent = recent.slice(0, 5);
    
    localStorage.setItem('watchTogetherRecent', JSON.stringify(recent));
    this.loadRecentRooms();
  }

  loadRecentRooms() {
    const recent = JSON.parse(localStorage.getItem('watchTogetherRecent') || '[]');
    const container = document.getElementById('recent-rooms-list');
    const wrapper = document.getElementById('recent-rooms');
    
    if (recent.length === 0) {
      wrapper.style.display = 'none';
      return;
    }
    
    wrapper.style.display = 'block';
    container.innerHTML = recent.map(room => 
      '<div class="recent-room-item" data-room="' + room.roomId + '">' +
        '<strong>' + room.roomId + '</strong>' +
        '<br><small>You were: ' + room.userName + '</small>' +
      '</div>'
    ).join('');
    
    container.querySelectorAll('.recent-room-item').forEach(el => {
      el.addEventListener('click', () => {
        document.getElementById('room-code').value = el.dataset.room;
        document.getElementById('join-name').focus();
      });
    });
  }

  showToast(message, type) {
    if (!type) type = 'info';
    document.querySelectorAll('.toast').forEach(t => t.remove());
    
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new WatchTogether();
});
