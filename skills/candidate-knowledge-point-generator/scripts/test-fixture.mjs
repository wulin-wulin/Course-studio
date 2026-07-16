import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';

export const POINT_IDS = [
  'input-state',
  'state-transition',
  'terminal-condition',
];

export const ANIMATION_TYPE = 'stateTransition';
export const ANIMATION_COMPONENT = 'StateTransition';
export const ANIMATION_SUGGESTION = '依次展示当前状态、触发条件、转移规则和更新后的状态。';

const INDEX_POINTS = [
  {
    id: 'input-state',
    title: '输入状态',
    shortSummary: '输入状态描述系统开始执行转移规则前已经具备的变量取值、环境条件与可用信息。',
    difficulty: '基础',
    importance: 0.72,
    keyTerms: ['初始条件', '状态变量', '输入信息'],
  },
  {
    id: 'state-transition',
    title: '状态转移',
    shortSummary: '状态转移描述系统如何依据触发条件和确定规则，从当前状态更新到下一个合法状态。',
    difficulty: '中等',
    importance: 0.9,
    keyTerms: ['当前状态', '转移规则', '触发条件'],
  },
  {
    id: 'terminal-condition',
    title: '终止条件',
    shortSummary: '终止条件规定状态更新过程何时停止，并使学习者能够判断结果是否已经完整产生。',
    difficulty: '基础',
    importance: 0.78,
    keyTerms: ['停止判据', '最终状态', '过程边界'],
  },
];

const MECHANISM = {
  inputs: '当前状态与触发条件',
  changingState: '系统当前状态',
  transitionRule: '满足触发条件后应用确定的状态转移规则',
  terminalState: '到达没有后续转移的终止状态',
  replayMode: 'restart',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function fixturePath(root, relativePath) {
  return join(root, ...relativePath.split('/'));
}

export function writeJson(root, relativePath, value) {
  const path = fixturePath(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJson(root, relativePath) {
  return JSON.parse(readFileSync(fixturePath(root, relativePath), 'utf8'));
}

export function writeText(root, relativePath, value) {
  const path = fixturePath(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

export function readText(root, relativePath) {
  return readFileSync(fixturePath(root, relativePath), 'utf8');
}

function createPoints() {
  return [
    {
      ...clone(INDEX_POINTS[0]),
      coreIdea: '输入状态把执行过程开始前的全部相关信息表示为一组明确且可检查的状态变量。',
      principles: [
        '状态变量必须足以决定后续转移规则需要读取的信息。',
        '没有进入模型的环境条件不能被转移过程隐式使用。',
      ],
      applications: ['描述工作流、协议或算法开始执行时的初始配置。'],
      aliases: ['Input State', 'Initial State'],
      intuition: '像开始一盘棋前记录棋盘上每个棋子的位置，后续步骤都从这份记录出发。',
      misconceptions: ['输入状态不只是外部参数，也可以包含系统内部已经保存的变量取值。'],
      qa: [
        {
          q: '输入状态为什么必须完整？',
          a: '如果遗漏会影响转移的变量，相同记录可能产生不同后续状态，模型就不再确定。',
        },
        {
          q: '输入状态与普通输入参数有什么区别？',
          a: '输入参数通常来自外部，而输入状态还可以包含过程开始前的内部变量和环境条件。',
        },
      ],
      animationType: 'none',
      prerequisites: [],
    },
    {
      ...clone(INDEX_POINTS[1]),
      coreIdea: '状态转移读取当前状态与触发条件，并按照显式规则计算下一个合法状态。',
      principles: [
        '每次转移都必须能由当前状态、触发条件和转移规则共同解释。',
        '转移结果必须仍位于系统允许的状态集合内。',
        '确定性规则在相同输入状态和条件下产生相同后继状态。',
      ],
      comparisons: ['状态转移强调过程中的更新规则，静态映射只描述输入与输出之间的对应关系。'],
      applications: ['实现协议状态机、业务工作流和离散算法步骤。'],
      aliases: ['State Transition'],
      intuition: '像按照棋谱规则移动棋子，每一步都从当前棋盘得到一个新的合法棋盘。',
      misconceptions: ['画面中对象发生移动并不自动构成状态转移，必须同时说明触发条件和更新规则。'],
      qa: [
        {
          q: '怎样判断一次状态变化是合法转移？',
          a: '它必须满足触发条件、执行定义好的规则，并得到状态集合中的合法结果。',
        },
        {
          q: '状态转移适合解决什么任务？',
          a: '它适合表达协议、工作流和算法中由规则驱动的离散步骤变化。',
        },
      ],
      animationType: 'none',
      difficulty: '中等',
      importance: 0.9,
      prerequisites: ['input-state'],
    },
    {
      ...clone(INDEX_POINTS[2]),
      coreIdea: '终止条件把停止判据写成可验证规则，使状态更新不会无限继续或过早结束。',
      principles: [
        '终止判据必须能够仅根据当前可观察状态进行判断。',
        '达到终止条件后不再执行普通状态转移。',
      ],
      applications: ['规定搜索、迭代算法和有限工作流的停止边界。'],
      aliases: ['Terminal Condition', 'Stopping Criterion'],
      intuition: '像路线到达终点标志后停止前进，标志必须清楚到足以立即判断。',
      misconceptions: ['达到固定步数不是唯一终止方式，也可以依据目标状态或收敛判据停止。'],
      qa: [
        {
          q: '为什么终止条件必须可验证？',
          a: '执行过程需要在每一步明确判断是否继续，否则无法保证有限时间内正确停止。',
        },
        {
          q: '终止条件与最终状态有什么关系？',
          a: '终止条件是判断规则，最终状态是该规则成立时系统实际处于的状态。',
        },
      ],
      animationType: 'none',
      prerequisites: ['state-transition'],
    },
  ];
}

function createRequests(withAnimation) {
  return [
    {
      schema_version: 'animation-request/1.0',
      pointId: 'input-state',
      needed: false,
      rationale: '该知识点主要解释初始信息的静态组成，不包含持续变化的状态。',
    },
    withAnimation
      ? {
        schema_version: 'animation-request/1.0',
        pointId: 'state-transition',
        needed: true,
        rationale: '状态按触发条件和规则逐步更新，动画能直接展示每一步变化的因果关系。',
        mechanism: clone(MECHANISM),
        suggestion: ANIMATION_SUGGESTION,
      }
      : {
        schema_version: 'animation-request/1.0',
        pointId: 'state-transition',
        needed: false,
        rationale: '当前课程选择用静态状态表解释该过程，不交付独立动画组件。',
      },
    {
      schema_version: 'animation-request/1.0',
      pointId: 'terminal-condition',
      needed: false,
      rationale: '该知识点聚焦停止判据的定义与边界，静态规则说明已经足够。',
    },
  ];
}

function createAnimationManifest(withAnimation) {
  return {
    schema_version: 'course-content-animations/1.0',
    animations: withAnimation
      ? [
        {
          type: ANIMATION_TYPE,
          component: ANIMATION_COMPONENT,
          title: '状态转移过程',
          mechanism: clone(MECHANISM),
          bindings: [
            {
              pointId: 'state-transition',
              suggestion: ANIMATION_SUGGESTION,
            },
          ],
        },
      ]
      : [],
  };
}

function writeAnimationComponent(root) {
  writeText(
    root,
    `src/animations/${ANIMATION_COMPONENT}.tsx`,
    `import { useState } from 'react';
import './${ANIMATION_COMPONENT}.css';

const states = [
  { name: '等待', explanation: '当前状态等待触发条件' },
  { name: '检查', explanation: '检查条件并选择转移规则' },
  { name: '完成', explanation: '应用规则得到下一状态' },
];

function ${ANIMATION_COMPONENT}() {
  const [step, setStep] = useState(0);
  const current = states[step];

  return (
    <div
      className="animation-stage state-transition-animation"
      aria-label="当前状态按触发条件和规则更新到下一状态的动画"
    >
      <svg viewBox="0 0 420 180" role="img">
        <title>当前状态经过转移规则得到下一状态</title>
        {states.map((state, index) => (
          <g
            key={state.name}
            className={
              index === step
                ? 'state-transition-animation__step is-active'
                : 'state-transition-animation__step'
            }
          >
            <circle cx={70 + index * 140} cy="72" r="30" />
            <text x={70 + index * 140} y="78" textAnchor="middle">
              {state.name}
            </text>
          </g>
        ))}
        <text x="210" y="145" textAnchor="middle">
          {current.explanation}
        </text>
      </svg>
      <div className="state-transition-animation__controls">
        <button
          type="button"
          onClick={() => setStep((currentStep) => (
            currentStep + 1
          ) % states.length)}
        >
          下一步
        </button>
        <button
          type="button"
          aria-label="重播状态转移动画"
          onClick={() => setStep(0)}
        >
          重播
        </button>
      </div>
    </div>
  );
}

export default ${ANIMATION_COMPONENT};
`,
  );
  writeText(
    root,
    `src/animations/${ANIMATION_COMPONENT}.css`,
    `.state-transition-animation {
  width: 100%;
  min-height: 180px;
}

.state-transition-animation svg {
  display: block;
  width: 100%;
  height: auto;
}

.state-transition-animation__step {
  opacity: 0.45;
  transition: opacity 180ms ease;
}

.state-transition-animation__step.is-active {
  opacity: 1;
}

.state-transition-animation__controls {
  display: flex;
  gap: 0.5rem;
}

@media (prefers-reduced-motion: reduce) {
  .state-transition-animation * {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
`,
  );
}

export function createCourseFixture(
  t,
  { withAnimation = true, includeDetails = true } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-generator-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(fixturePath(root, 'src/data'), { recursive: true });
  mkdirSync(fixturePath(root, 'generation'), { recursive: true });
  writeJson(root, 'src/data/course.json', {
    schema_version: '1.0',
    id: 'state-machines',
    title: '状态机基础',
    description: '理解状态、转移规则与终止条件如何共同定义可执行的离散过程。',
    language: 'zh-CN',
    version: '0.1.0',
    updatedAt: '2026-07-16',
  });
  writeJson(root, 'src/data/index.json', {
    schema_version: 'course-content-index/1.0',
    courseId: 'state-machines',
    points: clone(INDEX_POINTS),
  });
  writeJson(root, 'generation/manifest.json', {
    schema_version: 'course-content-generation/1.0',
    subject: {
      id: 'state-machines',
      input: '状态机基础',
      normalizedTitle: '状态机基础',
      inputType: 'course',
      language: 'zh-CN',
      audience: '计算机相关专业本科生',
      depth: '一学期课程中的基础单元',
      scope: '覆盖状态表示、状态转移和过程终止的核心机制。',
      exclusions: ['特定编程语言状态机框架 API'],
      outcomes: ['能够定义并检查一个有限状态转移过程。'],
    },
    generation: {
      evidenceMode: 'model-only',
      generatedAt: '2026-07-16',
      pointCount: INDEX_POINTS.length,
    },
    sources: [],
    pointEvidence: INDEX_POINTS.map((point) => ({
      pointId: point.id,
      title: point.title,
      kind: point.id === 'state-transition' ? 'method' : 'concept',
      sourceRefs: [],
      confidence: 0.6,
      scopeStatus: 'core',
    })),
    reviewQueue: [],
  });

  if (includeDetails) {
    mkdirSync(fixturePath(root, 'src/data/points'), { recursive: true });
    mkdirSync(
      fixturePath(root, 'generation/animation-requests'),
      { recursive: true },
    );
    mkdirSync(fixturePath(root, 'src/animations'), { recursive: true });
    mkdirSync(fixturePath(root, 'src/components'), { recursive: true });

    const points = createPoints();
    for (const point of points) {
      writeJson(root, `src/data/points/${point.id}.json`, point);
    }
    for (const request of createRequests(withAnimation)) {
      writeJson(
        root,
        `generation/animation-requests/${request.pointId}.json`,
        request,
      );
    }
    writeJson(
      root,
      'generation/animation-manifest.json',
      createAnimationManifest(withAnimation),
    );
    if (withAnimation) writeAnimationComponent(root);
  }

  return {
    root,
    pointIds: [...POINT_IDS],
    animationType: ANIMATION_TYPE,
    animationComponent: ANIMATION_COMPONENT,
    animationSuggestion: ANIMATION_SUGGESTION,
  };
}
