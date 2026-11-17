import type { TnApi } from '../../../preload/api'

/** The preload bridge. The window has no other route to the file system or the OS. */
export const api: TnApi = window.tn
