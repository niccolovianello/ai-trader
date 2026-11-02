// Copy to secrets.ts (git-ignored) and fill in. Never commit secrets.ts.
// Environment variables with the same names are used when a field is empty.
export const secrets = {
  ALPACA_KEY_ID: "", // app.alpaca.markets → Paper Trading → API Keys (starts with PK)
  ALPACA_SECRET_KEY: "",
  TELEGRAM_BOT_TOKEN: "", // @BotFather → /newbot
  TELEGRAM_CHAT_ID: "", // message the bot, then https://api.telegram.org/bot<TOKEN>/getUpdates
  CLAUDE_CODE_OAUTH_TOKEN: "", // `claude setup-token` — only needed on a server
  FIREBASE_SERVICE_ACCOUNT: "", // service-account JSON, only with TRADER_STORE=firestore
};
