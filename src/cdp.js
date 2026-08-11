function protocolError(method, error) {
  const detail = error?.message ?? "Unknown CDP error";
  const result = new Error(`${method}: ${detail}`);
  result.code = error?.code;
  result.data = error?.data;
  return result;
}

export class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
  }

  async connect(timeoutMs = 10000) {
    if (typeof WebSocket !== "function") {
      throw new Error("Node.js 22 or newer is required because the harness uses the built-in WebSocket client.");
    }
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out connecting to CDP: ${this.url}`)), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`Failed connecting to CDP: ${this.url}`));
      }, { once: true });
    });
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("close", () => this.#rejectPending(new Error("CDP connection closed")));
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      const listeners = this.eventListeners.get(message.method);
      if (listeners) {
        for (const listener of [...listeners]) listener(message.params ?? {});
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(protocolError(pending.method, message.error));
    else pending.resolve(message.result ?? {});
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async send(method, params = {}, timeoutMs = 30000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("CDP is not connected");
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.socket.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  onEvent(method, listener) {
    if (typeof method !== "string" || !method) throw new Error("CDP event method is required");
    if (typeof listener !== "function") throw new Error("CDP event listener must be a function");
    let listeners = this.eventListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(method);
    };
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  close() {
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
    this.eventListeners.clear();
  }
}
