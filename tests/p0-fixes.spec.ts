/**
 * P0 回归：本轮修复的 8 个硬 bug 的手算证据（每个用例都是修复前会失败、修复后通过）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bollinger } from '../src/dsh-alpha/indicators.ts'
import { factorEvaluate } from '../src/dsh-alpha/factor.ts'
import { executeSimulate } from '../src/dsh-execution/execute.ts'
import { researchPipeline } from '../src/dsh-execution/pipeline.ts'
import { layeredBacktest } from '../src/dsh-ml/layered.ts'
import { riskMetrics } from '../src/dsh-risk/risk.ts'
import { parseKlines, parseSinaKlines } from '../src/dsh-data/market.ts'

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) { sa += a[i]!; sb += b[i]! }
  const ma = sa / n
  const mb = sb / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    cov += (a[i]! - ma) * (b[i]! - mb)
    va += (a[i]! - ma) ** 2
    vb += (b[i]! - mb) ** 2
  }
  return cov / Math.sqrt(va * vb)
}

test('P0 market: 缺值不再被 Number() 静默转成 0', () => {
  assert.throws(() => parseKlines([[1, null, '2', '0.5', '1.5', '10']]), /open is missing/)
  assert.throws(() => parseKlines([[1, '   ', '2', '0.5', '1.5', '10']]), /open is missing/)
  assert.throws(() => parseKlines([[1, '', '2', '0.5', '1.5', '10']]), /open is missing/)
  // 合法 0 仍是 0（volume 0 合法，不能一刀切 falsy）
  assert.equal(parseKlines([[1, '2', '3', '0.5', '1.5', '0']])[0]!.volume, 0)
  assert.throws(
    () => parseSinaKlines([{ day: '2024-01-02', open: null, high: 1, low: 1, close: 1, volume: 1 }]),
    /open is missing/,
  )
})

test('P0 risk: CVaR 取最差 tailCount 样本，下行偏差围绕 0', () => {
  // 97 个 +0.1% + 3 个 -10%：95% ES = (3×0.1 + 2×0.001)/5 = 0.0604
  const rets = [...Array(97).fill(0.001), -0.1, -0.1, -0.1]
  const r = riskMetrics(rets, { confidence: 0.95 })
  assert.ok(Math.abs(r.cvar95 - (3 * 0.1 - 2 * 0.001) / 5) < 1e-12, `cvar=${r.cvar95}`)
  // 下行偏差 = sqrt(Σ min(r,0)² / N)
  const d = riskMetrics([-0.01, 0.02])
  assert.ok(Math.abs(d.downsideDeviation - Math.sqrt(0.0001 / 2)) < 1e-12, `down=${d.downsideDeviation}`)
})

test('P0 indicators: 布林带在大均值小方差下不归零', () => {
  const values = Array.from({ length: 40 }, (_, i) => 1e8 + (i % 2) * 0.01)
  const b = bollinger(values, 20, 1)
  const halfWidth = b.upper[19]! - b.middle[19]!
  assert.ok(Math.abs(halfWidth - 0.005) < 1e-7, `halfwidth=${halfWidth}`)
})

test('P0 factor: IC 衰减 h=1 等于全样本 IC（不再多滞后一期）', () => {
  const factor = Array.from({ length: 60 }, (_, i) => Math.sin(i / 3) + (i % 7) * 0.05)
  const fwd = [0, ...factor.slice(0, -1)] // forwardReturns[i] = factor[i-1] → factor[i] 预测 fwd[i+1] = factor[i]
  const ev = factorEvaluate(factor, fwd, 5, 20, 3)
  assert.ok(Math.abs(ev.ic - 1) < 1e-12, `ic=${ev.ic}`)
  assert.ok(Math.abs(ev.icDecay[0]! - 1) < 1e-12, `decay0=${ev.icDecay[0]}`)
})

test('P0 execute: 满仓买入可成交，乱序提交按时间序撮合', () => {
  const full = executeSimulate([100, 100, 100], [{ index: 0, side: 'buy', valueFraction: 1 }], { feeRate: 0.001 })
  assert.equal(full.tradeCount, 1)
  assert.equal(full.unfilledCount, 0)
  assert.ok(full.fills[0]!.quantity > 0)

  const c = [10, 11, 12, 13, 14, 15, 16]
  const r = executeSimulate(c, [
    { index: 5, side: 'buy', quantity: 0.05 },
    { index: 1, side: 'buy', quantity: 0.05 },
  ], { feeRate: 0, initialCash: 100 })
  assert.equal(r.tradeCount, 2)
  assert.deepEqual(r.fills.map(f => f.fillIndex), [2, 6])
  assert.equal(r.fills[0]!.orderIndex, 1)

  // bar 1 的卖单不能使用 bar 5 才买入的持仓（修复前是未来函数）
  const f2 = executeSimulate(c, [
    { index: 5, side: 'buy', quantity: 0.05 },
    { index: 0, side: 'sell', quantity: 0.05 },
  ], { feeRate: 0 })
  assert.equal(f2.fills.length, 1)
  assert.equal(f2.fills[0]!.side, 'buy')
  assert.equal(f2.fills[0]!.fillIndex, 6)
  assert.equal(f2.unfilledCount, 1)
  assert.deepEqual(f2.equityCurve.slice(0, 6), [1, 1, 1, 1, 1, 1])
})

test('P0 layered: 持有 horizon 期并逐期推进净值', () => {
  const t = 10
  const n = 10
  const factor = Array.from({ length: t }, () => Array<number>(n).fill(1))
  const returns = Array.from({ length: t }, () => Array<number>(n).fill(0.01))
  const r = layeredBacktest(factor, returns, 5, 5, 0)
  // 10 根价格 → 9 个收益期，全部计入
  assert.ok(Math.abs(r.topReturnPct / 100 - (Math.pow(1.01, 9) - 1)) < 1e-12, `top=${r.topReturnPct}`)
  assert.ok(Math.abs(r.topEquity[5]! - Math.pow(1.01, 5)) < 1e-12)
  assert.ok(Math.abs(r.topEquity[9]! - Math.pow(1.01, 9)) < 1e-12)
})

test('P0 pipeline: 因子 IC 是 1 期前瞻', async () => {
  const close = Array.from({ length: 80 }, (_, i) => 100 + i * 0.4 + Math.sin(i / 2) * 3 + Math.cos(i / 5) * 2)
  const candles = close.map((c, i) => ({ openTime: i, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }))
  const res = await researchPipeline({ candles, fast: 5, slow: 20, feeRate: 0 }, new AbortController().signal)
  const f: number[] = []
  const ret: number[] = []
  for (let t = 12; t < close.length; t++) {
    f.push(close[t]! / close[t - 12]! - 1)
    ret.push(close[t]! / close[t - 1]! - 1)
  }
  // factorEvaluate 内部：factor[k] 配 forwardReturns[k+1] → 1 期前瞻
  const expectedIc = pearson(f.slice(0, -1), ret.slice(1))
  assert.ok(Math.abs(res.factor.ic - expectedIc) < 1e-9, `pipeline=${res.factor.ic} expected=${expectedIc}`)
})
