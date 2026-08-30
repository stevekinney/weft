/// <reference lib="webworker" />
self.onmessage = (event: MessageEvent) => {
  self.postMessage({ echo: event.data });
};
