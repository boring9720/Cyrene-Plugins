/**
 * bili-music bili-preload.cjs (v0.3.3)
 * 插件面板窗口的受控桥：contextIsolation 下唯一可用接口。
 * 仅放行 plugin:bili-music: 前缀通道，其余一律拒绝——面板页即使被注入也无法触达宿主其他 IPC。
 */
const { contextBridge, ipcRenderer } = require("electron");

const PREFIX = "plugin:bili-music:";

contextBridge.exposeInMainWorld("bili", {
  invoke: (ch, ...args) => {
    if (typeof ch !== "string" || !ch.startsWith(PREFIX)) {
      return Promise.reject(new Error("E_CHANNEL_FORBIDDEN: " + String(ch)));
    }
    return ipcRenderer.invoke(ch, ...args);
  },
  send: (ch, ...args) => {
    if (typeof ch !== "string" || !ch.startsWith(PREFIX)) return;
    ipcRenderer.send(ch, ...args);
  },
});
