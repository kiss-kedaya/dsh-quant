/**
 * P1 回归：边界/契约缺口修复的手算证据（每个用例都是修复前会失败、修复后通过）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fundSimulate } from '../src/dsh-execution/fund.ts'
import { executeSimulate } from '../src/dsh-execution/execute.ts'
import { tradeQuality } from '../src/dsh-execution/trade-quality.ts'
import { chartBacktest, chartCandles } from '../src/dsh-execution/chart.ts'
import { researchPipeline } from '../src/dsh-execution/pipeline.ts'
import { dataQualityReport } from '../src/dsh-data/quality.ts'
import { seriesStats } from '../src/dsh-data/stats.ts'
import { compareChannels } from '../src/dsh-data/data-guide.ts'
import { parseNpmStats } from '../src/dsh-community/npm.ts'
import { rebalanceSchedule } from '../src/dsh-ml/rebalance.ts'

test('P1 fund: 非法净值序列直接抛错而不是产出 NaN', () => {
  assert.throws(() => fundSimulate([1, 0, 1.2]), /finite positive/)
  assert.throws(() => fundSimulate([1, Number.NaN]), /finite positive/)
  assert.throws(() => fundSimulate([1, 1.1], { initialCapital: Number.NaN }), /initialCapital/)
})

test('P1 execute: slippageBps >= 10000 抛错（成交价会变负）', () => {
  assert.throws(() => executeSimulate([100, 100, 100], [], { slippageBps: 10000 }), /slippageBps/)
  assert.throws(() => executeSimulate([100, 100, 100], [], { slippageBps: 20000 }), /slippageBps/)
})

test('P1 trade-quality: 持仓周期按买→卖配对；负数未成交订单抛错', () => {
  const fills = [
    { orderIndex: 0, side: 'buy' as const, fillIndex: 1, fillPrice: 100, quantity: 1, value: 100, fee: 0, slippageCost: 0, cashAfter: 0, positionAfter: 1, equityAfter: 100 },
    { orderIndex: 1, side: 'sell' as const, fillIndex: 6, fillPrice: 105, quantity: 1, value: 105, fee: 0, slippageCost: 0, cashAfter: 105, positionAfter: 0, equityAfter: 105 },
  ]
  const r = tradeQuality(fills, 0)
  assert.equal(r.avgHoldingBars, 5) // 修复前恒 0（orderIndex 不同）
  assert.throws(() => tradeQuality(fills, -1), /unfilledOrders/)
  assert.ok(tradeQuality([], 0).notes.includes('无订单'))
})

test('P1 chart: 回测图带买卖标记；错位 overlay/越界 marker 抛错', () => {
  const d = chartBacktest([1, 1.1, 1.2, 1.3], [{ entryIndex: 0, exitIndex: 2, exitReason: 'stop_loss' }])
  assert.equal(d.kind, 'series')
  assert.deepEqual(d.markers, [{ index: 0, kind: 'entry' }, { index: 2, kind: 'stop' }])
  assert.throws(
    () => chartCandles([{ openTime: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }], [{ name: 'x', values: [1, 2] }]),
    /length/,
  )
  assert.throws(
    () => chartCandles([{ openTime: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }], [], [{ index: 5, kind: 'entry' }]),
    /out of range/,
  )
})

test('P1 pipeline: 显式空 candles 抛错；K 线图带 exit 标记', async () => {
  await assert.rejects(
    () => researchPipeline({ candles: [] }, new AbortController().signal),
    /candles must not be empty/,
  )
  const close = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5)
  const candles = close.map((c, i) => ({ openTime: i * 86400000, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }))
  const r = await researchPipeline({ candles, fast: 2, slow: 4, feeRate: 0 }, new AbortController().signal)
  assert.ok(Array.isArray(r.charts.candles.markers))
  assert.ok(Array.isArray(r.charts.equity.markers ?? []))
  if (r.metrics.trades.tradeCount > 0) assert.ok(r.charts.candles.markers.some(m => m.kind === 'entry'))
})

test('P1 data: PIT 前视下标映射回原始序列', () => {
  const rep = dataQualityReport([1, null, 2, 10, 20])
  assert.deepEqual(rep.pit.lookAheadIndices, [3, 4])
  assert.deepEqual(rep.survivorship.gaps, [{ start: 1, end: 2 }])
})

test('P1 stats: lag-1 自相关用 n 口径；0 分母不进年化波动', () => {
  const s = seriesStats([1, 2, 3, 4])
  assert.ok(Math.abs(s.autocorr1 - 0.25) < 1e-12, `ac=${s.autocorr1}`)
  const z = seriesStats([0, 1, 2])
  assert.ok(Number.isFinite(z.annualizedVol))
})

test('P1 data-guide: 空 dataType 抛错而不是全命中', () => {
  assert.throws(() => compareChannels('   '), /dataType/)
})

test('P1 npm: 缺 dist-tags 抛可诊断错误', () => {
  assert.throws(() => parseNpmStats('x', {}, null, null), /missing dist-tags/)
})

test('P1 rebalance: 存在内部最优频率（不再恒为 1 或 60）', () => {
  const r = rebalanceSchedule(0.0001, 0.005, 60)
  // f* = sqrt(2c/d) = sqrt(0.01/0.0001) = 10
  assert.ok(r.bestFrequency > 1 && r.bestFrequency < 60, `best=${r.bestFrequency}`)
  assert.ok(Math.abs(r.bestFrequency - 10) <= 2, `best=${r.bestFrequency}`)
})
