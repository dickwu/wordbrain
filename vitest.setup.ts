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
  if (typeof ResizeObserver === 'undefined') {
    class ResizeObserverPolyfill {
      constructor(_callback: ResizeObserverCallback) {}
      observe(_target: Element, _options?: ResizeObserverOptions) {}
      unobserve(_target: Element) {}
      disconnect() {}
    }
    const resizeObserverPolyfill = ResizeObserverPolyfill as typeof ResizeObserver;
    window.ResizeObserver = resizeObserverPolyfill;
    globalThis.ResizeObserver = resizeObserverPolyfill;
  }
}
