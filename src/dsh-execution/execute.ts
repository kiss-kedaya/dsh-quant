/**
 * 交易执行模拟（纯函数、零依赖）—— dsh-execution 域（PET 映射）。
 *
 * 兑现「提供 dsh 交易框架（不接实盘）」承诺：订单在信号后一根（可加
 * 延迟）收盘成交，含双边手续费与滑点，资金曲线按收盘价盯市。仅多头
 * 现货语义：卖出受持仓约束。
 */

export interface SimOrder {
  /** 信号 K 线索引（成交在 index + 1 + latencyBars） */
  index: number
  side: 'buy' | 'sell'
  /** 数量（与 valueFraction 二选一） */
  quantity?: number
  /** 按当前权益比例下单（0-1，与 quantity 二选一） */
  valueFraction?: number
}

export interface SimFill {
  orderIndex: number
  side: 'buy' | 'sell'
  /** 成交 K 线索引 */
  fillIndex: number
  fillPrice: number
  quantity: number
  value: number
  fee: number
  slippageCost: number
  cashAfter: number
  positionAfter: number
  equityAfter: number
}

export interface SimResult {
  fills: SimFill[]
  /** 归一化权益曲线（与 close 等长，初始 1.0） */
  equityCurve: number[]
  finalEquity: number
  totalReturnPct: number
  totalFee: number
  totalSlippageCost: number
  tradeCount: number
  /** 因越界/参数问题未成交的订单数 */
  unfilledCount: number
  cash: number
  position: number
}

export interface SimOptions {
  /** 初始资金（默认 1） */
  initialCash?: number
  /** 单边手续费率（默认 0.001） */
  feeRate?: number
  /** 滑点（基点，默认 0；买入按 +、卖出按 -） */
  slippageBps?: number
  /** 成交延迟根数（默认 0：信号后一根成交） */
  latencyBars?: number
}

/**
 * 执行模拟：按订单序列逐笔撮合，成交价 = close[fillIndex] × (1 ± 滑点)，
 * 手续费按成交金额单边收取，权益按收盘价盯市。
 */
export function executeSimulate(
  close: readonly number[],
  orders: readonly SimOrder[],
  options: SimOptions = {},
): SimResult {
  const n = close.length
  if (n < 2) throw new RangeError(`close must have at least 2 values, got ${n}`)
  for (const v of close) {
    if (!Number.isFinite(v) || v <= 0) throw new RangeError(`close values must be finite positive numbers, got ${v}`)
  }
  const initialCash = options.initialCash ?? 1
  if (!Number.isFinite(initialCash) || initialCash <= 0) throw new RangeError(`initialCash must be > 0, got ${initialCash}`)
  const feeRate = options.feeRate ?? 0.001
  if (!Number.isFinite(feeRate) || feeRate < 0) throw new RangeError(`feeRate must be >= 0, got ${feeRate}`)
  const slippageBps = options.slippageBps ?? 0
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps >= 10000) {
    // 10000bps = 100%：卖价会变成 0 或负数，现金被倒扣
    throw new RangeError(`slippageBps must be in [0, 10000), got ${slippageBps}`)
  }
  const latencyBars = options.latencyBars ?? 0
  if (!Number.isInteger(latencyBars) || latencyBars < 0) throw new RangeError(`latencyBars must be an integer >= 0, got ${latencyBars}`)
  const slip = slippageBps / 10000

  let cash = initialCash
  let position = 0
  const fills: SimFill[] = []
  let unfilledCount = 0

  // 1) 静态校验 + 按成交时间排序（同一根 bar 内保持提交顺序）。
  //    不能先按提交顺序撮合、事后排序：那样 cashAfter/positionAfter 与时间序错位，
  //    甚至会让 bar i 的卖单用上 bar j>i 才买入的持仓（未来函数）。
  const candidates: { order: SimOrder; orderIndex: number; fillIndex: number }[] = []
  orders.forEach((order, orderIndex) => {
    if (!Number.isInteger(order.index) || order.index < 0 || order.index >= n - 1) {
      unfilledCount++
      return
    }
    if (order.side !== 'buy' && order.side !== 'sell') {
      unfilledCount++
      return
    }
    if (order.quantity !== undefined && (!Number.isFinite(order.quantity) || order.quantity <= 0)) {
      unfilledCount++
      return
    }
    if (order.valueFraction !== undefined && (!Number.isFinite(order.valueFraction) || order.valueFraction <= 0 || order.valueFraction > 1)) {
      unfilledCount++
      return
    }
    if (order.quantity !== undefined && order.valueFraction !== undefined) {
      unfilledCount++
      return
    }
    const fillIndex = order.index + 1 + latencyBars
    if (fillIndex >= n) {
      unfilledCount++
      return
    }
    candidates.push({ order, orderIndex, fillIndex })
  })
  candidates.sort((a, b) => (a.fillIndex - b.fillIndex) || (a.orderIndex - b.orderIndex))

  // 2) 按时间序逐笔撮合，现金/持仓状态随成交推进
  for (const { order, orderIndex, fillIndex } of candidates) {
    const base = close[fillIndex]!
    const fillPrice = order.side === 'buy' ? base * (1 + slip) : base * (1 - slip)
    const equity = cash + position * base

    let quantity: number
    if (order.quantity !== undefined) {
      quantity = order.quantity
    } else {
      const frac = order.valueFraction ?? 1
      if (order.side === 'buy') {
        // 按权益比例定量，但受现金（含手续费）约束缩量：
        // 否则 valueFraction=1 的满仓单会因算不入手续费而永远 unfilled。
        const byEquity = (equity * frac) / fillPrice
        const byCash = cash / (fillPrice * (1 + feeRate))
        quantity = Math.min(byEquity, byCash)
      } else {
        quantity = position * frac
      }
    }
    if (order.side === 'sell') quantity = Math.min(quantity, position)
    if (quantity <= 0) {
      unfilledCount++
      continue
    }
    const value = quantity * fillPrice
    const fee = value * feeRate
    const slippageCost = quantity * Math.abs(fillPrice - base)
    if (order.side === 'buy') {
      const required = value + fee
      if (required > cash + Math.max(1e-12, Math.abs(cash) * 1e-12)) {
        unfilledCount++
        continue
      }
      cash -= required
      position += quantity
    } else {
      cash += value - fee
      position -= quantity
    }
    fills.push({
      orderIndex, side: order.side, fillIndex, fillPrice, quantity, value, fee,
      slippageCost, cashAfter: cash, positionAfter: position, equityAfter: cash + position * base,
    })
  }

  // 3) 按时间序重放状态 → 每根 K 线的盯市权益
  const equityCurve: number[] = new Array(n).fill(0)
  let c = initialCash
  let p = 0
  let fi = 0
  for (let i = 0; i < n; i++) {
    while (fi < fills.length && fills[fi]!.fillIndex === i) {
      c = fills[fi]!.cashAfter
      p = fills[fi]!.positionAfter
      fi++
    }
    equityCurve[i] = c + p * close[i]!
  }
  const finalEquity = equityCurve[n - 1]!
  return {
    fills,
    equityCurve: equityCurve.map(v => v / initialCash),
    finalEquity,
    totalReturnPct: (finalEquity / initialCash - 1) * 100,
    totalFee: fills.reduce((a, f) => a + f.fee, 0),
    totalSlippageCost: fills.reduce((a, f) => a + f.slippageCost, 0),
    tradeCount: fills.length,
    unfilledCount,
    cash,
    position,
  }
}
