import { contextBridge } from 'electron'
contextBridge.exposeInMainWorld('tn', { ping: () => 'pong' })
