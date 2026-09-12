/**
 * bili-music player-preload.cjs (v0.3.3)
 * 隐藏播放器窗口的受控桥：contextIsolation 下唯一可用接口。
 * 只暴露 player.html 需要的 3 个操作，通道硬编码，无通用 IPC 面。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("biliPlayer", {
  /** 主进程播放命令（play/resume/pause/stop/load 等） */
  onCmd: (cb) => {
    ipcRenderer.on("plugin:bili-music:player-cmd", (_e, cmd) => cb(cmd));
  },
  /** 错误等事件上报 */
  sendEvent: (ev) => {
    ipcRenderer.send("plugin:bili-music:player-event", ev);
  },
  /** 音轨播完信号 */
  sendEnded: () => {
    ipcRenderer.send("plugin:bili-music:player-ended");
  },
});
