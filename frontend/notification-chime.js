export class NotificationChime {
  constructor() { this.audio = new Audio('/public/silence.wav'); this.audio.volume = .25; }
  unlock() {
    if (this.unlocked || this.unlocking) return;
    this.unlocking = true;
    // All activation calls occur synchronously in the original button gesture.
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context) {
      this.context ??= new Context(); this.context.resume().catch(() => {});
      const silent = this.context.createBufferSource(); silent.buffer = this.context.createBuffer(1, 1, 22050);
      silent.connect(this.context.destination); silent.start();
    }
    this.audio.muted = false;
    this.audio.play().then(() => {
      this.audio.pause(); this.audio.src = '/public/chime.wav'; this.audio.load(); this.unlocked = true;
    }).catch(() => { this.unlocked = this.context?.state === 'running'; this.audio.src = '/public/chime.wav'; }).finally(() => { this.unlocking = false; });
  }
  play() {
    if (!this.unlocked) return;
    this.audio.currentTime = 0;
    this.audio.play().catch(() => {
      // Safari may still restrict media after a background transition; use the
      // context resumed by the same initial gesture as a quiet chime fallback.
      if (this.context?.state !== 'running') return;
      const oscillator = this.context.createOscillator(), gain = this.context.createGain(), at = this.context.currentTime;
      oscillator.frequency.value = 660; gain.gain.setValueAtTime(.08, at); gain.gain.exponentialRampToValueAtTime(.001, at + .18);
      oscillator.connect(gain); gain.connect(this.context.destination); oscillator.start(at); oscillator.stop(at + .18);
    });
  }
  stop() { this.audio.pause(); }
}
