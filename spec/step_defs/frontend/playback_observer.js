// Observe the real SDK; only the explicit fault-injection gate alters a method.
(() => {
  const mk = MusicKit.getInstance();
  const samples = [];
  const errors = [];
  const faults = {};
  const sample = () => {
    const entry = {
      at: performance.now(),
      playing: mk.isPlaying,
      state: mk.playbackState,
      id: mk.nowPlayingItem?.id ?? null,
      position: mk.currentPlaybackTime,
      volume: mk.volume,
    };
    samples.push(entry);
    return entry;
  };
  const timer = setInterval(sample, 10);
  mk.addEventListener('playbackStateDidChange', sample);
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  window.__introProbe = {
    samples, errors, sample, faults,
    mark() { return sample().at; },
    arm(method, mode) {
      const original = mk[method];
      if (typeof original !== 'function') throw new Error(`No SDK method ${method}`);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const fault = { called: false, completed: false, release };
      faults[method] = fault;
      mk[method] = async function (...args) {
        mk[method] = original;
        fault.called = true;
        if (mode === 'reject') throw new Error(`Injected ${method} failure`);
        if (mode === 'noop') { fault.completed = true; return; }
        if (mode === 'hold-before') await gate;
        const actualArgs = mode === 'wrong-song'
          ? [{ ...args[0], song: args[0].song === 'track-1' ? 'track-2' : 'track-1' }]
          : args;
        const result = await original.apply(this, actualArgs);
        if (mode === 'hold-after') await gate;
        fault.completed = true;
        return result;
      };
    },
    releaseAll() { Object.values(faults).forEach(fault => fault.release()); },
    holdNextPlay() {
      const original = mk.play;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      this.releasePlay = release;
      this.playHeld = false;
      mk.play = async function (...args) {
        mk.play = original;
        await original.apply(this, args);
        window.__introProbe.playHeld = true;
        await gate;
      };
    },
    dispose() { clearInterval(timer); mk.removeEventListener('playbackStateDidChange', sample); },
  };
})();
