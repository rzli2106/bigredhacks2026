/** Keep provider reads and lifecycle operations ordered across sharing sessions. */
export class NativeHealthService {
  constructor({ bridge, onSamples = () => {}, onStatus = () => {}, intervalMs = 30000 }) {
    Object.assign(this, { bridge, onSamples, onStatus, intervalMs });
    this.pending = Promise.resolve(); this.generation = 0;
    this.running = false; this.starting = false; this.reading = false;
  }
  start() {
    if (this.running || this.starting) return this.pending;
    const generation = ++this.generation; this.starting = true;
    const current = () => generation === this.generation;
    this.pending = this.pending.catch(() => {}).then(async () => {
      try {
        if (!current()) return;
        const availability = await this.bridge.availability();
        if (!current()) return;
        if (!availability.available) { this.onStatus({ state: 'unavailable', reason: availability.reason || 'Native health is unavailable.' }); return; }
        await this.bridge.requestPermissions(); if (!current()) return;
        await this.bridge.startMonitoring(); if (!current()) return;
        this.running = true;
        this.timer = setInterval(() => this.read(), this.intervalMs);
        this.onStatus({ state: 'waiting' }); this.read();
      } catch (error) {
        await Promise.resolve().then(() => this.bridge.stopMonitoring()).catch(() => {});
        throw error;
      } finally { if (current()) this.starting = false; }
    });
    return this.pending;
  }
  read() {
    if (!this.running || this.reading) return this.pending;
    const generation = this.generation; this.reading = true;
    const current = () => this.running && generation === this.generation;
    this.pending = this.pending.catch(() => {}).then(async () => {
      try {
        if (!current()) return;
        const { samples } = await this.bridge.readSamples();
        if (current()) this.onSamples(samples);
      } catch (error) { if (current()) this.onStatus({ state: 'error', reason: error.message }); }
      finally { this.reading = false; }
    });
    return this.pending;
  }
  stop() {
    ++this.generation; this.running = false; this.starting = false;
    clearInterval(this.timer);
    // A late native startup/read finishes before shutdown and the next startup.
    this.pending = this.pending.catch(() => {}).then(() => this.bridge.stopMonitoring());
    return this.pending;
  }
}
