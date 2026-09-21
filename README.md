# Signal Terminal

A crypto trading terminal:

- a live TradingView chart with coin and timeframe pickers (5M … 1M)
- **SIGNAL**: LONG / SHORT / WAIT (or **NO EDGE** on a timeframe that failed testing), the estimated probability the trade works out, the composite score and what is driving it
- **RISK MANAGEMENT**: entry, stop loss and take profit from the exit setup that tested best, how to manage the trade (breakeven / trailing), risk : reward, expected profit per $1, **suggested risk per trade** (quarter-Kelly), breakeven win rate
- **⚙ Parameters** (button in the Signal header): hidden knobs — any of 27 stop/target setups, long/short bars, news-tilt cap, the no-edge gate — each shown with its own tested result
- **NEWS & EVENTS**: Fear & Greed index, the next Fed decision, live headlines scored for sentiment, and your own event bias
- **TESTED ON UNSEEN DATA** next to every call: the whole holdout, the most recent slice on its own, maker-fee sensitivity, and what sizing would have done

## Open it

| What | How |
|---|---|
| **Terminal** | Run `serve.cmd` and go to <http://localhost:8777> (double-clicking `index.html` also works, but without live headlines) |
| **Tuning & results** | `tune.html`: every table behind the numbers below |
| **Refresh historical data** | `update-data.cmd` (new candles, funding rates, Fear & Greed history) |
| **Re-tune the signal engine** | Run `serve.cmd`, open <http://localhost:8777/tune.html>, click **Tune signal engine** (5–12 min). Saves `config/signal.js` and `results/tuning.js`. |

Requirements: Windows (PowerShell is built in) and a browser with an internet connection. Nothing to install.

## How the signal is built

**23 sub-signals in 7 groups**, each scaled to −1 … +1 (bullish positive):

| Group | Signals |
|---|---|
| ML model | logistic-regression probability on 25 features, retrained weekly on a trailing window |
| Structure | position in the 100-bar range · 20-bar breakout · swing support / resistance proximity |
| Momentum | RSI(14) · MACD histogram · Bollinger %B · EMA 20/50/200 alignment · volume-backed candle |
| Volatility | ATR(14)/ATR(50) expansion in the move's direction · Bollinger-squeeze breakout |
| Context | BTC 48-bar trend · BTC 4-bar move (alts only) · close location in range · funding rate (contrarian) · **daily-chart EMA alignment · daily 12-day momentum** (for 1H/4H, from daily candles that closed before the bar opened) |
| Patterns | engulfing candle · pin bar after a move · fair-value gap |
| News & events | Crypto Fear & Greed level · its 7-day change · FOMC decision within 48h |

**Composite score** = weighted sum. LONG above the long bar, SHORT below minus the short bar (tuned separately — shorts need a much higher bar), otherwise WAIT with the lean shown.

**Exit setups**: 27 candidates — stop 1.5, 2 or 3 × ATR(14) (each with or without a move to breakeven at +1R), a stop just beyond the nearest swing support/resistance (1–3 ATR), or a 2× / 3× ATR trailing stop; targets 1:2, 1:3, 1:4 the stop (trailing setups also with no fixed target); time-out after a fixed number of candles. 0.07% fee per side. Results in **R** (multiples of the initial stop distance).

**Adaptive exit policy**: per situation (low / normal / high volatility × long / short × moderate / strong) the setup with the best lower-confidence-bound result on the fit half, switched on only if it beats the single best setup on the validation half.

**Probability** = P(this trade works out | score), a logistic fit per exit setup on the train period, so the number is calibrated for the exact stop/target shown.

**Suggested risk** = ¼ Kelly on the calibrated probability and payoff, capped at 2% of the account; zero when the odds are too thin.

**No-edge gate**: a timeframe whose final formula did not make money on unseen data shows **NO EDGE** instead of a call (the raw call is still printed small; a checkbox in ⚙ shows calls anyway).

**News tilt (untested)**: live headlines scored with a keyword lexicon (capped ±0.75) plus your manual event bias per coin. There is no headline archive to backtest, so the terminal always also shows what the tested formula alone says.

## How it was tuned (tune.html)

1. Walk-forward ML input: retrained every week, only ever predicts bars after its training window.
2. Every bar of BTC, ETH, SOL, BNB, XRP gets its 23 sub-signals and the outcome of a long and a short entered there, for all 27 exit setups.
3. **Fit half 2021-01 → 2022-12**: start from equal weights; each round try −0.5, +0.5, 0 and a sign flip on every weight, keep changes that improve the objective (t-statistic of R per trade) by at least 0.05; re-pick the long and short bars; stop when a round gains < 1%; then a finer pass with 0.25 steps; drop weights that don't matter. A formula must fire on at least 1% of bars.
4. **Validation half 2023-01 → 2024-06**: every exit setup's tuned weights are judged here against plain equal weights; the best out-of-sample variant wins. The adaptive exit policy is kept only if it beats the fixed setup here.
5. The winner is refitted on the whole train period; probabilities are calibrated per exit setup there.
6. **Holdout 2024-07 → today** played no part in any fit. It is reported whole, and the slice **since 2026-01-01** on its own.

## Results as of 14 Sep 2026 (unseen data, after 0.07% fees per side, one position per coin at a time)

| Timeframe | Setup chosen | Trades | Win rate | Avg R / trade | t | Risking 1% | ¼-Kelly | Since Jan 2026 | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **1D** | 3×ATR stop → breakeven at +1R, target 1:4, bar +0.25 / −5, tuned | 224 | 44% | **+0.078R** | 1.19 | +18% | +36% | **+0.187R** over 65 trades (win 51%, t 1.67) | positive; the recent slice is the strongest number in this project |
| **4H** | 3×ATR stop, target 1:3, bar +1 / −7, equal weights | 841 | 44% | +0.055R | 1.33 | +49% | +98% | +0.065R over 257 trades | positive, modest, could be luck |
| 1H | 3×ATR stop, target 1:3, bar +5 / −7, tuned, adaptive exits | 1,036 | 35% | −0.009R | −0.18 | −20% | −50% | +0.097R over 302 trades | **no edge** overall → gated |

Other facts from this run:

- The ML model alone loses money on all three timeframes; equal weights over all 23 signals is what won on 4H.
- Wide stops (3×ATR) with far targets (1:3–1:4) win everywhere; the swing-S/R stop and the trailing stops were competitive but never best.
- Shorts need a far higher bar than longs; 65–90% of the surviving trades are longs.
- Per-situation exits only passed validation on 1H, and even there they did not beat the fixed setup on the holdout.
- Maker-level fees (0.04%) change little (+0.16 vs +0.15R per signal bar on 1D): the edge is not a fee artefact.
- Next-candle direction is still 48–50%: the money is in the exit geometry and in *when* the formula fires, not in calling direction.

**What "profitable" honestly means here.** After fees, the tested formulas make roughly +0.05 to +0.08R per trade on 4H and 1D, i.e. about 5–8 cents per dollar risked, with drawdowns of 15–50R along the way. With 1% risk per trade that compounded to +18% (1D) and +49% (4H) over 26 months; with quarter-Kelly sizing +36% and +98%. That is real but modest, the t-statistics (1.2–1.3) say it could still partly be luck, and the holdout has been consulted several times during development, so treat the "since Jan 2026" column as the best guide to live behaviour. 1H is not tradeable after fees and the terminal says so.

## Forward test (the live track record)

The **FORWARD TEST** pane under the news logs every call the tested formula makes the moment a candle closes — all 12 coins, 1H / 4H / 1D, one position per coin and timeframe at a time, the tuned exit setup, 0.07% fees — and scores each one against the candles that follow (target / stop / trailed / time-out, exactly like the backtest). Only candles that close **after the last tuning** count, so nothing in the log was ever peeked at.

- It saves to `results/forward.json` when `serve.cmd` is running (so any browser sees the same log), otherwise to this browser.
- Keep the page open, or just open it now and then: each sweep catches up on the last 300 candles of every coin (12 days of 1H, 50 days of 4H). It sweeps automatically after every candle close and on **Sweep now**.
- Each timeframe's tile shows closed / open trades, win rate, avg R, total R, return at 1% risk — beside the backtest's "since Jan 2026" figures, which is the comparison that matters.

The decision rule: after 2–3 months, if the live column looks like the backtest column, the edge is real enough to trade small; if it doesn't, nothing was lost. Don't re-tune while the forward test runs — re-tuning resets which candles count.

### The honest scorecard

The **LOGGER & HONEST SCORECARD** pane shows whether the logger is alive (sweeps in the last day, recent runs, failures) and — more importantly — the only comparison that can't be faked by a rising market:

| Column | Meaning |
|---|---|
| **Logged / Realised** | the actual sequential trades and their average R |
| **Its picks** | a long from every bar the formula *fired* on, base exit rules |
| **Every bar** | the same trade from *every* bar in the window, rules unchanged |
| **Skill** | its picks minus every bar. Positive = it chose better moments than a dart. Negative = worse. |

A bull week lifts "its picks" and "every bar" together, so a spectacular win rate proves nothing on its own. Only the **Skill** column isolates the formula. First week's reading (Sep 15–21, a week where BTC rose 11% and AVAX 47%): **−0.67R on 1H, −0.52R on 4H** — random entries beat the formula's entries. That is the number to watch, and it needs a flat or falling week before it means much either way.

### Logging by itself (no browser window needed)

`install-logger.cmd` registers a Windows scheduled task, **Signal Terminal logger**, that runs every hour at :05 while you are logged in. Each run starts the local server if it isn't running, opens the terminal in a hidden browser (Edge or Chrome, its own private profile), waits until the page reports that the sweep is saved, and closes it. Every run is written to `results\logger.log`; the terminal's forward-test header shows "auto-logger ran HH:MM". The PC has to be on and you logged in — a sleeping PC logs nothing, but the next run catches up. `uninstall-logger.cmd` removes the task.

`serve.cmd` notices when the logger already started the server and just opens the terminal.

## Hidden parameters (⚙ in the Signal header)

| Knob | What it does | What you see |
|---|---|---|
| No-edge gate | show LONG / SHORT anyway on a gated timeframe | — |
| Exit policy | tuned setup (default) or *Fixed, my choice* | — |
| Stop & target | any of the 27 setups, ranked by tested result | that setup's unseen-data avg R, win rate, bars |
| Strong-call bar | separate long / short thresholds | the tuned bars, and the tested result at your bar |
| News tilt cap | 0 (off) … ±1.5 | — |

Settings are remembered per timeframe; **Reset to tuned** clears them. Anything overridden is marked *custom*, and the probability and suggested risk shown are for the setup you picked.

## Put it on your phone (free)

The terminal is a static site — about 1.4 MB once `data/` is excluded — so GitHub Pages can host it and your phone runs the whole thing in its browser: live Binance prices, the chart, the signal, the risk levels, and the forward-test log.

**One-time setup (yours, ~10 minutes)**

1. Create a free account at [github.com](https://github.com).
2. Install [GitHub Desktop](https://desktop.github.com) and sign in.
3. **File → Add local repository →** `C:\Users\legion\Documents\Kairos` → when it says this isn't a repository, click **create a repository** → **Create**.
4. Click **Publish repository**. **Untick "Keep this code private"** — free GitHub Pages needs a public repo. (Nothing here is sensitive: no keys, no account details, just the tool and its own test log.)
5. On github.com open the repo → **Settings → Pages** → Source: **Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**. After a minute the site is live at `https://<your-username>.github.io/<repo>/`.

**After that it keeps itself current.** The hourly logger detects the repository and pushes `results/forward.json`, `logger-runs.json` and `logger-status.json` after every sweep, so the phone is at most an hour behind while the PC is on. It finds git inside GitHub Desktop automatically — nothing to configure.

**What works on the phone:** the chart, live prices, the signal and probability, risk levels, the ⚙ parameters, the forward test and the scorecard. **What doesn't:** live news headlines (they come through the local server, so that pane shows a note instead), and `tune.html` (the 50 MB of candles stays on the PC). Fear & Greed and the Fed calendar still work.

## Files

```
index.html             the terminal
tune.html              tunes the signal engine and shows the full results (needs serve.cmd)
css/terminal.css       styles
js/core/               indicators, ML features + model, backtester, FOMC calendar, signal engine, tuner
js/app/                live Binance data, headlines + sentiment, live signal inference, forward-test logger, terminal UI
config/signal.js       tuned weights, bars, exit setups with calibrations, policy, ML model, tested stats used live
results/tuning.js      full tuning report used by tune.html
results/forward.json   the forward-test log (written by the terminal through serve.cmd)
data/                  downloaded history incl. fng.json (not needed to view the site)
tools/                 fetch-data.ps1, fetch-fng.ps1, serve.ps1 (files + /api/news + /api/fng)
kairos.html, research.html, performance.html   the ML model's own pages (internals; not linked from the terminal)
```

Research tool, not financial advice. Calls are probabilities from a formula tested on past data; they are often wrong and past results do not guarantee future returns.
