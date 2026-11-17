/**
 * backtest.ts 纯函数测试（手算样例）。
 * 运行：cd deepseek-harness && pnpm exec tsx --test ../quant-indicators/tests/backtest.spec.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backtestBollingerBreakout, backtestGrid, backtestMaCross, backtestRsiReversion } from '../src/dsh-ml/backtest.ts'

test('backtest: V 形序列 — 一次买入持有到末尾（open trade）', () => {
  const close = [10, 9, 8, 7, 6, 5, 6, 7, 8, 9, 10, 11, 12]
  const out = backtestMaCross(close, 2, 3, 0.001)
  // 手算：crossUp 确认于 i=7（prev fast 5.5 <= slow 6，cur 6.5 > 6），i=8 收盘价 8 成交
  assert.equal(out.trades.length, 1)
  assert.equal(out.trades[0].entryIndex, 8)
  assert.equal(out.trades[0].entryPrice, 8)
  assert.equal(out.trades[0].exitIndex, null) // 持仓到末尾
  // position：i=8 起满仓
  assert.deepEqual(out.position, [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1])
  // equity[12] = 0.999 * 12/8 = 1.4985
  assert.ok(Math.abs(out.equityCurve[12]! - 0.999 * 12 / 8) < 1e-9)
  assert.ok(Math.abs(out.totalReturnPct - (0.999 * 12 / 8 - 1) * 100) < 1e-6)
  // 最大回撤 = 买入瞬间的手续费成本（1 → 0.999）
  assert.ok(Math.abs(out.maxDrawdownPct - 0.1) < 1e-6)
})

test('backtest: V 形后回落 — 完整买卖周期 + 双边手续费', () => {
  const close = [10, 9, 8, 7, 6, 5, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4]
  const out = backtestMaCross(close, 2, 3, 0.001)
  // 买 i=8 @8；crossDown 确认于 i=12（prev fast 9.5 >= slow 9.333，cur 8.5 < 9），i=13 收盘价 7 卖出
  assert.equal(out.trades.length, 1)
  const t = out.trades[0]!
  assert.equal(t.entryIndex, 8)
  assert.equal(t.exitIndex, 13)
  assert.equal(t.exitPrice, 7)
  // 净收益含双边手续费：0.999^2 × (7/8) - 1
  assert.ok(Math.abs(t.returnPct! - (0.999 * 0.999 * (7 / 8) - 1)) < 1e-12)
  // 空仓收尾：cash 已实现价格盈亏并扣双边手续费 = 0.999^2 × 7/8
  assert.equal(out.position[13], 0)
  assert.ok(Math.abs(out.equityCurve[13]! - 0.999 * 0.999 * (7 / 8)) < 1e-12)
  assert.ok(Math.abs(out.totalReturnPct - (0.999 * 0.999 * (7 / 8) - 1) * 100) < 1e-9)
})

test('backtest: 单调上升无交叉 → 无交易', () => {
  const out = backtestMaCross([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2, 3, 0)
  assert.equal(out.trades.length, 0)
  assert.equal(out.totalReturnPct, 0)
  assert.deepEqual(out.position, new Array(10).fill(0))
})

test('backtest: 空序列 → 空结果', () => {
  const out = backtestMaCross([], 2, 3, 0)
  assert.equal(out.trades.length, 0)
  assert.equal(out.totalReturnPct, 0)
  assert.deepEqual(out.equityCurve, [])
})

test('backtest: 前置条件', () => {
  assert.throws(() => backtestMaCross([1, 2, 3], 3, 2, 0), /fast must be < slow/)
  assert.throws(() => backtestMaCross([1, 2, 3], 0, 3, 0), /positive integer/)
  assert.throws(() => backtestMaCross([1, 2, 3], 2, 3, -0.1), /feeRate/)
})

test('backtest: 真实数据冒烟（BTC 日线 close 序列）', () => {
  // 使用与 verify 相同的真实抓取验证链路在 verify.ts 中；这里用确定性上升-震荡序列
  // 验证 equityCurve/position 等长且资金曲线非负
  const close = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.1)
  const out = backtestMaCross(close, 5, 20, 0.001)
  assert.equal(out.equityCurve.length, 200)
  assert.equal(out.position.length, 200)
  for (const v of out.equityCurve) assert.ok(v > 0)
  assert.ok(out.sharpe > -100 && out.sharpe < 100) // 数值合理
})

test('backtestGrid: 小网格结果正确且按收益降序', () => {
  const close = [10, 9, 8, 7, 6, 5, 6, 7, 8, 9, 10, 11, 12]
  const out = backtestGrid(close, 2, 2, 3, 3, 0.001) // 只有 (2,3) 一个组合
  assert.equal(out.results.length, 1)
  assert.equal(out.best.fast, 2)
  assert.equal(out.best.slow, 3)
  // 与单点回测一致
  const single = backtestMaCross(close, 2, 3, 0.001)
  assert.ok(Math.abs(out.best.totalReturnPct - single.totalReturnPct) < 1e-9)
  assert.equal(out.results[0]!.trades, 1)
})

test('backtestGrid: 多组合排序 + 跳过 fast >= slow', () => {
  const close = [10, 9, 8, 7, 6, 5, 6, 7, 8, 9, 10, 11, 12]
  const out = backtestGrid(close, 2, 3, 2, 3, 0.001)
  // 合法组合：fast=2,slow=3（(2,2)(3,2)(3,3) 被跳过）
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0]!.fast, 2)
  assert.equal(out.results[0]!.slow, 3)
})

test('backtestGrid: 收益降序', () => {
  // 构造一个 (2,3) 明显优于 (3,4) 的序列：用确定性序列验证排序方向
  const close = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 20 + (i % 10) * 2)
  const out = backtestGrid(close, 2, 3, 3, 4, 0.001)
  const returns = out.results.map(r => r.totalReturnPct)
  for (let i = 1; i < returns.length; i++) {
    assert.ok(returns[i - 1]! >= returns[i]!, `results not sorted at ${i}`)
  }
  assert.equal(out.results.length, 3) // (2,3)(2,4)(3,4)
  assert.equal(out.best.totalReturnPct, returns[0])
})

test('backtestGrid: 前置条件', () => {
  assert.throws(() => backtestGrid([1, 2, 3], 5, 2, 3, 4, 0), /fastMin must be <= fastMax/)
  assert.throws(() => backtestGrid([1, 2, 3], 2, 2, 3, 3, -1), /feeRate/)
  // 所有组合都非法（fast 范围全 >= slow 范围）→ 抛错
  assert.throws(() => backtestGrid([1, 2, 3, 4, 5], 5, 5, 1, 1, 0), /no valid/)
})

// ---- 平仓会计恒等式（Issue #166）：价格盈亏必须真正结算，双边费用分别扣除 ----

test('backtest: 盈利完整买卖 — 平仓收益计入净值和含费净收益', () => {
  // 买 i=5 @6；卖 i=10 @8（信号 i 确认、i+1 收盘成交）
  const out = backtestMaCross([5, 4, 3, 4, 5, 6, 10, 10, 10, 9, 8, 7], 2, 3, 0.001)
  assert.equal(out.trades.length, 1)
  const t = out.trades[0]!
  assert.equal(t.entryIndex, 5)
  assert.equal(t.exitIndex, 10)
  assert.equal(t.entryPrice, 6)
  assert.equal(t.exitPrice, 8)
  const expectedNav = 0.999 * 0.999 * (8 / 6)
  assert.ok(Math.abs(out.equityCurve[10]! - expectedNav) < 1e-12)
  assert.ok(Math.abs(out.equityCurve[11]! - expectedNav) < 1e-12) // 空仓后保持
  assert.ok(Math.abs(t.returnPct! - (expectedNav - 1)) < 1e-12)
  assert.ok(Math.abs(out.totalReturnPct - (expectedNav - 1) * 100) < 1e-9)
})

test('backtest: 零手续费时净值等于价格比', () => {
  const out = backtestMaCross([5, 4, 3, 4, 5, 6, 10, 10, 10, 9, 8, 7], 2, 3, 0)
  assert.ok(Math.abs(out.equityCurve[10]! - 8 / 6) < 1e-12)
  assert.ok(Math.abs(out.trades[0]!.returnPct! - (8 / 6 - 1)) < 1e-12)
})

test('backtest: 止盈平仓也结算价格盈亏', () => {
  const out = backtestMaCross([10, 10, 10, 10, 11, 12, 13, 14, 15, 16], 2, 3, 0.001, undefined, 0.10)
  const t = out.trades[0]!
  assert.equal(t.exitReason, 'take_profit')
  assert.equal(t.entryPrice, 12)
  assert.equal(t.exitPrice, 14)
  const expectedNav = 0.999 * 0.999 * (14 / 12)
  assert.ok(Math.abs(out.equityCurve[7]! - expectedNav) < 1e-12)
  assert.ok(Math.abs(t.returnPct! - (expectedNav - 1)) < 1e-12)
})

test('backtest: 止损平仓也结算价格盈亏（布林带）', () => {
  const out = backtestBollingerBreakout([100, 100, 100, 100, 130, 140, 100, 90, 80, 70, 60, 50], 3, 1, 0.001, 0.15)
  const t = out.trades[0]!
  assert.equal(t.exitReason, 'stop_loss')
  assert.equal(t.entryPrice, 140)
  assert.equal(t.exitPrice, 100)
  const expectedNav = 0.999 * 0.999 * (100 / 140)
  assert.ok(Math.abs(out.equityCurve[6]! - expectedNav) < 1e-12)
  assert.ok(Math.abs(t.returnPct! - (expectedNav - 1)) < 1e-12)
})

test('backtest: RSI 平仓净收益', () => {
  const out = backtestRsiReversion([100, 90, 80, 70, 60, 50, 60, 70, 80, 90, 100, 110, 120, 130, 120, 110, 100], 3, 30, 70, 0.001)
  assert.equal(out.trades.length, 1)
  const t = out.trades[0]!
  assert.equal(t.entryPrice, 70)
  assert.equal(t.exitPrice, 110)
  const expectedNav = 0.999 * 0.999 * (110 / 70)
  assert.ok(Math.abs(out.equityCurve.at(-1)! - expectedNav) < 1e-12)
  assert.ok(Math.abs(t.returnPct! - (expectedNav - 1)) < 1e-12)
})

test('backtest: 多笔平仓后净值等于逐笔净收益复合（会计恒等式）', () => {
  const close = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.1)
  const feeRate = 0.001
  const out = backtestMaCross(close, 5, 20, feeRate)
  assert.ok(out.trades.length >= 2)
  let nav = 1
  for (const t of out.trades) {
    if (t.exitPrice === null) {
      nav *= close[close.length - 1]! / t.entryPrice
      break
    }
    nav *= (1 - feeRate) * (1 - feeRate) * (t.exitPrice / t.entryPrice)
  }
  assert.ok(Math.abs(out.equityCurve.at(-1)! - nav) < 1e-12)
})
