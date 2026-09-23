/**
 * The signature visual (brief §8): IDEA → DATA → TEST → GATE → VERDICT.
 *
 * The five stages are fixed data, not props, because they are a statement about
 * how this product works and not about any particular session. What the caller
 * supplies is the STATE — which node is happening now, and how the verdict came
 * out — so this component can be the live indicator while remaining incapable of
 * asserting a stage the caller did not report.
 *
 * §29: "Do not animate all five stages simultaneously." Nothing here animates at
 * all. The current node is marked with amber and a rule, which is a state a
 * reader can find by looking rather than by waiting.
 *
 * The states are derived in `app/page.tsx` and passed in whole, rather than
 * computed here from a `phase`, because the reasoning about what this session
 * has actually evidenced is the same reasoning the header and the panels use and
 * belongs beside it. This component renders; it does not decide.
 */

import { Fragment } from 'react';
import { ArrowRight, Database, FlaskConical, Gavel, Lightbulb, ShieldCheck } from 'lucide-react';
import { ProcessStep, type StageState } from './ProcessStep';

/**
 * The five stages, in order. Exported so the caller's state array can be checked
 * against it — `states` must be five long, and a silent length mismatch would
 * render a pipeline that quietly stopped at GATE.
 */
export const STAGE_COUNT = 5;

const STAGES = [
  {
    label: 'IDEA',
    icon: <Lightbulb size={20} aria-hidden />,
    explanation: 'AI proposes a trading idea',
  },
  {
    label: 'DATA',
    icon: <Database size={20} aria-hidden />,
    // "Frozen" rather than §29's "historical": the dataset is pinned and hashed,
    // and that distinction is the product's, not a wording preference. See
    // ProvenancePanel and the `dataset_sha256` it prints.
    explanation: 'Frozen Bitget data tests it',
  },
  {
    label: 'TEST',
    icon: <FlaskConical size={20} aria-hidden />,
    explanation: 'The analysis runs',
  },
  {
    label: 'GATE',
    icon: <ShieldCheck size={20} aria-hidden />,
    explanation: 'Fixed rules judge the evidence',
  },
  {
    label: 'VERDICT',
    icon: <Gavel size={20} aria-hidden />,
    explanation: 'Survive or get killed',
  },
] as const;

export interface ProcessPipelineProps {
  /** One state per stage, in order. Must be `STAGE_COUNT` long. */
  states: StageState[];
  /** Colours the VERDICT node once a verdict exists. Null leaves it neutral. */
  verdict?: 'promoted' | 'killed' | null;
}

/**
 * The connector between two nodes. Completed when the node it leaves is done,
 * per §29's rule that the connector goes ink-light on completion — otherwise it
 * stays the rule colour, so a fully idle pipeline reads as a diagram rather than
 * as a set of switches that are all off.
 */
function Connector({ done }: { done: boolean }) {
  return (
    <div className="flex items-center justify-center py-1 lg:w-10 lg:py-0" aria-hidden>
      <ArrowRight
        size={16}
        className={`rotate-90 lg:rotate-0 ${done ? 'text-ink-light' : 'text-rule'}`}
      />
    </div>
  );
}

export function ProcessPipeline({ states, verdict = null }: ProcessPipelineProps) {
  return (
    <section
      aria-label="How a trading idea is tested"
      className="border-y border-rule px-2 py-6"
    >
      <div className="flex flex-col lg:flex-row lg:items-start">
        {STAGES.map((stage, index) => (
          /*
           * A keyed Fragment, not a wrapper div: the nodes and the connectors
           * between them have to be siblings of one flex container, and a div
           * here would nest them one level deep and break the row.
           */
          <Fragment key={stage.label}>
            {index > 0 ? <Connector done={states[index - 1] === 'done'} /> : null}
            <ProcessStep
              label={stage.label}
              icon={stage.icon}
              explanation={stage.explanation}
              state={states[index] ?? 'idle'}
              // Only the last node may take a verdict tone; handing it to any
              // other node would put the outcome's colour on a step that did not
              // produce it.
              tone={index === STAGES.length - 1 ? verdict : null}
            />
          </Fragment>
        ))}
      </div>
    </section>
  );
}
