// The Launch Handler API that lib.dom does not ship yet (js/app.js): the installed app's launches into its open window.

interface LaunchParams {
  readonly targetURL?: string;
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

interface Window {
  readonly launchQueue?: LaunchQueue;
}
