/**
 * Deflated Sharpe Ratio（过拟合校正夏普，纯函数、零依赖）。
 *
 * 核心问题：回测出来的夏普有多大概率是过拟合的？
 * 多次试验（调参/多因子/多策略）后，最好结果的夏普会被高估。
 * Deflated Sharpe（Bailey & López de Prado, 2014）用试验次数 N 和
 * 回测长度 T 校正这一偏差，给出"经试验次数修正后的最小显著夏普"。
 */

/** Deflated Sharpe 结果。 */
export interface DeflatedSharpeResult {
  /** 观察到的夏普（年化） */
  observedSharpe: number
  /** 试验次数校正后的最小显著夏普（超过它才算真有效） */
  minSignificantSharpe: number
  /** Deflated Sharpe = (observed - minSignificant) * sqrt(T-1) 的标准化值 */
  deflatedSharpe: number
  /** 是否显著（observed > minSignificant） */
  significant: boolean
  /** 通过概率（标准正态 CDF） */
  pValue: number
  notes: string[]
}

/** 标准正态 CDF（近似，Abramowitz-Stegun）。 */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989423 * Math.exp(-x * x / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x > 0 ? 1 - p : p
}

/** 逆正态 CDF（Acklam 近似）。 */
function normInv(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const plow = 0.02425
  const phigh = 1 - plow
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (p > phigh) {
    return -normInv(1 - p)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
}

/**
 * Deflated Sharpe 计算。
 *
 * @param observedSharpe 观察到的年化夏普（内部按 periodsPerYear 换算成每期）
 * @param numPeriods 回测收益期数（如日频 = 天数）
 * @param numTrials 试验次数（参数搜索/因子数量，至少 1）
 * @param skewness 收益偏度（默认 0）
 * @param kurtosis 超额峰度（默认 0；正态 = 0）
 * @param periodsPerYear 每年期数（默认 252），用于年化/每期换算
 */
export function deflatedSharpe(
  observedSharpe: number,
  numPeriods: number,
  numTrials = 1,
  skewness = 0,
  kurtosis = 0,
  periodsPerYear = 252,
): DeflatedSharpeResult {
  if (!Number.isFinite(observedSharpe)) throw new RangeError('observedSharpe must be finite')
  if (numPeriods < 30) throw new RangeError(`numPeriods must be >= 30, got ${numPeriods}`)
  if (numTrials < 1 || !Number.isInteger(numTrials)) throw new RangeError(`numTrials must be a positive integer, got ${numTrials}`)
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) {
    throw new RangeError(`periodsPerYear must be > 0, got ${periodsPerYear}`)
  }

  // 期望最大 z（试验次数校正）：E[max] ≈ (1-γ)Φ⁻¹(1-1/N) + γΦ⁻¹(1-1/(Ne))
  const gamma = 0.5772156649 // Euler-Mascheroni
  const eMaxZ = numTrials === 1
    ? 0
    : (1 - gamma) * normInv(1 - 1 / numTrials) + gamma * normInv(1 - 1 / (numTrials * Math.E))

  // observedSharpe 是年化值，先换算成每期夏普，再与期数 T 配对算标准误
  const sr = observedSharpe / Math.sqrt(periodsPerYear)
  // Bailey & López de Prado (2014) SR 标准误：sqrt((1 - skew·SR + (γ4-1)/4·SR²)/(T-1))。
  // γ4 为原始峰度 = 超额峰度 + 3，故 (γ4-1)/4 = (kurtosis+2)/4（正态超额峰度 0 → 0.5）。
  const srVar = 1 - skewness * sr + ((kurtosis + 2) / 4) * sr * sr
  const se = Math.sqrt(Math.max(srVar, 0) / (numPeriods - 1))
  const minSignificantSharpe = eMaxZ * se * Math.sqrt(periodsPerYear)
  // Deflated Sharpe 检验统计量：z = SR/SE - E[max]（年化门槛与 z 同源，量纲一致）
  const deflated = se > 0 ? sr / se - eMaxZ : 0
  const pValue = 1 - normCdf(deflated)
  const significant = deflated > 1.6448536269514722 // one-sided 5%
  const notes: string[] = []
  notes.push(`试验次数 ${numTrials} → 期望最大 z ${eMaxZ.toFixed(2)}（年化门槛 ${minSignificantSharpe.toFixed(3)}）`)
  notes.push(`年化夏普 ${observedSharpe.toFixed(3)} → 每期 ${sr.toFixed(4)}，z=${deflated.toFixed(2)}，p=${pValue.toFixed(4)}`)
  if (significant) notes.push('通过 Deflated Sharpe 检验（单侧 5%）—— 结果不太可能是过拟合')
  else notes.push('未通过（单侧 5%）—— 结果可能在试验次数内被高估（过拟合风险）')
  return { observedSharpe, minSignificantSharpe, deflatedSharpe: deflated, significant, pValue, notes }
}
