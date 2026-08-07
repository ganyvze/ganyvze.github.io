/**
 * AudioManager 模块（静音版）
 * 游戏内所有音效（含背景音乐、按键音效、合成音效如竞速倒计时等）已被禁用。
 * 保留原有的方法名/接口，使调用方代码无需改动；所有方法均为空操作。
 */
class AudioManager {
    constructor() {
        this.enabled = false;
        this.masterVolume = 0;
        this.sfxVolume = 0;
        this.bgmVolume = 0;
        this.sfxBoost = 0;
        this.bgmEnabled = false;

        this.isLoaded = true;
        this.audioCtx = null;
        this._audioCtx = null;
        this._bgmAudio = null;
        this._bgmStarted = false;
    }

    // --- 通用播放接口（全部空操作） ---
    playSound() {}
    playSyntheticRaceSound() {}

    // --- 背景音乐控制（全部空操作） ---
    startBgm() {}
    stopBgm() {}
    setBgmEnabled() { this.bgmEnabled = false; }
    setBgmVolume() {}
    setSfxVolume() {}

    // --- 具体场景音效接口（全部空操作） ---
    playClick() {}
    playElementClick() {}
    playTick() {}
    playError() {}
    playSuccess() {}
    playGameWin() {}
    playPhaseChange() {}
    playSummaGrab() {}
    playSummaDrag() {}
    playSummaThrow() {}
    playRaceCountdown() {}
    playRaceBeep() {}
    playRaceAlert() {}
    playRaceFinish() {}
    playRaceFanfare() {}
    playRaceLaunch() {}
    playSummaFling() {}

    // Summa 说话时的音效已禁用，但仍需驱动逐字显示的打字机动画，
    // 因此保留 onChar 回调的调用（仅去掉发声部分）。
    playSummaTalkBlip() {}
    playSummaTalkSequence(text = '', mood = 'neutral', onChar = null) {
        const src = String(text || '');
        if (!src || typeof onChar !== 'function') return;

        const chars = [...src];
        let delay = 0.5;
        for (const ch of chars) {
            const currentDelay = delay;
            setTimeout(() => onChar(ch), currentDelay * 1000);
            delay += /\s/.test(ch) ? 0.05 : (/[，。！？!?]/.test(ch) ? 0.13 : 0.08);
        }
    }
}

// 挂载到全局
window.audioManager = new AudioManager();
