// Type stub for @whiskeysockets/baileys
// The actual package is installed in Docker (Linux) where native modules compile.
// This stub allows local TypeScript compilation without the native libsignal module.
declare module "@whiskeysockets/baileys" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeWASocket: (...args: any[]) => any;
  export default makeWASocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const DisconnectReason: Record<string, any>;
  export function useMultiFileAuthState(folder: string): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveCreds: () => Promise<any>;
  }>;
  export function fetchLatestBaileysVersion(): Promise<{ version: [number, number, number]; isLatest: boolean }>;
}
