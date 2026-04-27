// Extends Vitest's default jsdom env with the polyfills AntD's responsive
// + virtualised components rely on. Both are absent from jsdom by default.

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
  if (!('ResizeObserver' in window)) {
    class ResizeObserverPolyfill {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // @ts-expect-error — patching jsdom global
    window.ResizeObserver = ResizeObserverPolyfill;
    // @ts-expect-error — also expose on globalThis for libraries that read it directly
    globalThis.ResizeObserver = ResizeObserverPolyfill;
  }
}
