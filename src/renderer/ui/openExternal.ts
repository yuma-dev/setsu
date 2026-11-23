export const KOFI_URL = "https://ko-fi.com/yumadev";

/** system browser via electron's shell, the renderer runs with node integration */
export function openExternal(url: string): void {
  try {
    const req = (window as unknown as { require?: (m: string) => { shell: { openExternal(u: string): void } } }).require;
    req?.("electron").shell.openExternal(url);
  } catch {
    /* ignore */
  }
}
