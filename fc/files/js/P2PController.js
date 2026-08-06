/**
 * P2PController - P2P 联机对战控制器（简化版）
 * 基于 PeerJS (WebRTC DataChannel) 实现跨网络 P2P 连接
 * 适配主文件结构
 */
class P2PController {
    // ═══ 静态信令服务器配置 ═══
    static signaling = {
        host: 'fnchess.peerserver.keye3tuido.site',
        port: 443,
        path: '/',
        secure: true,
        key: 'peerjs',
        debug: 0
    };

    constructor() {
        this.peer = null;
        this.conn = null;
        this.isHost = false;
        this.roomCode = '';
        this.isConnected = false;
        this.isConnecting = false;
        this._disconnecting = false;
        this._guestConnecting = false;
        this._timeoutId = null;

        this.myPlayerId = '';
        this.opponentPlayerId = '';
        this._gen = 0;
        this._seqno = 0;
        this._pendingAck = null;
        this._watchdogId = null;
        this._pingInterval = null;

        this.onStatusChange = null;
        this.onConnected    = null;
        this.onDisconnected = null;
        this.onError        = null;
        this.onGameAction   = null;
        this.onNack         = null;
        this.onGameInit     = null;
        this.onStateSync    = null;
        this.onTimerSync    = null;
        this.onTimeout      = null;
        this.onRematch      = null;

        this.iceServers = [
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:stun.qq.com:3478' },
            { urls: 'stun:stun.miwifi.com:3478' }
        ];
        this._codeChars = 'ABCDEFGHJKMNPRSTUVWXYZ23456789';
        this._cachedIceServers = null;
    }

    async _fetchIceServers() {
        if (this._cachedIceServers) return this._cachedIceServers;
        const sig = P2PController.signaling;
        const proto = sig.secure ? 'https' : 'http';
        const portPart = (sig.port === 443 && sig.secure) || (sig.port === 80 && !sig.secure) ? '' : `:${sig.port}`;
        try {
            const ticketUrl = `${proto}://${sig.host}${portPart}/auth-ticket`;
            const ticketResp = await fetch(ticketUrl);
            if (!ticketResp.ok) throw new Error('ticket HTTP ' + ticketResp.status);
            const { ticket, expires } = await ticketResp.json();

            const configUrl = `${proto}://${sig.host}${portPart}/turn-config?ticket=${encodeURIComponent(ticket)}&expires=${expires}`;
            const resp = await fetch(configUrl);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            this._cachedIceServers = data.iceServers;
        } catch (e) {
            console.warn('[P2P] 获取中继配置失败，使用 STUN 兜底:', e.message);
            this._cachedIceServers = this.iceServers;
        }
        return this._cachedIceServers;
    }

    _generateRoomCode() {
        let code = '';
        const len = this._codeChars.length;
        for (let i = 0; i < 6; i++) code += this._codeChars[Math.floor(Math.random() * len)];
        return code;
    }

    async createRoom() {
        if (this.isConnecting || this.isConnected) {
            this._notifyStatus('error', '已有进行中的连接');
            return;
        }
        this._disconnecting = false;
        this.roomCode = this._generateRoomCode();
        this.isHost = true;
        this.myPlayerId = 'A';
        this.opponentPlayerId = 'B';
        this.isConnecting = true;
        this._notifyStatus('connecting', '正在创建房间...');
        this._startTimeout('创建房间超时，请检查网络后重试', 45000);

        const iceServers = await this._fetchIceServers();
        if (!this.isConnecting) return;
        try {
            const sig = P2PController.signaling;
            this.peer = new Peer(this.roomCode, {
                debug: sig.debug,
                host: sig.host,
                port: sig.port,
                path: sig.path,
                secure: sig.secure,
                key: sig.key,
                config: { iceServers }
            });
            this.peer.on('open', () => {
                this._clearTimeout();
                this._notifyStatus('waiting', '等待对手加入...');
                this._startTimeout('等待对手超时，请确认房间码已分享给对方', 60000);
            });
            this.peer.on('connection', (conn) => {
                if (this.isConnected || this._guestConnecting) { conn.close(); return; }
                this._guestConnecting = true;
                this._clearTimeout();
                this._setupConnection(conn);
            });
            this.peer.on('error', (err) => this._handleError(err));
            this.peer.on('disconnected', () => {
                if (this._disconnecting) return;
                if (this.peer && !this.peer.destroyed) this.peer.reconnect();
            });
        } catch (err) { this._handleError(err); }
    }

    async joinRoom(roomCode) {
        if (this.isConnecting || this.isConnected) {
            this._notifyStatus('error', '已有进行中的连接');
            return;
        }
        const normalized = roomCode.trim().toUpperCase().replace(/[^ABCDEFGHJKMNPRSTUVWXYZ23456789]/g, '');
        if (normalized.length !== 6) {
            this._notifyStatus('error', '房间码必须是6位有效字符');
            return;
        }
        this._disconnecting = false;
        this.roomCode = normalized;
        this.isHost = false;
        this.myPlayerId = 'B';
        this.opponentPlayerId = 'A';
        this.isConnecting = true;
        this._notifyStatus('connecting', '正在连接房间...');
        this._startTimeout('连接房间超时，请检查房间码和网络后重试', 45000);

        const iceServers = await this._fetchIceServers();
        if (!this.isConnecting) return;
        try {
            const guestId = 'g_' + Math.random().toString(36).substr(2, 9);
            const sig = P2PController.signaling;
            this.peer = new Peer(guestId, {
                debug: sig.debug,
                host: sig.host,
                port: sig.port,
                path: sig.path,
                secure: sig.secure,
                key: sig.key,
                config: { iceServers }
            });
            this.peer.on('open', () => {
                const conn = this.peer.connect(normalized, { reliable: true });
                this._setupConnection(conn);
            });
            this.peer.on('error', (err) => this._handleError(err));
            this.peer.on('disconnected', () => {
                if (this._disconnecting) return;
                if (this.peer && !this.peer.destroyed) this.peer.reconnect();
            });
        } catch (err) { this._handleError(err); }
    }

    _setupConnection(conn) {
        this._clearTimeout();
        this.conn = conn;
        this._startTimeout('连接超时，请确认房间码正确且对方在线', 15000);
        conn.on('open', () => {
            this._clearTimeout();
            this.isConnected = true;
            this.isConnecting = false;
            this._guestConnecting = false;
            this._resetWatchdog();
            this._pingInterval = setInterval(() => { if (this.isConnected) this.send({ type: 'ping' }); }, 5000);
            this._notifyStatus('connected', this.isHost ? '对手已加入！游戏即将开始...' : '已连接到房间！游戏即将开始...');
            if (this.onConnected) this.onConnected();
        });
        conn.on('data', (data) => { this._resetWatchdog(); this._handleMessage(data); });
        conn.on('close', () => this._handleDisconnect());
        conn.on('error', () => this._handleDisconnect());
    }

    _handleMessage(data) {
        if (!data || !data.type) return;
        switch (data.type) {
            case 'ping': this.send({ type: 'pong' }); break;
            case 'pong': break;
            case 'game_init':
                if (data.config?.gen !== undefined) this._gen = data.config.gen;
                if (this.onGameInit) this.onGameInit(data.config);
                break;
            case 'action': {
                if (data.gen !== undefined && data.gen !== this._gen) {
                    this.send({ type: 'nack', seqno: data.seqno, action: data.action, reason: 'stale_gen' });
                    break;
                }
                const ok = this.onGameAction ? this.onGameAction(data.action, data.payload || {}) : true;
                this.send(ok
                    ? { type: 'ack', seqno: data.seqno }
                    : { type: 'nack', seqno: data.seqno, action: data.action, reason: 'execution_failed' }
                );
                break;
            }
            case 'ack':
                if (this._pendingAck && data.seqno === this._pendingAck.seqno) {
                    clearTimeout(this._pendingAck.timer);
                    this._pendingAck = null;
                }
                break;
            case 'nack':
                if (this._pendingAck && data.seqno === this._pendingAck.seqno) {
                    clearTimeout(this._pendingAck.timer);
                    const { action, rollback } = this._pendingAck;
                    this._pendingAck = null;
                    if (this.onNack) this.onNack(action, rollback, data.reason);
                }
                break;
            case 'state_sync':
                if (data.gen === this._gen && this.onStateSync) this.onStateSync(data.state);
                break;
            case 'timer_sync':
                if (data.gen === this._gen && this.onTimerSync) this.onTimerSync(data.remainingTime);
                break;
            case 'timeout':
                if (data.gen === this._gen && this.onTimeout) this.onTimeout(data.player);
                break;
            case 'rematch_request':
                if (this.onRematch) this.onRematch();
                break;
        }
    }

    send(data) {
        if (!this.conn || !this.isConnected) return false;
        try { this.conn.send(data); return true; }
        catch (err) { console.error('[P2P] 发送失败:', err); return false; }
    }

    sendGameInit(config) {
        this._gen++;
        this.send({ type: 'game_init', config: { ...config, gen: this._gen } });
    }

    sendGameAction(action, payload, rollback = null) {
        if (this._pendingAck) {
            clearTimeout(this._pendingAck.timer);
            this._pendingAck = null;
        }
        const seqno = ++this._seqno;
        const timer = setTimeout(() => {
            console.warn('[P2P] ack 超时:', action);
            this._pendingAck = null;
            this._handleDisconnect();
        }, 8000);
        this._pendingAck = { seqno, action, rollback, timer };
        this.send({ type: 'action', action, payload, seqno, gen: this._gen });
    }

    sendStateSync(state)             { this.send({ type: 'state_sync', state, gen: this._gen }); }
    sendTimerSync(remainingTime)     { this.send({ type: 'timer_sync', remainingTime, gen: this._gen }); }
    sendTimeout(player)              { this.send({ type: 'timeout', player, gen: this._gen }); }
    sendRematchRequest()             { this.send({ type: 'rematch_request' }); }
    flipRoleForRematch()            { this.isHost = !this.isHost; }

    isMyTurn(currentPlayer)  { return currentPlayer === this.myPlayerId; }
    getMyPlayerId()          { return this.myPlayerId; }

    _handleError(err) {
        this.isConnecting = false;
        this.isConnected = false;
        this._guestConnecting = false;
        let message = '连接失败';
        if (err?.type === 'unavailable-id') {
            message = '房间码已被占用，请重新创建房间';
            this.disconnect();
            this._notifyStatus('error', message);
            if (this.onError) this.onError(err || new Error(message));
            return;
        } else if (err?.type === 'peer-unavailable') {
            message = '无法连接到房间，请检查房间码是否正确';
        } else if (err?.type === 'network') {
            message = '网络连接失败，请检查网络后重试';
        } else if (err?.message) {
            message = err.message;
        }
        this._notifyStatus('error', message);
        if (this.onError) this.onError(err || new Error(message));
    }

    _handleDisconnect() {
        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.isConnecting = false;
        this._guestConnecting = false;
        this.conn = null;
        clearTimeout(this._watchdogId);  this._watchdogId = null;
        clearInterval(this._pingInterval); this._pingInterval = null;
        if (this._pendingAck) { clearTimeout(this._pendingAck.timer); this._pendingAck = null; }
        if (this.peer) { this.peer.destroy(); this.peer = null; }
        this.roomCode = '';
        if (wasConnected) {
            this._notifyStatus('disconnected', '对手已断开连接');
            if (this.onDisconnected) this.onDisconnected();
        } else if (!this._disconnecting) {
            this._handleError({ type: 'network', message: '连接失败，请确认房间码正确且对方在线' });
        }
    }

    disconnect() {
        this._disconnecting = true;
        this._clearTimeout();
        clearTimeout(this._watchdogId);  this._watchdogId = null;
        clearInterval(this._pingInterval); this._pingInterval = null;
        if (this._pendingAck) { clearTimeout(this._pendingAck.timer); this._pendingAck = null; }
        if (this.conn) { try { this.conn.close(); } catch (e) {} this.conn = null; }
        if (this.peer) { this.peer.destroy(); this.peer = null; }
        this.isConnected = false;
        this.isConnecting = false;
        this._guestConnecting = false;
        this.isHost = false;
        this.roomCode = '';
    }

    _resetWatchdog() {
        clearTimeout(this._watchdogId);
        this._watchdogId = setTimeout(() => {
            console.warn('[P2P] 心跳超时，对手可能已崩溃');
            this._handleDisconnect();
        }, 15000);
    }

    _startTimeout(message, duration = 30000) {
        this._clearTimeout();
        this._timeoutId = setTimeout(() => {
            this._handleError({ type: 'timeout', message });
            this.disconnect();
        }, duration);
    }

    _clearTimeout() {
        if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
    }

    _notifyStatus(status, message) {
        if (this.onStatusChange) this.onStatusChange(status, message);
    }
}

// 导出到全局
window.P2PController = P2PController;
