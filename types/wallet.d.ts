// Browser wallets (js/contracts.js): the EIP-1193 provider a wallet extension injects, and the EIP-6963 events by
// which each one announces itself. Only what the board calls is listed.

export interface Eip1193Request {
  method: string;
  params?: unknown[];
}

export interface Eip1193Provider {
  request(args: Eip1193Request): Promise<any>; // any: the answer's shape depends on the method
  on?(event: string, listener: (...args: any[]) => void): void; // any: each event passes its own arguments
  removeListener?(event: string, listener: (...args: any[]) => void): void; // any: as for on()
  // Flags set by the wallets that also pass for MetaMask.
  isMetaMask?: boolean;
  isPhantom?: boolean;
  isRabby?: boolean;
  isOkxWallet?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isCoinbaseWallet?: boolean;
  isBraveWallet?: boolean;
}

// EIP-6963: a wallet's name, icon (a data URL) and reverse-DNS id.
export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

declare global {
  interface WindowEventMap {
    'eip6963:announceProvider': CustomEvent<Eip6963ProviderDetail | undefined>;
  }
  // The injected provider of a wallet that announces nothing.
  var ethereum: Eip1193Provider | undefined;
}
