import { bus } from './eventBus'

/**
 * Zero-cost live Bitcoin data (§5.3, §15) — no keys, no paid APIs.
 *
 * - Coinbase Advanced Trade public WS: price + 24h change (ticker_batch,
 *   5s cadence) + heartbeats. Works from github.io (CORS-tested).
 * - Coinbase Exchange candles REST (public, CORS *): 7-day trend.
 * - mempool.space WS: blocks, fees, mempool stats, difficulty adjustment.
 * - mempool.space REST poll (6s): whale watch on recent transactions.
 * - localStorage cache so a fresh load renders instantly with last-known
 *   values; every feed tracks its own freshness.
 */

export type FeedStatus = 'ok' | 'stale' | 'error' | 'offline' | 'connecting'

export interface Feed {
  status: FeedStatus
  lastUpdate: number // performance-agnostic epoch ms, 0 = never
  detail?: string
}

const CACHE_KEY = 'hashlake.cache.v1'
const WHALE_THRESHOLD_BTC = 3
const WHALE_POLL_MS = 6000

interface CacheShape {
  price?: number
  chg24h?: number
  chg7d?: number
  fastestFee?: number
  mempoolCount?: number
  blockHeight?: number
  difficultyChange?: number
}

export class LiveBitcoinStore {
  price = 0
  chg24h = 0 // percent
  chg7d = 0 // percent
  fastestFee = 0
  mempoolCount = 0
  blockHeight = 0
  difficultyChange = 0
  lastWhaleBtc = 0
  lastWhaleTxid = ''
  whaleCount = 0

  readonly feeds: Record<string, Feed> = {
    price: { status: 'connecting', lastUpdate: 0 },
    market: { status: 'connecting', lastUpdate: 0 },
    mempool: { status: 'connecting', lastUpdate: 0 },
    fees: { status: 'connecting', lastUpdate: 0 },
    whales: { status: 'connecting', lastUpdate: 0 },
    difficulty: { status: 'connecting', lastUpdate: 0 },
    websocket: { status: 'connecting', lastUpdate: 0 },
  }

  private seenTxids = new Set<string>()
  private firstWhalePoll = true

  start(): void {
    this.loadCache()
    this.connectCoinbase()
    this.connectMempool()
    this.fetch7d()
    window.setInterval(() => this.pollWhales(), WHALE_POLL_MS)
    this.pollWhales()
    window.setInterval(() => this.saveCache(), 20000)
    window.setInterval(() => this.updateStaleness(), 2000)
  }

  /** 0 = perfectly fresh, 1 = fully stale (drives the fog). */
  get staleness(): number {
    const critical = ['price', 'mempool']
    let worst = 0
    for (const k of critical) {
      const f = this.feeds[k]
      if (f.lastUpdate === 0) continue
      const age = (Date.now() - f.lastUpdate) / 1000
      worst = Math.max(worst, Math.min(1, Math.max(0, (age - 45) / 90)))
    }
    return worst
  }

  private mark(feed: string, status: FeedStatus = 'ok', detail?: string): void {
    const f = this.feeds[feed]
    if (!f) return
    f.status = status
    if (status === 'ok') f.lastUpdate = Date.now()
    if (detail) f.detail = detail
  }

  private updateStaleness(): void {
    for (const f of Object.values(this.feeds)) {
      if (f.status === 'ok' && Date.now() - f.lastUpdate > 60000) {
        f.status = 'stale'
      }
    }
  }

  // ------------------------------------------------------------- coinbase
  private connectCoinbase(): void {
    try {
      const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com')
      ws.onopen = () => {
        // must subscribe within 5s of connecting
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            channel: 'ticker_batch',
            product_ids: ['BTC-USD'],
          }),
        )
        ws.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats' }))
        this.mark('websocket', 'ok', 'coinbase live')
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string)
          if (msg.channel === 'ticker_batch' || msg.channel === 'ticker') {
            const t = msg.events?.[0]?.tickers?.[0]
            if (t?.product_id === 'BTC-USD') {
              this.price = parseFloat(t.price)
              this.chg24h = parseFloat(t.price_percent_chg_24_h ?? '0')
              this.mark('price')
              this.mark('market')
            }
          } else if (msg.channel === 'heartbeats') {
            this.mark('websocket')
          }
        } catch {
          /* malformed frame — ignore */
        }
      }
      ws.onclose = () => {
        this.mark('websocket', 'offline', 'reconnecting')
        window.setTimeout(() => this.connectCoinbase(), 5000)
      }
      ws.onerror = () => {
        this.mark('websocket', 'error')
        ws.close()
      }
    } catch {
      this.mark('websocket', 'error')
      window.setTimeout(() => this.connectCoinbase(), 10000)
    }
  }

  private async fetch7d(): Promise<void> {
    try {
      const res = await fetch(
        'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400',
      )
      const candles: number[][] = await res.json()
      if (Array.isArray(candles) && candles.length > 7) {
        const nowClose = candles[0][4]
        const then = candles[7][4]
        this.chg7d = (nowClose / then - 1) * 100
        this.mark('market')
      }
    } catch {
      // fallback: mempool.space historical price
      try {
        const ts = Math.floor(Date.now() / 1000) - 7 * 86400
        const res = await fetch(
          `https://mempool.space/api/v1/historical-price?currency=USD&timestamp=${ts}`,
        )
        const data = await res.json()
        const old = data?.prices?.[0]?.USD
        if (old && this.price) this.chg7d = (this.price / old - 1) * 100
      } catch {
        /* keep cache */
      }
    }
    // refresh every 30 min
    window.setTimeout(() => this.fetch7d(), 30 * 60 * 1000)
  }

  // ------------------------------------------------------------- mempool
  private connectMempool(): void {
    try {
      const ws = new WebSocket('wss://mempool.space/api/v1/ws')
      ws.onopen = () => {
        ws.send(JSON.stringify({ action: 'init' }))
        ws.send(
          JSON.stringify({ action: 'want', data: ['blocks', 'stats', 'mempool-blocks'] }),
        )
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string)
          if (msg.mempoolInfo?.size !== undefined) {
            this.mempoolCount = msg.mempoolInfo.size
            this.mark('mempool')
          }
          if (msg.fees?.fastestFee !== undefined) {
            this.fastestFee = msg.fees.fastestFee
            this.mark('fees')
          }
          if (msg.da?.difficultyChange !== undefined) {
            this.difficultyChange = msg.da.difficultyChange
            this.mark('difficulty')
          }
          if (msg.block?.height) {
            const h = msg.block.height
            if (h > this.blockHeight) {
              this.blockHeight = h
              this.mark('mempool')
              bus.emit('newBlock', { height: h })
            }
          }
          if (Array.isArray(msg.blocks) && msg.blocks.length) {
            const top = msg.blocks[msg.blocks.length - 1]
            if (top.height > this.blockHeight) this.blockHeight = top.height
          }
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        window.setTimeout(() => this.connectMempool(), 6000)
      }
      ws.onerror = () => ws.close()
    } catch {
      window.setTimeout(() => this.connectMempool(), 12000)
    }
  }

  // ------------------------------------------------------------- whales
  private async pollWhales(): Promise<void> {
    try {
      const res = await fetch('https://mempool.space/api/mempool/recent')
      const txs: { txid: string; value: number }[] = await res.json()
      let qualifying = 0
      for (const tx of txs) {
        if (this.seenTxids.has(tx.txid)) continue
        this.seenTxids.add(tx.txid)
        const btc = tx.value / 1e8
        if (btc >= WHALE_THRESHOLD_BTC) {
          qualifying++
          this.lastWhaleBtc = btc
          this.lastWhaleTxid = tx.txid
          this.whaleCount++
          // never replay a burst from the FIRST poll after load (§15.3)
          if (!this.firstWhalePoll) {
            bus.emit('whale', { btc, txid: tx.txid })
          }
        }
      }
      // keep the dedup set bounded
      if (this.seenTxids.size > 4000) {
        const keep = [...this.seenTxids].slice(-2000)
        this.seenTxids = new Set(keep)
      }
      this.mark(
        'whales',
        'ok',
        qualifying ? `${this.lastWhaleBtc.toFixed(1)} BTC` : 'no recent whale',
      )
      this.firstWhalePoll = false
    } catch {
      this.mark('whales', 'error', 'backoff')
    }
  }

  // ------------------------------------------------------------- cache
  private loadCache(): void {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return
      const c: CacheShape = JSON.parse(raw)
      this.price = c.price ?? 0
      this.chg24h = c.chg24h ?? 0
      this.chg7d = c.chg7d ?? 0
      this.fastestFee = c.fastestFee ?? 0
      this.mempoolCount = c.mempoolCount ?? 0
      this.blockHeight = c.blockHeight ?? 0
      this.difficultyChange = c.difficultyChange ?? 0
      for (const f of Object.values(this.feeds)) f.status = 'stale'
    } catch {
      /* no cache */
    }
  }

  private saveCache(): void {
    try {
      const c: CacheShape = {
        price: this.price,
        chg24h: this.chg24h,
        chg7d: this.chg7d,
        fastestFee: this.fastestFee,
        mempoolCount: this.mempoolCount,
        blockHeight: this.blockHeight,
        difficultyChange: this.difficultyChange,
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(c))
    } catch {
      /* storage full/blocked — fine */
    }
  }
}
