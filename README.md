# Paperdesk — Fomo paper trader

Practice manual memecoin trades and track a virtual portfolio alongside Fomo. Desktop extension for Google Chrome and Microsoft Edge.

## Download

**[Download Paperdesk Desktop v0.4.2](https://github.com/aarctx/Fomo-paper/raw/refs/heads/main/Paperdesk-Desktop-0.4.2.zip)**

[SHA-256 checksum](Paperdesk-Desktop-0.4.2.sha256)

The ZIP contains the extension, browser icons, installation guide, privacy notes, and third-party chart licenses. It contains no saved portfolios or API keys. Each browser profile starts with its own $100 virtual portfolio.

## Install

1. Download and extract the entire ZIP to a permanent folder.
2. Type `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Turn on **Developer mode**, then click **Load unpacked**.
4. Select the extracted folder containing **manifest.json**.
5. Pin **Paperdesk** from your browser's Extensions menu. Click its icon to open the dashboard.
6. Open or refresh a Fomo token page on **fomo.family** or **fomo.fun** and click **Paper trade** at the bottom right.

Open **START-HERE.html** in the extracted folder for the full guide and troubleshooting. Keep that folder in place after installation. This is a manually installed development build; it has not been published to a browser extension store.

No wallet connection, deposited money, coding tools, paid Fomo API, or Etherscan key is required. Prices use DEX Screener. Optional Etherscan contract checks use your own key entered locally in Settings.

## Features

- Manual paper buys and sells, trade notes, portfolio value, positions, fees, and P&L.
- Multiple local portfolios with editable names, starting cash, colors, and trading-cost assumptions.
- **Customize → Starting cash → Save changes** updates an existing portfolio, including after trading. A preview shows the cash adjustment and minimum allowed.
- TradingView Lightweight Charts with line/candle modes and **1m, 5m, 15m, 1h, 4h** intervals on one row.
- Five-second refresh while the dashboard or trading panel is active; slower background observations while the browser runs.
- Suspicious-quote checks, visible last-known-price warnings, and CSV/JSON exports.

Starting-cash changes preserve trades, positions, and dollar trading P&L; percentage return uses the new starting capital. Cash adjustments are recorded separately from market performance.

## Data and updates

Portfolios are stored locally in the browser profile. There are no online accounts, cloud synchronization, or automatic updates. Export your records when needed; this version has no built-in import screen. Removing the extension or clearing its storage can erase your data.

To update, keep the **same installed folder and browser profile**, replace the application files with the newer release, click **Reload** on Paperdesk's Extensions card, and refresh the dashboard and Fomo tabs. Do not uninstall the extension to update it.

## Simulation limits

Trades use virtual money only. Reference quotes can lag or differ from Fomo's trading route. Fees and slippage are configurable simulation assumptions. The simulator does not model actual routing, gas, MEV, transfer taxes, or whether a token can be sold on-chain. No observations are invented while offline or asleep.

See **PRIVACY.txt** and **RELEASE-NOTES.txt** inside the ZIP for more detail. TradingView Lightweight Charts 5.2.1 is bundled locally with its Apache-2.0 license, NOTICE, and attribution.
