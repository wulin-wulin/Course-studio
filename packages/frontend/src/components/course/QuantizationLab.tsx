import { useId, useMemo, useState } from "react";
import { Activity, Gauge, RotateCcw, SlidersHorizontal } from "lucide-react";
import "./quantizationLab.css";

export type QuantizationLabPreset = {
  rangeMin?: number;
  rangeMax?: number;
  unit?: string;
  adcBits?: number;
  enob?: number;
  noisePeakToPeak?: number;
  inputValue?: number;
};

export type QuantizationLabAsset = {
  title?: string;
  learningPurpose?: string;
  config?: {
    preset?: QuantizationLabPreset;
  };
};

type LabState = {
  bits: number;
  rangeSpan: number;
  noisePeakToPeak: number;
  inputValue: number;
};

export function QuantizationLab({ asset }: { asset: QuantizationLabAsset }) {
  const prefix = useId();
  const preset = useMemo(() => normalizePreset(asset.config?.preset), [asset.config?.preset]);
  const [state, setState] = useState<LabState>(() => stateFromPreset(preset));
  const rangeMin = preset.rangeMin;
  const rangeMax = rangeMin + state.rangeSpan;
  const levels = 2 ** state.bits - 1;
  const step = state.rangeSpan / levels;
  const inputIsInRange = state.inputValue >= rangeMin && state.inputValue <= rangeMax;
  const clippedInput = clamp(state.inputValue, rangeMin, rangeMax);
  const code = Math.round(((clippedInput - rangeMin) / state.rangeSpan) * levels);
  const quantizedValue = rangeMin + (code / levels) * state.rangeSpan;
  const error = state.inputValue - quantizedValue;
  const enobStep = state.rangeSpan / (2 ** preset.enob - 1);
  const noiseToStep = state.noisePeakToPeak / Math.max(step, Number.EPSILON);
  const effectiveLimit = Math.max(enobStep, state.noisePeakToPeak);

  const reset = () => setState(stateFromPreset(preset));
  const setBits = (value: number) => setState((current) => ({ ...current, bits: value }));
  const setRangeSpan = (value: number) => setState((current) => {
    const nextMax = rangeMin + value;
    return { ...current, rangeSpan: value, inputValue: clamp(current.inputValue, rangeMin - value * 0.1, nextMax + value * 0.1) };
  });
  const setNoise = (value: number) => setState((current) => ({ ...current, noisePeakToPeak: value }));
  const setInput = (value: number) => setState((current) => ({ ...current, inputValue: value }));

  return (
    <section className="quantization-lab" aria-labelledby={`${prefix}-title`}>
      <header className="quantization-lab__head">
        <div>
          <span><SlidersHorizontal aria-hidden="true" size={15} />互动实验</span>
          <h3 id={`${prefix}-title`}>{asset.title || "量程、位数与噪声实验"}</h3>
          <p>{asset.learningPurpose || "调节测量条件，观察理论分辨率何时不再决定真实精度。"}</p>
        </div>
        <button type="button" onClick={reset}>
          <RotateCcw aria-hidden="true" size={14} />恢复教材案例
        </button>
      </header>

      <div className="quantization-lab__body">
        <div className="quantization-lab__controls" aria-label="实验参数">
          <LabRange
            id={`${prefix}-bits`}
            label="ADC 位数"
            value={state.bits}
            min={8}
            max={24}
            step={1}
            display={`${state.bits} 位`}
            onChange={setBits}
          />
          <LabRange
            id={`${prefix}-span`}
            label="量程跨度"
            value={state.rangeSpan}
            min={10}
            max={200}
            step={5}
            display={`${formatNumber(state.rangeSpan, 0)} ${preset.unit}`}
            onChange={setRangeSpan}
          />
          <LabRange
            id={`${prefix}-noise`}
            label="前端噪声峰峰值"
            value={state.noisePeakToPeak}
            min={0}
            max={1}
            step={0.01}
            display={`${formatNumber(state.noisePeakToPeak, 2)} ${preset.unit}`}
            onChange={setNoise}
          />
          <LabRange
            id={`${prefix}-input`}
            label="当前输入"
            value={state.inputValue}
            min={rangeMin - state.rangeSpan * 0.1}
            max={rangeMax + state.rangeSpan * 0.1}
            step={Math.max(state.rangeSpan / 500, 0.01)}
            display={`${formatNumber(state.inputValue, 2)} ${preset.unit}`}
            onChange={setInput}
          />
        </div>

        <div className="quantization-lab__stage">
          <QuantizationPlot
            idPrefix={prefix}
            rangeMin={rangeMin}
            rangeMax={rangeMax}
            input={state.inputValue}
            quantized={quantizedValue}
            step={step}
            unit={preset.unit}
            outOfRange={!inputIsInRange}
          />

          <div className="quantization-lab__metrics" aria-live="polite">
            <Metric label="理论量化间隔" value={`${formatEngineering(step)} ${preset.unit}`} />
            <Metric label="输出码" value={inputIsInRange ? `${code} / ${levels}` : `${code} · 已截断`} tone={inputIsInRange ? "normal" : "warning"} />
            <Metric label="本次量化误差" value={`${formatEngineering(error)} ${preset.unit}`} />
            <Metric label={`${formatNumber(preset.enob, 1)} ENOB 间隔`} value={`${formatEngineering(enobStep)} ${preset.unit}`} />
          </div>

          <div className={`quantization-lab__finding ${findingTone(inputIsInRange, noiseToStep)}`}>
            {inputIsInRange ? <Activity aria-hidden="true" size={18} /> : <Gauge aria-hidden="true" size={18} />}
            <div>
              <strong>{findingTitle(inputIsInRange, noiseToStep)}</strong>
              <p>{findingText({ inputIsInRange, noiseToStep, effectiveLimit, unit: preset.unit })}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LabRange({
  id,
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="quantization-lab__control" htmlFor={id}>
      <span>{label}<output htmlFor={id}>{display}</output></span>
      <input
        id={id}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function Metric({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "warning" }) {
  return (
    <div className={tone === "warning" ? "is-warning" : undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function QuantizationPlot({
  idPrefix,
  rangeMin,
  rangeMax,
  input,
  quantized,
  step,
  unit,
  outOfRange,
}: {
  idPrefix: string;
  rangeMin: number;
  rangeMax: number;
  input: number;
  quantized: number;
  step: number;
  unit: string;
  outOfRange: boolean;
}) {
  const span = rangeMax - rangeMin;
  const inputX = 24 + clamp((input - rangeMin) / span, 0, 1) * 432;
  const outputY = 146 - clamp((quantized - rangeMin) / span, 0, 1) * 104;
  const visibleStepCount = 10;
  const staircase = Array.from({ length: visibleStepCount }, (_, index) => {
    const x0 = 24 + (index / visibleStepCount) * 432;
    const x1 = 24 + ((index + 1) / visibleStepCount) * 432;
    const y = 146 - ((index + 0.5) / visibleStepCount) * 104;
    return `${index === 0 ? "M" : "L"}${x0},${y} L${x1},${y}`;
  }).join(" ");
  return (
    <figure className="quantization-lab__plot">
      <svg viewBox="0 0 480 184" role="img" aria-labelledby={`${idPrefix}-plot-title ${idPrefix}-plot-desc`}>
        <title id={`${idPrefix}-plot-title`}>连续输入到离散输出的量化示意</title>
        <desc id={`${idPrefix}-plot-desc`}>输入值沿横轴移动，阶梯线表示离散量化输出。</desc>
        <line x1="24" y1="146" x2="456" y2="42" className="quantization-lab__ideal" />
        <path d={staircase} className="quantization-lab__stairs" />
        <line x1={inputX} y1="154" x2={inputX} y2={outputY} className={outOfRange ? "quantization-lab__cursor is-warning" : "quantization-lab__cursor"} />
        <circle cx={inputX} cy={outputY} r="5" className={outOfRange ? "quantization-lab__dot is-warning" : "quantization-lab__dot"} />
        <text x="24" y="171">{formatNumber(rangeMin, 0)} {unit}</text>
        <text x="456" y="171" textAnchor="end">{formatNumber(rangeMax, 0)} {unit}</text>
      </svg>
      <figcaption>
        灰线表示理想连续关系，彩色阶梯是便于观察的局部示意；精确结果以指标为准。当前理论间隔为 {formatEngineering(step)} {unit}。
      </figcaption>
    </figure>
  );
}

function normalizePreset(value: QuantizationLabPreset | undefined) {
  const rangeMin = finiteOr(value?.rangeMin, -40);
  const candidateMax = finiteOr(value?.rangeMax, 60);
  const rangeMax = candidateMax > rangeMin ? candidateMax : rangeMin + 100;
  return {
    rangeMin,
    rangeMax,
    unit: typeof value?.unit === "string" && value.unit.trim() ? value.unit.trim() : "°C",
    adcBits: clamp(Math.round(finiteOr(value?.adcBits, 16)), 8, 24),
    enob: clamp(finiteOr(value?.enob, 14.2), 1, 24),
    noisePeakToPeak: clamp(finiteOr(value?.noisePeakToPeak, 0.3), 0, 10),
    inputValue: finiteOr(value?.inputValue, rangeMin + (rangeMax - rangeMin) * 0.42),
  };
}

function stateFromPreset(preset: ReturnType<typeof normalizePreset>): LabState {
  return {
    bits: preset.adcBits,
    rangeSpan: preset.rangeMax - preset.rangeMin,
    noisePeakToPeak: preset.noisePeakToPeak,
    inputValue: preset.inputValue,
  };
}

function findingTone(inputIsInRange: boolean, noiseToStep: number) {
  if (!inputIsInRange) return "is-danger";
  if (noiseToStep >= 4) return "is-caution";
  return "is-good";
}

function findingTitle(inputIsInRange: boolean, noiseToStep: number) {
  if (!inputIsInRange) return "先处理量程溢出";
  if (noiseToStep >= 4) return "噪声正在掩盖理论分辨率";
  return "量化间隔仍会影响可辨变化";
}

function findingText({
  inputIsInRange,
  noiseToStep,
  effectiveLimit,
  unit,
}: {
  inputIsInRange: boolean;
  noiseToStep: number;
  effectiveLimit: number;
  unit: string;
}) {
  if (!inputIsInRange) {
    return "输入已经越过配置量程。边界码必须同时标记 OUT_OF_RANGE，不能直接当成真实高温或低温。";
  }
  if (noiseToStep >= 4) {
    return `前端噪声约为理论间隔的 ${formatNumber(noiseToStep, 0)} 倍；继续增加位数的收益很小。当前可辨变化至少约为 ${formatEngineering(effectiveLimit)} ${unit}。`;
  }
  return `当前噪声与量化间隔处在相近尺度，调整位数或缩小量程仍可能改善测量。估计可辨变化约为 ${formatEngineering(effectiveLimit)} ${unit}。`;
}

function formatEngineering(value: number) {
  const absolute = Math.abs(value);
  if (absolute === 0) return "0";
  if (absolute < 0.001) return value.toExponential(2);
  if (absolute < 0.1) return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatNumber(value: number, digits: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
}

function finiteOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
