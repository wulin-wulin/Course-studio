# 教学动画代码契约

## 核心规则

动画必须揭示真实机制，而不是给静态内容添加装饰运动。

只有同时能说明以下四项时才实现动画：

1. 输入或初始状态；
2. 随时间改变的状态；
3. 驱动每次变化的规则；
4. 终态、收敛条件或清晰的循环边界。

任一项无法回答时，改用静态图示或 `animationType: "none"`。

## 适用机制

通常适合动画：

- 状态转移；
- 迭代更新和收敛；
- 信息、信号或物质传播；
- 搜索、规划和决策；
- 采样与概率分布变化；
- 输入—处理—输出流程；
- 控制、博弈或学习反馈闭环；
- 几何变换或时间演化。

通常不适合动画：

- 术语定义；
- 静态分类和清单；
- 仅有组成关系的结构；
- 价值判断或规范框架；
- 没有唯一忠实过程的高度抽象概念。

不允许用漂移、闪烁、旋转、脉冲或粒子背景替代机制。

## 共享与拆分

- 输入、状态、更新规则和终态相同的机制可以共享组件。
- 只有主题名称相近但转移规则不同的知识点必须拆分。
- 共享组件中的标签和控制必须适用于所有绑定知识点。
- 每个非 `none` 类型对应一个组件和一个同名 CSS 文件。
- 动画数量由唯一机制数量决定，不按知识点数设置比例。

## 文件与命名

对 manifest 中每个动画项生成：

```text
src/animations/<PascalCaseComponent>.tsx
src/animations/<PascalCaseComponent>.css
```

规则：

- `animationType` 为 ASCII lowerCamelCase。
- 组件、文件名和默认导出名使用同一个 PascalCase 名称。
- CSS 文件由组件直接导入。
- 类型名表达机制，例如 `newtonIteration`，禁止 `animation1`、`coolEffect`。
- 不修改 `courseKnowledge.ts`、`AnimationBlock.tsx` 或 points；它们由构建脚本生成。

## 技术边界

优先使用 React、SVG 和 CSS，不引入输出包未声明的第三方依赖。

仅当三维空间关系不可替代时使用 Three.js；使用前必须确认目标项目已提供依赖，并完整释放 renderer、geometry、material、texture 和观察器。

组件采用零 props 接口。manifest 中的机制在源码中实现，知识点专属说明由 `AnimationBlock` 展示。

## 最小组件结构

```tsx
import { useEffect, useState } from 'react';
import './ProcessFlow.css';

function ProcessFlow() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStep((current) => (current + 1) % 4);
    }, 900);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="animation-stage process-flow" aria-label="输入按规则经过中间状态得到输出的动画">
      <svg viewBox="0 0 420 180" role="img">
        <title>输入经过三次状态更新得到输出</title>
        {/* 绘制输入、状态、规则标签和输出；step 控制真实状态 */}
      </svg>
      <button type="button" onClick={() => setStep(0)}>
        重播
      </button>
    </div>
  );
}

export default ProcessFlow;
```

实际组件不得保留占位注释，必须完整绘制机制。

## 状态与控制

动画至少呈现：

1. 初始输入或状态；
2. 一个或多个有教学意义的中间状态；
3. 终态、收敛结果或明确循环边界。

控制规则：

- 确定性过程提供“重播”，回到同一初始条件。
- 随机过程使用显式 seed。
- “重播”复现相同样本和轨迹。
- “重新生成”才改变 seed 或样本。
- 连续循环必须让学习者看得出循环边界。
- 控件使用原生 `button`，有明确中文文字或 `aria-label`。
- 不把预先写死的答案伪装成实时计算或学习结果。

## 副作用清理

若使用以下任一资源，必须在 React effect 清理函数中释放：

- `setTimeout`、`setInterval`；
- `requestAnimationFrame`；
- DOM 或媒体事件监听；
- `ResizeObserver`、`IntersectionObserver`；
- WebGL renderer、geometry、material、texture；
- worker、音频上下文或订阅。

重播和卸载不能留下叠加计时器或后台渲染循环。

## 响应式与样式

每个组件 CSS 使用独立命名空间：

```css
.process-flow {
  width: 100%;
  min-height: 180px;
  overflow: hidden;
}

.process-flow svg {
  display: block;
  width: 100%;
  height: auto;
}

@media (prefers-reduced-motion: reduce) {
  .process-flow * {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
```

禁止污染全局 `svg`、`path`、`text`、`button` 或通配选择器。不要写死容器宽度；SVG 使用响应式 `viewBox`。

## 低动态模式

所有动画必须支持 `prefers-reduced-motion: reduce`：

- CSS 动画和过渡缩短到一次；
- JavaScript 动画检测媒体查询并显示可读静态终态；
- SVG SMIL 无法被 CSS 可靠降级时，组件负责停止运动；
- 低动态模式下仍显示输入、规则和结果，不能只显示空白首帧。

## 可访问性

每个组件必须：

- 根节点包含 `animation-stage` 和准确中文 `aria-label`；
- 主 SVG 包含 `role="img"`；
- 主 SVG 包含描述机制的 `<title>`；
- 文本标签说明状态和变化规则；
- 颜色不是唯一信息通道，同时使用文字、形状、线型或位置；
- 控件可用键盘操作；
- 不使用快速闪烁或可能诱发不适的频率。

## 教学真实性

实现前逐项核对：

- 图中的变量是否对应知识点中的真实对象；
- 中间状态是否由显示的规则产生；
- 终态是否符合算法、定律或机制；
- 简化是否改变关键结论；
- 组件是否适用于 manifest 中的全部绑定点；
- 学习者能否根据标签解释“为什么发生变化”。

不得把随机移动解释成搜索，把插值路径解释成优化，把顺序点亮解释成因果传播。

## 建议人工验证

对每个组件至少执行：

1. 初次加载，观察输入、中间状态和结果是否完整。
2. 点击重播，确认回到相同初始条件。
3. 若有重新生成，确认只在该操作后改变样本。
4. 缩放容器，确认标签和图形不裁切。
5. 开启低动态偏好，确认显示可读终态。
6. 卸载并重新挂载，确认没有重复定时器或资源泄漏。
7. 对照绑定知识点的 `coreIdea` 和 `principles`，确认动画没有误导。

## 注册构建

组件完成后运行 `scripts/build_animation_registry.mjs`。脚本负责：

- 将 manifest 绑定写入 points 的 `animationType` 和 `animationSuggestion`；
- 生成 `AnimationType` 联合类型；
- 生成组件导入、标题映射和渲染注册；
- 生成共享的 `AnimationBlock.css`；
- 在无动画课程中生成只支持 `none` 的空注册层。

不得手工编辑这些生成文件来绕过 manifest。

## 完成定义

一个动画只有在以下条件全部满足时才算交付：

- manifest 绑定唯一且机制描述完整；
- TSX 和同名 CSS 均存在；
- 组件默认导出、可访问、响应式且支持低动态；
- 输入、状态、规则和终态可从画面读出；
- 副作用完整清理；
- points、类型声明和 `AnimationBlock` 已由脚本同步；
- 全量校验和目标项目可用构建通过。
